import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { reactivateCoveredShortages } from '@/lib/shortage-reactivator';

const WEBHOOK_API_KEY =
  process.env.WEBHOOK_API_KEY || 'dummy-webhook-api-key-12345';

function validateApiKey(request: Request): boolean {
  const auth = request.headers.get('Authorization');
  if (auth?.startsWith('Bearer ')) {
    return auth.slice(7) === WEBHOOK_API_KEY;
  }
  return request.headers.get('X-API-Key') === WEBHOOK_API_KEY;
}

type RawRow = Record<string, unknown>;

interface NormalizedRow {
  materialDocument: string;
  postingDate: Date;
  entryDate: Date;
  material: string;
  materialDescription: string | null;
  movementType: string;
  quantity: number;
  batch: string;
  baseUnit: string;
  plant: string;
  userName: string | null;
  documentHeaderText: string | null;
  timeOfEntry: string | null;
  purchaseOrder: string | null;
}

function asString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length === 0 ? null : s;
}

function parseDate(v: unknown, field: string): Date {
  const s = asString(v);
  if (!s) throw new Error(`${field} is required`);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`${field} is not a valid date: ${s}`);
  return d;
}

function normalize(r: RawRow, idx: number): NormalizedRow {
  const required = (k: string) => {
    const v = asString(r[k]);
    if (!v) throw new Error(`row ${idx}: missing ${k}`);
    return v;
  };
  const qtyRaw = r.quantity;
  const qty =
    typeof qtyRaw === 'number'
      ? qtyRaw
      : typeof qtyRaw === 'string'
      ? Number(qtyRaw)
      : NaN;
  if (!Number.isFinite(qty) || !Number.isInteger(qty)) {
    throw new Error(`row ${idx}: quantity must be an integer, got ${qtyRaw}`);
  }
  return {
    materialDocument: required('material_document'),
    postingDate: parseDate(r.posting_date, `row ${idx}: posting_date`),
    entryDate: parseDate(r.entry_date, `row ${idx}: entry_date`),
    material: required('material'),
    materialDescription: asString(r.material_description),
    movementType: required('movement_type'),
    quantity: qty,
    batch: required('batch'),
    baseUnit: asString(r.base_unit) ?? 'BOX',
    plant: required('plant'),
    userName: asString(r.user_name),
    documentHeaderText: asString(r.document_header_text),
    timeOfEntry: asString(r.time_of_entry),
    purchaseOrder: asString(r.purchase_order),
  };
}

export async function POST(request: Request) {
  if (!validateApiKey(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (
    !body ||
    typeof body !== 'object' ||
    !Array.isArray((body as { rows?: unknown }).rows)
  ) {
    return NextResponse.json(
      { error: 'Body must be { rows: [...] }' },
      { status: 400 }
    );
  }

  const rawRows = (body as { rows: RawRow[] }).rows;
  if (rawRows.length === 0) {
    return NextResponse.json({ error: 'rows must be non-empty' }, { status: 400 });
  }

  let normalized: NormalizedRow[];
  try {
    normalized = rawRows.map(normalize);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 }
    );
  }

  const postingDates = new Set<string>();
  let inserted = 0;
  let updated = 0;

  for (const row of normalized) {
    postingDates.add(row.postingDate.toISOString().slice(0, 10));
    const result = await prisma.materialReceipt.upsert({
      where: {
        materialDocument_material_batch: {
          materialDocument: row.materialDocument,
          material: row.material,
          batch: row.batch,
        },
      },
      create: row,
      update: row,
    });
    if (result.createdAt.getTime() === result.updatedAt.getTime()) inserted++;
    else updated++;
  }

  const reactivation = await reactivateCoveredShortages();

  return NextResponse.json({
    rowsInserted: inserted,
    rowsUpdated: updated,
    postingDates: [...postingDates].sort(),
    reactivatedSos: reactivation.reactivatedSos,
    shortagesConsidered: reactivation.considered,
  });
}
