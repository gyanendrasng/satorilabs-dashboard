/**
 * Focused regression test for the stock_precheck 3-way per-material verdict
 * (fully / partial / none) added for the LS-created "don't preserve" path.
 *
 * Seeds InventorySnapshot rows at the SO's plant and asserts runStockPrecheck
 * surfaces the correct `perMaterial` verdict per increased material:
 *   - avail >= requested            → 'fully'
 *   - 0 < avail < requested         → 'partial'
 *   - avail == 0 (no snapshot row)  → 'none'
 *
 *   npx tsx scripts/test-stock-precheck-3way.ts
 *
 * Exits 0 on pass, 1 on fail. Cleans up its own fixtures.
 * NOTE: materials are chosen to have NO cross-plant equivalent in the product
 * DB so substitution doesn't mask the partial/none verdicts under test.
 */

import { prisma } from '../src/lib/prisma';
import { runStockPrecheck } from '../src/lib/stock-precheck';

const RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';
const pass = (m: string) => console.log(`${GREEN}✓ PASS${RESET} ${m}`);
const fail = (m: string) => { console.error(`${RED}✗ FAIL${RESET} ${m}`); failed = true; };
let failed = false;

const PO_NUMBER = `S3W-TEST-${Math.floor(Date.now() % 1e9)}`;
const PLANT = '1101';
const M_FULLY = 'ZZ3WFULLY0000PJP';
const M_PARTIAL = 'ZZ3WPARTL0000PJP';
const M_NONE = 'ZZ3WNONE00000PJP';

async function main() {
  const po = await prisma.purchaseOrder.create({
    data: { poNumber: PO_NUMBER, customerName: 'Stock 3-way Co' },
  });
  const so = await prisma.salesOrder.create({
    data: { soNumber: `${Math.floor(Date.now() % 1e7)}`, purchaseOrderId: po.id, plant: PLANT },
  });
  // FULLY: 100 free, requesting 50. PARTIAL: 20 free, requesting 50.
  // NONE: no snapshot row at all → freeStock treated as 0.
  await prisma.inventorySnapshot.create({ data: { material: M_FULLY, plant: PLANT, freeStock: 100 } });
  await prisma.inventorySnapshot.create({ data: { material: M_PARTIAL, plant: PLANT, freeStock: 20 } });

  try {
    const result = await runStockPrecheck({
      salesOrderId: so.id,
      classification: {
        materials: [
          { material_code: M_FULLY, operation: 'inc', quantity: 50 },
          { material_code: M_PARTIAL, operation: 'inc', quantity: 50 },
          { material_code: M_NONE, operation: 'inc', quantity: 50 },
        ],
      },
    });

    if (!('perMaterial' in result)) {
      fail(`result has no perMaterial field (outcome=${result.outcome})`);
    } else {
      const byCode = new Map(result.perMaterial.map((p) => [p.material, p]));
      const check = (code: string, want: 'fully' | 'partial' | 'none') => {
        const v = byCode.get(code);
        if (!v) return fail(`${code}: no perMaterial verdict`);
        if (v.verdict === want) pass(`${code}: verdict=${want} (req=${v.requested}, avail=${v.available})`);
        else fail(`${code}: expected ${want}, got ${v.verdict} (req=${v.requested}, avail=${v.available})`);
      };
      check(M_FULLY, 'fully');
      check(M_PARTIAL, 'partial');
      check(M_NONE, 'none');
    }
  } finally {
    await prisma.inventorySnapshot.deleteMany({ where: { material: { in: [M_FULLY, M_PARTIAL, M_NONE] }, plant: PLANT } });
    await prisma.salesOrder.delete({ where: { id: so.id } });
    await prisma.purchaseOrder.delete({ where: { id: po.id } });
  }

  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
