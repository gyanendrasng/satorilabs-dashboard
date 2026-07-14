/**
 * bundle_capacity_assessment must credit the space a CONCURRENT decrease frees,
 * so an increase that would overflow at the current bundle weights fits once the
 * decrease is accounted for.
 *
 * Setup: capacity 20 t. Bundle 1 carries A (50 u × 100 kg = 5 t) and
 * B (100 u × 100 kg = 10 t) → 15 t used, 5 t free.
 *   - Increase A by 8 t (80 u):
 *       NO decrease   → only 5 t fits → partial_overflow (3 t over).
 *       decrease B→60 → frees 4 t (40 u × 100) → 9 t free → fully_allocated.
 *
 *   npx tsx scripts/test-capacity-decrease-frees-space.ts   (or: npm test)
 *
 * Exits 0/1; cleans up fixtures.
 */

import { prisma } from '../src/lib/prisma';
import { assessPostLsIncrease } from '../src/lib/bundle-capacity';

const RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';
let failed = false;
const pass = (m: string) => console.log(`${GREEN}✓ PASS${RESET} ${m}`);
const fail = (m: string) => { console.error(`${RED}✗ FAIL${RESET} ${m}`); failed = true; };

async function main() {
  const uniq = `${Date.now()}`;
  const po = await prisma.purchaseOrder.create({
    data: { poNumber: `CAP-${uniq}`, customerName: 'Cap Co', weightage: 20, dispatchRound: 1 },
  });
  const so = await prisma.salesOrder.create({
    data: { soNumber: `CAP-${uniq}`.slice(0, 18), purchaseOrderId: po.id, plant: '1101' },
  });
  const bundle = await prisma.bundle.create({
    data: { purchaseOrderId: po.id, bundleNumber: 1, totalWeightKg: 15000 },
  });
  const ls = await prisma.loadingSlip.create({
    data: { salesOrderId: so.id, bundleId: bundle.id, lsNumber: `LS-${uniq}`, plantEmail: 'plant@example.com' },
  });
  // Material rows: kgPerUnit = 100 for both (weight / qty).
  await prisma.material.create({
    data: { salesOrderId: so.id, material: 'A', batch: 'BA', orderQuantity: 50, dispatchQuantity: 50, orderWeightKg: 5000 },
  });
  await prisma.material.create({
    data: { salesOrderId: so.id, material: 'B', batch: 'BB', orderQuantity: 100, dispatchQuantity: 100, orderWeightKg: 10000 },
  });
  // LSIs on bundle 1 so findCurrentBundleForMaterial + LSI weight resolve.
  await prisma.loadingSlipItem.create({
    data: { salesOrderId: so.id, loadingSlipId: ls.id, lsNumber: ls.lsNumber, material: 'A', batch: 'BA', orderQuantity: 50 },
  });
  await prisma.loadingSlipItem.create({
    data: { salesOrderId: so.id, loadingSlipId: ls.id, lsNumber: ls.lsNumber, material: 'B', batch: 'BB', orderQuantity: 100 },
  });

  try {
    // No decrease → A overflows.
    const without = await assessPostLsIncrease({
      salesOrderId: so.id,
      items: [{ material: 'A', deltaKg: 8000 }],
      overflowMode: 'new_so',
    });
    const vA1 = without.verdicts.find((v) => v.material === 'A');
    if (vA1?.verdict === 'partial_overflow' && Math.round(vA1.overflowKg) === 3000)
      pass('without decrease: A partial_overflow, 3000 kg over');
    else fail(`without decrease: expected partial_overflow/3000, got ${vA1?.verdict}/${vA1?.overflowKg}`);

    // Decrease B 100→60 frees 4000 kg → A now fits.
    const withDec = await assessPostLsIncrease({
      salesOrderId: so.id,
      items: [{ material: 'A', deltaKg: 8000 }],
      overflowMode: 'new_so',
      decreases: [{ material: 'B', toQty: 60 }],
    });
    const vA2 = withDec.verdicts.find((v) => v.material === 'A');
    if (vA2?.verdict === 'fully_allocated' && vA2.overflowKg === 0)
      pass('with decrease B→60: A fully_allocated (freed space absorbed the increase)');
    else fail(`with decrease: expected fully_allocated/0, got ${vA2?.verdict}/${vA2?.overflowKg}`);
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
