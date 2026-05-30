#!/usr/bin/env node
/**
 * E2E test for cancelWork — cancelling still-queued WorkQueue items while
 * refusing to cancel anything that has already fired.
 *
 * Asserts:
 *   1. A `queued` row cancels → state='cancelled', finishedAt set.
 *   2. A `firing` row refuses to cancel → reason='already_firing'.
 *   3. A `done` row refuses to cancel → reason='already_firing' (non-queued).
 *   4. An unknown id → reason='not_found'.
 *   5. pumpQueue ignores `cancelled` rows (a cancelled row is never fired).
 *
 * Run:
 *   DATABASE_URL="file:./test-cancel.db" npx prisma db push --schema prisma/schema.prisma --skip-generate
 *   DATABASE_URL="file:./test-cancel.db" AUTO_GUI_HOST=localhost AUTO_GUI_PORT=8000 npx tsx scripts/test-cancel-work.mjs
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const mkRow = (state, extra = {}) =>
  prisma.workQueue.create({
    data: {
      step: 'visibility',
      payload: JSON.stringify({ instruction: 'noop', transaction_code: 'TEST', meta: {} }),
      state,
      ...extra,
    },
  });

async function main() {
  await prisma.workQueue.deleteMany({});

  const { cancelWork, pumpQueue } = await import('../src/lib/work-queue.ts');

  // --- 1. Cancel a queued row ---
  const queued = await mkRow('queued');
  let r = await cancelWork(queued.id);
  console.log('[test] cancel queued:', r);
  if (!r.cancelled) throw new Error('FAIL: 1 queued row should cancel');
  let after = await prisma.workQueue.findUnique({ where: { id: queued.id } });
  if (after.state !== 'cancelled') throw new Error(`FAIL: 1 state expected cancelled, got ${after.state}`);
  if (after.finishedAt === null) throw new Error('FAIL: 1 finishedAt should be set');

  // --- 2. Refuse to cancel a firing row ---
  const firing = await mkRow('firing', { startedAt: new Date() });
  r = await cancelWork(firing.id);
  console.log('[test] cancel firing:', r);
  if (r.cancelled) throw new Error('FAIL: 2 firing row must NOT cancel');
  if (r.reason !== 'already_firing') throw new Error(`FAIL: 2 reason expected already_firing, got ${r.reason}`);
  after = await prisma.workQueue.findUnique({ where: { id: firing.id } });
  if (after.state !== 'firing') throw new Error(`FAIL: 2 firing row state changed to ${after.state}`);

  // --- 3. Refuse to cancel a done row ---
  const done = await mkRow('done', { finishedAt: new Date() });
  r = await cancelWork(done.id);
  console.log('[test] cancel done:', r);
  if (r.cancelled || r.reason !== 'already_firing') throw new Error(`FAIL: 3 done row unexpected ${JSON.stringify(r)}`);

  // --- 4. Unknown id ---
  r = await cancelWork('does-not-exist');
  console.log('[test] cancel unknown:', r);
  if (r.cancelled || r.reason !== 'not_found') throw new Error(`FAIL: 4 unknown id unexpected ${JSON.stringify(r)}`);

  // --- 5. pumpQueue ignores cancelled rows ---
  // Clear firing row so the queue slot is free, leaving only the cancelled row.
  await prisma.workQueue.update({ where: { id: firing.id }, data: { state: 'done', finishedAt: new Date() } });
  const onlyCancelledPump = await pumpQueue();
  if (onlyCancelledPump) throw new Error(`FAIL: 5 pumpQueue fired a non-queued row ${onlyCancelledPump.id} (${onlyCancelledPump.state})`);
  console.log('[test] pump correctly skips cancelled rows (queue empty of fireable work)');

  // A fresh queued row alongside the cancelled one should still fire.
  const fireable = await mkRow('queued');
  const fired = await pumpQueue();
  if (!fired || fired.id !== fireable.id) throw new Error(`FAIL: 5 pumpQueue should fire ${fireable.id}, got ${fired?.id}`);
  console.log('[test] pump fires the fresh queued row, not the cancelled one');

  console.log('\n[test] ✅ ALL ASSERTIONS PASS');
  console.log('  - queued → cancelled (finishedAt set)');
  console.log('  - firing → refused (already_firing, state untouched)');
  console.log('  - done   → refused (already_firing)');
  console.log('  - unknown id → not_found');
  console.log('  - pumpQueue never fires a cancelled row');
}

main()
  .catch((e) => {
    console.error('\n[test] ❌', e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
