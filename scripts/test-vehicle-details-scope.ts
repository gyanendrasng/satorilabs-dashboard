/**
 * Regression test for the vehicle-details email being scoped to bundles that
 * still LACK vehicle details (src/lib/auto-gui-trigger.ts —
 * sendCombinedVehicleDetailsEmailForPo).
 *
 *   DATABASE_URL="file:/tmp/x.db" npx prisma db push --skip-generate \
 *     && DATABASE_URL="file:/tmp/x.db" npx tsx scripts/test-vehicle-details-scope.ts
 *
 * Bug: after a post-plant_ls append (ZLOAD1) onto an existing bundle, the
 * staleness guard saw a newer ZLOAD1 `done` row and re-sent the vehicle-details
 * email — re-asking the branch for transport it had already given. And it always
 * asked for ALL bundles.
 *
 * Fix: ask only for bundles WITHOUT vehicle details; if none lack them, skip
 * entirely; a brand-new vehicle/bundle is asked, and only that one.
 *
 * Exits 0/1; cleans up its fixtures.
 */

process.env.DASHBOARD_URL = process.env.DASHBOARD_URL || 'http://localhost:3001';
process.env.BRANCH_EMAIL = process.env.BRANCH_EMAIL || 'test-branch@example.com';

import { RECORDED_EMAILS } from './e2e-shared';
import { prisma } from '../src/lib/prisma';
import { sendCombinedVehicleDetailsEmailForPo } from '../src/lib/auto-gui-trigger';

const RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';
let failed = false;
const pass = (m: string) => console.log(`${GREEN}✓ PASS${RESET} ${m}`);
const fail = (m: string) => { console.error(`${RED}✗ FAIL${RESET} ${m}`); failed = true; };
const gid = () => `g-${Math.floor(Date.now() % 1e9)}-${Math.random().toString(36).slice(2, 8)}`;

const vehicleEmailBody = () => {
  const sent = RECORDED_EMAILS.find(
    (e) => /sendPlainEmail|sendReplyEmail/.test(e.fn) && String(e.args[1] ?? '').includes('Vehicle Details Required'),
  );
  return sent ? String(sent.args[2] ?? '') : null;
};

async function caseAllArranged() {
  const po = await prisma.purchaseOrder.create({
    data: { poNumber: `VDS-ALL-${Math.floor(Date.now() % 1e9)}`, customerName: 'VD Co', weightage: 12 },
  });
  const so = await prisma.salesOrder.create({
    data: { soNumber: `${Math.floor(Date.now() % 1e7)}`, purchaseOrderId: po.id, plant: '1101' },
  });
  // Both bundles already have vehicle details.
  await prisma.bundle.create({ data: { purchaseOrderId: po.id, bundleNumber: 1, totalWeightKg: 6000, vehicleNumber: 'MH-01-AA-1111' } });
  await prisma.bundle.create({ data: { purchaseOrderId: po.id, bundleNumber: 2, totalWeightKg: 6000, vehicleNumber: 'MH-02-BB-2222' } });
  // An existing vehicle_details email + a ZLOAD1 done AFTER it → trips the
  // staleness guard (which, pre-fix, would re-send).
  await prisma.email.create({
    data: {
      purchaseOrderId: po.id, salesOrderId: so.id, emailType: 'vehicle_details',
      gmailMessageId: gid(), gmailThreadId: gid(), recipientEmail: process.env.BRANCH_EMAIL!,
      subject: 'Vehicle Details Required', status: 'sent', sentAt: new Date('2026-06-21T10:00:00Z'),
    },
  });
  await prisma.workQueue.create({
    data: {
      salesOrderId: so.id, step: 'zload1', state: 'done',
      createdAt: new Date('2026-06-21T10:09:00Z'), finishedAt: new Date('2026-06-21T10:10:00Z'),
      payload: JSON.stringify({ transaction_code: 'ZLOAD1', meta: { append_to_bundle_id: 'x' } }),
    },
  });

  try {
    RECORDED_EMAILS.length = 0;
    const r = await sendCombinedVehicleDetailsEmailForPo(po.id);
    if (r.sent === false && vehicleEmailBody() === null)
      pass('all bundles already have vehicle details → NO re-ask (append did not trigger a re-send)');
    else fail(`expected skip, but sent=${r.sent}, emailBody=${vehicleEmailBody() ? 'present' : 'none'}`);
  } finally {
    await prisma.workQueue.deleteMany({ where: { salesOrderId: so.id } });
    await prisma.email.deleteMany({ where: { purchaseOrderId: po.id } });
    await prisma.bundle.deleteMany({ where: { purchaseOrderId: po.id } });
    await prisma.salesOrder.deleteMany({ where: { id: so.id } });
    await prisma.purchaseOrder.deleteMany({ where: { id: po.id } });
  }
}

async function caseNewVehicleOnly() {
  const po = await prisma.purchaseOrder.create({
    data: { poNumber: `VDS-NEW-${Math.floor(Date.now() % 1e9)}`, customerName: 'VD Co', weightage: 12 },
  });
  const so = await prisma.salesOrder.create({
    data: { soNumber: `${Math.floor((Date.now() + 1) % 1e7)}`, purchaseOrderId: po.id, plant: '1101' },
  });
  // Bundles 1 & 2 arranged; Bundle 3 is a brand-new vehicle with no details.
  await prisma.bundle.create({ data: { purchaseOrderId: po.id, bundleNumber: 1, totalWeightKg: 6000, vehicleNumber: 'MH-01-AA-1111' } });
  await prisma.bundle.create({ data: { purchaseOrderId: po.id, bundleNumber: 2, totalWeightKg: 6000, vehicleNumber: 'MH-02-BB-2222' } });
  const b3 = await prisma.bundle.create({ data: { purchaseOrderId: po.id, bundleNumber: 3, totalWeightKg: 2000 } });
  const ls = await prisma.loadingSlip.create({
    data: { salesOrderId: so.id, lsNumber: 'LS-NEW', bundleId: b3.id, plantEmail: 'p@example.com', status: 'pending' },
  });
  await prisma.loadingSlipItem.create({
    data: { salesOrderId: so.id, loadingSlipId: ls.id, lsNumber: 'LS-NEW', material: 'YAFPLNA00000043P', batch: 'LD-01', orderQuantity: 20 },
  });

  try {
    RECORDED_EMAILS.length = 0;
    const r = await sendCombinedVehicleDetailsEmailForPo(po.id);
    const body = vehicleEmailBody();
    if (r.sent && body) pass('new vehicle/bundle → vehicle-details email IS sent');
    else { fail(`expected a send for the new bundle; sent=${r.sent}`); return; }

    // Ask-lines must include ONLY Bundle 3, not the already-arranged 1 & 2.
    if (/Bundle 3: <Vehicle Number>/.test(body) && !/Bundle 1: <Vehicle Number>/.test(body) && !/Bundle 2: <Vehicle Number>/.test(body))
      pass('asks for ONLY the new Bundle 3 (not the already-arranged bundles)');
    else fail(`ask-lines not scoped to Bundle 3 only:\n${body}`);
  } finally {
    await prisma.loadingSlipItem.deleteMany({ where: { salesOrderId: so.id } });
    await prisma.loadingSlip.deleteMany({ where: { salesOrderId: so.id } });
    await prisma.email.deleteMany({ where: { purchaseOrderId: po.id } });
    await prisma.bundle.deleteMany({ where: { purchaseOrderId: po.id } });
    await prisma.salesOrder.deleteMany({ where: { id: so.id } });
    await prisma.purchaseOrder.deleteMany({ where: { id: po.id } });
  }
}

async function main() {
  try {
    await caseAllArranged();
    await caseNewVehicleOnly();
  } finally {
    await prisma.$disconnect();
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
