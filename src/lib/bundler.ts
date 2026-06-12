import { prisma } from './prisma';

/**
 * Thrown by computeBundlesForPo when the PO has no `weightage` yet — the
 * NEW ORDER email didn't include vehicle tonnage and the branch hasn't
 * replied to the tonnage_inquiry email. Callers should catch this
 * specifically and surface "waiting for tonnage" rather than treat it as
 * a generic failure.
 */
export class BundlerWeightageMissingError extends Error {
  constructor(poNumber: string) {
    super(`PO ${poNumber}: vehicle tonnage not known yet — waiting for branch to share via tonnage_inquiry reply`);
    this.name = 'BundlerWeightageMissingError';
  }
}

/**
 * Thrown by computeBundlesForPo when at least one LoadingSlip under the PO
 * has already been sent to the plant. The composition of those bundles is
 * frozen and the wipe-and-recreate path would migrate LSIs across bundles,
 * which the plant has already committed truck-side logistics against. The
 * planner's Rule 11 handles post-plant modifications without this path; this
 * guard exists as a hard backstop so any other caller that hits the bundler
 * post-intimation fails loudly rather than silently rearranging composition.
 */
export class BundlesFrozenError extends Error {
  constructor(public readonly purchaseOrderId: string, public readonly sentLsCount: number) {
    super(
      `PurchaseOrder ${purchaseOrderId}: ${sentLsCount} loading slip(s) already sent to plant — bundles are frozen and cannot be re-bundled. Use the post-plant modify flow (Rule 11) instead.`,
    );
    this.name = 'BundlesFrozenError';
  }
}

/**
 * Returns true when any LoadingSlip under `purchaseOrderId` has reached
 * `status='sent_to_plant'` (or later — `invoiced`, `completed`). Used by
 * computeBundlesForPo to refuse re-bundling once the plant has been told.
 */
export async function anyLoadingSlipSentToPlant(purchaseOrderId: string): Promise<boolean> {
  const sentLs = await prisma.loadingSlip.count({
    where: {
      salesOrder: { purchaseOrderId },
      status: { in: ['sent_to_plant', 'invoiced', 'completed'] },
    },
  });
  return sentLs > 0;
}

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
 * A bundle expressed as the set of materials it holds. Used to compare the
 * proposed bundling against what's already in the DB so we only do the
 * destructive wipe when composition actually changed. Keys are
 * `${material}|${batch}`; values are the per-line `dispatchQuantity`.
 *
 * Two bundles are "the same" when their material-key maps are equal.
 * Bundle numbers are NOT part of the identity — the bin-packer is free to
 * renumber (1,2,3...) without that counting as a change.
 */
type BundleComposition = Map<string, number>;

interface BundleSnapshot {
  /** Source of truth for "which SAP LS holds this bundle." Null when the
   *  bundle exists only in our DB and hasn't been pushed to SAP yet. */
  lsNumber: string | null;
  composition: BundleComposition;
}

/**
 * Read the current state of bundles for a PO: each Bundle plus the LS that
 * was created from it (via `LoadingSlip.bundleId`) and the materials it
 * carries (via `Material.bundleId`). Returns the per-bundle snapshot used
 * by `diffBundleComposition`.
 */
async function readCurrentBundles(purchaseOrderId: string): Promise<BundleSnapshot[]> {
  const bundles = await prisma.bundle.findMany({
    where: { purchaseOrderId },
    include: {
      loadingSlips: { select: { lsNumber: true } },
      materials: { select: { material: true, batch: true, dispatchQuantity: true } },
    },
    orderBy: { bundleNumber: 'asc' },
  });
  return bundles.map((b) => {
    const composition: BundleComposition = new Map();
    for (const m of b.materials) {
      const key = `${m.material}|${m.batch ?? ''}`;
      composition.set(key, (composition.get(key) ?? 0) + (m.dispatchQuantity ?? 0));
    }
    // A bundle can in principle hold multiple LSs (one per SO under the PO).
    // For diff purposes we tag the snapshot with the first LS as a label —
    // the cleanup logic enumerates ALL LSs of an eliminated bundle below.
    const lsNumber = b.loadingSlips[0]?.lsNumber ?? null;
    return { lsNumber, composition };
  });
}

/** Convert proposed bins (from `packMaterialsIntoBundles`) into snapshots
 *  for diffing. Needs the per-Material id → (material, batch, qty) map. */
function snapshotProposedBundles(
  bins: BundlerBin[],
  matIndex: Map<string, { material: string; batch: string; dispatchQuantity: number }>,
): BundleSnapshot[] {
  return bins.map((bin) => {
    const composition: BundleComposition = new Map();
    for (const id of bin.itemIds) {
      const m = matIndex.get(id);
      if (!m) continue;
      const key = `${m.material}|${m.batch ?? ''}`;
      composition.set(key, (composition.get(key) ?? 0) + m.dispatchQuantity);
    }
    return { lsNumber: null, composition };
  });
}

function compositionsEqual(a: BundleComposition, b: BundleComposition): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    if (b.get(k) !== v) return false;
  }
  return true;
}

/**
 * Compare proposed vs current bundle snapshots. Returns:
 *   - `unchanged: true` when every current bundle has a 1:1 composition match
 *     in the proposed set (regardless of bundle number).
 *   - Otherwise, the list of LS numbers whose source bundle no longer matches
 *     any proposed bundle — these must be closed in SAP before the wipe.
 *
 * The diff is composition-only: a material moving from Bundle 1 to Bundle 2
 * (even with no qty change) counts as a change, because the SAP LS that
 * held it under the old plan no longer accurately reflects the new plan.
 */
function diffBundleComposition(
  proposed: BundleSnapshot[],
  current: BundleSnapshot[],
): { unchanged: true } | { unchanged: false; lssToClose: string[] } {
  // Match each current bundle against a proposed bundle by composition.
  const matchedProposed = new Set<number>();
  const lssToClose: string[] = [];

  for (const curr of current) {
    let matchIdx = -1;
    for (let i = 0; i < proposed.length; i++) {
      if (matchedProposed.has(i)) continue;
      if (compositionsEqual(curr.composition, proposed[i].composition)) {
        matchIdx = i;
        break;
      }
    }
    if (matchIdx === -1) {
      // No proposed bundle matches this current one — its LS (if any) must
      // be closed in SAP.
      if (curr.lsNumber) lssToClose.push(curr.lsNumber);
    } else {
      matchedProposed.add(matchIdx);
    }
  }

  // Composition is unchanged when every current bundle paired with a unique
  // proposed bundle AND no extra proposed bundles remained. The second half
  // matters only when the proposed plan has MORE bundles than current — that
  // means new material got added (or existing material grew past capacity),
  // which is itself a composition change.
  const allProposedMatched = matchedProposed.size === proposed.length;
  const allCurrentMatched = lssToClose.length === 0;
  if (allCurrentMatched && allProposedMatched && proposed.length === current.length) {
    return { unchanged: true };
  }
  // Also include LSs from bundles that had no LS attached (e.g. a Bundle
  // row that ZLOAD1 hadn't yet materialised into an LS) — those don't need
  // closing in SAP, but their DB Bundle row will still be wiped below.
  return { unchanged: false, lssToClose };
}

/**
 * Compute capacity-based bundles for a PurchaseOrder from its Material rows
 * (the branch-confirmed dispatch plan).
 *
 * Two distinct cases:
 *
 *   1. **First call** (pre-ZLOAD1, no LSs exist yet) — the diff trivially
 *      reports "changed, nothing to close in SAP," falls through to the
 *      compute+commit phase. Same code path; the wipe is a no-op because
 *      there's nothing to wipe.
 *
 *   2. **Re-bundle after a modification** — materials have changed (qty,
 *      composition). We:
 *        a. Compute the proposed bundles in memory (dry run).
 *        b. Diff against the existing Bundle/LoadingSlip state.
 *        c. If composition is unchanged → no-op (common case for
 *           "release as-is" replies after a clarification).
 *        d. If composition changed → enqueue ZLOADING_CLOSE for every
 *           affected SAP-issued LS, await completion, then wipe + recreate.
 *
 * Per-Material weight = (dispatchQuantity / orderQuantity) * orderWeightKg.
 * Capacity = `PO.weightage * 1000` kg. Bin packing delegated to
 * `packMaterialsIntoBundles` — material-grouping is enforced there.
 */
export async function computeBundlesForPo(purchaseOrderId: string): Promise<{
  bundleCount: number;
  totalKg: number;
  capacityKg: number;
}> {
  const po = await prisma.purchaseOrder.findUnique({
    where: { id: purchaseOrderId },
  });
  if (!po) throw new Error(`PurchaseOrder ${purchaseOrderId} not found`);

  // Bundle-freeze guard. Once a LoadingSlip on this PO has reached
  // 'sent_to_plant' (or later), the truck-side composition is committed.
  // Wipe-and-recreate would migrate LSIs across bundles, which is exactly
  // what the plant has already committed against. Refuse loudly — Rule 11
  // in the planner handles post-plant modifications via a different path
  // (bundle_capacity_assessment → zload2 OR zload1-append OR new-SO email).
  const sentLs = await prisma.loadingSlip.count({
    where: {
      salesOrder: { purchaseOrderId },
      status: { in: ['sent_to_plant', 'invoiced', 'completed'] },
    },
  });
  if (sentLs > 0) {
    throw new BundlesFrozenError(purchaseOrderId, sentLs);
  }

  // Vehicle capacity comes from the NEW ORDER email and is stored on the
  // PO directly. If it's null, the branch never told us — the intake
  // already sent a tonnage_inquiry email; we just can't bundle yet.
  const rawWeightage = po.weightage ? Number(po.weightage) : 0;
  if (rawWeightage <= 0) {
    throw new BundlerWeightageMissingError(po.poNumber);
  }
  const capacityKg = rawWeightage * 1000;

  // ── Phase 1: read materials and compute proposed bundles in memory ──────
  const materials = await prisma.material.findMany({
    where: {
      salesOrder: { purchaseOrderId },
      dispatchQuantity: { gt: 0 },
    },
  });

  if (materials.length === 0) {
    // Nothing to bundle. Treat as "wipe-and-leave-empty" — but only if
    // there's something to wipe; otherwise it's a true no-op.
    const existing = await prisma.bundle.count({ where: { purchaseOrderId } });
    if (existing === 0) {
      return { bundleCount: 0, totalKg: 0, capacityKg };
    }
    // Existing bundles but no materials → wipe (no SAP cleanup needed for
    // the unusual case where every line went to zero; close any LSs found).
    return wipeAndCommit(purchaseOrderId, [], 0, capacityKg);
  }

  const matIndex = new Map<string, { material: string; batch: string; dispatchQuantity: number }>();
  const weighted: BundlerInput[] = materials.map((m) => {
    const dispatchQty = m.dispatchQuantity!;
    const orderedQty = m.orderQuantity || 0;
    const fullWeight = m.orderWeightKg ? Number(m.orderWeightKg) : 0;
    const weightKg = orderedQty > 0 ? (dispatchQty / orderedQty) * fullWeight : 0;
    matIndex.set(m.id, { material: m.material, batch: m.batch ?? '', dispatchQuantity: dispatchQty });
    return { id: m.id, material: m.material, weightKg };
  });

  const totalKg = weighted.reduce((s, w) => s + w.weightKg, 0);
  const proposedBins = packMaterialsIntoBundles(weighted, capacityKg, (msg) => console.warn(msg));

  // ── Phase 2: diff proposed against current ──────────────────────────────
  const proposedSnapshots = snapshotProposedBundles(proposedBins, matIndex);
  const currentSnapshots = await readCurrentBundles(purchaseOrderId);
  const diff = diffBundleComposition(proposedSnapshots, currentSnapshots);

  if (diff.unchanged) {
    // Common case after the planner re-emits `email_confirm_bundle_details`
    // for a no-op confirmation. Bundles + LSs stay exactly as they are; we
    // just return the freshly computed totals (identical to current since
    // composition matches).
    console.log(
      `[Bundler] PO ${po.poNumber}: re-bundle no-op (${currentSnapshots.length} bundle(s) unchanged) — skipping wipe`,
    );
    return {
      bundleCount: currentSnapshots.length,
      totalKg,
      capacityKg,
    };
  }

  // ── Phase 3: SAP-aware cleanup of LSs that no longer match the plan ─────
  if (diff.lssToClose.length > 0) {
    console.log(
      `[Bundler] PO ${po.poNumber}: composition changed — closing ${diff.lssToClose.length} LS(s) in SAP before re-bundling: ${diff.lssToClose.join(', ')}`,
    );

    const { triggerZloadingClose } = await import('./auto-gui-trigger');
    const { awaitWorkCompletion } = await import('./work-queue');

    // For each LS to close, build the materials list from its LSI rows and
    // emit ZLOADING_CLOSE. We collect the resulting WorkQueue ids so we can
    // block on completion before wiping.
    const workIdsToAwait: string[] = [];
    for (const lsNumber of diff.lssToClose) {
      const lsiRows = await prisma.loadingSlipItem.findMany({
        where: { lsNumber },
        select: { material: true },
      });
      const materialCodes = Array.from(new Set(lsiRows.map((r) => r.material)));
      if (materialCodes.length === 0) {
        console.warn(`[Bundler] LS ${lsNumber} has no LSI rows — skipping ZLOADING_CLOSE`);
        continue;
      }
      // triggerZloadingClose enqueues + pumps internally. It dedupes on
      // (lsNumber, materials) so re-calling within the same flow is safe.
      await triggerZloadingClose(lsNumber, materialCodes);
      // Pick up the work id we just enqueued for the wait. The trigger
      // doesn't return it, so we re-query the most recent matching row.
      const justQueued = await prisma.workQueue.findFirst({
        where: {
          step: 'zloading_close',
          payload: { contains: `"ls_number":"${lsNumber}"` },
          state: { in: ['queued', 'firing'] },
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      if (justQueued) workIdsToAwait.push(justQueued.id);
    }

    if (workIdsToAwait.length > 0) {
      console.log(
        `[Bundler] PO ${po.poNumber}: awaiting ${workIdsToAwait.length} ZLOADING_CLOSE work row(s)…`,
      );
      await awaitWorkCompletion(workIdsToAwait, { timeoutMs: 120_000 });
      console.log(`[Bundler] PO ${po.poNumber}: all ZLOADING_CLOSE work rows terminal`);
    }
  }

  // ── Phase 4: wipe and commit the new bundles ────────────────────────────
  return wipeAndCommit(purchaseOrderId, proposedBins, totalKg, capacityKg);
}

/**
 * Apply the destructive wipe + recreate. Split out so the empty-materials
 * fallback path can re-use it without duplicating the deletes.
 */
async function wipeAndCommit(
  purchaseOrderId: string,
  proposedBins: BundlerBin[],
  totalKg: number,
  capacityKg: number,
): Promise<{ bundleCount: number; totalKg: number; capacityKg: number }> {
  await prisma.material.updateMany({
    where: { salesOrder: { purchaseOrderId }, bundleId: { not: null } },
    data: { bundleId: null },
  });
  await prisma.loadingSlipItem.updateMany({
    where: { salesOrder: { purchaseOrderId }, loadingSlipId: { not: null } },
    data: { loadingSlipId: null },
  });
  await prisma.loadingSlip.deleteMany({
    where: { salesOrder: { purchaseOrderId } },
  });
  await prisma.bundle.deleteMany({ where: { purchaseOrderId } });

  for (const bin of proposedBins) {
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

  return { bundleCount: proposedBins.length, totalKg, capacityKg };
}

/**
 * (Removed) linkLsiToBundle copied Material.bundleId onto LoadingSlipItem
 * so downstream code could group LSIs by bundle. With the LoadingSlip
 * refactor, LSIs reach their bundle via LoadingSlip.bundleId, set by
 * /backend/orders/aman/zload1-data when SAP returns the LS PDF. No
 * post-hoc linking step is needed.
 */
