/**
 * The bundle_capacity_assessment step records a concurrent decrease VIRTUALLY:
 * it sets Material.dispatchQuantity to the new lower total (display only) and
 * leaves orderQuantity + orderWeightKg untouched (the SO line is reconciled in
 * SAP later, Phase 3). It also stores the decrease in the step_completed payload.
 *
 *   npx tsx scripts/test-virtual-decrease-dispatchqty.ts   (or: npm test)
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

async function main() {
  const uniq = `${Date.now()}`;
  const po = await prisma.purchaseOrder.create({
    data: { poNumber: `VD-${uniq}`, customerName: 'VD Co', weightage: 20, dispatchRound: 1 },
  });
  const so = await prisma.salesOrder.create({
    data: { soNumber: `VD-${uniq}`.slice(0, 18), purchaseOrderId: po.id, plant: '1101' },
  });
  const bundle = await prisma.bundle.create({
    data: { purchaseOrderId: po.id, bundleNumber: 1, totalWeightKg: 15000 },
  });
  const ls = await prisma.loadingSlip.create({
    data: { salesOrderId: so.id, bundleId: bundle.id, lsNumber: `LS-${uniq}`, plantEmail: 'plant@example.com' },
  });
  await prisma.material.create({
    data: { salesOrderId: so.id, material: 'A', batch: 'BA', orderQuantity: 50, dispatchQuantity: 50, orderWeightKg: 5000 },
  });
  await prisma.material.create({
    data: { salesOrderId: so.id, material: 'B', batch: 'BB', orderQuantity: 100, dispatchQuantity: 100, orderWeightKg: 10000 },
  });
  await prisma.loadingSlipItem.create({
    data: { salesOrderId: so.id, loadingSlipId: ls.id, lsNumber: ls.lsNumber, material: 'A', batch: 'BA', orderQuantity: 50 },
  });
  await prisma.loadingSlipItem.create({
    data: { salesOrderId: so.id, loadingSlipId: ls.id, lsNumber: ls.lsNumber, material: 'B', batch: 'BB', orderQuantity: 100 },
  });
  // Trigger WITHOUT replyHtml so the handler's planner re-enter is skipped (no LLM call).
  const trig = await prisma.email.create({
    data: {
      salesOrderId: so.id, gmailMessageId: `VD-MSG-${uniq}`, gmailThreadId: `VD-THR-${uniq}`,
      recipientEmail: 'branch@example.com', subject: 't', status: 'sent', emailType: 'ls_dispatch',
    },
  });

  const step = [{
    kind: 'bundle_capacity_assessment',
    args: { items: [{ material: 'A', deltaKg: 2000 }], decreases: [{ material: 'B', toQty: 60 }] },
    rationale: 'test',
  }];
  await prisma.scenarioProgress.create({
    data: {
      salesOrderId: so.id, scenarioKey: 'llm-planned', state: 'ready', classifierOutput: '{}',
      generatedSteps: JSON.stringify(step), stopAfterIndex: 0, currentStepIndex: 0, triggerEmailId: trig.id,
    },
  });

  try {
    try { await executeScenario({ salesOrderId: so.id, log: () => {} }); } catch { /* no re-enter; ignore */ }

    const b = await prisma.material.findFirst({ where: { salesOrderId: so.id, material: 'B' } });
    if (b?.dispatchQuantity === 60) pass('B.dispatchQuantity set to 60 (virtual decrease)');
    else fail(`B.dispatchQuantity = ${b?.dispatchQuantity} (expected 60)`);
    if (b?.orderQuantity === 100 && Math.abs(Number(b?.orderWeightKg) - 10000) < 1e-3)
      pass('B.orderQuantity + orderWeightKg unchanged (SAP deferred)');
    else fail(`B.orderQuantity=${b?.orderQuantity} orderWeightKg=${b?.orderWeightKg} (expected 100 / 10000)`);

    const evt = await prisma.scenarioEvent.findFirst({
      where: { salesOrderId: so.id, type: 'step_completed', payload: { contains: '"kind":"bundle_capacity_assessment"' } },
      orderBy: { createdAt: 'desc' },
    });
    const payload = evt ? JSON.parse(evt.payload) : null;
    const dec = Array.isArray(payload?.decreases) ? payload.decreases.find((d: any) => d.material === 'B') : null;
    if (dec && dec.fromQty === 100 && dec.toQty === 60) pass('step_completed payload carries decrease B 100→60');
    else fail(`payload.decreases = ${JSON.stringify(payload?.decreases)}`);
  } finally {
    await prisma.scenarioEvent.deleteMany({ where: { salesOrderId: so.id } });
    await prisma.scenarioProgress.deleteMany({ where: { salesOrderId: so.id } });
    await prisma.workQueue.deleteMany({ where: { salesOrderId: so.id } });
    await prisma.loadingSlipItem.deleteMany({ where: { salesOrderId: so.id } });
    await prisma.loadingSlip.deleteMany({ where: { salesOrderId: so.id } });
    await prisma.material.deleteMany({ where: { salesOrderId: so.id } });
    await prisma.bundle.deleteMany({ where: { purchaseOrderId: po.id } });
    await prisma.email.deleteMany({ where: { salesOrderId: so.id } });
    await prisma.salesOrder.deleteMany({ where: { id: so.id } });
    await prisma.purchaseOrder.deleteMany({ where: { id: po.id } });
    await prisma.$disconnect();
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
