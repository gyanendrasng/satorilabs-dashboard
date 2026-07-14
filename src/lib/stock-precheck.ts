import { prisma } from './prisma';
import { findEquivalents } from './product-db';
import type { MaterialOpSummary } from './planner-step-args';

export type StockShortage = {
  material: string;
  requested: number;
  available: number;
};

export type Substitution = {
  /** Material code originally requested by the branch. */
  originalMaterial: string;
  /** Material code we'll swap in (different SKU, different plant prefix). */
  substituteMaterial: string;
  /** Plant where the substitute is held. */
  substitutePlant: string;
  /** Quantity the branch wanted (the substitute fully replaces this line). */
  requested: number;
  /** Free stock the substitute had when picked — kept for audit + email body. */
  substituteAvailable: number;
};

/**
 * Per-material availability verdict for an increase line, independent of the
 * substitution decision. Surfaces the THREE-WAY distinction the LS-created
 * "don't preserve" flow (path [A], A1/A2/A3) needs:
 *   - 'fully'   → available >= requested (covered at the SO's own plant)
 *   - 'partial' → 0 < available < requested
 *   - 'none'    → available == 0
 * `available` here is free stock at the SO's OWN plant only (pre-substitution);
 * a material can be `partial`/`none` here yet still resolve via a cross-plant
 * substitute, which is reflected separately in `outcome: 'substituted'`.
 */
export type PerMaterialVerdict = {
  material: string;
  requested: number;
  available: number;
  verdict: 'fully' | 'partial' | 'none';
};

export type StockPrecheckResult =
  | { outcome: 'sufficient'; perMaterial: PerMaterialVerdict[] }
  | { outcome: 'substituted'; substitutions: Substitution[]; perMaterial: PerMaterialVerdict[] }
  | { outcome: 'short'; shortages: StockShortage[]; plant: string; substitutions?: Substitution[]; perMaterial: PerMaterialVerdict[] }
  | { outcome: 'plant_unknown' };

/**
 * Shape of one planner-emitted material entry on a stock_precheck step.
 * `operation` is the short-code union the coercer in planner-step-args.ts
 * produces — keeping the type strict here surfaces any future
 * filter-string mismatches at compile time (the verbose-vs-short bug
 * that silently bypassed the inventory lookup was hidden by an
 * `operation: string` type here).
 */
type ClassifiedMaterial = {
  material_code: string;
  operation: MaterialOpSummary;
  quantity: number;
};

export async function resolveSalesOrderPlant(salesOrderId: string): Promise<string | null> {
  const so = await prisma.salesOrder.findUnique({
    where: { id: salesOrderId },
    select: { plant: true },
  });
  if (so?.plant) return so.plant;
  const fallback = process.env.SAP_DEFAULT_PLANT;
  if (fallback && fallback.trim().length > 0) return fallback.trim();
  return null;
}

/**
 * For a material that's short at the SO's plant, look up cross-plant
 * equivalents (same `narrow_material_group` in the product DB) and pick the
 * best-fit substitute: among equivalents whose `InventorySnapshot.freeStock`
 * fully covers the originally requested qty, return the one with the SMALLEST
 * such stock (preserves bigger inventories elsewhere for future orders).
 *
 * Single-equivalent allocation only — if no single equivalent can cover the
 * full requested qty, returns null and the caller falls back to the branch
 * shortage email. Multi-equivalent packing is future work.
 */
async function findBestSubstitute(args: {
  originalMaterial: string;
  requested: number;
}): Promise<Substitution | null> {
  const equivs = findEquivalents(args.originalMaterial);
  if (equivs.length === 0) return null;

  type Candidate = { substituteMaterial: string; substitutePlant: string; freeStock: number };
  const covering: Candidate[] = [];

  for (const equiv of equivs) {
    if (!equiv.plant_code) continue;
    const snap = await prisma.inventorySnapshot.findUnique({
      where: { material_plant: { material: equiv.material, plant: equiv.plant_code } },
      select: { freeStock: true },
    });
    const freeStock = snap?.freeStock ?? 0;
    if (freeStock >= args.requested) {
      covering.push({
        substituteMaterial: equiv.material,
        substitutePlant: equiv.plant_code,
        freeStock,
      });
    }
  }
  if (covering.length === 0) return null;

  // Best fit: smallest sufficient stock. Tie-break by material code asc for
  // determinism (matters only when two plants happen to have the exact same
  // stock level).
  covering.sort((a, b) => a.freeStock - b.freeStock || a.substituteMaterial.localeCompare(b.substituteMaterial));
  const pick = covering[0];
  return {
    originalMaterial: args.originalMaterial,
    substituteMaterial: pick.substituteMaterial,
    substitutePlant: pick.substitutePlant,
    requested: args.requested,
    substituteAvailable: pick.freeStock,
  };
}

export async function runStockPrecheck(args: {
  salesOrderId: string;
  classification: { materials: ClassifiedMaterial[] };
}): Promise<StockPrecheckResult> {
  const plant = await resolveSalesOrderPlant(args.salesOrderId);
  if (!plant) return { outcome: 'plant_unknown' };

  // Operation codes come in as the planner-step-args short form
  // ('inc' | 'dec' | 'del'). Filter on the matching short code; an earlier
  // version of this filter checked `'increase'` (verbose), matched zero
  // rows on every call, and silently returned `sufficient` without ever
  // touching InventorySnapshot. The `MaterialOpSummary`-typed
  // `ClassifiedMaterial` above now catches any future mismatch at compile
  // time.
  const increases = (args.classification.materials ?? []).filter(
    (m) => m.operation === 'inc',
  );
  if (increases.length === 0) return { outcome: 'sufficient', perMaterial: [] };

  const shortages: StockShortage[] = [];
  const substitutions: Substitution[] = [];
  // Three-way availability at the SO's OWN plant, computed for every increase
  // line regardless of how the outcome resolves (substitution etc.). Consumed
  // by the LS-created "don't preserve" path to drive the A1/A2/A3 branch.
  const perMaterial: PerMaterialVerdict[] = [];

  for (const m of increases) {
    const snap = await prisma.inventorySnapshot.findUnique({
      where: { material_plant: { material: m.material_code, plant } },
      select: { freeStock: true },
    });
    const available = snap?.freeStock ?? 0;
    perMaterial.push({
      material: m.material_code,
      requested: m.quantity,
      available,
      verdict: available >= m.quantity ? 'fully' : available > 0 ? 'partial' : 'none',
    });
    if (available >= m.quantity) continue;

    // Short at the SO's plant. Try cross-plant substitution before giving up.
    const sub = await findBestSubstitute({
      originalMaterial: m.material_code,
      requested: m.quantity,
    });
    if (sub) {
      substitutions.push(sub);
    } else {
      shortages.push({ material: m.material_code, requested: m.quantity, available });
    }
  }

  if (shortages.length === 0 && substitutions.length === 0) {
    return { outcome: 'sufficient', perMaterial };
  }
  if (shortages.length === 0) {
    return { outcome: 'substituted', substitutions, perMaterial };
  }
  // Mixed result: some lines substituted, others still short. Engine fires VA02
  // for the substitutions AND emails the branch about the remaining gap.
  return { outcome: 'short', shortages, plant, substitutions: substitutions.length > 0 ? substitutions : undefined, perMaterial };
}
