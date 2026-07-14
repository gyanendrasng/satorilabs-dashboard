/**
 * Regression test: the zload2 PENDING-SO-DECREASE detection must be split-aware.
 *
 *   npx tsx scripts/test-zload2-split-pending-dec.ts   (or: npm test)
 *
 * A post-plant_ls increase can SPLIT a material across bundles: zload2 sets the
 * primary LS to the portion that fits (e.g. 213 of a 250 SO line) and a sibling
 * zload1 appends the overflow (37) to a NEW LS. The old check flagged a pending
 * SO-line DECREASE whenever the zload2 quantity was below the SO line
 * (213 < 250) — so a later va02 flushed orderQuantity 250 → 213, inflating every
 * weight calc (6300/213 instead of 6300/250) and making SAP try to lower the
 * line. (The SO 3382184 / YAFPLNA bug.)
 *
 * Fix: only flag a pending decrease when the revised LS line actually SHRANK
 * vs. its prior quantity. An increase (same-bundle or split) raises the LS line
 * (overflow goes to a new LS), so it is no longer mislabeled.
 *
 * Cases:
 *   A  split increase  — SO line 250, prior LS 200, zload2 213 → NO pending dec.
 *   B  genuine decrease — SO line 200, prior LS 200, zload2 150 → pending dec=150.
 *   C  same-bundle incr — SO line 210, prior LS 200, zload2 210 → NO pending dec.
 *
 * Exits 0/1; cleans up fixtures.
 */

process.env.SCENARIO_ENGINE_ENABLED = 'true';
process.env.AUTO_GUI_HOST = '127.0.0.1';
process.env.AUTO_GUI_PORT = '59999';
process.env.PLANT_EMAIL = process.env.PLANT_EMAIL || 'plant@example.com';

import { prisma } from '../src/lib/prisma';
import { executeScenario } from '../src/lib/scenario-engine';

const RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';
let failed = false;
const pass = (m: string) => console.log(`${GREEN}✓ PASS${RESET} ${m}`);
const fail = (m: string) => { console.error(`${RED}✗ FAIL${RESET} ${m}`); failed = true; };

const MAT = 'YAFPLNA00000043P';
const BATCH = 'LD-01';
let seq = 0;

async function run(tag: string, soLine: number, priorLsQty: number, zload2Qty: number) {
  seq += 1;
  const uniq = `${Date.now()}${seq}`;
  const po = await prisma.purchaseOrder.create({
    data: { poNumber: `Z2S-${tag}-${uniq}`, customerName: 'Z2S', weightage: 12, dispatchRound: 3 },
  });
  const so = await prisma.salesOrder.create({
    data: { soNumber: `Z2S-${tag}-${uniq}`.slice(0, 18), purchaseOrderId: po.id, plant: '1101' },
  });
  const bundle = await prisma.bundle.create({
    data: { purchaseOrderId: po.id, bundleNumber: 1, totalWeightKg: 0, status: 'planned' },
  });
  const lsNumber = `Z2S${seq}${(Date.now() % 1e6)}`;
  const ls = await prisma.loadingSlip.create({
    data: { lsNumber, bundleId: bundle.id, salesOrderId: so.id, plantEmail: 'plant@example.com', status: 'sent_to_plant' },
  });
  await prisma.loadingSlipItem.create({
    data: { salesOrderId: so.id, loadingSlipId: ls.id, lsNumber, material: MAT, batch: BATCH, orderQuantity: priorLsQty, status: 'pending' },
  });
  await prisma.material.create({
    data: { salesOrderId: so.id, material: MAT, batch: BATCH, orderQuantity: soLine, dispatchQuantity: soLine, materialDescription: 'OAFFJ 600X600-4 REC PLANK NATURAL MDR-P', orderWeightKg: 6300 },
  });
  const trig = await prisma.email.create({
    data: {
      salesOrderId: so.id, gmailMessageId: `Z2S-MSG-${uniq}`, gmailThreadId: `Z2S-THR-${uniq}`,
      recipientEmail: 'branch@example.com', subject: 't', status: 'sent', emailType: 'dispatch_confirmation', replyHtml: '<p>x</p>',
    },
  });
  const step = [{ kind: 'zload2', args: { revisions: [{ material: MAT, qty: zload2Qty, lsNumber, batch: BATCH }] }, rationale: 'test' }];
  await prisma.scenarioProgress.create({
    data: { salesOrderId: so.id, scenarioKey: 'llm-planned', state: 'ready', classifierOutput: '{}', generatedSteps: JSON.stringify(step), stopAfterIndex: 0, currentStepIndex: 0, triggerEmailId: trig.id },
  });

  try { await executeScenario({ salesOrderId: so.id, log: () => {} }); } catch { /* dead-port send is swallowed; pending-dec already applied */ }

  const m = await prisma.material.findFirst({ where: { salesOrderId: so.id, material: MAT }, select: { pendingSoOp: true, pendingSoQty: true } });

  // cleanup
  await prisma.scenarioEvent.deleteMany({ where: { salesOrderId: so.id } });
  await prisma.scenarioProgress.deleteMany({ where: { salesOrderId: so.id } });
  await prisma.workQueue.deleteMany({ where: { salesOrderId: so.id } });
  await prisma.loadingSlipItem.deleteMany({ where: { salesOrderId: so.id } });
  await prisma.loadingSlip.deleteMany({ where: { salesOrderId: so.id } });
  await prisma.material.deleteMany({ where: { salesOrderId: so.id } });
  await prisma.bundle.deleteMany({ where: { id: bundle.id } });
  await prisma.email.deleteMany({ where: { salesOrderId: so.id } });
  await prisma.salesOrder.deleteMany({ where: { id: so.id } });
  await prisma.purchaseOrder.deleteMany({ where: { id: po.id } });
  return m;
}

async function main() {
  try {
    // A — split increase: SO line already at 250, this LS portion is 213 (was
    //     200 → it GREW), overflow goes to a new LS via zload1. NOT a decrease.
    const a = await run('split', 250, 200, 213);
    if (a?.pendingSoOp == null && a?.pendingSoQty == null)
      pass('split increase (LS 200→213, SO line 250) → NO pending decrease');
    else
      fail(`split increase wrongly flagged: pendingSoOp=${a?.pendingSoOp} pendingSoQty=${a?.pendingSoQty}`);

    // B — genuine decrease: LS 200→150 (shrank) below SO line 200 → pending dec.
    const b = await run('dec', 200, 200, 150);
    if (b?.pendingSoOp === 'dec' && b?.pendingSoQty === 150)
      pass('genuine decrease (LS 200→150) → pending dec = 150 (still works)');
    else
      fail(`genuine decrease not flagged correctly: pendingSoOp=${b?.pendingSoOp} pendingSoQty=${b?.pendingSoQty}`);

    // C — same-bundle increase: LS 200→210, SO line already 210. NOT a decrease.
    const c = await run('same', 210, 200, 210);
    if (c?.pendingSoOp == null && c?.pendingSoQty == null)
      pass('same-bundle increase (LS 200→210, SO line 210) → NO pending decrease');
    else
      fail(`same-bundle increase wrongly flagged: pendingSoOp=${c?.pendingSoOp} pendingSoQty=${c?.pendingSoQty}`);
  } finally {
    await prisma.$disconnect();
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
