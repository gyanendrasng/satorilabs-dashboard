/**
 * Regression test for email_clarify_plant fanning out to EVERY distinct plant
 * (src/lib/scenario-engine.ts).
 *
 *   DATABASE_URL="file:/tmp/x.db" npx prisma db push --skip-generate \
 *     && DATABASE_URL="file:/tmp/x.db" npx tsx scripts/test-clarify-plant-fanout.ts
 *
 * Bug: email_clarify_plant sent only to process.env.PLANT_EMAIL. An SO/PO spans
 * multiple plants (each LoadingSlip.plantEmail differs), so the other plants were
 * never told. Fix: enumerate distinct LoadingSlip.plantEmail and send to each.
 *
 * Captures sends via the e2e-shared Gmail stub. Exits 0/1; cleans up fixtures.
 */

process.env.DASHBOARD_URL = process.env.DASHBOARD_URL || 'http://localhost:3001';
process.env.BRANCH_EMAIL = process.env.BRANCH_EMAIL || 'test-branch@example.com';
process.env.PLANT_EMAIL = process.env.PLANT_EMAIL || 'fallback-plant@example.com';
process.env.SCENARIO_ENGINE_ENABLED = 'true';

import { RECORDED_EMAILS } from './e2e-shared'; // installs Gmail/S3 require-hooks
import { prisma } from '../src/lib/prisma';
import { executeScenario } from '../src/lib/scenario-engine';

const RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';
let failed = false;
const pass = (m: string) => console.log(`${GREEN}✓ PASS${RESET} ${m}`);
const fail = (m: string) => { console.error(`${RED}✗ FAIL${RESET} ${m}`); failed = true; };

const PO_NUMBER = `CLRFAN-TEST-${Math.floor(Date.now() % 1e9)}`;
const SO_NUMBER = `${Math.floor(Date.now() % 1e7)}`;
const PLANT_A = 'plantA@example.com';
const PLANT_B = 'plantB@example.com';

async function driveClarifyPlant(soId: string, question: string) {
  await prisma.scenarioProgress.create({
    data: {
      salesOrderId: soId, scenarioKey: 'llm-planned', state: 'ready', classifierOutput: '{}',
      generatedSteps: JSON.stringify([{ kind: 'email_clarify_plant', question, rationale: 'test' }]),
      stopAfterIndex: 0, currentStepIndex: 0,
    },
  });
  await executeScenario({ salesOrderId: soId, log: () => {} });
}

// Recipient is the first arg of sendPlainEmail / sendReplyEmail.
const recipientsOf = () =>
  RECORDED_EMAILS.filter((e) => /sendPlainEmail|sendReplyEmail/.test(e.fn)).map((e) => e.args[0] as string);

async function main() {
  const po = await prisma.purchaseOrder.create({
    data: { poNumber: PO_NUMBER, customerName: 'Clarify Fanout Co', weightage: 12 },
  });
  const so = await prisma.salesOrder.create({
    data: { soNumber: SO_NUMBER, purchaseOrderId: po.id, plant: '1101' },
  });
  const bundle = await prisma.bundle.create({
    data: { purchaseOrderId: po.id, bundleNumber: 1, totalWeightKg: 1000 },
  });
  // Two loading slips on the SAME SO/PO but DIFFERENT plants.
  await prisma.loadingSlip.create({
    data: { salesOrderId: so.id, lsNumber: 'LS-A1', bundleId: bundle.id, plantEmail: PLANT_A, status: 'sent_to_plant' },
  });
  await prisma.loadingSlip.create({
    data: { salesOrderId: so.id, lsNumber: 'LS-A2', bundleId: bundle.id, plantEmail: PLANT_A, status: 'sent_to_plant' },
  });
  await prisma.loadingSlip.create({
    data: { salesOrderId: so.id, lsNumber: 'LS-B1', bundleId: bundle.id, plantEmail: PLANT_B, status: 'sent_to_plant' },
  });

  try {
    RECORDED_EMAILS.length = 0;
    await driveClarifyPlant(so.id, 'Please confirm the dispatch schedule.');
    const recips = recipientsOf();
    const distinct = new Set(recips);

    if (distinct.has(PLANT_A) && distinct.has(PLANT_B))
      pass('clarification reached BOTH distinct plants (A and B)');
    else fail(`expected both plants; got recipients=${JSON.stringify(recips)}`);

    // Exactly the two distinct plants — no duplicate-per-LS spam, no fallback env addr.
    if (distinct.size === 2) pass('exactly 2 distinct plant recipients (deduped across 3 LSs)');
    else fail(`expected 2 distinct recipients, got ${distinct.size}: ${JSON.stringify([...distinct])}`);

    if (!distinct.has(process.env.PLANT_EMAIL!))
      pass('did NOT fall back to the single PLANT_EMAIL env address');
    else fail('wrongly sent to the PLANT_EMAIL env fallback when loading slips exist');
  } finally {
    await prisma.scenarioEvent.deleteMany({ where: { salesOrderId: so.id } });
    await prisma.scenarioProgress.deleteMany({ where: { salesOrderId: so.id } });
    await prisma.email.deleteMany({ where: { purchaseOrderId: po.id } });
    await prisma.loadingSlip.deleteMany({ where: { salesOrderId: so.id } });
    await prisma.bundle.deleteMany({ where: { purchaseOrderId: po.id } });
    await prisma.salesOrder.deleteMany({ where: { id: so.id } });
    await prisma.purchaseOrder.deleteMany({ where: { id: po.id } });
    await prisma.$disconnect();
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
