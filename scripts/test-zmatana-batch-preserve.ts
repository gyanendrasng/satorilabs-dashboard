/**
 * Regression test for the zmatana-data callback's batch handling
 * (src/app/backend/orders/aman/zmatana-data/route.ts).
 *
 *   DATABASE_URL="file:/tmp/x.db" npx prisma db push --skip-generate \
 *     && DATABASE_URL="file:/tmp/x.db" npx tsx scripts/test-zmatana-batch-preserve.ts
 *
 * Bug: auto_gui2 sometimes echoes materials as bare CODE STRINGS (no batch).
 * The old code set batch='N/A' and the upsert update OVERWROTE an already-
 * fetched real batch ("P"), breaking the downstream ZLOAD2 PDF reconcile.
 * Fix: only overwrite batch on update when SAP actually returned one.
 *
 * Exits 0 on pass, 1 on fail. Cleans up its own fixtures.
 */

import { prisma } from '../src/lib/prisma';
import { POST as zmatanaPost } from '../src/app/backend/orders/aman/zmatana-data/route';

const RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';
let failed = false;
const pass = (m: string) => console.log(`${GREEN}✓ PASS${RESET} ${m}`);
const fail = (m: string) => { console.error(`${RED}✗ FAIL${RESET} ${m}`); failed = true; };

const PO_NUMBER = `ZMAT-TEST-${Math.floor(Date.now() % 1e9)}`;
const SO_NUMBER = `${Math.floor(Date.now() % 1e7)}`;
const TARGET = 'YO00000530000SOP';
const NEWMAT = 'YNEWMAT0000000PJP';

const postZmatana = (body: unknown) =>
  zmatanaPost(new Request('http://test/zmatana-data', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }));

const batchOf = async (so: string, mat: string) =>
  (await prisma.material.findFirst({
    where: { salesOrder: { soNumber: so }, material: mat }, select: { batch: true },
  }))?.batch;

async function main() {
  const po = await prisma.purchaseOrder.create({
    data: { poNumber: PO_NUMBER, customerName: 'Zmatana Test Co', weightage: 12 },
  });
  const so = await prisma.salesOrder.create({
    data: { soNumber: SO_NUMBER, purchaseOrderId: po.id, plant: '1101', visibilityState: 'received' },
  });
  // Existing row with a REAL batch "P" already fetched by a prior lone_zmatana.
  await prisma.material.create({
    data: {
      salesOrderId: so.id, material: TARGET, materialDescription: 'OOWJ 108X108-80 MANGO YELLOW GL UNREC- P',
      batch: 'P', orderQuantity: 200, orderWeightKg: 1900, availableStock: 99999, dispatchQuantity: 200,
    },
  });

  try {
    // E1 — bare-string echo (no batch) must NOT clobber the existing "P".
    await postZmatana({ so_number: SO_NUMBER, materials: [TARGET] });
    if ((await batchOf(SO_NUMBER, TARGET)) === 'P') pass('E1: bare-string echo (no batch) preserves existing "P"');
    else fail(`E1: batch = "${await batchOf(SO_NUMBER, TARGET)}" (expected "P")`);

    // E2 — an object WITH a real batch "Q" updates the row.
    await postZmatana({ so_number: SO_NUMBER, materials: [{ material: TARGET, batch: 'Q' }] });
    if ((await batchOf(SO_NUMBER, TARGET)) === 'Q') pass('E2: object with batch "Q" updates the row');
    else fail(`E2: batch = "${await batchOf(SO_NUMBER, TARGET)}" (expected "Q")`);

    // E3 — a genuinely-new material with no batch → created with "N/A".
    await postZmatana({ so_number: SO_NUMBER, materials: [{ material: NEWMAT, order_quantity: 5 }] });
    if ((await batchOf(SO_NUMBER, NEWMAT)) === 'N/A') pass('E3: new material with no batch → created with "N/A"');
    else fail(`E3: batch = "${await batchOf(SO_NUMBER, NEWMAT)}" (expected "N/A")`);
  } finally {
    await prisma.material.deleteMany({ where: { salesOrderId: so.id } });
    await prisma.salesOrder.deleteMany({ where: { id: so.id } });
    await prisma.purchaseOrder.deleteMany({ where: { id: po.id } });
    await prisma.$disconnect();
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
