/**
 * Static product master data (committed at data/product_database.json).
 *
 * Each record is one SKU code at one plant. SKUs with the same physical
 * design but produced at different plants share a `narrow_material_group`
 * but have different `material` codes (e.g. YM6ALMI00001A43P at plant YM6
 * vs YM7ALMI00001A43P at plant YM7). This module gives us the "find the
 * cross-plant equivalents of material X" lookup used by the stock-precheck
 * substitution path.
 *
 * Loaded once at module-init (no async, no DB hit) into two Maps. ~13k
 * records, ~7 MB on disk; in-memory footprint is small enough to keep hot
 * for the lifetime of the Node process.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface ProductRecord {
  /** SKU code, e.g. "YM6ALMI00001A43P". */
  material: string;
  /** Plant code embedded in the SKU prefix, e.g. "YM6". */
  plant_code: string;
  /** Group of equivalent SKUs across plants. The substitution key. */
  narrow_material_group: string;
  /** Human-readable name for the email body. */
  material_description?: string;
  // Remaining fields kept loose — we don't read them, but TypeScript should
  // not complain when callers access them by name.
  [key: string]: unknown;
}

const DB_PATH = path.join(process.cwd(), 'data', 'product_database.json');

let byMaterial: Map<string, ProductRecord> | null = null;
let byNarrowGroup: Map<string, ProductRecord[]> | null = null;

function loadIndex(): void {
  if (byMaterial && byNarrowGroup) return;
  const raw = fs.readFileSync(DB_PATH, 'utf8');
  const records = JSON.parse(raw) as ProductRecord[];

  const m = new Map<string, ProductRecord>();
  const g = new Map<string, ProductRecord[]>();
  for (const r of records) {
    if (!r.material) continue;
    // Last writer wins for duplicate `material` rows — the JSON has a few.
    // The duplicates we've seen are exact repeats, so this is harmless.
    m.set(r.material, r);
    const group = r.narrow_material_group;
    if (!group) continue;
    const arr = g.get(group);
    if (arr) arr.push(r);
    else g.set(group, [r]);
  }
  byMaterial = m;
  byNarrowGroup = g;
}

/** Look up a single product record by its material/SKU code. */
export function getProduct(material: string): ProductRecord | undefined {
  loadIndex();
  return byMaterial!.get(material);
}

/**
 * Return every product record sharing the input's `narrow_material_group`,
 * EXCLUDING the input itself. Empty array when the material is unknown or
 * has no equivalents. The caller uses these to attempt cross-plant
 * substitution when the original material is short.
 */
export function findEquivalents(material: string): ProductRecord[] {
  loadIndex();
  const self = byMaterial!.get(material);
  if (!self || !self.narrow_material_group) return [];
  const peers = byNarrowGroup!.get(self.narrow_material_group) ?? [];
  return peers.filter((p) => p.material !== material);
}
