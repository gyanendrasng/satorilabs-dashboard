/**
 * Regression test for ZLOAD1 APPEND-mode dedup (src/lib/auto-gui-trigger.ts —
 * triggerZload1 + fanOutZload1AppendToBundle).
 *
 *   DATABASE_URL="file:/tmp/x.db" npx prisma db push --skip-generate \
 *     && DATABASE_URL="file:/tmp/x.db" npx tsx scripts/test-zload1-append-dedup.ts
 *
 * Bug: the ZLOAD1 dedup key was `so:<so>|bundle:<n>` with no append marker. The
 * INITIAL fan-out already left a `done` work row with that key for (SO, Bundle 3),
 * so an `other_bundle` append targeting Bundle 3 dedup-collided and was silently
 * skipped — yet fanOutZload1AppendToBundle returned {fired:1}, so the engine
 * paused on a callback that never came (deadlock).
 *
 * Fix: append-mode key carries `|append|round:<n>|mat:<materials>` so it never
 * collides with the initial fire; triggerZload1 returns whether it enqueued;
 * fanOutZload1AppendToBundle reports fired:0 on a true dedup so the engine
 * advances. A genuine retry (same round + materials) is still deduped.
 *
 * Exits 0/1; cleans up its fixtures.
 */

// Point the work-queue pump at a dead port so its fire-and-forget fetch fails
// silently instead of hitting a real auto_gui2.
process.env.AUTO_GUI_HOST = '127.0.0.1';
process.env.AUTO_GUI_PORT = '59999';

import { prisma } from '../src/lib/prisma';
import { fanOutZload1AppendToBundle } from '../src/lib/auto-gui-trigger';

const RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';
let failed = false;
const pass = (m: string) => console.log(`${GREEN}✓ PASS${RESET} ${m}`);
const fail = (m: string) => { console.error(`${RED}✗ FAIL${RESET} ${m}`); failed = true; };

const PO_NUMBER = `APPDEDUP-${Math.floor(Date.now() % 1e9)}`;
const SO_NUMBER = `${Math.floor(Date.now() % 1e7)}`;
const MAT = 'YH4PULMA00000Y7P';

const appendRows = (soId: string) =>
  prisma.workQueue.findMany({ where: { salesOrderId: soId, step: 'zload1' }, select: { payload: true } });

async function main() {
  const po = await prisma.purchaseOrder.create({
    data: { poNumber: PO_NUMBER, customerName: 'Append Dedup Co', weightage: 12, dispatchRound: 2 },
  });
  const so = await prisma.salesOrder.create({
    data: { soNumber: SO_NUMBER, purchaseOrderId: po.id, plant: '1101' },
  });
  const bundle3 = await prisma.bundle.create({
    data: { purchaseOrderId: po.id, bundleNumber: 3, totalWeightKg: 7000 },
  });
  await prisma.material.create({
    data: {
      salesOrderId: so.id, material: MAT, batch: 'NO1',
      orderQuantity: 73, orderWeightKg: 1563, dispatchQuantity: 73,
    },
  });
  // Simulate the INITIAL fan-out's ZLOAD1 for (SO, Bundle 3): a `done` row with
  // the exact key triggerZload1 builds for initial mode, bundleNumber=3.
  await prisma.workQueue.create({
    data: {
      salesOrderId: so.id, step: 'zload1', state: 'done',
      payload: JSON.stringify({
        transaction_code: 'ZLOAD1', so_number: SO_NUMBER,
        meta: { so_number: SO_NUMBER, bundle_number: 3, dedup_key: `so:${SO_NUMBER}|bundle:3` },
      }),
    },
  });

  try {
    // 1) The append must NOT collide with the initial done row.
    const r1 = await fanOutZload1AppendToBundle({
      salesOrderId: so.id, appendToBundleId: bundle3.id,
      materials: [{ material_code: MAT, batch: 'NO1', quantity: 10 }],
      log: () => {},
    });
    const rows1 = await appendRows(so.id);
    const appendEnqueued = rows1.some((r) => r.payload.includes('append_to_bundle_id'));

    if (r1.fired === 1) pass('append reports fired:1 (not the phantom-success deadlock)');
    else fail(`append fired=${r1.fired}, expected 1 — collided with the initial (SO,bundle) done row`);

    if (appendEnqueued) pass('a distinct append-mode ZLOAD1 work row was actually enqueued');
    else fail('no append-mode work row enqueued — dedup-collided with the initial fire');

    // 2) A genuine retry (same round + same materials) MUST be deduped.
    const r2 = await fanOutZload1AppendToBundle({
      salesOrderId: so.id, appendToBundleId: bundle3.id,
      materials: [{ material_code: MAT, batch: 'NO1', quantity: 10 }],
      log: () => {},
    });
    if (r2.fired === 0) pass('identical retry (same round+materials) is deduped → fired:0');
    else fail(`retry fired=${r2.fired}, expected 0 — append dedup not protecting against re-fire`);
  } finally {
    await prisma.workQueue.deleteMany({ where: { salesOrderId: so.id } });
    await prisma.material.deleteMany({ where: { salesOrderId: so.id } });
    await prisma.bundle.deleteMany({ where: { purchaseOrderId: po.id } });
    await prisma.salesOrder.deleteMany({ where: { id: so.id } });
    await prisma.purchaseOrder.deleteMany({ where: { id: po.id } });
    await prisma.$disconnect();
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
