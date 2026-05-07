import { NextResponse } from 'next/server';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import * as XLSX from 'xlsx';
import { ingestMaterialReceipts, type NormalizedReceiptRow } from '@/lib/material-receipts-ingest';

/**
 * POST /backend/orders/aman/material_list
 *
 * Receives the .XLSX file auto-gui2 saves after running MB51 in SAP. The
 * upload arrives as multipart/form-data with field `file` containing the
 * raw .XLSX. auto-gui2's send_data passes meta keys (so_number, work_id,
 * posting_date, etc.) as additional form fields — currently ignored here.
 *
 * Schema (per the MB51 export): 14 columns headed
 *   Material Document, Entry Date, Posting Date, Material, Material Description,
 *   Movement Type, Quantity, Batch, User name, Base Unit of Measure, Plant,
 *   Document Header Text, Time of Entry, Purchase Order
 *
 * Each row → upserted into material_receipt on (materialDocument, material, batch).
 * Then runs the FCFS shortage reactivator. Idempotent — re-upload of the same
 * posting date is safe.
 */
export async function POST(request: Request) {
  console.log('[MaterialList] POST received, content-type:', request.headers.get('content-type'));

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch (err) {
    console.error('[MaterialList] formData parse failed:', err);
    return NextResponse.json(
      { error: 'Expected multipart/form-data with a `file` field', details: String(err) },
      { status: 400 }
    );
  }

  // Log every field we got so we can see what auto-gui2 actually sent.
  for (const [k, v] of formData.entries()) {
    if (v instanceof Blob) {
      console.log(`[MaterialList] field "${k}": Blob size=${v.size} type=${v.type}`);
    } else {
      console.log(`[MaterialList] field "${k}":`, String(v).slice(0, 200));
    }
  }

  const file = formData.get('file');
  if (!(file instanceof Blob)) {
    console.error('[MaterialList] no Blob under "file" key');
    return NextResponse.json(
      { error: 'No `file` in form data — auto-gui2 should send the .XLSX as the file field' },
      { status: 400 }
    );
  }

  let rows: NormalizedReceiptRow[];
  try {
    const buf = Buffer.from(await file.arrayBuffer());

    // Dump every upload to /tmp/mb51-uploads/ so we can inspect what auto-gui2
    // actually sent. Filename includes timestamp + original name when present.
    try {
      const dumpDir = '/tmp/mb51-uploads';
      await mkdir(dumpDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const origName = (file as { name?: string }).name || 'upload.xlsx';
      const safeName = origName.replace(/[^a-zA-Z0-9._-]/g, '_');
      const dumpPath = join(dumpDir, `${stamp}_${safeName}`);
      await writeFile(dumpPath, buf);
      console.log(`[MaterialList] dumped upload to ${dumpPath} (${buf.length} bytes)`);
    } catch (dumpErr) {
      console.warn('[MaterialList] failed to dump upload to disk:', dumpErr);
    }

    const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
    const sheetName = wb.SheetNames[0];
    if (!sheetName) {
      return NextResponse.json({ error: 'Workbook has no sheets' }, { status: 400 });
    }
    const sheet = wb.Sheets[sheetName];
    const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
      defval: null,
      raw: true,
    });
    // MB51 exports often have trailing empty rows / a totals row at the bottom.
    // Skip anything that doesn't have a Material Document.
    const dataRows = raw.filter((r) => {
      const md = r['Material Document'] ?? r['material_document'];
      return md !== undefined && md !== null && String(md).trim() !== '';
    });
    rows = dataRows.map(normalizeRow);
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to parse .XLSX', details: err instanceof Error ? err.message : String(err) },
      { status: 400 }
    );
  }

  // Empty MB51 (no production that day) is a legitimate state, not an error.
  // Skip ingest but still run the reactivator — it's idempotent and may
  // resolve shortages from prior days' accumulated receipts.
  if (rows.length === 0) {
    console.log('[MaterialList] sheet has no data rows — likely a no-production day');
    const result = await ingestMaterialReceipts([]);
    return NextResponse.json({ ...result, note: 'no rows in sheet — reactivator ran anyway' });
  }

  const result = await ingestMaterialReceipts(rows);
  return NextResponse.json(result);
}

function normalizeRow(r: Record<string, unknown>, idx: number): NormalizedReceiptRow {
  const get = (...keys: string[]): unknown => {
    for (const k of keys) {
      if (r[k] !== undefined && r[k] !== null && r[k] !== '') return r[k];
    }
    return null;
  };
  const required = (label: string, ...keys: string[]): string => {
    const v = get(...keys);
    if (v === null || v === undefined) {
      throw new Error(`row ${idx}: missing column ${label}`);
    }
    return String(v).trim();
  };
  const optional = (...keys: string[]): string | null => {
    const v = get(...keys);
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    return s.length === 0 ? null : s;
  };
  const dateField = (label: string, ...keys: string[]): Date => {
    const v = get(...keys);
    if (v instanceof Date) return v;
    if (typeof v === 'string') {
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) throw new Error(`row ${idx}: ${label} is not a valid date: ${v}`);
      return d;
    }
    if (typeof v === 'number') {
      // Excel serial date — should be rare since cellDates:true converts most
      const epoch = new Date(Date.UTC(1899, 11, 30));
      return new Date(epoch.getTime() + v * 86400000);
    }
    throw new Error(`row ${idx}: ${label} required`);
  };
  const intField = (label: string, ...keys: string[]): number => {
    const v = get(...keys);
    if (typeof v === 'number') {
      if (!Number.isInteger(v)) return Math.round(v);
      return v;
    }
    if (typeof v === 'string') {
      const n = Number(v.trim());
      if (Number.isFinite(n) && Number.isInteger(n)) return n;
    }
    throw new Error(`row ${idx}: ${label} must be an integer, got ${v}`);
  };
  const timeField = (...keys: string[]): string | null => {
    const v = get(...keys);
    if (v === null || v === undefined) return null;
    if (v instanceof Date) {
      const hh = String(v.getUTCHours()).padStart(2, '0');
      const mm = String(v.getUTCMinutes()).padStart(2, '0');
      const ss = String(v.getUTCSeconds()).padStart(2, '0');
      return `${hh}:${mm}:${ss}`;
    }
    return String(v).trim() || null;
  };
  // Excel exports the Entry Date column as date-only at midnight, with the
  // actual SAP posting time in a separate Time of Entry column. Splice them
  // into one timestamp so the FCFS reactivator's `entryDate >= recordedAt`
  // window is precise to the second — otherwise same-day MB51 uploads taken
  // shortly after a wait reply will never count, since midnight < the wait's
  // recordedAt.
  const mergeDateAndTime = (date: Date, time: string | null): Date => {
    if (!time) return date;
    const [h, m, s] = time.split(':').map((p) => Number.parseInt(p, 10));
    if (Number.isNaN(h)) return date;
    const merged = new Date(date);
    merged.setUTCHours(h, Number.isFinite(m) ? m : 0, Number.isFinite(s) ? s : 0, 0);
    return merged;
  };

  const rawEntryDate = dateField('Entry Date', 'Entry Date', 'entry_date');
  const entryTime = timeField('Time of Entry', 'time_of_entry');
  const entryDate = mergeDateAndTime(rawEntryDate, entryTime);

  return {
    materialDocument: required('Material Document', 'Material Document', 'material_document'),
    postingDate: dateField('Posting Date', 'Posting Date', 'posting_date'),
    entryDate,
    material: required('Material', 'Material', 'material'),
    materialDescription: optional('Material Description', 'material_description'),
    movementType: required('Movement Type', 'Movement Type', 'movement_type'),
    quantity: intField('Quantity', 'Quantity', 'quantity'),
    batch: required('Batch', 'Batch', 'batch'),
    baseUnit: optional('Base Unit of Measure', 'base_unit') ?? 'BOX',
    plant: required('Plant', 'Plant', 'plant'),
    userName: optional('User name', 'User Name', 'user_name'),
    documentHeaderText: optional('Document Header Text', 'document_header_text'),
    timeOfEntry: timeField('Time of Entry', 'time_of_entry'),
    purchaseOrder: optional('Purchase Order', 'purchase_order'),
  };
}
