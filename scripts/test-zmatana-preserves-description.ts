/**
 * Regression test for the description-clobber bug (SO 3382184).
 *
 *   npx tsx scripts/test-zmatana-preserves-description.ts   (or: npm test)
 *
 * A delta-scoped LONE-ZMATANA (a post-plant_ls increase on an already-loaded
 * material) reports only batch + free stock — it carries NO material_description.
 * If the SAP code is also absent from the static product DB (e.g.
 * YAFPLNA00000043P, whose description "OAFFJ 600X600-4 …" only ever came from
 * ZSO-VISIBILITY), the /zmatana-data callback resolves description → null.
 *
 * Bug: the Material upsert wrote that null on UPDATE, WIPING the real
 * description. The downstream ZLOAD1/ZLOAD2 PDF reconcile matches rows by
 * (description, batch); with the description gone it skipped the row and fell
 * back to the family prefix, mangling the LSI code (YAFPLNA00000043P → "OAFFJ")
 * — which then broke the bundle-weight rollup and the vehicle-details email.
 *
 * Fix: guard materialDescription on UPDATE exactly like batch — only overwrite
 * when a non-empty value was resolved. This test drives the real POST handler.
 *
 * Exits 0/1; cleans up its fixtures.
 */

import { prisma } from '../src/lib/prisma';
import { POST as zmatanaPost } from '../src/app/backend/orders/aman/zmatana-data/route';

const RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';
let failed = false;
const pass = (m: string) => console.log(`${GREEN}✓ PASS${RESET} ${m}`);
const fail = (m: string) => { console.error(`${RED}✗ FAIL${RESET} ${m}`); failed = true; };

const MAT = 'YAFPLNA00000043P'; // real SAP code, deliberately NOT in product_database.json
const REAL_DESC = 'OAFFJ 600X600-4 REC PLANK NATURAL MDR-P';

async function seed(soNumber: string, desc: string | null) {
  const po = await prisma.purchaseOrder.create({
    data: { poNumber: `ZMD-${soNumber}`, customerName: 'ZMD Co', weightage: 12, dispatchRound: 3 },
  });
  const so = await prisma.salesOrder.create({ data: { soNumber, purchaseOrderId: po.id, plant: '1101' } });
  await prisma.material.create({
    data: { salesOrderId: so.id, material: MAT, materialDescription: desc, batch: 'LD-01', orderQuantity: 200, dispatchQuantity: 200 },
  });
  return { poId: po.id, soId: so.id };
}

function post(body: unknown) {
  return zmatanaPost(
    new Request('http://localhost/backend/orders/aman/zmatana-data', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

async function cleanup(soId: string, poId: string) {
  await prisma.scenarioEvent.deleteMany({ where: { salesOrderId: soId } });
  await prisma.material.deleteMany({ where: { salesOrderId: soId } });
  await prisma.salesOrder.deleteMany({ where: { id: soId } });
  await prisma.purchaseOrder.deleteMany({ where: { id: poId } });
}

async function main() {
  try {
    // Case 1 — THE BUG: delta-scoped LONE-ZMATANA with no description, code not
    // in the product DB. The real description must SURVIVE.
    {
      const so = 'ZMD-PRESERVE-1';
      const { poId, soId } = await seed(so, REAL_DESC);
      try {
        await post({ so_number: so, materials: [{ material: MAT, available_stock_for_so: 250 }] });
        const m = await prisma.material.findFirst({ where: { salesOrderId: soId, material: MAT } });
        if (m?.materialDescription === REAL_DESC) pass('no-description LONE-ZMATANA preserves the real description');
        else fail(`description was clobbered: got "${m?.materialDescription ?? '<null>'}" (expected "${REAL_DESC}")`);
        if (m?.batch === 'LD-01') pass('batch preserved (existing guard)');
        else fail(`batch changed: got "${m?.batch}" (expected "LD-01")`);
        if (m?.availableStock === 250) pass('availableStock still updated (guard does not block real fields)');
        else fail(`availableStock not updated: got ${m?.availableStock} (expected 250)`);
      } finally {
        await cleanup(soId, poId);
      }
    }

    // Case 2 — guard must NOT block a legitimate update: when SAP DOES supply a
    // description (e.g. a cross-plant substitution), it should overwrite.
    {
      const so = 'ZMD-UPDATE-1';
      const { poId, soId } = await seed(so, 'STALE DESC');
      try {
        await post({ so_number: so, materials: [{ material: MAT, material_description: 'NEW DESC FROM SAP', available_stock_for_so: 5 }] });
        const m = await prisma.material.findFirst({ where: { salesOrderId: soId, material: MAT } });
        if (m?.materialDescription === 'NEW DESC FROM SAP') pass('a SAP-supplied description still updates (guard only blocks null/empty)');
        else fail(`supplied description did not update: got "${m?.materialDescription}" (expected "NEW DESC FROM SAP")`);
      } finally {
        await cleanup(soId, poId);
      }
    }
  } finally {
    await prisma.$disconnect();
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
