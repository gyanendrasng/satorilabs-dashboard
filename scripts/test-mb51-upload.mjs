#!/usr/bin/env node
/**
 * E2E test: parse a real MB51 .XLSX exactly the way the new
 * /backend/orders/aman/material_list endpoint does, then ingest via the
 * shared helper. Asserts row count + that material_receipt rows landed.
 *
 * Run:
 *   DATABASE_URL="file:./test-mb51.db" npx prisma db push --schema prisma/schema.prisma --skip-generate
 *   DATABASE_URL="file:./test-mb51.db" npx tsx scripts/test-mb51-upload.mjs <path-to-.xlsx>
 */

import { readFileSync } from 'node:fs';
import * as XLSX from 'xlsx';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const path = process.argv[2];
if (!path) {
  console.error('usage: node scripts/test-mb51-upload.mjs <path-to-.xlsx>');
  process.exit(1);
}

console.log(`[test] parsing ${path}`);
const buf = readFileSync(path);
const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
const sheet = wb.Sheets[wb.SheetNames[0]];
const raw = XLSX.utils.sheet_to_json(sheet, { defval: null, raw: true });
console.log(`[test] parsed ${raw.length} rows from sheet "${wb.SheetNames[0]}"`);
console.log('[test] first row keys:', Object.keys(raw[0] || {}));
console.log('[test] first row sample:', raw[0]);

// Use the route's normalize logic by importing the route module isn't trivial
// in a script, so duplicate the normalization here (kept in sync with the
// route at src/app/backend/orders/aman/material_list/route.ts).
function normalize(r, idx) {
  const get = (...keys) => {
    for (const k of keys) {
      if (r[k] !== undefined && r[k] !== null && r[k] !== '') return r[k];
    }
    return null;
  };
  const required = (label, ...keys) => {
    const v = get(...keys);
    if (v === null || v === undefined) throw new Error(`row ${idx}: missing ${label}`);
    return String(v).trim();
  };
  const optional = (...keys) => {
    const v = get(...keys);
    if (v === null) return null;
    const s = String(v).trim();
    return s.length === 0 ? null : s;
  };
  const dateField = (label, ...keys) => {
    const v = get(...keys);
    if (v instanceof Date) return v;
    if (typeof v === 'string') {
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) throw new Error(`row ${idx}: ${label} bad date: ${v}`);
      return d;
    }
    if (typeof v === 'number') {
      const epoch = new Date(Date.UTC(1899, 11, 30));
      return new Date(epoch.getTime() + v * 86400000);
    }
    throw new Error(`row ${idx}: ${label} required`);
  };
  const intField = (label, ...keys) => {
    const v = get(...keys);
    if (typeof v === 'number') return Math.round(v);
    if (typeof v === 'string') {
      const n = Number(v.trim());
      if (Number.isFinite(n)) return Math.round(n);
    }
    throw new Error(`row ${idx}: ${label} not a number: ${v}`);
  };
  const timeField = (...keys) => {
    const v = get(...keys);
    if (v === null) return null;
    if (v instanceof Date) {
      const hh = String(v.getUTCHours()).padStart(2, '0');
      const mm = String(v.getUTCMinutes()).padStart(2, '0');
      const ss = String(v.getUTCSeconds()).padStart(2, '0');
      return `${hh}:${mm}:${ss}`;
    }
    return String(v).trim() || null;
  };
  // Mirror route: merge Entry Date + Time of Entry into one timestamp
  const rawEntryDate = dateField('Entry Date', 'Entry Date');
  const entryTime = timeField('Time of Entry');
  const entryDateMerged = (() => {
    if (!entryTime) return rawEntryDate;
    const [h, m, s] = entryTime.split(':').map((p) => Number.parseInt(p, 10));
    if (Number.isNaN(h)) return rawEntryDate;
    const merged = new Date(rawEntryDate);
    merged.setUTCHours(h, Number.isFinite(m) ? m : 0, Number.isFinite(s) ? s : 0, 0);
    return merged;
  })();
  return {
    materialDocument: required('Material Document', 'Material Document'),
    postingDate: dateField('Posting Date', 'Posting Date'),
    entryDate: entryDateMerged,
    material: required('Material', 'Material'),
    materialDescription: optional('Material Description'),
    movementType: required('Movement Type', 'Movement Type'),
    quantity: intField('Quantity', 'Quantity'),
    batch: required('Batch', 'Batch'),
    baseUnit: optional('Base Unit of Measure') ?? 'BOX',
    plant: required('Plant', 'Plant'),
    userName: optional('User name', 'User Name'),
    documentHeaderText: optional('Document Header Text'),
    timeOfEntry: timeField('Time of Entry'),
    purchaseOrder: optional('Purchase Order'),
  };
}

const dataRows = raw.filter((r) => {
  const md = r['Material Document'];
  return md !== undefined && md !== null && String(md).trim() !== '';
});
console.log(`[test] kept ${dataRows.length}/${raw.length} non-empty rows`);
const rows = dataRows.map(normalize);
console.log(`[test] normalized ${rows.length} rows`);
console.log('[test] first normalized:', rows[0]);

const { ingestMaterialReceipts } = await import('../src/lib/material-receipts-ingest.ts');

await prisma.materialReceipt.deleteMany({});
console.log('[test] cleared material_receipt');

const result = await ingestMaterialReceipts(rows);
console.log('[test] ingest result:', JSON.stringify(result, null, 2));

const persisted = await prisma.materialReceipt.count();
console.log(`[test] persisted ${persisted} material_receipt rows`);

// Upserts on (materialDocument, material, batch) — duplicate keys in input
// collapse, which is correct. Compare against unique-key count instead.
const uniqueKeys = new Set(rows.map((r) => `${r.materialDocument}|${r.material}|${r.batch}`));
console.log(`[test] unique keys in input: ${uniqueKeys.size}`);
if (persisted !== uniqueKeys.size) {
  console.error(`[test] ❌ FAIL: persisted=${persisted}, expected unique-key-count=${uniqueKeys.size}`);
  process.exit(1);
}
console.log('[test] ✅ PASS — all unique receipt rows persisted');
await prisma.$disconnect();
