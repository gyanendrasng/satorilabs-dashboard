/**
 * Regression test for the dispatch_confirmation (upcoming-changes) email body
 * produced by sendDispatchConfirmationWithUpcomingChanges in auto-gui-trigger.ts.
 *
 *   DATABASE_URL="file:/tmp/x.db" npx prisma db push --skip-generate \
 *     && DATABASE_URL="file:/tmp/x.db" npx tsx scripts/test-dispatch-confirm-render.ts
 *
 * Reproduces the prod email where a surgical increase 200→210 rendered:
 *   - diff line "200 → 211"   (off-by-one from a stale kgPerUnit = 1900/210)
 *   - bundle line "200 units, 1.810 t"  (dispatchQuantity never bumped; weight
 *     computed as (200/210)*1900)
 *
 * After the fix (VA02 keeps orderQuantity / orderWeightKg / dispatchQuantity on
 * one basis, and the diff sources CURRENT from the LSI and PROPOSED from
 * orderQuantity) the email must show "200 → 210" and "210 units, 1.995 t".
 *
 * Captures the outbound email body via the e2e-shared Gmail require-hook stub
 * (RECORDED_EMAILS) — no real Gmail. Exits 0/1; cleans up its fixtures.
 */

// e2e-shared reads these at import time; set before importing it.
process.env.DASHBOARD_URL = process.env.DASHBOARD_URL || 'http://localhost:3001';
process.env.BRANCH_EMAIL = process.env.BRANCH_EMAIL || 'test-branch@example.com';
process.env.PLANT_EMAIL = process.env.PLANT_EMAIL || 'test-plant@example.com';

import { RECORDED_EMAILS } from './e2e-shared'; // installs the Gmail/S3 require-hooks
import { prisma } from '../src/lib/prisma';
import { sendDispatchConfirmationWithUpcomingChanges } from '../src/lib/auto-gui-trigger';

const RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';
let failed = false;
const pass = (m: string) => console.log(`${GREEN}✓ PASS${RESET} ${m}`);
const fail = (m: string) => { console.error(`${RED}✗ FAIL${RESET} ${m}`); failed = true; };

const PO_NUMBER = `DCR-TEST-${Math.floor(Date.now() % 1e9)}`;
const SO_NUMBER = `${Math.floor(Date.now() % 1e7)}`;
const TARGET = 'YO00000530000SOP';
const TARGET_DESC = 'OOWJ 108X108-80 MANGO YELLOW GL UNREC- P';

async function main() {
  const po = await prisma.purchaseOrder.create({
    data: { poNumber: PO_NUMBER, customerName: 'Render Test Co', weightage: 12 },
  });
  const so = await prisma.salesOrder.create({
    data: { soNumber: SO_NUMBER, purchaseOrderId: po.id, plant: '1101', visibilityState: 'received' },
  });
  // Post-VA02 surgical-increase state (what the engine leaves after Fix A1):
  //   orderQuantity=210, orderWeightKg=1995 (210×9.5), dispatchQuantity=210.
  // Bundle totalWeightKg reflects the dispatched 210 units (1995 kg).
  const bundle = await prisma.bundle.create({
    data: { purchaseOrderId: po.id, bundleNumber: 1, totalWeightKg: 1995 },
  });
  await prisma.material.create({
    data: {
      salesOrderId: so.id, material: TARGET, materialDescription: TARGET_DESC,
      batch: 'P', orderQuantity: 210, orderWeightKg: 1995, availableStock: 99999,
      dispatchQuantity: 210, bundleId: bundle.id,
    },
  });
  // The LS/LSI still holds the PHYSICAL pre-ZLOAD2 qty of 200 (the change hasn't
  // been applied to the slip yet at confirmation time).
  const lsNumber = `LS-DCR-${Math.floor(Date.now() % 1e7)}`;
  const ls = await prisma.loadingSlip.create({
    data: { salesOrderId: so.id, lsNumber, bundleId: bundle.id, plantEmail: 'p@example.com', status: 'pending' },
  });
  await prisma.loadingSlipItem.create({
    data: { salesOrderId: so.id, material: TARGET, batch: 'P', orderQuantity: 200, loadingSlipId: ls.id, lsNumber },
  });

  try {
    RECORDED_EMAILS.length = 0;
    await sendDispatchConfirmationWithUpcomingChanges({
      purchaseOrderId: po.id,
      salesOrderId: so.id,
      // same_bundle allocation for the +10 units (95 kg) — what the assessment
      // verdict carries.
      allocations: [{ material: TARGET, kind: 'same_bundle', bundleId: bundle.id, kg: 95 }],
      overflowItems: [],
      log: () => {},
    });

    const sent = RECORDED_EMAILS.find((e) => /sendPlainEmail|sendReplyEmail/.test(e.fn));
    if (!sent) { fail('no dispatch_confirmation email captured'); throw new Error('no email'); }
    const body: string = (sent.args[2] as string) ?? '';

    // Diff line: must be "200 → 210", never "200 → 211".
    if (body.includes('200 → 210 units')) pass('diff line shows "200 → 210 units"');
    else fail(`diff line wrong — expected "200 → 210 units" in body:\n${body}`);
    if (body.includes('→ 211')) fail('diff line still shows the off-by-one "211"');
    else pass('diff line has no off-by-one "211"');

    // Bundle line: proposed dispatch must be "210 units, 1.995 t", not "200 … 1.810 t".
    if (body.includes(`${TARGET} (Batch P): 210 units, 1.995 t`)) pass('bundle line shows "210 units, 1.995 t"');
    else fail(`bundle line wrong — expected "210 units, 1.995 t" in body:\n${body}`);
    if (body.includes('200 units, 1.810 t')) fail('bundle line still shows stale "200 units, 1.810 t"');
    else pass('bundle line has no stale "200 units / 1.810 t"');
  } finally {
    await prisma.loadingSlipItem.deleteMany({ where: { salesOrderId: so.id } });
    await prisma.loadingSlip.deleteMany({ where: { salesOrderId: so.id } });
    await prisma.material.deleteMany({ where: { salesOrderId: so.id } });
    await prisma.bundle.deleteMany({ where: { purchaseOrderId: po.id } });
    await prisma.email.deleteMany({ where: { purchaseOrderId: po.id } });
    await prisma.salesOrder.deleteMany({ where: { id: so.id } });
    await prisma.purchaseOrder.deleteMany({ where: { id: po.id } });
    await prisma.$disconnect();
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
