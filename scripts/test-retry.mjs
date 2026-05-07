#!/usr/bin/env node
/**
 * E2E test for bounded retry on WorkQueue failures.
 *
 * Seeds one row in `firing` state, calls markFailed 4 times in a row, and
 * asserts the state transitions match: queued (3 retries) then failed
 * (terminal). Also verifies pumpQueue's nextAttemptAt filter blocks a row
 * that's still in backoff.
 *
 * Run:
 *   DATABASE_URL="file:./test-retry.db" npx prisma db push --schema prisma/schema.prisma --skip-generate
 *   DATABASE_URL="file:./test-retry.db" AUTO_GUI_HOST=localhost AUTO_GUI_PORT=8000 npx tsx scripts/test-retry.mjs
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  await prisma.workQueue.deleteMany({});

  const row = await prisma.workQueue.create({
    data: {
      step: 'visibility',
      payload: JSON.stringify({ instruction: 'noop', transaction_code: 'TEST', meta: {} }),
      state: 'firing',
      startedAt: new Date(),
    },
  });
  console.log(`[test] seeded firing row ${row.id}`);

  const { markFailed, pumpQueue, MAX_ATTEMPTS, RETRY_BACKOFF_MS } = await import(
    '../src/lib/work-queue.ts'
  );

  // Helper to flip a queued row back to firing for the next markFailed call.
  const flipToFiring = async () => {
    await prisma.workQueue.update({
      where: { id: row.id },
      data: { state: 'firing', startedAt: new Date(), nextAttemptAt: null },
    });
  };

  // --- Attempt 1 (initial fail → retry 1) ---
  let r = await markFailed(row.id, 'transient #1');
  console.log('[test] attempt 1:', r);
  if (!r.matched) throw new Error('FAIL: 1 not matched');
  if (r.terminal) throw new Error('FAIL: 1 should not be terminal');
  if (r.attemptCount !== 1) throw new Error(`FAIL: 1 expected attemptCount=1, got ${r.attemptCount}`);

  let after = await prisma.workQueue.findUnique({ where: { id: row.id } });
  if (after.state !== 'queued') throw new Error(`FAIL: 1 state expected queued, got ${after.state}`);
  if (after.nextAttemptAt === null) throw new Error('FAIL: 1 nextAttemptAt should be set');
  const backoff = after.nextAttemptAt.getTime() - Date.now();
  if (backoff < RETRY_BACKOFF_MS - 1000 || backoff > RETRY_BACKOFF_MS + 1000) {
    throw new Error(`FAIL: 1 backoff ~${RETRY_BACKOFF_MS}ms expected, got ${backoff}ms`);
  }

  // --- Pump should NOT fire while backoff is in effect ---
  const fired = await pumpQueue();
  if (fired) throw new Error(`FAIL: pumpQueue fired despite nextAttemptAt=${after.nextAttemptAt.toISOString()}`);
  console.log('[test] pump correctly skipped backed-off row');

  // --- Attempts 2 and 3 (still retries) ---
  await flipToFiring();
  r = await markFailed(row.id, 'transient #2');
  console.log('[test] attempt 2:', r);
  if (r.terminal || r.attemptCount !== 2) throw new Error(`FAIL: 2 unexpected ${JSON.stringify(r)}`);

  await flipToFiring();
  r = await markFailed(row.id, 'transient #3');
  console.log('[test] attempt 3:', r);
  if (r.terminal || r.attemptCount !== 3) throw new Error(`FAIL: 3 unexpected ${JSON.stringify(r)}`);

  // --- Attempt 4 (terminal) ---
  await flipToFiring();
  r = await markFailed(row.id, 'final fail');
  console.log('[test] attempt 4:', r);
  if (!r.terminal) throw new Error(`FAIL: 4 should be terminal`);
  if (r.attemptCount !== MAX_ATTEMPTS) throw new Error(`FAIL: 4 attemptCount=${MAX_ATTEMPTS} expected, got ${r.attemptCount}`);

  after = await prisma.workQueue.findUnique({ where: { id: row.id } });
  if (after.state !== 'failed') throw new Error(`FAIL: 4 state expected failed, got ${after.state}`);
  if (after.nextAttemptAt !== null) throw new Error('FAIL: 4 nextAttemptAt should be cleared on terminal');
  if (after.error !== 'final fail') throw new Error(`FAIL: 4 error not preserved, got "${after.error}"`);

  // --- Past-backoff pump should fire ---
  // Manually bypass the backoff by clearing nextAttemptAt to simulate elapsed time.
  await prisma.workQueue.update({
    where: { id: row.id },
    data: { state: 'queued', nextAttemptAt: null },
  });
  // We need AUTO_GUI to be unreachable so the fetch fails silently — that's
  // expected here since we're not running a real auto-gui2.
  const fired2 = await pumpQueue();
  if (!fired2) throw new Error('FAIL: pumpQueue should fire row with cleared nextAttemptAt');
  console.log('[test] pump fires once nextAttemptAt is cleared/past');

  console.log('\n[test] ✅ ALL ASSERTIONS PASS');
  console.log(`  - 1 → 3 retries (state=queued, attemptCount grows, nextAttemptAt set ${RETRY_BACKOFF_MS / 1000}s out)`);
  console.log('  - pumpQueue respects nextAttemptAt (skips backed-off rows)');
  console.log(`  - 4th failure is terminal (state=failed, count=${MAX_ATTEMPTS}, nextAttemptAt cleared)`);
  console.log('  - error column captures latest failure');
}

main()
  .catch((e) => {
    console.error('\n[test] ❌', e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
