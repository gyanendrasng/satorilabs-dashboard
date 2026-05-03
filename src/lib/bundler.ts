import { prisma } from './prisma';

export type BundlerInput = { id: string; material: string; weightKg: number };
export type BundlerBin = { bundleNumber: number; totalKg: number; itemIds: string[] };

/**
 * Pure two-phase bin-packer.
 *
 * Phase A — group rows by `material` code. If a group's total weight ≤ capacity,
 *           emit one chunk holding all of its row IDs. If a group's total > capacity,
 *           FFD-pack the group's rows into the minimum number of ≤ capacity chunks
 *           and emit them all (with an overflow log).
 *
 * Phase B — sort chunks by weight desc (tiebreak: material code asc for determinism)
 *           and FFD-pack chunks into bins of `capacityKg`.
 *
 * Constraint: rows sharing the same `material` code land in the same bundle unless
 * their combined weight exceeds capacity (then split across the minimum number of
 * bundles, best effort). Required so a single truck only has to pick a material
 * from one factory.
 */
export function packMaterialsIntoBundles(
  items: BundlerInput[],
  capacityKg: number,
  log: (msg: string) => void = () => {}
): BundlerBin[] {
  if (items.length === 0) return [];
  if (capacityKg <= 0) {
    throw new Error(`packMaterialsIntoBundles: capacityKg must be > 0 (got ${capacityKg})`);
  }

  // Phase A: per-material chunks.
  type Chunk = { material: string; itemIds: string[]; weightKg: number };

  const byCode = new Map<string, BundlerInput[]>();
  for (const m of items) {
    const arr = byCode.get(m.material);
    if (arr) arr.push(m);
    else byCode.set(m.material, [m]);
  }

  const chunks: Chunk[] = [];
  for (const [material, rows] of byCode) {
    const total = rows.reduce((s, r) => s + r.weightKg, 0);
    if (total <= capacityKg) {
      chunks.push({ material, itemIds: rows.map((r) => r.id), weightKg: total });
      continue;
    }

    // Overflow: FFD-pack rows of this material into ≤ capacity sub-chunks.
    rows.sort((a, b) => b.weightKg - a.weightKg);
    const sub: Chunk[] = [];
    for (const r of rows) {
      const fit = sub.find((c) => capacityKg - c.weightKg >= r.weightKg);
      if (fit) {
        fit.itemIds.push(r.id);
        fit.weightKg += r.weightKg;
      } else {
        sub.push({ material, itemIds: [r.id], weightKg: r.weightKg });
        if (r.weightKg > capacityKg) {
          log(
            `[Bundler] CRITICAL: single row ${r.id} (${material}) weighs ${(r.weightKg / 1000).toFixed(3)} t > capacity ${(capacityKg / 1000).toFixed(3)} t — placing alone in over-capacity bundle`
          );
        }
      }
    }
    log(
      `[Bundler] Material ${material} totals ${(total / 1000).toFixed(3)} t > capacity ${(capacityKg / 1000).toFixed(3)} t — splitting across ${sub.length} bundle(s)`
    );
    chunks.push(...sub);
  }

  // Phase B: FFD-pack chunks into bins.
  chunks.sort((a, b) => b.weightKg - a.weightKg || a.material.localeCompare(b.material));

  type BinSlot = { bundleNumber: number; remainingKg: number; itemIds: string[]; totalKg: number };
  const bins: BinSlot[] = [];

  for (const ch of chunks) {
    let placed = false;
    for (const bin of bins) {
      if (bin.remainingKg >= ch.weightKg) {
        bin.itemIds.push(...ch.itemIds);
        bin.remainingKg -= ch.weightKg;
        bin.totalKg += ch.weightKg;
        placed = true;
        break;
      }
    }
    if (!placed) {
      bins.push({
        bundleNumber: bins.length + 1,
        remainingKg: Math.max(0, capacityKg - ch.weightKg),
        itemIds: [...ch.itemIds],
        totalKg: ch.weightKg,
      });
    }
  }

  return bins.map((b) => ({
    bundleNumber: b.bundleNumber,
    totalKg: b.totalKg,
    itemIds: b.itemIds,
  }));
}

/**
 * Compute capacity-based bundles for a PurchaseOrder from its Material rows
 * (the branch-confirmed dispatch plan). Run AFTER the branch confirms the
 * dispatch — before ZLOAD1 fires — so the truck count is locked in before
 * any LS is created.
 *
 * Per-Material weight = (dispatchQuantity / orderQuantity) * orderWeightKg.
 * Capacity = Customer.weightage * 1000 kg (defaults to 31000 if missing or
 * non-positive). Bin packing delegated to `packMaterialsIntoBundles` —
 * material-grouping is enforced there.
 *
 * Idempotent — wipes existing Bundle rows and Material.bundleId for the PO
 * before recomputing. LSIs created later by /zload1-data inherit bundleId
 * from the matching Material.
 */
export async function computeBundlesForPo(purchaseOrderId: string): Promise<{
  bundleCount: number;
  totalKg: number;
  capacityKg: number;
}> {
  const po = await prisma.purchaseOrder.findUnique({
    where: { id: purchaseOrderId },
    include: { customer: true },
  });
  if (!po) throw new Error(`PurchaseOrder ${purchaseOrderId} not found`);

  const rawWeightage = po.customer?.weightage ? Number(po.customer.weightage) : 0;
  const weightageT = rawWeightage > 0 ? rawWeightage : 31;
  if (rawWeightage <= 0) {
    console.warn(
      `[Bundler] PO ${po.poNumber}: customer weightage missing/zero, defaulting to 31 t per truck`
    );
  }
  const capacityKg = weightageT * 1000;

  // Idempotency: detach Materials and LSIs from existing bundles, drop bundles.
  await prisma.material.updateMany({
    where: { salesOrder: { purchaseOrderId }, bundleId: { not: null } },
    data: { bundleId: null },
  });
  await prisma.loadingSlipItem.updateMany({
    where: { salesOrder: { purchaseOrderId }, bundleId: { not: null } },
    data: { bundleId: null },
  });
  await prisma.bundle.deleteMany({ where: { purchaseOrderId } });

  const materials = await prisma.material.findMany({
    where: {
      salesOrder: { purchaseOrderId },
      dispatchQuantity: { gt: 0 },
    },
  });

  if (materials.length === 0) {
    return { bundleCount: 0, totalKg: 0, capacityKg };
  }

  const weighted: BundlerInput[] = materials.map((m) => {
    const dispatchQty = m.dispatchQuantity!;
    const orderedQty = m.orderQuantity || 0;
    const fullWeight = m.orderWeightKg ? Number(m.orderWeightKg) : 0;
    const weightKg = orderedQty > 0 ? (dispatchQty / orderedQty) * fullWeight : 0;
    return { id: m.id, material: m.material, weightKg };
  });

  const totalKg = weighted.reduce((s, w) => s + w.weightKg, 0);

  const bins = packMaterialsIntoBundles(weighted, capacityKg, (msg) => console.warn(msg));

  for (const bin of bins) {
    const bundle = await prisma.bundle.create({
      data: {
        purchaseOrderId,
        bundleNumber: bin.bundleNumber,
        totalWeightKg: bin.totalKg,
      },
    });
    await prisma.material.updateMany({
      where: { id: { in: bin.itemIds } },
      data: { bundleId: bundle.id },
    });
  }

  return { bundleCount: bins.length, totalKg, capacityKg };
}

/**
 * After ZLOAD1 lands and a LoadingSlipItem is created, copy the matching
 * Material.bundleId onto the LSI so downstream (vehicle details, plant
 * email, ZLOAD3-B1) can group LSIs by bundle.
 *
 * Match by salesOrderId + material code. With same-material grouping enforced
 * in `packMaterialsIntoBundles`, all candidate Materials should share the
 * same bundleId — the bundleNumber-asc sort below is now a defensive tie-
 * breaker. We log a warning if multiple distinct bundleIds appear (means
 * the invariant was violated, e.g. by an overflow split).
 */
export async function linkLsiToBundle(loadingSlipItemId: string): Promise<void> {
  const lsi = await prisma.loadingSlipItem.findUnique({
    where: { id: loadingSlipItemId },
    select: { id: true, salesOrderId: true, material: true, bundleId: true },
  });
  if (!lsi || lsi.bundleId) return;

  const candidates = await prisma.material.findMany({
    where: {
      salesOrderId: lsi.salesOrderId,
      material: lsi.material,
      bundleId: { not: null },
    },
    include: { bundle: { select: { bundleNumber: true } } },
  });
  if (candidates.length === 0) return;

  const distinctBundles = new Set(candidates.map((c) => c.bundleId));
  if (distinctBundles.size > 1) {
    console.warn(
      `[Bundler] linkLsiToBundle: ${candidates.length} candidates for SO ${lsi.salesOrderId} / ${lsi.material} span ${distinctBundles.size} bundles — likely an overflow split. Picking smallest bundleNumber.`
    );
  }

  candidates.sort((a, b) => (a.bundle?.bundleNumber ?? 999) - (b.bundle?.bundleNumber ?? 999));
  const winner = candidates[0];
  if (!winner.bundleId) return;

  await prisma.loadingSlipItem.update({
    where: { id: loadingSlipItemId },
    data: { bundleId: winner.bundleId },
  });
}
