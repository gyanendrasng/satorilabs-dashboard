/**
 * Regression test for LSI-based bundle weight (src/lib/bundle-capacity.ts —
 * recomputeBundleWeight + recomputeBundleWeightsForSo).
 *
 *   DATABASE_URL="file:/tmp/x.db" npx prisma db push --skip-generate \
 *     && DATABASE_URL="file:/tmp/x.db" npx tsx scripts/test-bundle-weight-lsi.ts
 *
 * Bug: bundle weight was recomputed from Material rows. A Material row has ONE
 * bundleId, but after an `other_bundle` ZLOAD1-append a material is physically
 * SPLIT across two bundles (63 units on Bundle 1, 10 on Bundle 3). The Material
 * row stays linked to Bundle 1 at the full 73, so Bundle 1 was OVERSTATED (73
 * not 63) and Bundle 3 UNDERSTATED (the 10 invisible — no Material points at it),
 * corrupting Bundle.totalWeightKg, the capacity authority for the next assessment.
 *
 * Fix: recompute from the loading-slip items physically on each bundle
 * (LSI → LoadingSlip.bundleId), per-unit weight from the Material row.
 *
 * Fixture: kgPerUnit = 730/73 = 10. Material 73 linked to Bundle 1; LSI splits
 * 63 → Bundle 1, 10 → Bundle 3. Exits 0/1; cleans up its fixtures.
 */

import { prisma } from '../src/lib/prisma';
import { recomputeBundleWeight, recomputeBundleWeightsForSo } from '../src/lib/bundle-capacity';

const RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';
let failed = false;
const pass = (m: string) => console.log(`${GREEN}✓ PASS${RESET} ${m}`);
const fail = (m: string) => { console.error(`${RED}✗ FAIL${RESET} ${m}`); failed = true; };
const near = (a: number, b: number) => Math.abs(a - b) < 0.5;

const PO_NUMBER = `BWLSI-${Math.floor(Date.now() % 1e9)}`;
const SO_NUMBER = `${Math.floor(Date.now() % 1e7)}`;
const MAT = 'YH4PULMA00000Y7P';

const weightOf = async (bundleId: string) =>
  Number((await prisma.bundle.findUnique({ where: { id: bundleId }, select: { totalWeightKg: true } }))!.totalWeightKg);

async function main() {
  const po = await prisma.purchaseOrder.create({
    data: { poNumber: PO_NUMBER, customerName: 'Bundle Weight Co', weightage: 12 },
  });
  const so = await prisma.salesOrder.create({
    data: { soNumber: SO_NUMBER, purchaseOrderId: po.id, plant: '1101' },
  });
  // Bundle 1 seeded with the STALE Material-based value (73×10=730); Bundle 3 at 0.
  const b1 = await prisma.bundle.create({ data: { purchaseOrderId: po.id, bundleNumber: 1, totalWeightKg: 730 } });
  const b3 = await prisma.bundle.create({ data: { purchaseOrderId: po.id, bundleNumber: 3, totalWeightKg: 0 } });
  // One Material row (unique per SO+material), linked to Bundle 1, full 73 units.
  await prisma.material.create({
    data: {
      salesOrderId: so.id, material: MAT, batch: 'NO1',
      orderQuantity: 73, orderWeightKg: 730, dispatchQuantity: 73, bundleId: b1.id,
    },
  });
  // The material is physically SPLIT: 63 on Bundle 1's LS, 10 on Bundle 3's LS.
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
    data: { salesOrderId: so.id, loadingSlipId: ls3.id, lsNumber: 'LS-B3', material: MAT, batch: 'NO1', orderQuantity: 10 },
  });

  try {
    // Single-bundle recompute (the zload1-data / zload2-data callback path).
    await recomputeBundleWeight(b1.id);
    await recomputeBundleWeight(b3.id);
    const w1 = await weightOf(b1.id);
    const w3 = await weightOf(b3.id);

    if (near(w1, 630)) pass('Bundle 1 weight = 63×10 = 630 (physical LSI, not the full 73)');
    else fail(`Bundle 1 weight = ${w1}, expected 630 (Material-based bug gives 730)`);

    if (near(w3, 100)) pass('Bundle 3 weight = 10×10 = 100 (the appended split, now visible)');
    else fail(`Bundle 3 weight = ${w3}, expected 100 (Material-based bug leaves it 0)`);

    // Per-SO recompute must DISCOVER Bundle 3 via its LSI even though no Material
    // row points at it (only the LS does).
    await prisma.bundle.update({ where: { id: b3.id }, data: { totalWeightKg: 0 } });
    await recomputeBundleWeightsForSo(so.id);
    const w3b = await weightOf(b3.id);
    if (near(w3b, 100)) pass('recomputeBundleWeightsForSo reaches Bundle 3 via LSI (not just Material.bundleId)');
    else fail(`Bundle 3 weight after per-SO recompute = ${w3b}, expected 100`);
  } finally {
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
