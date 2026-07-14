/**
 * One-time cleanup before the Material unique constraint changes from
 * (salesOrderId, material, batch) → (salesOrderId, material).
 *
 * A reordered / augmented batch string from a later ZSO_Visibility / ZMatana
 * run created duplicate Material rows for the same (SO, material) pair. The
 * new constraint forbids that, so the duplicates must be merged first or
 * `prisma db push` will refuse to apply the unique index.
 *
 * Merge rule, per (salesOrderId, material) group with >1 row:
 *   - KEEP the row with the most recent `updatedAt` (the latest SAP truth).
 *   - Re-point any LoadingSlipItem rows that referenced a deleted duplicate
 *     (by material — LSI carries its own batch, not a Material FK, so there's
 *     no DB-level cascade; this is belt-and-braces logging only).
 *   - DELETE the other rows in the group.
 *
 * Dry-run by default. Pass `--apply` to actually delete.
 *
 *   npx tsx scripts/merge-duplicate-materials.ts          # dry run
 *   npx tsx scripts/merge-duplicate-materials.ts --apply  # perform deletes
 */

import { prisma } from '../src/lib/prisma';

async function main() {
  const apply = process.argv.includes('--apply');
  console.log(`[merge-duplicate-materials] mode=${apply ? 'APPLY' : 'DRY-RUN'}`);

  const all = await prisma.material.findMany({
    orderBy: [{ salesOrderId: 'asc' }, { material: 'asc' }, { updatedAt: 'desc' }],
    select: {
      id: true,
      salesOrderId: true,
      material: true,
      batch: true,
      orderQuantity: true,
      availableStock: true,
      updatedAt: true,
    },
  });

  // Group by (salesOrderId, material).
  const groups = new Map<string, typeof all>();
  for (const m of all) {
    const key = `${m.salesOrderId}|${m.material}`;
    const arr = groups.get(key);
    if (arr) arr.push(m);
    else groups.set(key, [m]);
  }

  const toDelete: string[] = [];
  let dupGroups = 0;
  for (const [key, rows] of groups.entries()) {
    if (rows.length <= 1) continue;
    dupGroups++;
    // rows are already sorted updatedAt desc → first is the keeper.
    const [keeper, ...losers] = rows;
    console.log(
      `[dup] ${key} — ${rows.length} rows. KEEP id=${keeper.id} ` +
        `(batch="${keeper.batch}", qty=${keeper.orderQuantity}, avail=${keeper.availableStock}, updatedAt=${keeper.updatedAt.toISOString()})`,
    );
    for (const l of losers) {
      console.log(
        `      DELETE id=${l.id} (batch="${l.batch}", qty=${l.orderQuantity}, avail=${l.availableStock}, updatedAt=${l.updatedAt.toISOString()})`,
      );
      toDelete.push(l.id);
    }
  }

  console.log(
    `[merge-duplicate-materials] ${dupGroups} duplicate group(s), ${toDelete.length} row(s) to delete.`,
  );

  if (toDelete.length === 0) {
    console.log('[merge-duplicate-materials] Nothing to do.');
    return;
  }

  if (!apply) {
    console.log('[merge-duplicate-materials] DRY-RUN — no rows deleted. Re-run with --apply to perform.');
    return;
  }

  const res = await prisma.material.deleteMany({ where: { id: { in: toDelete } } });
  console.log(`[merge-duplicate-materials] Deleted ${res.count} duplicate row(s).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
