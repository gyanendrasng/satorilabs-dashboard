import { prisma } from './prisma';
import { findEquivalents } from './product-db';

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

export type StockPrecheckResult =
  | { outcome: 'sufficient' }
  | { outcome: 'substituted'; substitutions: Substitution[] }
  | { outcome: 'short'; shortages: StockShortage[]; plant: string; substitutions?: Substitution[] }
  | { outcome: 'plant_unknown' };

type ClassifiedMaterial = {
  material_code: string;
  operation: string;
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

  const increases = (args.classification.materials ?? []).filter(
    (m) => m.operation === 'increase',
  );
  if (increases.length === 0) return { outcome: 'sufficient' };

  const shortages: StockShortage[] = [];
  const substitutions: Substitution[] = [];

  for (const m of increases) {
    const snap = await prisma.inventorySnapshot.findUnique({
      where: { material_plant: { material: m.material_code, plant } },
      select: { freeStock: true },
    });
    const available = snap?.freeStock ?? 0;
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
    return { outcome: 'sufficient' };
  }
  if (shortages.length === 0) {
    return { outcome: 'substituted', substitutions };
  }
  // Mixed result: some lines substituted, others still short. Engine fires VA02
  // for the substitutions AND emails the branch about the remaining gap.
  return { outcome: 'short', shortages, plant, substitutions: substitutions.length > 0 ? substitutions : undefined };
}
