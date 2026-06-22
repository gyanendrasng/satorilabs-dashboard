/**
 * Regression test for email_modified_ls_to_plant forwarding the ZLOAD1-APPEND's
 * new loading slip, not just the zload2-revised one (src/lib/scenario-engine.ts).
 *
 *   DATABASE_URL="file:/tmp/x.db" npx prisma db push --skip-generate \
 *     && DATABASE_URL="file:/tmp/x.db" npx tsx scripts/test-plant-notify-append.ts
 *
 * Bug: in the post-plant_ls surgical flow, an other_bundle increase fires ZLOAD2
 * (revise existing LS) + ZLOAD1-append (new LS on a sibling bundle). The plant
 * notification only forwarded the zload2-touched LS — it gathered touched LSs
 * solely from zload2/zloading_close work rows, so the brand-new appended LS was
 * never sent to the plant (it'd never get invoiced).
 *
 * Fix: also forward LoadingSlips created during this scenario (the append's LS).
 *
 * Exits 0/1; cleans up its fixtures.
 */

process.env.DASHBOARD_URL = process.env.DASHBOARD_URL || 'http://localhost:3001';
process.env.BRANCH_EMAIL = process.env.BRANCH_EMAIL || 'test-branch@example.com';
process.env.PLANT_EMAIL = process.env.PLANT_EMAIL || 'test-plant@example.com';
process.env.SCENARIO_ENGINE_ENABLED = 'true';

import { RECORDED_EMAILS } from './e2e-shared'; // installs Gmail/S3 require-hooks
import { prisma } from '../src/lib/prisma';
import { executeScenario } from '../src/lib/scenario-engine';

const RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';
let failed = false;
const pass = (m: string) => console.log(`${GREEN}✓ PASS${RESET} ${m}`);
const fail = (m: string) => { console.error(`${RED}✗ FAIL${RESET} ${m}`); failed = true; };

const PO_NUMBER = `PNAPP-${Math.floor(Date.now() % 1e9)}`;
const SO_NUMBER = `${Math.floor(Date.now() % 1e7)}`;
const gid = () => `g-${Math.floor(Date.now() % 1e9)}-${Math.random().toString(36).slice(2, 8)}`;
const EXIST_LS = 'LS-EXIST';
const APPEND_LS = 'LS-APPEND';

// The handler logs which LSs it forwards: "forwarding N modified LS(s) … [a, b]".
// We assert on that selection line — it's the behaviour under test (the actual
// S3 download + plant send happen after, and aren't relevant to this fix). The
// engine's dynamic import('./s3') isn't caught by the require-hook, so the send
// itself errors in-test; that's downstream of the selection we're verifying.
const ENGINE_LOG: string[] = [];
const forwardingLine = () => ENGINE_LOG.find((l) => l.includes('forwarding') && l.includes('modified LS')) ?? '';

async function main() {
  const po = await prisma.purchaseOrder.create({
    data: { poNumber: PO_NUMBER, customerName: 'Plant Notify Co', weightage: 12 },
  });
  const so = await prisma.salesOrder.create({
    data: { soNumber: SO_NUMBER, purchaseOrderId: po.id, plant: '1101' },
  });
  const bundle = await prisma.bundle.create({
    data: { purchaseOrderId: po.id, bundleNumber: 3, totalWeightKg: 7000, vehicleNumber: 'MH-01-AA-1111' },
  });

  // The existing LS, revised by ZLOAD2 — created BEFORE the scenario started.
  const exist = await prisma.loadingSlip.create({
    data: {
      salesOrderId: so.id, lsNumber: EXIST_LS, bundleId: bundle.id, plantEmail: 'plantA@example.com',
      fileUrl: `ls-files/${SO_NUMBER}/${EXIST_LS}.pdf`, status: 'sent_to_plant',
      createdAt: new Date('2026-06-21T10:00:00Z'),
    },
  });
  await prisma.loadingSlipItem.create({
    data: { salesOrderId: so.id, loadingSlipId: exist.id, lsNumber: EXIST_LS, material: 'YO00000530000SOP', batch: 'P', orderQuantity: 230 },
  });

  // Prior plant_ls email → handler runs in FOLLOW-UP mode (not first-send).
  await prisma.email.create({
    data: {
      salesOrderId: so.id, purchaseOrderId: po.id, emailType: 'plant_ls',
      gmailMessageId: gid(), gmailThreadId: gid(), recipientEmail: 'plantA@example.com',
      subject: 'Loading Slip', status: 'sent', sentAt: new Date('2026-06-21T09:00:00Z'),
    },
  });

  // The scenario: a one-step email_modified_ls_to_plant plan. createdAt sits
  // between the existing LS (before) and the append LS (after).
  const progress = await prisma.scenarioProgress.create({
    data: {
      salesOrderId: so.id, scenarioKey: 'llm-planned', state: 'ready', classifierOutput: '{}',
      generatedSteps: JSON.stringify([{ kind: 'email_modified_ls_to_plant', rationale: 'test' }]),
      stopAfterIndex: 0, currentStepIndex: 0,
      createdAt: new Date('2026-06-21T10:05:00Z'),
    },
  });

  // The ZLOAD2 work row for the revised LS (this scenario), carrying its ls_number.
  await prisma.workQueue.create({
    data: {
      salesOrderId: so.id, step: 'zload2', state: 'done', createdAt: new Date('2026-06-21T10:06:00Z'),
      payload: JSON.stringify({ transaction_code: 'ZLOAD2', meta: { ls_number: EXIST_LS } }),
    },
  });

  // The ZLOAD1-APPEND's NEW LS — created AFTER the scenario started.
  const append = await prisma.loadingSlip.create({
    data: {
      salesOrderId: so.id, lsNumber: APPEND_LS, bundleId: bundle.id, plantEmail: 'plantA@example.com',
      fileUrl: `ls-files/${SO_NUMBER}/${APPEND_LS}.pdf`, status: 'pending',
      createdAt: new Date('2026-06-21T10:10:00Z'),
    },
  });
  await prisma.loadingSlipItem.create({
    data: { salesOrderId: so.id, loadingSlipId: append.id, lsNumber: APPEND_LS, material: 'YAFPLNA00000043P', batch: 'LD-01', orderQuantity: 20 },
  });

  try {
    await executeScenario({ salesOrderId: so.id, log: (m) => ENGINE_LOG.push(m) });
    const line = forwardingLine();

    if (line.includes(EXIST_LS))
      pass('plant notification includes the ZLOAD2-revised LS');
    else fail(`revised LS ${EXIST_LS} not in the forwarded set; line="${line}"`);

    if (line.includes(APPEND_LS))
      pass('plant notification includes the ZLOAD1-APPEND new LS');
    else fail(`appended LS ${APPEND_LS} not in the forwarded set (the bug); line="${line}"`);
  } finally {
    await prisma.scenarioEvent.deleteMany({ where: { salesOrderId: so.id } });
    await prisma.scenarioProgress.deleteMany({ where: { salesOrderId: so.id } });
    await prisma.workQueue.deleteMany({ where: { salesOrderId: so.id } });
    await prisma.loadingSlipItem.deleteMany({ where: { salesOrderId: so.id } });
    await prisma.loadingSlip.deleteMany({ where: { salesOrderId: so.id } });
    await prisma.email.deleteMany({ where: { purchaseOrderId: po.id } });
    await prisma.bundle.deleteMany({ where: { purchaseOrderId: po.id } });
    await prisma.salesOrder.deleteMany({ where: { id: so.id } });
    await prisma.purchaseOrder.deleteMany({ where: { id: po.id } });
    await prisma.$disconnect();
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
