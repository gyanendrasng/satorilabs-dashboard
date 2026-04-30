import { prisma } from './prisma';
import type { WorkQueue } from '@prisma/client';

const AUTO_GUI_HOST = process.env.AUTO_GUI_HOST || 'localhost';
const AUTO_GUI_PORT = process.env.AUTO_GUI_PORT || '8000';

export type WorkStep = 'visibility' | 'zload1' | 'zload3b1' | 'vto1n';

export interface ChatPayload {
  instruction: string;
  transaction_code: string;
  so_number: string;
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

  const next = await prisma.workQueue.findFirst({
    where: { state: 'queued' },
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
 * Mark a firing work row as `failed`. Returns true if a row was matched.
 */
export async function markFailed(workId: string, error?: string): Promise<boolean> {
  const result = await prisma.workQueue.updateMany({
    where: { id: workId, state: 'firing' },
    data: { state: 'failed', finishedAt: new Date(), error: error ?? null },
  });
  return result.count > 0;
}

/**
 * Return the currently firing work row, if any. Useful for diagnostics
 * and the stale-recovery sweep.
 */
export function getFiringWork() {
  return prisma.workQueue.findFirst({ where: { state: 'firing' } });
}
