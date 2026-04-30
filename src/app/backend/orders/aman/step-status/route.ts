import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { markDone, markFailed, pumpQueue } from '@/lib/work-queue';

/**
 * Accepts EITHER of two body shapes:
 *
 * 1. Legacy:                 { work_id, status: 'done'|'failed', error? }
 * 2. auto_gui2 webhook:      { event: 'workflow_complete', meta: { work_id, ... }, success: bool, summary, error? }
 *
 * COMPLETION_WEBHOOK_URL on auto_gui2 should be set to this route.
 */
interface StepStatusPayload {
  // shape 1
  work_id?: string;
  status?: 'done' | 'failed';
  error?: string;
  // shape 2 (auto_gui2 COMPLETION_WEBHOOK)
  event?: string;
  meta?: { work_id?: string; [k: string]: unknown };
  success?: boolean;
  summary?: string;
}

function normalizeBody(body: StepStatusPayload): { workId: string | null; status: 'done' | 'failed' | null; errorMsg?: string } {
  // Shape 2 — has `event:'workflow_complete'` or any `meta.work_id` + `success`.
  const isWebhook = body.event === 'workflow_complete' || (typeof body.success === 'boolean' && body.meta && typeof body.meta.work_id === 'string');
  if (isWebhook) {
    const workId = (body.meta?.work_id as string | undefined) ?? null;
    const status: 'done' | 'failed' | null = body.success === true ? 'done' : body.success === false ? 'failed' : null;
    const errorMsg = body.success === false ? (body.error ?? body.summary ?? 'auto_gui2 reported failure') : undefined;
    return { workId, status, errorMsg };
  }
  // Shape 1
  return {
    workId: body.work_id ?? null,
    status: body.status === 'done' || body.status === 'failed' ? body.status : null,
    errorMsg: body.error,
  };
}

/**
 * POST /backend/orders/aman/step-status
 *
 * auto_gui2 calls this AFTER the SAP transaction finishes (success or failure)
 * to acknowledge a /chat work item. Marks the matching `firing` WorkQueue row
 * as `done` or `failed`, then pumps the queue to fire the next queued item.
 *
 * No retries — failed rows are skipped, the next queued item is fired.
 */
export async function POST(request: Request) {
  let body: StepStatusPayload;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { workId, status, errorMsg } = normalizeBody(body);

  if (!workId) {
    return NextResponse.json({ error: 'work_id (or meta.work_id) is required' }, { status: 400 });
  }
  if (status !== 'done' && status !== 'failed') {
    return NextResponse.json(
      { error: "status must be 'done' or 'failed' (or success: bool in webhook shape)" },
      { status: 400 }
    );
  }

  // Look up the row first to provide a useful error if it's not in `firing`.
  const existing = await prisma.workQueue.findUnique({ where: { id: workId } });
  if (!existing) {
    return NextResponse.json(
      { error: `work_id not found: ${workId}` },
      { status: 404 }
    );
  }
  if (existing.state !== 'firing') {
    return NextResponse.json(
      { error: `work_id ${workId} is in state '${existing.state}', not 'firing'` },
      { status: 409 }
    );
  }

  const matched = status === 'done'
    ? await markDone(workId)
    : await markFailed(workId, errorMsg);

  if (!matched) {
    // Someone else marked it between our findUnique and updateMany.
    return NextResponse.json(
      { error: `work_id ${workId} could not be transitioned (race)` },
      { status: 409 }
    );
  }

  const payload = JSON.parse(existing.payload);
  const soNumber = payload.meta?.so_number ?? payload.so_number ?? 'unknown';
  const arrow = status === 'done' ? '✓ DONE' : '✗ FAILED';
  console.log(
    `[WorkQueue] ← ${arrow} work ${workId} (${existing.step}, SO ${soNumber}) from auto_gui2${errorMsg ? ` — ${errorMsg}` : ''}`
  );

  const next = await pumpQueue();

  if (next) {
    const nextPayload = JSON.parse(next.payload);
    return NextResponse.json({
      success: true,
      marked_state: status,
      next_fired: {
        work_id: next.id,
        step: next.step,
        so_number: nextPayload.meta?.so_number ?? nextPayload.so_number,
      },
    });
  }

  return NextResponse.json({ success: true, marked_state: status });
}
