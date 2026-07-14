/**
 * Focused regression test for the LS-created "preserve" overflow → NEW BUNDLE
 * mechanic.
 *
 * Covers:
 *   1. assessPostLsIncrease with overflowMode='new_bundle' packs the residual
 *      that doesn't fit existing bundles into one (or more) new_bundle
 *      allocation legs, verdict='allocated_with_new_bundle', overflowKg=0.
 *   2. The SAME scenario with overflowMode='new_so' (default) instead yields a
 *      partial_overflow verdict with overflowKg>0 (the existing behavior).
 *   3. createSingleBundleForPo creates bundle N+1 without disturbing existing
 *      bundles, and links nothing on its own.
 *
 *   npx tsx scripts/test-new-bundle-overflow.ts
 *
 * Exits 0 on pass, 1 on fail. Cleans up its own fixtures.
 */

import { prisma } from '../src/lib/prisma';
import { assessPostLsIncrease } from '../src/lib/bundle-capacity';
import { createSingleBundleForPo as createSingleBundleFromBundler } from '../src/lib/bundler';

const RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';
const pass = (m: string) => console.log(`${GREEN}✓ PASS${RESET} ${m}`);
const fail = (m: string) => { console.error(`${RED}✗ FAIL${RESET} ${m}`); failed = true; };
let failed = false;

const PO_NUMBER = `NBOVF-TEST-${Math.floor(Date.now() % 1e9)}`;
const MATERIAL = 'YV7NBOVF000000PJP';

async function main() {
  // 1 vehicle = 10 t capacity. One existing bundle already holds 9 t of MATERIAL
  // (1 t headroom). Ask to add 5 t → 1 t fits the existing bundle, 4 t residual.
  //   new_so mode   → partial_overflow, overflowKg≈4000
  //   new_bundle    → allocated_with_new_bundle, one new_bundle leg of ≈4000 kg
  const po = await prisma.purchaseOrder.create({
    data: { poNumber: PO_NUMBER, customerName: 'NB Overflow Co', weightage: 10 },
  });
  const so = await prisma.salesOrder.create({
    data: { soNumber: `${Math.floor(Date.now() % 1e7)}`, purchaseOrderId: po.id, plant: '1101' },
  });
  // Existing bundle at 9 t.
  const bundle1 = await prisma.bundle.create({
    data: { purchaseOrderId: po.id, bundleNumber: 1, totalWeightKg: 9000 },
  });
  // Material row carrying MATERIAL on bundle1. orderWeightKg/orderQuantity set so
  // kg↔unit conversion is 1 kg/unit for simple arithmetic.
  await prisma.material.create({
    data: {
      salesOrderId: so.id,
      material: MATERIAL,
      materialDescription: 'NB Overflow Mat',
      batch: 'B1',
      orderQuantity: 9000,
      orderWeightKg: 9000,
      availableStock: 100000,
      dispatchQuantity: 9000,
      bundleId: bundle1.id,
    },
  });
  // A loading slip on bundle1 so the SO counts as "LS exists".
  await prisma.loadingSlip.create({
    data: { salesOrderId: so.id, lsNumber: `LS-NB-${Math.floor(Date.now() % 1e7)}`, bundleId: bundle1.id, plantEmail: 'plant@example.com', status: 'pending' },
  });

  try {
    // --- Case 1: new_bundle mode ---
    const nb = await assessPostLsIncrease({
      salesOrderId: so.id,
      items: [{ material: MATERIAL, deltaKg: 5000 }],
      overflowMode: 'new_bundle',
    });
    const v1 = nb.verdicts[0];
    if (!v1) {
      fail('new_bundle: no verdict produced');
    } else {
      if (v1.verdict === 'allocated_with_new_bundle') pass('new_bundle: verdict is allocated_with_new_bundle');
      else fail(`new_bundle: expected allocated_with_new_bundle, got ${v1.verdict}`);
      if (v1.overflowKg === 0) pass('new_bundle: overflowKg is 0 (nothing sent to new SO)');
      else fail(`new_bundle: expected overflowKg 0, got ${v1.overflowKg}`);
      const newLegs = v1.allocations.filter((a) => a.kind === 'new_bundle');
      const newKg = newLegs.reduce((s, a) => s + a.kg, 0);
      if (newLegs.length >= 1 && Math.abs(newKg - 4000) < 1) pass(`new_bundle: ${newLegs.length} new_bundle leg(s) totaling ${Math.round(newKg)} kg`);
      else fail(`new_bundle: expected new_bundle leg(s) totaling ~4000 kg, got ${Math.round(newKg)} across ${newLegs.length} leg(s)`);
      const sameLeg = v1.allocations.find((a) => a.kind === 'same_bundle');
      if (sameLeg && Math.abs(sameLeg.kg - 1000) < 1) pass('new_bundle: same_bundle leg packed the 1 t headroom first');
      else fail(`new_bundle: expected same_bundle leg ~1000 kg, got ${sameLeg ? Math.round(sameLeg.kg) : 'none'}`);
    }

    // --- Case 2: new_so mode (default) — same scenario, different resolution ---
    const ns = await assessPostLsIncrease({
      salesOrderId: so.id,
      items: [{ material: MATERIAL, deltaKg: 5000 }],
      overflowMode: 'new_so',
    });
    const v2 = ns.verdicts[0];
    if (!v2) {
      fail('new_so: no verdict produced');
    } else {
      if (v2.verdict === 'partial_overflow') pass('new_so: verdict is partial_overflow (existing behavior preserved)');
      else fail(`new_so: expected partial_overflow, got ${v2.verdict}`);
      if (Math.abs((v2.overflowKg ?? 0) - 4000) < 1) pass(`new_so: overflowKg ≈ 4000 (${Math.round(v2.overflowKg ?? 0)})`);
      else fail(`new_so: expected overflowKg ~4000, got ${Math.round(v2.overflowKg ?? 0)}`);
      if (!v2.allocations.some((a) => a.kind === 'new_bundle')) pass('new_so: no new_bundle legs (default mode)');
      else fail('new_so: unexpected new_bundle leg in default mode');
    }

    // --- Case 3: createSingleBundleForPo ---
    const created = await createSingleBundleFromBundler(po.id);
    if (created.bundleNumber === 2) pass('createSingleBundleForPo: numbered bundle 2 (max+1)');
    else fail(`createSingleBundleForPo: expected bundleNumber 2, got ${created.bundleNumber}`);
    const bundleCount = await prisma.bundle.count({ where: { purchaseOrderId: po.id } });
    if (bundleCount === 2) pass('createSingleBundleForPo: existing bundle untouched (2 total)');
    else fail(`createSingleBundleForPo: expected 2 bundles, got ${bundleCount}`);
    const b1Still = await prisma.bundle.findUnique({ where: { id: bundle1.id } });
    if (b1Still && Number(b1Still.totalWeightKg) === 9000) pass('createSingleBundleForPo: bundle 1 weight unchanged (9000)');
    else fail(`createSingleBundleForPo: bundle 1 weight changed to ${b1Still ? Number(b1Still.totalWeightKg) : 'missing'}`);
  } finally {
    await prisma.loadingSlip.deleteMany({ where: { salesOrderId: so.id } });
    await prisma.material.deleteMany({ where: { salesOrderId: so.id } });
    await prisma.bundle.deleteMany({ where: { purchaseOrderId: po.id } });
    await prisma.salesOrder.delete({ where: { id: so.id } });
    await prisma.purchaseOrder.delete({ where: { id: po.id } });
  }

  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
