/**
 * Regression test for the "2nd Release Confirmation" email's Changes diff
 * (sendSecondReleaseEmail in src/lib/scenario-engine.ts).
 *
 *   DATABASE_URL="file:/tmp/x.db" npx prisma db push --skip-generate \
 *     && DATABASE_URL="file:/tmp/x.db" npx tsx scripts/test-2nd-release-email.ts
 *
 * Bug: the Changes line "Increase <mat>: <was> → <new>" read `was` from
 * Material.dispatchQuantity. VA02 fires immediately BEFORE this email (Phase 2:
 * stock_precheck → va02 → email_2nd_release) and now bumps dispatchQuantity to
 * the NEW total (210) so the later bundle-confirmation line can render it. So
 * `was` became 210 and the email showed the no-op "210 → 210".
 *
 * Fix: source `was` from the loading-slip items (LSI), which still hold the
 * pre-increase qty (200) until ZLOAD2 runs in Phase 3.
 *
 * Mirrors prod SO 3382184: YO00000530000SOP increased 200 → 210, one LS
 * carrying 200, Material.dispatchQuantity already 210 post-VA02.
 *
 * Exits 0/1; cleans up its fixtures.
 */

process.env.DASHBOARD_URL = process.env.DASHBOARD_URL || 'http://localhost:3001';
process.env.BRANCH_EMAIL = process.env.BRANCH_EMAIL || 'test-branch@example.com';

import { RECORDED_EMAILS } from './e2e-shared'; // installs Gmail/S3 require-hooks
import { prisma } from '../src/lib/prisma';
import { sendSecondReleaseEmail } from '../src/lib/scenario-engine';

const RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';
let failed = false;
const pass = (m: string) => console.log(`${GREEN}✓ PASS${RESET} ${m}`);
const fail = (m: string) => { console.error(`${RED}✗ FAIL${RESET} ${m}`); failed = true; };

const PO_NUMBER = `2NDREL-TEST-${Math.floor(Date.now() % 1e9)}`;
const SO_NUMBER = `${Math.floor(Date.now() % 1e7)}`;
const TARGET = 'YO00000530000SOP';
const TARGET_DESC = 'OOWJ 108X108-80 MANGO YELLOW GL UNREC- P';

async function main() {
  const po = await prisma.purchaseOrder.create({
    data: { poNumber: PO_NUMBER, customerName: '2nd Release Co', weightage: 12 },
  });
  const so = await prisma.salesOrder.create({
    data: { soNumber: SO_NUMBER, purchaseOrderId: po.id, plant: '1101' },
  });
  const bundle = await prisma.bundle.create({
    data: { purchaseOrderId: po.id, bundleNumber: 1, totalWeightKg: 1900 },
  });
  // Post-VA02 state: orderQuantity & dispatchQuantity already at the new total
  // 210; the loading slip still carries the pre-change 200.
  await prisma.material.create({
    data: {
      salesOrderId: so.id, material: TARGET, materialDescription: TARGET_DESC,
      batch: 'P', orderQuantity: 210, orderWeightKg: 1995, availableStock: 200,
      dispatchQuantity: 210, bundleId: bundle.id,
    },
  });
  const ls = await prisma.loadingSlip.create({
    data: { salesOrderId: so.id, lsNumber: 'LS-2NDREL', bundleId: bundle.id, plantEmail: 'plantA@example.com', status: 'sent_to_plant' },
  });
  await prisma.loadingSlipItem.create({
    data: {
      salesOrderId: so.id, loadingSlipId: ls.id, lsNumber: 'LS-2NDREL',
      material: TARGET, batch: 'P', orderQuantity: 200,
    },
  });

  try {
    RECORDED_EMAILS.length = 0;
    await sendSecondReleaseEmail({
      salesOrderId: so.id,
      modifications: [{ material_code: TARGET, batch: 'P', operation: 'increase', quantity: 210 }],
      log: () => {},
    });

    const sent = RECORDED_EMAILS.find((e) => /sendPlainEmail|sendReplyEmail/.test(e.fn));
    const body = sent ? (sent.args[2] as string) : '';

    if (/Increase .*: *200 → 210/.test(body))
      pass('Changes line shows "200 → 210" (was sourced from the loading slip, not dispatchQuantity)');
    else fail(`Changes line wrong — expected "200 → 210"; body:\n${body}`);

    if (!/: *210 → 210/.test(body))
      pass('no no-op "210 → 210" line');
    else fail(`rendered the no-op "210 → 210" — wasQty came from dispatchQuantity:\n${body}`);
  } finally {
    await prisma.scenarioEvent.deleteMany({ where: { salesOrderId: so.id } });
    await prisma.email.deleteMany({ where: { purchaseOrderId: po.id } });
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
