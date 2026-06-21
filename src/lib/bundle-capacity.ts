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
  | { kind: 'other_bundle'; bundleId: string; kg: number }
  /**
   * ZLOAD1 onto a BRAND-NEW bundle (extra vehicle) that does not exist yet.
   * Only emitted when `overflowMode: 'new_bundle'` (the LS-created-but-not-sent
   * "preserve" path). `bundleId` is null because the engine creates the bundle
   * (createSingleBundleForPo) at execution time. One leg per new vehicle.
   */
  | { kind: 'new_bundle'; bundleId: null; kg: number };

export type CapacityVerdict =
  /** Every kg of the requested delta was placed in EXISTING bundles. */
  | { material: string; verdict: 'fully_allocated'; allocations: Allocation[]; overflowKg: 0 }
  /** Some kg placed in existing bundles, some kg overflow — branch raises a new SO for the overflow. */
  | { material: string; verdict: 'partial_overflow'; allocations: Allocation[]; overflowKg: number }
  /** Nothing fit in existing bundles — branch raises a new SO for the whole delta. */
  | { material: string; verdict: 'needs_new_so'; allocations: []; overflowKg: number }
  /**
   * Every kg placed, but the residual that didn't fit existing bundles is
   * routed to one or more NEW bundles (extra vehicles) instead of a new SO.
   * Only produced when `overflowMode: 'new_bundle'`. `allocations` may mix
   * same_bundle / other_bundle (existing headroom) with new_bundle legs.
   */
  | { material: string; verdict: 'allocated_with_new_bundle'; allocations: Allocation[]; overflowKg: 0 };

export interface AssessPostLsIncreaseArgs {
  salesOrderId: string;
  items: Array<{ material: string; deltaKg: number }>;
  /**
   * How to handle kg that doesn't fit existing bundles.
   *   'new_so'     (default) — post-plant_ls behavior: overflow → new SO
   *                 (partial_overflow / needs_new_so verdicts).
   *   'new_bundle' — LS-created-but-not-sent "preserve" path: pack the residual
   *                 into one or more new bundles (extra vehicles) on the same PO
   *                 (allocated_with_new_bundle verdict). Never overflows to a SO.
   */
  overflowMode?: 'new_so' | 'new_bundle';
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
  const overflowMode = args.overflowMode ?? 'new_so';

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
    //
    // The MIN_ALLOCATION_KG floor exists to avoid FRAGMENTING a delta into
    // useless slivers across bundles — it must NOT reject a leg that places
    // the ENTIRE remaining delta. A small total increase (e.g. 47.5 kg) that
    // fits wholly in the bundle the material already lives on is a clean
    // ZLOAD2 bump, not a sliver. So: accept the leg if it either clears the
    // whole remaining amount OR meets the floor.
    if (currentBundleId) {
      const headroom = remainingFor(currentBundleId);
      const take = Math.min(remaining, headroom);
      if (take > 0 && (take >= remaining || take >= MIN_ALLOCATION_KG)) {
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
    //
    // Loop while there's anything left to place (remaining > 0), not just
    // while it clears the floor — otherwise a small whole residual (< floor)
    // that a sibling could fully absorb would be wrongly skipped and end up
    // as overflow. The floor still applies to the per-leg `take` below (a
    // partial spill leaves residual, so it must be a meaningful chunk), but a
    // leg that clears the whole remaining amount is always accepted.
    while (remaining > 0) {
      const candidates = bundles
        .filter((b) => b.id !== currentBundleId && !dispatchedIds.has(b.id))
        .map((b) => ({ id: b.id, remainingKg: remainingFor(b.id) }))
        .filter((c) => c.remainingKg >= Math.min(remaining, MIN_ALLOCATION_KG));
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

    // Step 3 — when the caller wants overflow to become NEW BUNDLES (the
    // LS-created "preserve" path) rather than a new SO, pack any residual into
    // one or more brand-new bundles, each up to one vehicle's capacity. The
    // engine materializes these via createSingleBundleForPo at execution time.
    // Any residual goes here regardless of the floor — once we've decided a new
    // vehicle is needed, even a small leftover must ride it (it can't overflow
    // to a SO in the preserve path).
    if (overflowMode === 'new_bundle' && remaining > 0) {
      while (remaining > 0) {
        const take = Math.min(remaining, capacityKg);
        allocations.push({ kind: 'new_bundle', bundleId: null, kg: take });
        remaining -= take;
      }
    }

    // Classify the outcome for this material.
    if (overflowMode === 'new_bundle' && allocations.some((a) => a.kind === 'new_bundle')) {
      // Residual was absorbed by new bundle(s); nothing overflows to a SO.
      verdicts.push({
        material: item.material,
        verdict: 'allocated_with_new_bundle',
        allocations,
        overflowKg: 0,
      });
    } else if (allocations.length === 0) {
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
 *
 * Once a material has been SPLIT across bundles (an `other_bundle` append), it
 * has an LSI on each — so we order by bundle number ascending and take the
 * lowest, making the "current bundle" pick deterministic instead of an
 * arbitrary findFirst. The assessment packs this bundle first (Step 1) and
 * spills the rest (Step 2), which is now correct because bundle headroom is
 * computed LSI-aware.
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
    orderBy: { loadingSlip: { bundle: { bundleNumber: 'asc' } } },
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
 * live recomputation from the loading-slip items physically on the bundle
 * (see `bundleWeightFromLsis`) and persist mismatches. Cheap (one read per PO +
 * per-bundle update only on drift). Idempotent.
 *
 * Why this is needed: `Bundle.totalWeightKg` was historically set once at
 * bundle creation and never updated even when ZLOAD2 changed quantities. The
 * post-plant capacity assessment uses this field as the authority for remaining
 * capacity, so we self-heal whenever the helper runs — and it must be LSI-based
 * so a material split across bundles is attributed to the right bundle.
 */
async function backfillStaleBundleWeights(purchaseOrderId: string): Promise<void> {
  const bundles = await prisma.bundle.findMany({
    where: { purchaseOrderId },
    select: { id: true, totalWeightKg: true },
  });
  for (const b of bundles) {
    const liveKg = await bundleWeightFromLsis(b.id);
    if (liveKg === null) continue; // pre-ZLOAD1 — leave bundler's value alone
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
 * Compute a bundle's live weight from the loading-slip items physically on it
 * (LSI → LoadingSlip.bundleId), NOT from Material rows.
 *
 * Why LSI and not Material: a Material row has ONE bundleId, but after an
 * `other_bundle` ZLOAD1-append a single material is physically SPLIT across two
 * bundles (e.g. 63 units on Bundle 1, 10 on Bundle 3). The LSI table records
 * that split correctly (one LSI per loading slip), so summing LSIs gives each
 * bundle its true weight; a Material-based sum would put the material's whole
 * weight on its single linked bundle and miss the spill entirely.
 *
 * Per-unit weight still comes from the Material row: `orderWeightKg` is the
 * FULL-order weight on basis `orderQuantity`, so kgPerUnit = orderWeightKg /
 * orderQuantity (kept invariant by the VA02 fix that scales orderWeightKg with
 * orderQuantity). LSI.orderWeight is unreliable (usually null), so we derive it.
 *
 * Returns `null` when the bundle has NO loading-slip items yet (pre-ZLOAD1) so
 * callers leave the bundler's creation-time `totalWeightKg` untouched. For a
 * NON-split bundle the result equals the old Material-based value (the LSI
 * quantities sum to dispatchQuantity), so there's no spurious drift.
 */
async function bundleWeightFromLsis(bundleId: string): Promise<number | null> {
  const lsis = await prisma.loadingSlipItem.findMany({
    where: { loadingSlip: { bundleId } },
    select: { salesOrderId: true, material: true, orderQuantity: true },
  });
  if (lsis.length === 0) return null; // pre-ZLOAD1 — leave the bundler's value alone

  // kgPerUnit per (salesOrderId, material) from the Material rows.
  const uniquePairs = Array.from(
    new Map(
      lsis.map((l) => [`${l.salesOrderId}|${l.material}`, { salesOrderId: l.salesOrderId, material: l.material }]),
    ).values(),
  );
  const mats = await prisma.material.findMany({
    where: { OR: uniquePairs },
    select: { salesOrderId: true, material: true, orderQuantity: true, orderWeightKg: true },
  });
  const kgPerUnit = new Map<string, number>();
  for (const m of mats) {
    const oq = m.orderQuantity || 0;
    const w = m.orderWeightKg ? Number(m.orderWeightKg) : 0;
    kgPerUnit.set(`${m.salesOrderId}|${m.material}`, oq > 0 && w > 0 ? w / oq : 0);
  }

  let total = 0;
  for (const l of lsis) {
    const kpu = kgPerUnit.get(`${l.salesOrderId}|${l.material}`) ?? 0;
    total += (l.orderQuantity ?? 0) * kpu;
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
  // Discover every bundle this SO touches via BOTH links: Material.bundleId
  // (set by the bundler / new-bundle path) AND the SO's loading-slip items
  // (LSI → LoadingSlip.bundleId). The LSI link is essential for the split case
  // — an `other_bundle` append lands an LSI on the sibling bundle WITHOUT
  // relinking the Material row, so a Material-only discovery would miss it.
  const bundleIdSet = new Set<string>();
  const viaMaterial = await prisma.material.findMany({
    where: { salesOrderId, bundleId: { not: null } },
    select: { bundleId: true },
    distinct: ['bundleId'],
  });
  for (const r of viaMaterial) if (r.bundleId) bundleIdSet.add(r.bundleId);
  const viaLsi = await prisma.loadingSlipItem.findMany({
    where: { salesOrderId, loadingSlipId: { not: null } },
    select: { loadingSlip: { select: { bundleId: true } } },
  });
  for (const r of viaLsi) if (r.loadingSlip?.bundleId) bundleIdSet.add(r.loadingSlip.bundleId);

  let touched = 0;
  for (const bundleId of bundleIdSet) {
    const before = await prisma.bundle.findUnique({
      where: { id: bundleId },
      select: { totalWeightKg: true },
    });
    await recomputeBundleWeight(bundleId);
    if (before) {
      const after = await prisma.bundle.findUnique({
        where: { id: bundleId },
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
 * Recompute and persist `Bundle.totalWeightKg` for a single bundle from the
 * loading-slip items physically on it (see `bundleWeightFromLsis`). Call from
 * every callback that changes a bundle's slip quantities (zload1/zload2 data).
 * Idempotent; safe to call repeatedly. No-op when the bundle has no loading-slip
 * items yet (pre-ZLOAD1 — the bundler's creation value stands) or didn't drift.
 */
export async function recomputeBundleWeight(bundleId: string): Promise<void> {
  const live = await bundleWeightFromLsis(bundleId);
  if (live === null) return; // pre-ZLOAD1 — leave the bundler's creation value
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
