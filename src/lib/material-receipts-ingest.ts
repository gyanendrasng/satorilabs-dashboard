import { prisma } from './prisma';
import { reactivateCoveredShortages } from './shortage-reactivator';

export interface NormalizedReceiptRow {
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

export interface IngestResult {
  rowsInserted: number;
  rowsUpdated: number;
  postingDates: string[];
  reactivatedSos: string[];
  shortagesConsidered: number;
}

/**
 * Persist a batch of MB51 receipt rows and run the FCFS shortage reactivator.
 * Idempotent: re-uploading the same posting date upserts on the natural key
 * (materialDocument, material, batch).
 *
 * Used by both the JSON upload endpoint and the multipart .XLSX endpoint.
 */
export async function ingestMaterialReceipts(
  rows: NormalizedReceiptRow[]
): Promise<IngestResult> {
  const postingDates = new Set<string>();
  let inserted = 0;
  let updated = 0;

  for (const row of rows) {
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

  return {
    rowsInserted: inserted,
    rowsUpdated: updated,
    postingDates: [...postingDates].sort(),
    reactivatedSos: reactivation.reactivatedSos,
    shortagesConsidered: reactivation.considered,
  };
}
