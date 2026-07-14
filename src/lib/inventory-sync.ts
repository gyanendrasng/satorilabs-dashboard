import { prisma } from './prisma';

const AUTO_GUI_HOST = process.env.AUTO_GUI_HOST || 'localhost';
const AUTO_GUI_PORT = process.env.AUTO_GUI_PORT || '8000';
const FETCH_TIMEOUT_MS = 30_000;

type IncomingRow = {
  material: string;
  materialDescription?: string | null;
  vertical?: string | null;
  plant: string;
  freeStock: number | string;
};

type AutoGuiResponse = {
  fileLabel: string | null;
  rows: IncomingRow[];
};

export async function syncInventoryFromAutoGui(args?: {
  log?: (s: string) => void;
}): Promise<{ changed: boolean; fileLabel: string | null; rowsUpserted: number }> {
  const log = args?.log ?? (() => {});

  const state = await prisma.inventorySyncState.findUnique({
    where: { id: 'singleton' },
  });
  const since = state?.lastFileLabel ?? '';

  const url = `http://${AUTO_GUI_HOST}:${AUTO_GUI_PORT}/inventory/latest?since=${encodeURIComponent(since)}`;
  let payload: AutoGuiResponse;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) {
      log(`[InventorySync] auto_gui2 returned HTTP ${res.status}`);
      return { changed: false, fileLabel: null, rowsUpserted: 0 };
    }
    payload = (await res.json()) as AutoGuiResponse;
  } catch (err) {
    log(`[InventorySync] fetch failed: ${err instanceof Error ? err.message : err}`);
    return { changed: false, fileLabel: null, rowsUpserted: 0 };
  }

  if (!payload || !Array.isArray(payload.rows) || payload.rows.length === 0) {
    log('[InventorySync] no new inventory file (empty payload)');
    return { changed: false, fileLabel: payload?.fileLabel ?? null, rowsUpserted: 0 };
  }

  let upserted = 0;
  const CHUNK = 500;
  for (let i = 0; i < payload.rows.length; i += CHUNK) {
    const chunk = payload.rows.slice(i, i + CHUNK);
    await prisma.$transaction(
      chunk.map((row) => {
        const freeStock = typeof row.freeStock === 'string' ? parseInt(row.freeStock, 10) : row.freeStock;
        return prisma.inventorySnapshot.upsert({
          where: { material_plant: { material: row.material, plant: row.plant } },
          create: {
            material: row.material,
            materialDescription: row.materialDescription ?? null,
            vertical: row.vertical ?? null,
            plant: row.plant,
            freeStock: Number.isFinite(freeStock) ? freeStock : 0,
          },
          update: {
            materialDescription: row.materialDescription ?? null,
            vertical: row.vertical ?? null,
            freeStock: Number.isFinite(freeStock) ? freeStock : 0,
            syncedAt: new Date(),
          },
        });
      }),
    );
    upserted += chunk.length;
  }

  await prisma.inventorySyncState.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton', lastFileLabel: payload.fileLabel },
    update: { lastFileLabel: payload.fileLabel },
  });

  log(`[InventorySync] upserted ${upserted} rows (fileLabel=${payload.fileLabel})`);
  return { changed: true, fileLabel: payload.fileLabel, rowsUpserted: upserted };
}
