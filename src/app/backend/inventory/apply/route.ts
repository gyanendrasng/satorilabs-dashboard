import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

/**
 * Apply a batch of manual edits to `inventory_snapshot` (the free-stock table
 * the stock pre-check reads). Powers the editor UI at src/app/(app)/inventory.
 *
 * Every change is keyed by the (material, plant) unique. The whole batch runs in
 * one transaction — partial failures roll back, so the confirmation the user saw
 * matches what lands. The response carries an `inverse` batch: re-POSTing it to
 * this same endpoint undoes exactly what was just applied (single-level undo).
 *
 * Policy: manual edits win immediately and are NOT protected from the 15-min
 * auto-sync (see inventory-sync.ts) — a later sync that reports the same
 * material can overwrite the manual value. That trade-off was chosen
 * deliberately to avoid a schema/flag change.
 */

type AddChange = {
  op: 'add';
  material: string;
  plant: string;
  freeStock: number;
  materialDescription?: string | null;
  vertical?: string | null;
};
type UpdateChange = {
  op: 'update';
  material: string;
  plant: string;
  fields: {
    freeStock?: number;
    materialDescription?: string | null;
    vertical?: string | null;
  };
};
type DeleteChange = { op: 'delete'; material: string; plant: string };
type Change = AddChange | UpdateChange | DeleteChange;

/** Trim to a non-empty string, or null (so "" and whitespace store as NULL). */
function normStr(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function assertFreeStock(v: unknown, label: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`Invalid free stock for ${label}: must be a whole number ≥ 0`);
  }
  return n;
}

export async function POST(request: Request) {
  let body: { changes?: Change[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const changes = Array.isArray(body.changes) ? body.changes : [];
  if (changes.length === 0) {
    return NextResponse.json({ error: 'No changes provided' }, { status: 400 });
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const inverse: Change[] = [];
      const applied: Array<{ op: string; material: string; plant: string }> = [];

      for (const ch of changes) {
        const material = String(ch.material ?? '').trim();
        const plant = String(ch.plant ?? '').trim();
        if (!material || !plant) {
          throw new Error('Each change needs both a material code and a plant');
        }
        const label = `${material} @ ${plant}`;
        const existing = await tx.inventorySnapshot.findUnique({
          where: { material_plant: { material, plant } },
        });

        if (ch.op === 'add') {
          if (existing) throw new Error(`Cannot add ${label}: a row already exists`);
          await tx.inventorySnapshot.create({
            data: {
              material,
              plant,
              freeStock: assertFreeStock(ch.freeStock, label),
              materialDescription: normStr(ch.materialDescription),
              vertical: normStr(ch.vertical),
            },
          });
          inverse.push({ op: 'delete', material, plant });
          applied.push({ op: 'add', material, plant });
        } else if (ch.op === 'delete') {
          if (!existing) throw new Error(`Cannot delete ${label}: no such row`);
          await tx.inventorySnapshot.delete({
            where: { material_plant: { material, plant } },
          });
          // Inverse re-creates the exact row we removed.
          inverse.push({
            op: 'add',
            material,
            plant,
            freeStock: existing.freeStock,
            materialDescription: existing.materialDescription,
            vertical: existing.vertical,
          });
          applied.push({ op: 'delete', material, plant });
        } else if (ch.op === 'update') {
          if (!existing) throw new Error(`Cannot update ${label}: no such row`);
          const fields = ch.fields ?? {};
          const data: Record<string, unknown> = {};
          const oldFields: UpdateChange['fields'] = {};
          if (fields.freeStock !== undefined) {
            data.freeStock = assertFreeStock(fields.freeStock, label);
            oldFields.freeStock = existing.freeStock;
          }
          if (fields.materialDescription !== undefined) {
            data.materialDescription = normStr(fields.materialDescription);
            oldFields.materialDescription = existing.materialDescription;
          }
          if (fields.vertical !== undefined) {
            data.vertical = normStr(fields.vertical);
            oldFields.vertical = existing.vertical;
          }
          if (Object.keys(data).length === 0) continue; // nothing actually changed
          data.syncedAt = new Date(); // reflect the manual touch time in the grid
          await tx.inventorySnapshot.update({
            where: { material_plant: { material, plant } },
            data,
          });
          // Inverse restores only the fields we touched, to their prior values.
          inverse.push({ op: 'update', material, plant, fields: oldFields });
          applied.push({ op: 'update', material, plant });
        } else {
          throw new Error(`Unknown op: ${String((ch as { op?: unknown }).op)}`);
        }
      }

      // Undo should unwind in reverse application order.
      inverse.reverse();
      return { applied, inverse };
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}
