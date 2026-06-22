/**
 * Regression test for the SO 3382184 description-clobber, fixed at the SOURCE.
 *
 *   npx tsx scripts/test-lone-zmatana-meta-no-clobber.ts   (or: npm test)
 *
 * Root cause: the LONE-ZMATANA work payload carried a bare-code `materials`
 * array in its `meta`. auto_gui POSTs the rich policy-optimiser JSON file back
 * to /zmatana-data and merges this meta OVER the file (json_data.update(meta)),
 * so `meta.materials` (bare codes) overwrote the file's rich materials objects —
 * the dashboard then saw codes with no description/batch and nulled the row.
 *
 * Fix (our side, leaving auto_gui untouched): the meta must carry NO key named
 * `materials` (that's the one that collides with the file). The requested code
 * list is kept under the non-colliding name `materials_codes`; the routing
 * fields (materials_key / dedup_key / materials_detail) stay. Matches
 * ZSO-VISIBILITY, whose meta never had a `materials` key.
 *
 * This test asserts the enqueued LONE-ZMATANA payload's meta has NO `materials`
 * key, that the codes are preserved under `materials_codes`, and that the
 * delta/dedup fields survive. Exits 0/1; cleans up.
 */

process.env.AUTO_GUI_HOST = '127.0.0.1';
process.env.AUTO_GUI_PORT = '59999'; // dead port — pumpQueue's send fails fast; the row is already enqueued

import { prisma } from '../src/lib/prisma';
import { triggerLoneZmatana } from '../src/lib/auto-gui-trigger';

const RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';
let failed = false;
const pass = (m: string) => console.log(`${GREEN}✓ PASS${RESET} ${m}`);
const fail = (m: string) => { console.error(`${RED}✗ FAIL${RESET} ${m}`); failed = true; };

async function main() {
  const soNumber = `LZM-META-${Math.floor(Date.now() % 1e7)}`;
  const po = await prisma.purchaseOrder.create({
    data: { poNumber: `LZM-${soNumber}`, customerName: 'LZM Co', weightage: 12, dispatchRound: 3 },
  });
  const so = await prisma.salesOrder.create({ data: { soNumber, purchaseOrderId: po.id, plant: '1101' } });
  try {
    // pumpQueue tries to reach the (dead) auto_gui — swallow that; the row is
    // enqueued before the send, so its payload is what we assert on.
    try {
      await triggerLoneZmatana(soNumber, [{ material: 'YAFPLNA00000043P', delta: 50 }]);
    } catch { /* dead-port send failure is expected */ }

    const row = await prisma.workQueue.findFirst({
      where: { step: 'lone_zmatana', salesOrderId: so.id },
      select: { payload: true },
    });
    if (!row) { fail('no lone_zmatana work row was enqueued'); return; }

    const payload = JSON.parse(row.payload) as { meta?: Record<string, unknown> };
    const meta = payload.meta ?? {};

    // THE FIX: the colliding bare-code `materials` key must be gone so auto_gui
    // can't echo it over the file's rich materials array.
    if (!('materials' in meta)) pass('meta has NO `materials` key (cannot clobber the file)');
    else fail(`meta still carries a colliding 'materials' key: ${JSON.stringify(meta.materials)} — will clobber the rich file`);

    // Requested codes preserved under the non-colliding `materials_codes`.
    const codes = meta.materials_codes as string[] | undefined;
    if (Array.isArray(codes) && codes.length === 1 && codes[0] === 'YAFPLNA00000043P')
      pass('requested codes preserved under non-colliding `materials_codes`');
    else fail(`materials_codes missing/wrong: ${JSON.stringify(codes)}`);

    // The fields auto_gui actually uses (and that DON'T collide) must survive.
    const detail = meta.materials_detail as Array<{ material: string; delta: number | null }> | undefined;
    if (Array.isArray(detail) && detail[0]?.material === 'YAFPLNA00000043P' && detail[0]?.delta === 50)
      pass('materials_detail (per-material delta) preserved');
    else fail(`materials_detail missing/wrong: ${JSON.stringify(detail)}`);

    if (meta.materials_key === 'YAFPLNA00000043P') pass('materials_key preserved (dedup display)');
    else fail(`materials_key wrong: ${JSON.stringify(meta.materials_key)}`);

    if (typeof meta.dedup_key === 'string' && (meta.dedup_key as string).includes('YAFPLNA00000043P/50'))
      pass('dedup_key preserved (cycle-aware dedup intact)');
    else fail(`dedup_key wrong: ${JSON.stringify(meta.dedup_key)}`);
  } finally {
    await prisma.workQueue.deleteMany({ where: { salesOrderId: so.id } });
    await prisma.salesOrder.deleteMany({ where: { id: so.id } });
    await prisma.purchaseOrder.deleteMany({ where: { id: po.id } });
    await prisma.$disconnect();
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
