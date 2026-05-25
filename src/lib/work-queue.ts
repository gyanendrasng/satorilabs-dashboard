import { prisma } from './prisma';
import type { WorkQueue } from '@prisma/client';

const AUTO_GUI_HOST = process.env.AUTO_GUI_HOST || 'localhost';
const AUTO_GUI_PORT = process.env.AUTO_GUI_PORT || '8000';

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
    meta: { ...(payload.meta ?? {}), work_id: next.id },
  };

  const soNumber = (payload.meta?.so_number as string | undefined) ?? payload.so_number ?? 'unknown';

  console.log(`[WorkQueue] → SEND work ${next.id} (${next.step}, SO ${soNumber}) → auto_gui2`);

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
 * Return the currently firing work row, if any. Useful for diagnostics
 * and the stale-recovery sweep.
 */
export function getFiringWork() {
  return prisma.workQueue.findFirst({ where: { state: 'firing' } });
}
