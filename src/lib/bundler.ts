import { prisma } from './prisma';

/**
 * Compute capacity-based bundles for a PurchaseOrder from its Material rows
 * (the branch-confirmed dispatch plan). Run AFTER the branch confirms the
 * dispatch — before ZLOAD1 fires — so the truck count is locked in before
 * any LS is created.
 *
 * Algorithm:
 *  1. Pull all Material rows of all SOs in the PO with `dispatchQuantity > 0`
 *     (i.e. branch chose to send them).
 *  2. Per-Material weight = (dispatchQuantity / orderQuantity) * orderWeightKg.
 *  3. Greedy first-fit-decreasing: sort by weight desc, drop each into the
 *     first bundle with room, else open a new bundle. Capacity =
 *     Customer.weightage * 1000 kg (default 31000).
 *  4. Persist Bundle rows + set Material.bundleId.
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

  const capacityKg = (po.customer?.weightage ? Number(po.customer.weightage) : 31) * 1000;

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

  // 1. Material rows the branch confirmed for dispatch.
  const materials = await prisma.material.findMany({
    where: {
      salesOrder: { purchaseOrderId },
      dispatchQuantity: { gt: 0 },
    },
  });

  if (materials.length === 0) {
    return { bundleCount: 0, totalKg: 0, capacityKg };
  }

  // 2. Compute weight per Material.
  type WeightedMat = { id: string; weightKg: number };
  const weighted: WeightedMat[] = materials.map((m) => {
    const dispatchQty = m.dispatchQuantity!;
    const orderedQty = m.orderQuantity || 0;
    const fullWeight = m.orderWeightKg ? Number(m.orderWeightKg) : 0;
    const weightKg = orderedQty > 0 ? (dispatchQty / orderedQty) * fullWeight : 0;
    return { id: m.id, weightKg };
  });

  const totalKg = weighted.reduce((s, w) => s + w.weightKg, 0);

  // 3. Greedy first-fit-decreasing.
  weighted.sort((a, b) => b.weightKg - a.weightKg);

  type BinSlot = { bundleNumber: number; remainingKg: number; itemIds: string[]; totalKg: number };
  const bins: BinSlot[] = [];

  for (const w of weighted) {
    let placed = false;
    for (const bin of bins) {
      if (bin.remainingKg >= w.weightKg) {
        bin.itemIds.push(w.id);
        bin.remainingKg -= w.weightKg;
        bin.totalKg += w.weightKg;
        placed = true;
        break;
      }
    }
    if (!placed) {
      bins.push({
        bundleNumber: bins.length + 1,
        remainingKg: Math.max(0, capacityKg - w.weightKg),
        itemIds: [w.id],
        totalKg: w.weightKg,
      });
    }
  }

  // 4. Persist.
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
 * Match by salesOrderId + material code. If multiple Material rows match
 * (e.g. multi-batch for the same code) we pick the one whose bundle has
 * the smallest bundleNumber — deterministic and keeps things compact.
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

  candidates.sort((a, b) => (a.bundle?.bundleNumber ?? 999) - (b.bundle?.bundleNumber ?? 999));
  const winner = candidates[0];
  if (!winner.bundleId) return;

  await prisma.loadingSlipItem.update({
    where: { id: loadingSlipItemId },
    data: { bundleId: winner.bundleId },
  });
}
