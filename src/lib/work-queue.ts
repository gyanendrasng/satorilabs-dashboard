import { prisma } from './prisma';
import type { WorkQueue } from '@prisma/client';

const AUTO_GUI_HOST = process.env.AUTO_GUI_HOST || 'localhost';
const AUTO_GUI_PORT = process.env.AUTO_GUI_PORT || '8000';

/**
 * When NEXT_PUBLIC_SAP_TEST_MODE is "true", every /chat request carries
 * `test_mode: true` so auto_gui2 replays fixtures instead of driving real SAP
 * (see TEST_MODE.md). Anything else (unset, "false", "0") means live SAP.
 */
export const SAP_TEST_MODE = process.env.NEXT_PUBLIC_SAP_TEST_MODE === 'true';

export type WorkStep = 'visibility' | 'zload1' | 'zload3b1' | 'vto1n' | 'mb51' | 'zloading_close' | 'va02' | 'zload2';

/**
 * Retry policy: 1 initial attempt + 3 retries = 4 total. Uniform across all
 * steps. Backoff between retries gives auto-gui2 / SAP a chance to recover
 * from transient failures (process restart, network blip) before we re-thrash.
 */
export const MAX_ATTEMPTS = 4;
export const RETRY_BACKOFF_MS = 30_000;

export interface ChatPayload {
  instruction: string;
  transaction_code: string;
  // so_number is optional now — preferred location is `meta.so_number`.
  // Some legacy triggers still set both top-level and meta.
  so_number?: string;
  attachments?: Array<{ filename: string; content_base64: string }>;
  extraction_context?: string;
  // auto_gui2 passthrough metadata. Echoed in the /chat response and
  // automatically merged into outgoing send_data callbacks (zload1-data,
  // visibility-data, etc.) and into the COMPLETION_WEBHOOK payload.
  meta?: Record<string, unknown>;
}

/**
 * Add a row to the work queue. Caller should chain `pumpQueue()` to
 * possibly fire it immediately. The row is fired only if no other row
 * is currently `firing` system-wide (one-at-a-time invariant).
 */
export async function enqueueWork(args: {
  salesOrderId?: string | null;
  step: WorkStep;
  payload: ChatPayload;
}): Promise<WorkQueue> {
  return prisma.workQueue.create({
    data: {
      salesOrderId: args.salesOrderId ?? null,
      step: args.step,
      payload: JSON.stringify(args.payload),
      state: 'queued',
    },
  });
}

/**
 * Atomically pick the oldest queued row and fire it on auto_gui2 — but only
 * if nothing is currently `firing`. Returns the row that was fired, or null
 * if the slot was busy or the queue was empty.
 *
 * Concurrency note: SQLite serializes writes, so the `firing` check + the
 * state flip on a single row is effectively atomic for our use case. If we
 * ever move to Postgres, wrap this in `prisma.$transaction` with explicit
 * row locking.
 */
export async function pumpQueue(): Promise<WorkQueue | null> {
  const firing = await prisma.workQueue.findFirst({ where: { state: 'firing' } });
  if (firing) return null;

  // Filter out rows that were just re-queued for retry but whose backoff hasn't
  // elapsed yet — they'll become eligible on a later pump tick (the per-minute
  // cron at /backend/cron/check-emails calls pumpQueue every tick).
  const next = await prisma.workQueue.findFirst({
    where: {
      state: 'queued',
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }],
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    include: { salesOrder: { select: { soNumber: true } } },
  });
  if (!next) return null;

  // Flip to firing — guard with state='queued' so a racing pump can't double-fire.
  const flipped = await prisma.workQueue.updateMany({
    where: { id: next.id, state: 'queued' },
    data: { state: 'firing', startedAt: new Date() },
  });
  if (flipped.count === 0) {
    // Lost the race — somebody else flipped it. Bail out; they'll fire it.
    return null;
  }

  // Fire-and-forget POST to auto_gui2. The status callback advances the queue.
  const payload = JSON.parse(next.payload) as ChatPayload;
  // Inject work_id into both the top level (legacy) and `meta` (so the
  // COMPLETION_WEBHOOK and any send_data callbacks echo it back).
  const wireBody = {
    work_id: next.id,
    ...payload,
    ...(SAP_TEST_MODE ? { test_mode: true } : {}),
    meta: { ...(payload.meta ?? {}), work_id: next.id },
  };

  // SO number for the log: the WorkQueue row's FK is the source of truth.
  // The payload-meta fallback is only useful for rows enqueued without a
  // salesOrderId set (rare — mostly PO-level steps).
  const soNumber =
    next.salesOrder?.soNumber ??
    (payload.meta?.so_number as string | undefined) ??
    payload.so_number ??
    'unknown';

  console.log(`[WorkQueue] → SEND work ${next.id} (${next.step}, SO ${soNumber})${SAP_TEST_MODE ? ' [TEST_MODE]' : ''} → auto_gui2`);

  fetch(`http://${AUTO_GUI_HOST}:${AUTO_GUI_PORT}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(wireBody),
  })
    .then((res) => {
      if (!res.ok) {
        console.error(`[WorkQueue] /chat returned ${res.status} for work ${next.id} (${next.step}, SO ${soNumber})`);
      } else {
        console.log(`[WorkQueue] ✓ ACCEPTED work ${next.id} (${next.step}, SO ${soNumber}) — auto_gui2 running`);
      }
    })
    .catch((err) => {
      console.error(
        `[WorkQueue] /chat unreachable for work ${next.id} (${next.step}, SO ${soNumber}): ${err instanceof Error ? err.message : String(err)}`
      );
    });

  return { ...next, state: 'firing', startedAt: new Date() };
}

/**
 * Mark a firing work row as `done`. Returns true if a row was matched
 * (i.e. the callback was for a row currently in `firing` state).
 */
export async function markDone(workId: string): Promise<boolean> {
  const result = await prisma.workQueue.updateMany({
    where: { id: workId, state: 'firing' },
    data: { state: 'done', finishedAt: new Date() },
  });
  return result.count > 0;
}

/**
 * Mark a firing work row as failed, with bounded retry. If this is not yet
 * the MAX_ATTEMPTS-th failure, the row is re-queued with a backoff
 * (`nextAttemptAt = now + RETRY_BACKOFF_MS`) and `terminal=false` is returned.
 * If it IS the final attempt, the row stays `failed` with `terminal=true`.
 *
 * Callers (step-status route) should branch on `terminal` for downstream
 * cleanup — e.g. only roll back a Shipment to `created` when the VTO1N
 * failure is terminal, not while we're still retrying.
 */
export async function markFailed(
  workId: string,
  error?: string,
): Promise<{ matched: boolean; terminal: boolean; attemptCount: number }> {
  const row = await prisma.workQueue.findUnique({ where: { id: workId } });
  if (!row || row.state !== 'firing') {
    return { matched: false, terminal: false, attemptCount: row?.attemptCount ?? 0 };
  }

  const nextCount = row.attemptCount + 1;
  if (nextCount < MAX_ATTEMPTS) {
    // Retry: re-queue with backoff
    const result = await prisma.workQueue.updateMany({
      where: { id: workId, state: 'firing' },
      data: {
        state: 'queued',
        startedAt: null,
        finishedAt: null,
        attemptCount: nextCount,
        nextAttemptAt: new Date(Date.now() + RETRY_BACKOFF_MS),
        error: error ?? null,
      },
    });
    return { matched: result.count > 0, terminal: false, attemptCount: nextCount };
  }

  // Terminal failure — give up
  const result = await prisma.workQueue.updateMany({
    where: { id: workId, state: 'firing' },
    data: {
      state: 'failed',
      finishedAt: new Date(),
      attemptCount: nextCount,
      nextAttemptAt: null,
      error: error ?? null,
    },
  });
  return { matched: result.count > 0, terminal: true, attemptCount: nextCount };
}

/**
 * Cancel a still-queued work row. Only rows in `state='queued'` can be
 * cancelled — a row that has already been fired (`state='firing'`) is being
 * worked on by auto_gui2 and cannot be pulled back. The `where` clause guards
 * the state transition atomically, so a row that flips to `firing` between the
 * UI render and this call simply won't match (count === 0).
 */
export async function cancelWork(
  workId: string,
): Promise<{ cancelled: boolean; reason?: 'not_found' | 'already_firing' }> {
  const row = await prisma.workQueue.findUnique({ where: { id: workId } });
  if (!row) return { cancelled: false, reason: 'not_found' };
  if (row.state !== 'queued') return { cancelled: false, reason: 'already_firing' };

  const result = await prisma.workQueue.updateMany({
    where: { id: workId, state: 'queued' },
    data: { state: 'cancelled', finishedAt: new Date() },
  });
  // Lost the race — the pump flipped it to firing just now.
  if (result.count === 0) return { cancelled: false, reason: 'already_firing' };

  console.log(`[WorkQueue] ✗ CANCELLED work ${workId} (${row.step})`);
  return { cancelled: true };
}

/**
 * Return the currently firing work row, if any. Useful for diagnostics
 * and the stale-recovery sweep.
 */
export function getFiringWork() {
  return prisma.workQueue.findFirst({ where: { state: 'firing' } });
}

export class WorkCompletionTimeoutError extends Error {
  constructor(public unfinishedWorkIds: string[], public timeoutMs: number) {
    super(
      `awaitWorkCompletion: ${unfinishedWorkIds.length} work row(s) still pending after ${timeoutMs}ms: ${unfinishedWorkIds.join(', ')}`,
    );
    this.name = 'WorkCompletionTimeoutError';
  }
}

/**
 * Poll until every work id has reached a terminal state (done | failed |
 * cancelled). Throws `WorkCompletionTimeoutError` if the timeout elapses
 * with rows still in `queued` or `firing`.
 *
 * Used by the SAP-aware re-bundle in `computeBundlesForPo`: when a
 * composition change requires closing existing LSs in SAP first, we enqueue
 * the `zloading_close` work and block here until SAP confirms via the
 * /step-status callback.
 *
 * pollIntervalMs default is 500ms — short enough to feel responsive in
 * tests, long enough to keep DB load minimal in prod. Override per call
 * if needed.
 */
export async function awaitWorkCompletion(
  workIds: string[],
  opts: { timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<void> {
  if (workIds.length === 0) return;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 500;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    // Keep the pump running each iteration. markDone / markFailed don't
    // pump on their own — the cron's per-minute tick is normally what
    // advances the queue, but waiting up to a minute per row here would
    // dominate the bundler's latency. Pumping at our poll cadence makes
    // back-to-back closes complete in ~ pollIntervalMs.
    await pumpQueue();

    const rows = await prisma.workQueue.findMany({
      where: { id: { in: workIds } },
      select: { id: true, state: true },
    });
    const pending = rows.filter((r) => r.state !== 'done' && r.state !== 'failed' && r.state !== 'cancelled');
    if (pending.length === 0) return;
    if (Date.now() >= deadline) {
      throw new WorkCompletionTimeoutError(pending.map((r) => r.id), timeoutMs);
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}
