import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { markDone, markFailed, pumpQueue, MAX_ATTEMPTS } from '@/lib/work-queue';
import { checkAndSendCombinedVehicleEmailForPo, updatePurchaseOrderStage } from '@/lib/auto-gui-trigger';

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

  // Apply the state transition. For failures, markFailed handles retry logic
  // internally — it may re-queue the row instead of marking it terminal.
  let terminal = true; // 'done' is always terminal; failure may not be.
  let attemptCount = 0;
  if (status === 'done') {
    const matched = await markDone(workId);
    if (!matched) {
      return NextResponse.json(
        { error: `work_id ${workId} could not be transitioned (race)` },
        { status: 409 }
      );
    }
  } else {
    const result = await markFailed(workId, errorMsg);
    if (!result.matched) {
      return NextResponse.json(
        { error: `work_id ${workId} could not be transitioned (race)` },
        { status: 409 }
      );
    }
    terminal = result.terminal;
    attemptCount = result.attemptCount;
  }

  const payload = JSON.parse(existing.payload);
  const soNumber = payload.meta?.so_number ?? payload.so_number ?? 'unknown';
  const arrow =
    status === 'done'
      ? '✓ DONE'
      : terminal
      ? `✗ FAILED (terminal, ${attemptCount}/${MAX_ATTEMPTS})`
      : `↻ RETRY (${attemptCount}/${MAX_ATTEMPTS})`;
  console.log(
    `[WorkQueue] ← ${arrow} work ${workId} (${existing.step}, SO ${soNumber}) from auto_gui2${errorMsg ? ` — ${errorMsg}` : ''}`
  );

  // ZLOAD1 completion gate: when a zload1 work row flips to `done`, check
  // if every ZLOAD1 row for the PO is now done — if so, send the combined
  // vehicle-details email. Idempotent.
  if (status === 'done' && existing.step === 'zload1' && existing.salesOrderId) {
    try {
      const so = await prisma.salesOrder.findUnique({
        where: { id: existing.salesOrderId },
        select: { purchaseOrderId: true },
      });
      if (so?.purchaseOrderId) {
        await checkAndSendCombinedVehicleEmailForPo(so.purchaseOrderId);
      }
    } catch (gateErr) {
      console.error(
        `[StepStatus] Combined-vehicle-email gate error for work ${workId}:`,
        gateErr
      );
    }
  }

  // VTO1N completion gate: flip Shipment to 'shipped'; if all shipments for
  // the SO are shipped, mark SO completed; if all SOs in the PO are completed,
  // bump the PO stage. This is the single source of "PO is done" — not the
  // earlier ZLOAD3-B1 callback.
  if (existing.step === 'vto1n' && existing.salesOrderId) {
    try {
      const shipmentId = (payload.meta?.shipment_id as string | undefined) ?? null;
      if (status === 'done' && shipmentId) {
        await prisma.shipment.updateMany({
          where: { id: shipmentId, status: 'shipment-triggered' },
          data: { status: 'shipped', shippedAt: new Date() },
        });
        // Mirror onto legacy Invoice row keyed by obdNumber for back-compat.
        const sh = await prisma.shipment.findUnique({
          where: { id: shipmentId },
          select: { obdNumber: true },
        });
        if (sh?.obdNumber) {
          await prisma.invoice.updateMany({
            where: { obdNumber: sh.obdNumber, status: 'shipment-triggered' },
            data: { status: 'shipped' },
          });
        }
      } else if (status === 'failed' && terminal && shipmentId) {
        // Only roll back on terminal failure — while we're still retrying,
        // keep Shipment in 'shipment-triggered' so the UI doesn't offer the
        // form again (the queue will re-fire automatically).
        await prisma.shipment.updateMany({
          where: { id: shipmentId, status: 'shipment-triggered' },
          data: { status: 'created', shipmentTriggeredAt: null },
        });
      }

      if (status === 'done') {
        // Did this complete every Shipment for the SO?
        const remainingShipments = await prisma.shipment.count({
          where: { salesOrderId: existing.salesOrderId, status: { not: 'shipped' } },
        });
        if (remainingShipments === 0) {
          await prisma.salesOrder.update({
            where: { id: existing.salesOrderId },
            data: { status: 'completed' },
          });
          const so = await prisma.salesOrder.findUnique({
            where: { id: existing.salesOrderId },
            select: { purchaseOrderId: true, soNumber: true },
          });
          if (so?.purchaseOrderId) {
            console.log(`[StepStatus] SO ${so.soNumber} all shipments shipped — marking completed and checking PO stage`);
            await updatePurchaseOrderStage(so.purchaseOrderId);
          }
        }
      }
    } catch (gateErr) {
      console.error(
        `[StepStatus] VTO1N completion gate error for work ${workId}:`,
        gateErr
      );
    }
  }

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
