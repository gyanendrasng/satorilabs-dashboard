/**
 * Database integrity invariants — run from CI / planner-tests teardown to
 * catch orphaned rows and stale rollups that would silently break the
 * post-plant-intimation modify flow.
 *
 * Invariants enforced (all violations are non-zero exit):
 *
 *   1. Zero orphan LoadingSlipItems: `loadingSlipId IS NULL`.
 *      Schema declares `LoadingSlipItem.loadingSlipId` with onDelete=SetNull,
 *      so orphans are physically possible. They must be transient.
 *
 *   2. Zero dangling Material.bundleId: every non-null Material.bundleId
 *      must point at an existing Bundle row. The FK has onDelete=SetNull,
 *      but in production the wipe path nullifies explicitly first; this
 *      check exists to catch any regression that violates that order.
 *
 *   3. Zero stale Bundle.totalWeightKg: for every bundle that has Material
 *      rows linked, `Bundle.totalWeightKg` must match the live computation
 *      from Material weights (same formula the bundler uses on initial
 *      creation). The new post-plant flow uses this field as the authority
 *      for remaining truck capacity — silent drift would mis-route increases.
 *
 * Usage:
 *   DATABASE_URL='file:./test-e2e.db' npx tsx scripts/db-invariant-check.ts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface InvariantResult {
  name: string;
  passed: boolean;
  details: string[];
}

async function checkOrphanLsis(): Promise<InvariantResult> {
  const orphans = await prisma.loadingSlipItem.findMany({
    where: { loadingSlipId: null },
    select: { id: true, salesOrderId: true, lsNumber: true, material: true, batch: true },
  });
  const details = orphans.map(
    (o) => `LSI ${o.id} on SO ${o.salesOrderId} (lsNumber=${o.lsNumber}, material=${o.material}, batch=${o.batch}) has loadingSlipId=NULL`,
  );
  return {
    name: 'No orphan LoadingSlipItems',
    passed: orphans.length === 0,
    details,
  };
}

async function checkDanglingMaterialBundleId(): Promise<InvariantResult> {
  const materials = await prisma.material.findMany({
    where: { bundleId: { not: null } },
    select: { id: true, bundleId: true, salesOrderId: true, material: true },
  });
  const bundleIds = new Set(materials.map((m) => m.bundleId!).filter(Boolean));
  const existing = await prisma.bundle.findMany({
    where: { id: { in: Array.from(bundleIds) } },
    select: { id: true },
  });
  const existingSet = new Set(existing.map((b) => b.id));
  const dangling = materials.filter((m) => !existingSet.has(m.bundleId!));
  const details = dangling.map(
    (m) => `Material ${m.id} on SO ${m.salesOrderId} (${m.material}) points at missing Bundle ${m.bundleId}`,
  );
  return {
    name: 'No dangling Material.bundleId',
    passed: dangling.length === 0,
    details,
  };
}

async function checkStaleBundleWeights(): Promise<InvariantResult> {
  const bundles = await prisma.bundle.findMany({
    select: {
      id: true,
      bundleNumber: true,
      purchaseOrderId: true,
      totalWeightKg: true,
      materials: {
        select: {
          dispatchQuantity: true,
          orderQuantity: true,
          orderWeightKg: true,
        },
      },
    },
  });
  const drifts: string[] = [];
  for (const b of bundles) {
    if (b.materials.length === 0) continue; // pre-ZLOAD1 — leave bundler's value alone
    let live = 0;
    for (const m of b.materials) {
      const dispatchQty = m.dispatchQuantity ?? 0;
      const orderedQty = m.orderQuantity || 0;
      const fullWeight = m.orderWeightKg ? Number(m.orderWeightKg) : 0;
      if (orderedQty > 0 && dispatchQty > 0 && fullWeight > 0) {
        live += (dispatchQty / orderedQty) * fullWeight;
      }
    }
    const stored = Number(b.totalWeightKg);
    if (Math.abs(stored - live) >= 0.5) {
      drifts.push(
        `Bundle ${b.id} (PO ${b.purchaseOrderId}, bundle ${b.bundleNumber}): stored=${stored.toFixed(2)} kg, live=${live.toFixed(2)} kg, drift=${(stored - live).toFixed(2)} kg`,
      );
    }
  }
  return {
    name: 'Bundle.totalWeightKg matches Material rollup',
    passed: drifts.length === 0,
    details: drifts,
  };
}

async function main(): Promise<void> {
  const results: InvariantResult[] = [];
  results.push(await checkOrphanLsis());
  results.push(await checkDanglingMaterialBundleId());
  results.push(await checkStaleBundleWeights());

  const passed = results.filter((r) => r.passed).length;
  console.log(`DB invariants: ${passed}/${results.length} passed`);
  for (const r of results) {
    console.log(`  ${r.passed ? '✓' : '✗'} ${r.name}`);
    if (!r.passed) {
      for (const d of r.details) {
        console.log(`      - ${d}`);
      }
    }
  }

  await prisma.$disconnect();
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error('FATAL:', err);
  prisma.$disconnect().finally(() => process.exit(2));
});
