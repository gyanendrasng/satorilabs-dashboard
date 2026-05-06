import { prisma } from './prisma';
import { triggerZsoVisibility } from './auto-gui-trigger';

interface ReactivationResult {
  reactivatedSos: string[];
  considered: number;
  logs: string[];
}

/**
 * FCFS allocator: for each open MaterialShortage, accumulate MaterialReceipt
 * arrivals (postingDate >= recordedAt) into a shared produce pool, then
 * greedily serve waiting SOs in order of recordedAt. An SO is "served" iff
 * every one of its open shortages can be satisfied from the remaining pool.
 *
 * On success: mark all that SO's open shortages resolved and re-fire
 * ZSO-VISIBILITY. The visibility-data callback's existing pipeline re-sends
 * the dispatch-approval email (with a "Stock Available" subject prefix added
 * by assembleAndSendCombinedEmail).
 *
 * The pool is shared across SOs and decremented as each is allocated, so
 * fresh stock is never double-counted.
 */
export async function reactivateCoveredShortages(): Promise<ReactivationResult> {
  const logs: string[] = [];
  const log = (m: string) => {
    const t = `[${new Date().toISOString()}] ${m}`;
    console.log(t);
    logs.push(t);
  };

  const open = await prisma.materialShortage.findMany({
    where: { resolvedAt: null },
    orderBy: [{ recordedAt: 'asc' }, { salesOrderId: 'asc' }],
    include: { salesOrder: { select: { id: true, soNumber: true } } },
  });

  if (open.length === 0) {
    return { reactivatedSos: [], considered: 0, logs };
  }

  log(`[Reactivator] ${open.length} open shortage row(s) across SOs`);

  // Group shortages by salesOrderId, capturing earliest recordedAt per SO
  // (FCFS key) and aggregating per-material short qty.
  type SoGroup = {
    salesOrderId: string;
    soNumber: string;
    earliestRecordedAt: Date;
    needs: Map<string, number>;
    shortageIds: string[];
  };
  const groups = new Map<string, SoGroup>();
  for (const s of open) {
    let g = groups.get(s.salesOrderId);
    if (!g) {
      g = {
        salesOrderId: s.salesOrderId,
        soNumber: s.salesOrder.soNumber,
        earliestRecordedAt: s.recordedAt,
        needs: new Map(),
        shortageIds: [],
      };
      groups.set(s.salesOrderId, g);
    }
    if (s.recordedAt < g.earliestRecordedAt) g.earliestRecordedAt = s.recordedAt;
    g.needs.set(s.material, (g.needs.get(s.material) ?? 0) + s.shortQty);
    g.shortageIds.push(s.id);
  }

  // FCFS order across SOs.
  const ordered = [...groups.values()].sort((a, b) => {
    const t = a.earliestRecordedAt.getTime() - b.earliestRecordedAt.getTime();
    return t !== 0 ? t : a.salesOrderId.localeCompare(b.salesOrderId);
  });

  // Build the produce pool: for every distinct material across all open
  // shortages, sum MaterialReceipt arrivals since the EARLIEST recordedAt
  // for that material. (Per-SO baselines are enforced implicitly by FCFS
  // order — earlier SOs are checked first, so they get the earlier-eligible
  // stock; later SOs only see what's left.)
  const earliestByMaterial = new Map<string, Date>();
  for (const g of ordered) {
    for (const m of g.needs.keys()) {
      const cur = earliestByMaterial.get(m);
      if (!cur || g.earliestRecordedAt < cur) {
        earliestByMaterial.set(m, g.earliestRecordedAt);
      }
    }
  }

  // Pool = inflow (MB51 receipts since `since`) − outflow (our own committed
  // releases since `since`). Subtracting our outflow keeps the FCFS pre-filter
  // accurate when fresh new orders consume incoming production stock between
  // shortage-record-time and now. ZSO-VISIBILITY remains the truth check —
  // pool is only the "is it worth re-firing visibility?" gate.
  const pool = new Map<string, number>();
  for (const [material, since] of earliestByMaterial) {
    const inflowAgg = await prisma.materialReceipt.aggregate({
      where: { material, postingDate: { gte: since } },
      _sum: { quantity: true },
    });
    const outflowAgg = await prisma.material.aggregate({
      where: {
        material,
        dispatchQuantity: { gt: 0 },
        releasedAt: { gte: since },
      },
      _sum: { dispatchQuantity: true },
    });
    const inflow = inflowAgg._sum.quantity ?? 0;
    const outflow = outflowAgg._sum.dispatchQuantity ?? 0;
    pool.set(material, inflow - outflow);
  }

  log(
    `[Reactivator] Pool snapshot (inflow − our outflow): ${[...pool.entries()]
      .map(([m, q]) => `${m}=${q}`)
      .join(', ') || '(empty)'}`
  );

  const reactivated: string[] = [];
  for (const g of ordered) {
    const covered = [...g.needs.entries()].every(
      ([m, need]) => (pool.get(m) ?? 0) >= need
    );
    if (!covered) {
      log(
        `[Reactivator] SO ${g.soNumber} NOT covered: needs=${JSON.stringify(
          Object.fromEntries(g.needs)
        )}`
      );
      continue;
    }
    // Allocate.
    for (const [m, need] of g.needs) {
      pool.set(m, (pool.get(m) ?? 0) - need);
    }
    await prisma.materialShortage.updateMany({
      where: { id: { in: g.shortageIds } },
      data: { resolvedAt: new Date() },
    });
    reactivated.push(g.soNumber);
    log(`[Reactivator] SO ${g.soNumber} covered → resolving ${g.shortageIds.length} shortage(s)`);
  }

  // Fire ZSO-VISIBILITY for each reactivated SO. Sequential await is fine —
  // enqueueWork + pumpQueue is fast and the work-queue itself serializes the
  // actual SAP fires.
  for (const so of reactivated) {
    try {
      await triggerZsoVisibility(so);
      log(`[Reactivator] Re-fired ZSO-VISIBILITY for SO ${so}`);
    } catch (err) {
      log(
        `[Reactivator] triggerZsoVisibility failed for SO ${so}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  return {
    reactivatedSos: reactivated,
    considered: ordered.length,
    logs,
  };
}
