/**
 * Regression test for the SUB-FLOOR small-increase bug.
 *
 * Bug: assessPostLsIncrease rejected any allocation leg below MIN_ALLOCATION_KG
 * (100 kg) — including a small TOTAL increase that fit entirely in the bundle
 * the material already lived on. A 47.5 kg increase on a bundle with ~5 t of
 * headroom wrongly returned needs_new_so (0 kg placed, 47.5 kg overflow),
 * producing a bogus "an additional vehicle is needed" email to the branch.
 *
 * Repro mirrors prod SO 3382184 / material YO00000530000SOP:
 *   - 12 t capacity, target material's bundle at ~7.08 t (≈4.9 t headroom)
 *   - increase = 5 units × 9.5 kg = 47.5 kg
 *   - expected: fully_allocated, one same_bundle leg of 47.5 kg, overflow 0
 *
 *   npx tsx scripts/test-small-increase-allocation.ts
 *
 * Exits 0 on pass, 1 on fail. Cleans up its own fixtures.
 */

import { prisma } from '../src/lib/prisma';
import { assessPostLsIncrease } from '../src/lib/bundle-capacity';

const RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';
let failed = false;
const pass = (m: string) => console.log(`${GREEN}✓ PASS${RESET} ${m}`);
const fail = (m: string) => { console.error(`${RED}✗ FAIL${RESET} ${m}`); failed = true; };

const PO_NUMBER = `SMALLINC-TEST-${Math.floor(Date.now() % 1e9)}`;
const TARGET = 'YO00000530000SOP'; // 9.5 kg/unit
const FILLER = 'YFILLER0000000PJP';

async function main() {
  const po = await prisma.purchaseOrder.create({
    data: { poNumber: PO_NUMBER, customerName: 'Small Inc Co', weightage: 12 }, // 12 t
  });
  const so = await prisma.salesOrder.create({
    data: { soNumber: `${Math.floor(Date.now() % 1e7)}`, purchaseOrderId: po.id, plant: '1101' },
  });

  // Bundle holding the target material at 1900 kg (200 units × 9.5) plus filler
  // to reach ~7083 kg — i.e. ~4917 kg headroom against the 12 t truck. Mirrors
  // prod Bundle 3.
  const bundle = await prisma.bundle.create({
    data: { purchaseOrderId: po.id, bundleNumber: 1, totalWeightKg: 7083.2 },
  });
  await prisma.material.create({
    data: {
      salesOrderId: so.id, material: TARGET, materialDescription: 'Target',
      batch: 'B1', orderQuantity: 200, orderWeightKg: 1900, availableStock: 100000,
      dispatchQuantity: 200, bundleId: bundle.id,
    },
  });
  await prisma.material.create({
    data: {
      salesOrderId: so.id, material: FILLER, materialDescription: 'Filler',
      batch: 'B2', orderQuantity: 1000, orderWeightKg: 5183.2, availableStock: 100000,
      dispatchQuantity: 1000, bundleId: bundle.id,
    },
  });
  // A loading slip carrying the target so findCurrentBundleForMaterial resolves
  // via LSI → loadingSlip.bundleId (the prod resolution path).
  const lsNumber = `LS-SI-${Math.floor(Date.now() % 1e7)}`;
  const ls = await prisma.loadingSlip.create({
    data: { salesOrderId: so.id, lsNumber, bundleId: bundle.id, plantEmail: 'plant@example.com', status: 'pending' },
  });
  await prisma.loadingSlipItem.create({
    data: { salesOrderId: so.id, material: TARGET, batch: 'B1', orderQuantity: 200, loadingSlipId: ls.id, lsNumber },
  });

  try {
    // --- Case 1: the exact prod scenario, default (new_so) mode. ---
    const r = await assessPostLsIncrease({
      salesOrderId: so.id,
      items: [{ material: TARGET, deltaKg: 47.5 }],
    });
    const v = r.verdicts[0];
    if (v.verdict === 'fully_allocated' && v.overflowKg === 0
      && v.allocations.length === 1 && v.allocations[0].kind === 'same_bundle'
      && Math.abs(v.allocations[0].kg - 47.5) < 0.01) {
      pass('47.5 kg increase → fully_allocated, same_bundle 47.5 kg (new_so mode)');
    } else {
      fail(`47.5 kg increase → got ${v.verdict} overflow=${v.overflowKg} alloc=${JSON.stringify(v.allocations)}`);
    }

    // --- Case 2: same tiny increase, preserve (new_bundle) mode → still same_bundle, no new vehicle. ---
    const r2 = await assessPostLsIncrease({
      salesOrderId: so.id,
      items: [{ material: TARGET, deltaKg: 47.5 }],
      overflowMode: 'new_bundle',
    });
    const v2 = r2.verdicts[0];
    if (v2.verdict === 'fully_allocated'
      && v2.allocations.length === 1 && v2.allocations[0].kind === 'same_bundle'
      && !v2.allocations.some((a) => a.kind === 'new_bundle')) {
      pass('47.5 kg increase (preserve mode) → same_bundle, NO new vehicle');
    } else {
      fail(`47.5 kg increase (preserve) → got ${v2.verdict} alloc=${JSON.stringify(v2.allocations)}`);
    }

    // --- Case 3: a genuinely too-big increase still overflows correctly. ---
    // Headroom ≈4917 kg; ask for 6000 kg → 4917 same_bundle, 1083 overflow (new_so).
    const r3 = await assessPostLsIncrease({
      salesOrderId: so.id,
      items: [{ material: TARGET, deltaKg: 6000 }],
    });
    const v3 = r3.verdicts[0];
    if (v3.verdict === 'partial_overflow' && v3.overflowKg > 1000 && v3.overflowKg < 1200
      && v3.allocations.some((a) => a.kind === 'same_bundle')) {
      pass(`6000 kg increase → partial_overflow, overflow≈${Math.round(v3.overflowKg)} kg (floor still works)`);
    } else {
      fail(`6000 kg increase → got ${v3.verdict} overflow=${v3.overflowKg} alloc=${JSON.stringify(v3.allocations)}`);
    }
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
