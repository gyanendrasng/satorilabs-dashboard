/**
 * Post-plant-intimation capacity assessment.
 *
 * Once `LoadingSlip.status='sent_to_plant'`, bundles are FROZEN — composition
 * must not change. When the branch asks to increase or add a material, we
 * split the requested delta across the bundles greedily:
 *
 *   1. Pack the bundle that already carries the material to its remaining
 *      capacity (`same_bundle` allocation → ZLOAD2 on the existing LS).
 *   2. Spill whatever doesn't fit onto sibling bundles, best-fit by smallest
 *      sufficient remaining (`other_bundle` allocation → ZLOAD1 in append
 *      mode, creating a new LS on the target bundle).
 *   3. Whatever still can't be placed is overflow — branch is asked to raise
 *      a fresh SO for those kg.
 *
 * Each material's outcome is one of:
 *   - fully_allocated  → every kg of the delta was placed (allocations[]).
 *   - partial_overflow → some kg placed, some kg overflow (allocations[] + overflowKg > 0).
 *   - needs_new_so     → nothing placed; everything is overflow.
 *
 * The decision is pure arithmetic. The LLM planner consumes the per-item
 * verdict from the audit trail and emits the corresponding step path (see
 * Rule 6e Phase 2 in `llm-planner.ts`): one ZLOAD2 per same_bundle
 * allocation, one ZLOAD1-append per other_bundle allocation, one
 * email_modified_ls_to_plant, and one email_branch_request_new_so when
 * overflow > 0.
 *
 * `Bundle.totalWeightKg` is the source of truth here. It is live-maintained
 * by every LSI write site that changes weight (see `zload2-data/route.ts`).
 * As a belt-and-braces measure this helper also self-heals stale bundles
 * before returning a verdict — see `backfillStaleBundleWeights`.
 *
 * MIN_ALLOCATION_KG below filters out operationally-useless tiny slivers
 * (e.g. "place 30 kg on bundle X, the rest on bundle Y") — anything below
 * the threshold is treated as if that bundle had no headroom for this item.
 */

import { prisma } from './prisma';

/**
 * One leg of an allocation for a single material. The same material can have
 * multiple legs (one same_bundle + one other_bundle, or two other_bundles)
 * when the delta is split across bundles.
 */
export type Allocation =
  /** ZLOAD2 on the LS that already carries this material. */
  | { kind: 'same_bundle'; bundleId: string; kg: number }
  /** ZLOAD1-append: new LS on a sibling bundle that had headroom. */
  | { kind: 'other_bundle'; bundleId: string; kg: number };

export type CapacityVerdict =
  /** Every kg of the requested delta was placed. */
  | { material: string; verdict: 'fully_allocated'; allocations: Allocation[]; overflowKg: 0 }
  /** Some kg placed, some kg overflow — branch raises a new SO for the overflow. */
  | { material: string; verdict: 'partial_overflow'; allocations: Allocation[]; overflowKg: number }
  /** Nothing fit — branch raises a new SO for the whole delta. */
  | { material: string; verdict: 'needs_new_so'; allocations: []; overflowKg: number };

export interface AssessPostLsIncreaseArgs {
  salesOrderId: string;
  items: Array<{ material: string; deltaKg: number }>;
}

export interface AssessPostLsIncreaseResult {
  verdicts: CapacityVerdict[];
  /** PO id resolved from the SO; useful for callers that want to scope follow-on work. */
  purchaseOrderId: string;
  /** Truck capacity (kg) read from `PurchaseOrder.weightage * 1000`. */
  capacityKg: number;
}

/**
 * Smallest kg an individual allocation leg can represent. Anything below
 * this is operationally useless (a near-empty ZLOAD2 modification or a new
 * LS with a few kg on it) and is treated as if the bundle has no headroom.
 */
const MIN_ALLOCATION_KG = 100;

/**
 * Assess whether each requested delta fits within an existing bundle on the
 * SO's PO. Read-only; never mutates Bundle rows beyond the self-heal of
 * `totalWeightKg` for any bundle whose stored value disagrees with the live
 * sum across its LoadingSlipItems.
 */
export async function assessPostLsIncrease(
  args: AssessPostLsIncreaseArgs,
): Promise<AssessPostLsIncreaseResult> {
  const so = await prisma.salesOrder.findUnique({
    where: { id: args.salesOrderId },
    select: { purchaseOrderId: true, soNumber: true },
  });
  if (!so) {
    throw new Error(`assessPostLsIncrease: SalesOrder ${args.salesOrderId} not found`);
  }

  const po = await prisma.purchaseOrder.findUnique({
    where: { id: so.purchaseOrderId },
    select: { id: true, poNumber: true, weightage: true },
  });
  if (!po) {
    throw new Error(`assessPostLsIncrease: PurchaseOrder ${so.purchaseOrderId} not found`);
  }
  const tonnes = po.weightage ? Number(po.weightage) : 0;
  if (tonnes <= 0) {
    throw new Error(
      `assessPostLsIncrease: PO ${po.poNumber} has no vehicle tonnage — cannot compute capacity`,
    );
  }
  const capacityKg = tonnes * 1000;

  // Self-heal any stale Bundle.totalWeightKg rows so the per-bundle remaining
  // calculation below is honest. Cheap and idempotent.
  await backfillStaleBundleWeights(po.id);

  const bundles = await prisma.bundle.findMany({
    where: { purchaseOrderId: po.id },
    select: {
      id: true,
      bundleNumber: true,
      totalWeightKg: true,
      status: true,
    },
    orderBy: { bundleNumber: 'asc' },
  });

  const verdicts: CapacityVerdict[] = [];
  // Tentative in-memory weight per bundle so multiple items in one assessment
  // don't all double-book the same headroom. We commit nothing here — the
  // actual writes happen later via zload1/zload2 callbacks — but for
  // decision-making across N items we have to debit as we go.
  const tentativeWeightKg = new Map<string, number>();
  for (const b of bundles) {
    tentativeWeightKg.set(b.id, Number(b.totalWeightKg));
  }
  const dispatchedIds = new Set(bundles.filter((b) => b.status === 'dispatched').map((b) => b.id));

  for (const item of args.items) {
    const currentBundleId = await findCurrentBundleForMaterial({
      salesOrderId: args.salesOrderId,
      material: item.material,
    });

    const remainingFor = (bundleId: string): number => {
      if (dispatchedIds.has(bundleId)) return 0; // dispatched bundles are fully frozen
      const used = tentativeWeightKg.get(bundleId) ?? 0;
      return Math.max(0, capacityKg - used);
    };

    const debit = (bundleId: string, kg: number) => {
      tentativeWeightKg.set(bundleId, (tentativeWeightKg.get(bundleId) ?? 0) + kg);
    };

    const allocations: Allocation[] = [];
    let remaining = item.deltaKg;

    // Step 1 — pack the current bundle to its remaining capacity first. The
    // existing LS stays on the same bundle (no LSI migration); the extra
    // weight rides the same LS via a ZLOAD2 quantity bump.
    if (currentBundleId) {
      const headroom = remainingFor(currentBundleId);
      const take = Math.min(remaining, headroom);
      if (take >= MIN_ALLOCATION_KG) {
        allocations.push({ kind: 'same_bundle', bundleId: currentBundleId, kg: take });
        debit(currentBundleId, take);
        remaining -= take;
      }
    }

    // Step 2 — spill the residual onto sibling bundles. Best-fit by smallest
    // sufficient remaining, so we leave roomier bundles open for bigger
    // future asks. When no single bundle can absorb the whole residual, take
    // from the LARGEST available (pack the spill in the chunkiest leg first
    // — fewer fragmented LSs).
    while (remaining >= MIN_ALLOCATION_KG) {
      const candidates = bundles
        .filter((b) => b.id !== currentBundleId && !dispatchedIds.has(b.id))
        .map((b) => ({ id: b.id, remainingKg: remainingFor(b.id) }))
        .filter((c) => c.remainingKg >= MIN_ALLOCATION_KG);
      if (candidates.length === 0) break;

      // Prefer a bundle that can take the entire residual (smallest such).
      // Fall back to the bundle with the largest headroom otherwise.
      const sufficient = candidates
        .filter((c) => c.remainingKg >= remaining)
        .sort((a, b) => a.remainingKg - b.remainingKg);
      const pick = sufficient.length > 0
        ? sufficient[0]
        : candidates.sort((a, b) => b.remainingKg - a.remainingKg)[0];

      const take = Math.min(remaining, pick.remainingKg);
      allocations.push({ kind: 'other_bundle', bundleId: pick.id, kg: take });
      debit(pick.id, take);
      remaining -= take;
    }

    // Classify the outcome for this material.
    if (allocations.length === 0) {
      verdicts.push({
        material: item.material,
        verdict: 'needs_new_so',
        allocations: [],
        overflowKg: item.deltaKg,
      });
    } else if (remaining > 0) {
      verdicts.push({
        material: item.material,
        verdict: 'partial_overflow',
        allocations,
        overflowKg: remaining,
      });
    } else {
      verdicts.push({
        material: item.material,
        verdict: 'fully_allocated',
        allocations,
        overflowKg: 0,
      });
    }
  }

  return {
    verdicts,
    purchaseOrderId: po.id,
    capacityKg,
  };
}

/**
 * Returns the bundle that currently carries `material` for `salesOrderId`,
 * or null if the material isn't on any bundle yet. We resolve via LSI →
 * LoadingSlip.bundleId because that's authoritative once ZLOAD1 has run.
 * As a fallback we also check `Material.bundleId` (set by the bundler
 * pre-ZLOAD1).
 */
async function findCurrentBundleForMaterial(args: {
  salesOrderId: string;
  material: string;
}): Promise<string | null> {
  const lsi = await prisma.loadingSlipItem.findFirst({
    where: {
      salesOrderId: args.salesOrderId,
      material: args.material,
      loadingSlipId: { not: null },
    },
    select: { loadingSlip: { select: { bundleId: true } } },
  });
  if (lsi?.loadingSlip?.bundleId) return lsi.loadingSlip.bundleId;

  const m = await prisma.material.findFirst({
    where: { salesOrderId: args.salesOrderId, material: args.material },
    select: { bundleId: true },
  });
  return m?.bundleId ?? null;
}

/**
 * For every Bundle under the PO, compare stored `totalWeightKg` against the
 * live recomputation from `Material` rows linked to the bundle and persist
 * mismatches. Uses the same formula the bundler does on initial creation:
 *   weight = (dispatchQuantity / orderQuantity) * orderWeightKg
 * summed over every Material with `bundleId == bundle.id`. Cheap (one read
 * per PO + per-bundle update only on drift). Idempotent.
 *
 * Why this is needed: `Bundle.totalWeightKg` was historically set once at
 * bundle creation and never updated even when ZLOAD2 changed Material
 * quantities. The new post-plant flow uses this field as the authority for
 * remaining capacity, so we self-heal whenever the helper runs.
 */
async function backfillStaleBundleWeights(purchaseOrderId: string): Promise<void> {
  const bundles = await prisma.bundle.findMany({
    where: { purchaseOrderId },
    select: {
      id: true,
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
  for (const b of bundles) {
    if (b.materials.length === 0) continue; // pre-ZLOAD1 — leave bundler's value alone
    const liveKg = computeBundleWeightFromMaterials(b.materials);
    const stored = Number(b.totalWeightKg);
    if (Math.abs(stored - liveKg) < 0.5) continue; // < 500 g drift — call it equal
    await prisma.bundle.update({
      where: { id: b.id },
      data: { totalWeightKg: liveKg },
    });
    console.log(
      `[bundle-capacity] Self-healed Bundle ${b.id}.totalWeightKg: ${stored} → ${liveKg} kg`,
    );
  }
}

/**
 * Compute a bundle's live weight from its linked Material rows. Mirrors the
 * formula in bundler.ts `computeBundlesForPo` so the rollup stays consistent
 * with how the initial value was set.
 */
export function computeBundleWeightFromMaterials(
  materials: Array<{
    dispatchQuantity: number | null;
    orderQuantity: number;
    orderWeightKg: { toString(): string } | null;
  }>,
): number {
  let total = 0;
  for (const m of materials) {
    const dispatchQty = m.dispatchQuantity ?? 0;
    const orderedQty = m.orderQuantity || 0;
    const fullWeight = m.orderWeightKg ? Number(m.orderWeightKg) : 0;
    if (orderedQty > 0 && dispatchQty > 0 && fullWeight > 0) {
      total += (dispatchQty / orderedQty) * fullWeight;
    }
  }
  return total;
}

/**
 * Recompute and persist `Bundle.totalWeightKg` for every bundle that holds
 * any Material under `salesOrderId`. Call from every callback that mutates
 * Material rows on an SO (visibility-data, zmatana-data, etc.) so the
 * post-plant capacity assessment reads honest values. Idempotent.
 *
 * Returns the number of bundles touched (drift detected and updated).
 */
export async function recomputeBundleWeightsForSo(salesOrderId: string): Promise<number> {
  const bundleIds = await prisma.material.findMany({
    where: { salesOrderId, bundleId: { not: null } },
    select: { bundleId: true },
    distinct: ['bundleId'],
  });
  let touched = 0;
  for (const row of bundleIds) {
    if (!row.bundleId) continue;
    const before = await prisma.bundle.findUnique({
      where: { id: row.bundleId },
      select: { totalWeightKg: true },
    });
    await recomputeBundleWeight(row.bundleId);
    if (before) {
      const after = await prisma.bundle.findUnique({
        where: { id: row.bundleId },
        select: { totalWeightKg: true },
      });
      if (after && Math.abs(Number(before.totalWeightKg) - Number(after.totalWeightKg)) >= 0.5) {
        touched++;
      }
    }
  }
  return touched;
}

/**
 * Recompute and persist `Bundle.totalWeightKg` for a single bundle. Call
 * from every callback that mutates a Material row (qty, weight) under the
 * bundle. Idempotent; safe to call repeatedly. No-op when the bundle has
 * no linked materials yet (pre-ZLOAD1) or the value didn't drift.
 */
export async function recomputeBundleWeight(bundleId: string): Promise<void> {
  const materials = await prisma.material.findMany({
    where: { bundleId },
    select: {
      dispatchQuantity: true,
      orderQuantity: true,
      orderWeightKg: true,
    },
  });
  if (materials.length === 0) return;
  const live = computeBundleWeightFromMaterials(materials);
  const current = await prisma.bundle.findUnique({
    where: { id: bundleId },
    select: { totalWeightKg: true },
  });
  if (!current) return;
  if (Math.abs(Number(current.totalWeightKg) - live) < 0.5) return;
  await prisma.bundle.update({
    where: { id: bundleId },
    data: { totalWeightKg: live },
  });
}
