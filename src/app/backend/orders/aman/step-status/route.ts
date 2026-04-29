import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { markDone, markFailed, pumpQueue } from '@/lib/work-queue';

interface StepStatusPayload {
  work_id?: string;
  status?: 'done' | 'failed';
  error?: string;
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

  const workId = body.work_id;
  const status = body.status;
  const errorMsg = body.error;

  if (!workId || typeof workId !== 'string') {
    return NextResponse.json({ error: 'work_id is required' }, { status: 400 });
  }
  if (status !== 'done' && status !== 'failed') {
    return NextResponse.json(
      { error: "status must be 'done' or 'failed'" },
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

  console.log(
    `[StepStatus] work ${workId} (${existing.step}) → ${status}${errorMsg ? ` (${errorMsg})` : ''}`
  );

  const next = await pumpQueue();

  if (next) {
    const payload = JSON.parse(next.payload);
    return NextResponse.json({
      success: true,
      marked_state: status,
      next_fired: {
        work_id: next.id,
        step: next.step,
        so_number: payload.so_number,
      },
    });
  }

  return NextResponse.json({ success: true, marked_state: status });
}
