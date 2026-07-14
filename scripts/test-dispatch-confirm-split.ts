/**
 * Regression test for the dispatch_confirmation listing when a material is SPLIT
 * across bundles by an `other_bundle` ZLOAD1-append
 * (sendDispatchConfirmationWithUpcomingChanges in src/lib/auto-gui-trigger.ts).
 *
 *   DATABASE_URL="file:/tmp/x.db" npx prisma db push --skip-generate \
 *     && DATABASE_URL="file:/tmp/x.db" npx tsx scripts/test-dispatch-confirm-split.ts
 *
 * Bug: the grouped per-bundle listing was read from Material rows. A Material row
 * has one bundleId, so an increased material (63 → 73) whose +10 spills to a
 * sibling bundle showed the FULL 73 on its original bundle and nothing on the
 * target — inconsistent with the email's own "+10 → Bundle 3" diff line.
 *
 * Fix: build the listing from the physical loading-slip items + the pending
 * allocations, so the split renders as 63 on Bundle 1 and 10 on Bundle 3.
 *
 * kgPerUnit = 730/73 = 10. Captures the body via the e2e-shared Gmail stub.
 * Exits 0/1; cleans up its fixtures.
 */

process.env.DASHBOARD_URL = process.env.DASHBOARD_URL || 'http://localhost:3001';
process.env.BRANCH_EMAIL = process.env.BRANCH_EMAIL || 'test-branch@example.com';
process.env.PLANT_EMAIL = process.env.PLANT_EMAIL || 'test-plant@example.com';

import { RECORDED_EMAILS } from './e2e-shared';
import { prisma } from '../src/lib/prisma';
import { sendDispatchConfirmationWithUpcomingChanges } from '../src/lib/auto-gui-trigger';

const RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';
let failed = false;
const pass = (m: string) => console.log(`${GREEN}✓ PASS${RESET} ${m}`);
const fail = (m: string) => { console.error(`${RED}✗ FAIL${RESET} ${m}`); failed = true; };

const PO_NUMBER = `DCSPLIT-${Math.floor(Date.now() % 1e9)}`;
const SO_NUMBER = `${Math.floor(Date.now() % 1e7)}`;
const MAT = 'YH4PULMA00000Y7P';      // the increased / split material
const MAT_DESC = 'OH4FJ 300X600-6 PULPIS MARPHIL PDR-P';
const FILL = 'YM00000900000UWP';     // a filler already on Bundle 3
const FILL_DESC = 'OMFJ 397X397-6 IVORY MTDGRE-P';

async function main() {
  const po = await prisma.purchaseOrder.create({
    data: { poNumber: PO_NUMBER, customerName: 'Split Listing Co', weightage: 12 },
  });
  const so = await prisma.salesOrder.create({
    data: { soNumber: SO_NUMBER, purchaseOrderId: po.id, plant: '1101', visibilityState: 'received' },
  });
  const b1 = await prisma.bundle.create({ data: { purchaseOrderId: po.id, bundleNumber: 1, totalWeightKg: 630 } });
  const b3 = await prisma.bundle.create({ data: { purchaseOrderId: po.id, bundleNumber: 3, totalWeightKg: 500 } });

  // Post-VA02: MAT increased to 73 on its SO line, still linked to Bundle 1.
  await prisma.material.create({
    data: {
      salesOrderId: so.id, material: MAT, materialDescription: MAT_DESC, batch: 'NO1',
      orderQuantity: 73, orderWeightKg: 730, dispatchQuantity: 73, bundleId: b1.id,
    },
  });
  // Filler material already living on Bundle 3.
  await prisma.material.create({
    data: {
      salesOrderId: so.id, material: FILL, materialDescription: FILL_DESC, batch: 'SZ-34',
      orderQuantity: 50, orderWeightKg: 500, dispatchQuantity: 50, bundleId: b3.id,
    },
  });

  // Physical loading slips: MAT 63 on Bundle 1 (the +10 hasn't been appended
  // yet), FILL 50 on Bundle 3.
  const ls1 = await prisma.loadingSlip.create({
    data: { salesOrderId: so.id, lsNumber: 'LS-B1', bundleId: b1.id, plantEmail: 'p@example.com', status: 'sent_to_plant' },
  });
  const ls3 = await prisma.loadingSlip.create({
    data: { salesOrderId: so.id, lsNumber: 'LS-B3', bundleId: b3.id, plantEmail: 'p@example.com', status: 'sent_to_plant' },
  });
  await prisma.loadingSlipItem.create({
    data: { salesOrderId: so.id, loadingSlipId: ls1.id, lsNumber: 'LS-B1', material: MAT, batch: 'NO1', orderQuantity: 63 },
  });
  await prisma.loadingSlipItem.create({
    data: { salesOrderId: so.id, loadingSlipId: ls3.id, lsNumber: 'LS-B3', material: FILL, batch: 'SZ-34', orderQuantity: 50 },
  });

  try {
    RECORDED_EMAILS.length = 0;
    await sendDispatchConfirmationWithUpcomingChanges({
      purchaseOrderId: po.id,
      salesOrderId: so.id,
      // +10 units (100 kg @ 10 kg/unit) spill to Bundle 3 as a new LS.
      allocations: [{ material: MAT, kind: 'other_bundle', bundleId: b3.id, kg: 100 }],
      overflowItems: [],
      log: () => {},
    });

    const sent = RECORDED_EMAILS.find((e) => /sendPlainEmail|sendReplyEmail/.test(e.fn));
    if (!sent) { fail('no dispatch_confirmation email captured'); throw new Error('no email'); }
    const body: string = (sent.args[2] as string) ?? '';

    // Bundle 1 keeps the physical 63 — NOT the full post-VA02 73.
    if (body.includes(`${MAT} (Batch NO1): 63 units`)) pass('Bundle 1 lists MAT at the physical 63 units');
    else fail(`expected "${MAT} (Batch NO1): 63 units" in body:\n${body}`);
    if (body.includes(`${MAT} (Batch NO1): 73 units`)) fail('Bundle 1 still shows the inflated 73 (Material-based listing)');
    else pass('Bundle 1 does NOT show the inflated 73');

    // Bundle 3 gains the appended 10 as its own line.
    if (body.includes(`${MAT} (Batch NO1): 10 units`)) pass('Bundle 3 lists the appended MAT at 10 units');
    else fail(`expected "${MAT} (Batch NO1): 10 units" (the spill) in body:\n${body}`);

    // The 10-units line must sit in the Bundle 3 section, after "Bundle 3".
    const b3Idx = body.indexOf('Bundle 3');
    const spillIdx = body.indexOf(`${MAT} (Batch NO1): 10 units`);
    if (b3Idx >= 0 && spillIdx > b3Idx) pass('the spilled MAT line is under the Bundle 3 section');
    else fail('the spilled MAT line is not placed under Bundle 3');

    // Diff block (already correct) must agree.
    if (/NEW LINE → 10 units in Bundle 3/.test(body)) pass('diff block shows "+ … NEW LINE → 10 units in Bundle 3"');
    else fail(`diff block missing the new-line entry:\n${body}`);
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
