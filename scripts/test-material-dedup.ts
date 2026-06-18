/**
 * Focused regression test for the Material (salesOrderId, material) unique
 * constraint change. Reproduces the duplicate-row bug:
 *   - Round 1 ZSO_Visibility returns batch="D-01,D-02,CP01" for material M.
 *   - Round 2 returns batch="CP-04,CP01,D-02,D-01" (reordered + augmented).
 * With the OLD 3-key (salesOrderId, material, batch) this created TWO rows.
 * With the NEW 2-key it must UPDATE the single row in place.
 *
 * Mirrors the exact upsert shape used in
 * src/app/backend/orders/aman/visibility-data/route.ts.
 *
 *   npx tsx scripts/test-material-dedup.ts
 *
 * Exits 0 on pass, 1 on fail. Cleans up its own fixtures.
 */

import { prisma } from '../src/lib/prisma';

const PO_NUMBER = `DEDUP-TEST-${Math.floor(Date.now() % 1e9)}`;
const MATERIAL = 'YV7HATLI00000PJP';

async function upsertLikeVisibility(salesOrderId: string, batch: string, qty: number, avail: number) {
  await prisma.material.upsert({
    where: { salesOrderId_material: { salesOrderId, material: MATERIAL } },
    update: {
      materialDescription: 'HATTIE LIME SPDR-P',
      batch,
      orderQuantity: qty,
      availableStock: avail,
      orderWeightKg: null,
    },
    create: {
      salesOrderId,
      material: MATERIAL,
      materialDescription: 'HATTIE LIME SPDR-P',
      batch,
      orderQuantity: qty,
      availableStock: avail,
      orderWeightKg: null,
    },
  });
}

async function main() {
  let failed = false;

  const po = await prisma.purchaseOrder.create({
    data: { poNumber: PO_NUMBER, customerName: 'Dedup Test Co' },
  });
  const so = await prisma.salesOrder.create({
    data: { soNumber: '9999999', purchaseOrderId: po.id, plant: '1101' },
  });

  try {
    // Round 1 — first visibility run.
    await upsertLikeVisibility(so.id, 'D-01,D-02,CP01', 50, 17);
    // Round 2 — second visibility run, reordered + augmented batch string.
    await upsertLikeVisibility(so.id, 'CP-04,CP01,D-02,D-01', 50, 50);

    const rows = await prisma.material.findMany({
      where: { salesOrderId: so.id, material: MATERIAL },
    });

    if (rows.length !== 1) {
      console.error(`✗ FAIL: expected exactly 1 Material row, got ${rows.length}`);
      for (const r of rows) console.error(`    id=${r.id} batch="${r.batch}" qty=${r.orderQuantity} avail=${r.availableStock}`);
      failed = true;
    } else {
      const r = rows[0];
      const okBatch = r.batch === 'CP-04,CP01,D-02,D-01';
      const okAvail = r.availableStock === 50;
      if (okBatch && okAvail) {
        console.log(`✓ PASS: single row, batch overwritten to round-2 value, availableStock=${r.availableStock}`);
      } else {
        console.error(`✗ FAIL: single row but stale fields. batch="${r.batch}" (expected "CP-04,CP01,D-02,D-01"), avail=${r.availableStock} (expected 50)`);
        failed = true;
      }
    }
  } finally {
    // Cleanup — Material cascades on SalesOrder delete; delete SO then PO.
    await prisma.material.deleteMany({ where: { salesOrderId: so.id } });
    await prisma.salesOrder.delete({ where: { id: so.id } });
    await prisma.purchaseOrder.delete({ where: { id: po.id } });
  }

  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
