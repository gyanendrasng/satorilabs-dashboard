import { prisma } from './prisma';

export type StockShortage = {
  material: string;
  requested: number;
  available: number;
};

export type StockPrecheckResult =
  | { outcome: 'sufficient' }
  | { outcome: 'short'; shortages: StockShortage[]; plant: string }
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
  for (const m of increases) {
    const snap = await prisma.inventorySnapshot.findUnique({
      where: { material_plant: { material: m.material_code, plant } },
      select: { freeStock: true },
    });
    const available = snap?.freeStock ?? 0;
    if (available < m.quantity) {
      shortages.push({ material: m.material_code, requested: m.quantity, available });
    }
  }

  if (shortages.length === 0) return { outcome: 'sufficient' };
  return { outcome: 'short', shortages, plant };
}
