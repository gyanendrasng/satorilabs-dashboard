/**
 * Keystone regression test for the surgical "preserve" increase flow
 * (Rule 6e same_bundle). Reproduces the exact prod failure on SO 3382184 /
 * material YO00000530000SOP increased 200 → 210, where the DB ended up at:
 *
 *     orderQuantity=200  batch="N/A"  pendingSoOp="dec"  pendingSoQty=210
 *
 * and the dispatch-approval email showed "200 units from Batch N/A".
 *
 *   DATABASE_URL="file:/tmp/x.db" npx prisma db push --skip-generate \
 *     && DATABASE_URL="file:/tmp/x.db" npx tsx scripts/test-surgical-increase-engine.ts
 *
 * Drives the REAL engine va02 + zload2 handlers (via executeScenario with a
 * one-step synthetic plan) and the zmatana-data callback, then asserts the
 * final Material row state AND the rendered dispatch-approval email content.
 * Exits 0 on pass, 1 on fail. Cleans up its own fixtures.
 *
 * SAP fan-out is fire-and-forget over HTTP; we point AUTO_GUI_HOST at an
 * unreachable port so those POSTs fail fast (caught by pumpQueue) — the DB
 * writes we assert happen synchronously in the engine handlers regardless.
 */

process.env.SCENARIO_ENGINE_ENABLED = 'true';
process.env.AUTO_GUI_HOST = '127.0.0.1';
process.env.AUTO_GUI_PORT = '9'; // discard port — fetch fails fast

import { prisma } from '../src/lib/prisma';
import { executeScenario } from '../src/lib/scenario-engine';
import { buildDispatchApprovalHtml, type DispatchSoSection } from '../src/lib/dispatch-email-template';

const RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';
let failed = false;
const pass = (m: string) => console.log(`${GREEN}✓ PASS${RESET} ${m}`);
const fail = (m: string) => { console.error(`${RED}✗ FAIL${RESET} ${m}`); failed = true; };

const PO_NUMBER = `SURG-TEST-${Math.floor(Date.now() % 1e9)}`;
const SO_NUMBER = `${Math.floor(Date.now() % 1e7)}`;
const TARGET = 'YO00000530000SOP';   // 9.5 kg/unit, increased 200→210
const TARGET_DESC = 'OOWJ 108X108-80 MANGO YELLOW GL UNREC- P';
const DECMAT = 'YDECDECDEC0000PJP';  // decreased 100→80 in the same flow (edge 3)

/** Seed a fresh single-step plan + active progress, then run executeScenario. */
async function driveStep(soId: string, kind: string, args: unknown) {
  await prisma.scenarioProgress.create({
    data: {
      salesOrderId: soId,
      scenarioKey: 'llm-planned',
      state: 'ready',
      classifierOutput: '{}',
      generatedSteps: JSON.stringify([{ kind, args, rationale: 'test' }]),
      stopAfterIndex: 0,
      currentStepIndex: 0,
    },
  });
  await executeScenario({ salesOrderId: soId, log: () => {} });
}

async function main() {
  const po = await prisma.purchaseOrder.create({
    data: { poNumber: PO_NUMBER, customerName: 'Surgical Test Co', weightage: 12 },
  });
  const so = await prisma.salesOrder.create({
    data: { soNumber: SO_NUMBER, purchaseOrderId: po.id, plant: '1101', visibilityState: 'received' },
  });
  const bundle = await prisma.bundle.create({
    data: { purchaseOrderId: po.id, bundleNumber: 1, totalWeightKg: 1900 },
  });
  // TARGET starts at 200 units / 1900 kg, batch already "P" (lone_zmatana ran).
  await prisma.material.create({
    data: {
      salesOrderId: so.id, material: TARGET, materialDescription: TARGET_DESC,
      batch: 'P', orderQuantity: 200, orderWeightKg: 1900, availableStock: 99999,
      dispatchQuantity: 200, bundleId: bundle.id,
    },
  });
  // DECMAT starts at 100; the same reply decreases it to 80 (genuine decrease).
  await prisma.material.create({
    data: {
      salesOrderId: so.id, material: DECMAT, materialDescription: 'ODEC 100X100 DECREASE MAT-P',
      batch: 'Q', orderQuantity: 100, orderWeightKg: 1000, availableStock: 99999,
      dispatchQuantity: 100, bundleId: bundle.id,
    },
  });
  // One LS carrying both, so the zload2 handler resolves lsNumber+batch via LSI.
  const lsNumber = `LS-SURG-${Math.floor(Date.now() % 1e7)}`;
  const ls = await prisma.loadingSlip.create({
    data: { salesOrderId: so.id, lsNumber, bundleId: bundle.id, plantEmail: 'plant@example.com', status: 'pending' },
  });
  await prisma.loadingSlipItem.create({
    data: { salesOrderId: so.id, material: TARGET, batch: 'P', orderQuantity: 200, loadingSlipId: ls.id, lsNumber },
  });
  await prisma.loadingSlipItem.create({
    data: { salesOrderId: so.id, material: DECMAT, batch: 'Q', orderQuantity: 100, loadingSlipId: ls.id, lsNumber },
  });

  try {
    // ── Step 1: VA02 raises the SO line. Phase 2 of Rule 6e: TARGET→210. ──
    await driveStep(so.id, 'va02', { materials: [{ code: TARGET, op: 'inc', qty: 210 }] });
    const afterVa02 = await prisma.material.findFirst({ where: { salesOrderId: so.id, material: TARGET } });
    if (afterVa02?.orderQuantity === 210) pass('Fix A1: VA02 increase persists Material.orderQuantity=210');
    else fail(`Fix A1: orderQuantity after va02 = ${afterVa02?.orderQuantity} (expected 210)`);
    // orderWeightKg must scale with orderQuantity (kgPerUnit stays 9.5) → 1995,
    // else kgPerUnit = 1900/210 = 9.05 and the diff line renders 211 not 210.
    const owk = afterVa02?.orderWeightKg ? Number(afterVa02.orderWeightKg) : 0;
    if (owk === 1995) pass('Fix A1: orderWeightKg scaled to 1995 (kgPerUnit stays 9.5)');
    else fail(`Fix A1: orderWeightKg after va02 = ${owk} (expected 1995 = 210×9.5)`);
    // dispatchQuantity tracks the new total (branch releases all 210).
    if (afterVa02?.dispatchQuantity === 210) pass('Fix A1: dispatchQuantity bumped to 210');
    else fail(`Fix A1: dispatchQuantity after va02 = ${afterVa02?.dispatchQuantity} (expected 210)`);

    // ── Step 2: zmatana-data callback for the delta with a bare-string echo. ──
    // batch should STAY "P" (Fix B1), not be clobbered to "N/A".
    const { POST: zmatanaPost } = await import('../src/app/backend/orders/aman/zmatana-data/route');
    const zmatanaReq = new Request('http://test/zmatana-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ so_number: SO_NUMBER, materials: [TARGET] }), // bare-string echo, NO batch
    });
    await zmatanaPost(zmatanaReq);
    const afterZmatana = await prisma.material.findFirst({ where: { salesOrderId: so.id, material: TARGET } });
    if (afterZmatana?.batch === 'P') pass('Fix B1: bare-string zmatana echo preserves batch "P" (not clobbered to N/A)');
    else fail(`Fix B1: batch after zmatana = "${afterZmatana?.batch}" (expected "P")`);

    // ── Step 3: ZLOAD2 revises the LS to the new total 210 (Phase 3 same_bundle). ──
    // It must NOT stamp a pending-dec (it's an increase). And orderQuantity stays 210.
    await driveStep(so.id, 'zload2', { revisions: [{ lsNumber, material: TARGET, batch: 'P', qty: 210 }] });
    const afterZ2 = await prisma.material.findFirst({ where: { salesOrderId: so.id, material: TARGET } });
    if (afterZ2?.pendingSoOp === null && afterZ2?.pendingSoQty === null)
      pass('Fix A2: ZLOAD2 increase does NOT stamp a pending-dec');
    else fail(`Fix A2: after zload2 pendingSoOp="${afterZ2?.pendingSoOp}" pendingSoQty=${afterZ2?.pendingSoQty} (expected null/null)`);
    if (afterZ2?.orderQuantity === 210) pass('Fix A2: ZLOAD2 increase leaves orderQuantity at 210');
    else fail(`Fix A2: orderQuantity after zload2 = ${afterZ2?.orderQuantity} (expected 210)`);

    // ── Edge 3: a GENUINE decrease via ZLOAD2 still records pending-dec. ──
    await driveStep(so.id, 'zload2', { revisions: [{ lsNumber, material: DECMAT, batch: 'Q', qty: 80 }] });
    const afterDec = await prisma.material.findFirst({ where: { salesOrderId: so.id, material: DECMAT } });
    if (afterDec?.pendingSoOp === 'dec' && afterDec?.pendingSoQty === 80)
      pass('Edge 3: genuine ZLOAD2 decrease still stamps pendingSoOp=dec/80 (no regression)');
    else fail(`Edge 3: decrease pendingSoOp="${afterDec?.pendingSoOp}" pendingSoQty=${afterDec?.pendingSoQty} (expected dec/80)`);

    // ── Email 1: dispatch-approval prose must show the FRESH 210 / Batch P. ──
    const m = (await prisma.material.findFirst({ where: { salesOrderId: so.id, material: TARGET } }))!;
    const section: DispatchSoSection = {
      soNumber: SO_NUMBER,
      soPlant: '1101',
      materials: [{
        material: m.material, materialDescription: m.materialDescription,
        batch: m.batch, orderQuantity: m.orderQuantity,
        availableStock: m.availableStock, orderWeightKg: m.orderWeightKg ? Number(m.orderWeightKg) : null,
      }],
    };
    const html = buildDispatchApprovalHtml(PO_NUMBER, [section], 12);
    if (html.includes('Proceed with 210 units from Batch P') && !html.includes('200 units'))
      pass('Email 1: dispatch-approval shows "210 units from Batch P" (not 200 / N/A)');
    else fail(`Email 1: prose wrong — has210P=${html.includes('Proceed with 210 units from Batch P')} has200=${html.includes('200 units')}`);
  } finally {
    await prisma.scenarioEvent.deleteMany({ where: { salesOrderId: so.id } });
    await prisma.scenarioProgress.deleteMany({ where: { salesOrderId: so.id } });
    await prisma.workQueue.deleteMany({ where: { salesOrder: { id: so.id } } });
    await prisma.loadingSlipItem.deleteMany({ where: { salesOrderId: so.id } });
    await prisma.loadingSlip.deleteMany({ where: { salesOrderId: so.id } });
    await prisma.material.deleteMany({ where: { salesOrderId: so.id } });
    await prisma.bundle.deleteMany({ where: { purchaseOrderId: po.id } });
    await prisma.salesOrder.deleteMany({ where: { id: so.id } });
    await prisma.purchaseOrder.deleteMany({ where: { id: po.id } });
    await prisma.$disconnect();
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
