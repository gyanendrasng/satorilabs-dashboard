import { prisma } from './prisma';

/**
 * Compute capacity-based bundles for all LoadingSlipItems of a PurchaseOrder.
 *
 * Algorithm:
 *  1. Collect every LSI in the PO that has a `fileUrl` (i.e. ZLOAD1 has run
 *     and the LS file is in R2).
 *  2. For each LSI, compute its weight from the matching Material rows
 *     (same SO + same material code; sum across batches).
 *     weight_kg = sum( (dispatchQuantity ?? orderQuantity) / orderQuantity * orderWeightKg )
 *  3. Greedy first-fit-decreasing pack: sort LSIs by weight desc, drop each
 *     into the first bundle with enough remaining capacity, else open a new
 *     bundle. Capacity = customer.weightage * 1000 kg (default 31000).
 *  4. Persist Bundle rows + set LoadingSlipItem.bundleId.
 *
 * Bundles can mix LSIs from different SOs within the same PO (per the
 * bundling diagram).
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

  // Idempotency: clear stale bundle assignments + delete unused bundles.
  await prisma.loadingSlipItem.updateMany({
    where: { salesOrder: { purchaseOrderId }, bundleId: { not: null } },
    data: { bundleId: null },
  });
  await prisma.bundle.deleteMany({ where: { purchaseOrderId } });

  // 1. Collect LSIs that have a file (ZLOAD1 done) for this PO.
  const lsis = await prisma.loadingSlipItem.findMany({
    where: {
      salesOrder: { purchaseOrderId },
      fileUrl: { not: null },
    },
    include: {
      salesOrder: {
        include: {
          materials: true,
        },
      },
    },
  });

  if (lsis.length === 0) {
    return { bundleCount: 0, totalKg: 0, capacityKg };
  }

  // 2. Compute weight per LSI from Material rows.
  type WeightedLsi = { id: string; weightKg: number };
  const weighted: WeightedLsi[] = lsis.map((lsi) => {
    let weightKg = 0;
    const matching = lsi.salesOrder.materials.filter((m) => m.material === lsi.material);
    for (const m of matching) {
      const orderedQty = m.orderQuantity || 0;
      const dispatchQty = m.dispatchQuantity ?? orderedQty;
      const fullWeight = m.orderWeightKg ? Number(m.orderWeightKg) : 0;
      if (orderedQty > 0 && dispatchQty > 0) {
        weightKg += (dispatchQty / orderedQty) * fullWeight;
      }
    }
    return { id: lsi.id, weightKg };
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
      // New bundle. If a single LSI exceeds capacity, the bundle still gets
      // it (operator/SAP will need to handle the over-cap row separately;
      // we don't split LSIs).
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
    await prisma.loadingSlipItem.updateMany({
      where: { id: { in: bin.itemIds } },
      data: { bundleId: bundle.id },
    });
  }

  return { bundleCount: bins.length, totalKg, capacityKg };
}

/**
 * Have all SOs in this PO finished ZLOAD1?
 * (Each SO's LSIs are created by the /zload1-data callback, so once every
 * SO has at least one LSI with a fileUrl, ZLOAD1 has landed for the PO.)
 */
export async function isPoZload1Complete(purchaseOrderId: string): Promise<boolean> {
  const sos = await prisma.salesOrder.findMany({
    where: { purchaseOrderId },
    include: {
      _count: {
        select: { items: { where: { fileUrl: { not: null } } } },
      },
    },
  });
  if (sos.length === 0) return false;
  return sos.every((so) => so._count.items > 0);
}
