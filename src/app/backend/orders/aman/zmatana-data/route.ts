import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getProduct } from '@/lib/product-db';

interface ZmatanaPayload {
  work_id?: string;
  so_number?: string;
  soNumber?: string;
  /** The material code ZMatana was run for. */
  material?: string;
  material_code?: string;
  /** Batch returned by SAP for this material on this SO. */
  batch?: string;
  batch_number?: string;
  /** Per-SO availability, equivalent to the visibility-data shape. */
  available_stock_for_so?: number | null;
  /** Optional weight (kg) if SAP returns it for the substitute material. */
  order_weight_kg?: number | null;
}

/**
 * POST /backend/orders/aman/zmatana-data
 *
 * Callback for the standalone ZMatana SAP transaction (`ZMATANA_LONE`).
 * Triggered by the planner's `lone_zmatana` step after stock_precheck
 * substituted a short material with a cross-plant equivalent and VA02 swapped
 * the SO line in SAP.
 *
 * Single-material payload. Upserts one Material row keyed on
 * (salesOrderId, material, batch) — sets `availableStock` (and weight if
 * present), pulls `materialDescription` from the product DB.
 *
 * Mirrors visibility-data's per-row upsert pattern but does not assemble any
 * email; the planner's next step (typically `email_2nd_release`) handles
 * notifying the plant.
 */
export async function POST(request: Request) {
  try {
    const rawText = await request.text();
    console.log(`[ZmatanaData] Raw body (${rawText.length} chars):`, rawText.slice(0, 500));

    let body: ZmatanaPayload;
    try {
      body = JSON.parse(rawText);
    } catch {
      console.error(`[ZmatanaData] JSON parse failed. Full body:`, rawText);
      return NextResponse.json(
        { error: 'Invalid JSON in request body', receivedPreview: rawText.slice(0, 200) },
        { status: 400 },
      );
    }

    const soNumber = body.so_number || body.soNumber;
    const materialCode = body.material || body.material_code;
    const batchRaw = body.batch || body.batch_number || '';
    const batch = batchRaw || 'N/A';

    if (!soNumber || !materialCode) {
      return NextResponse.json(
        { error: 'so_number and material are required' },
        { status: 400 },
      );
    }

    const salesOrder = await prisma.salesOrder.findFirst({
      where: { soNumber },
      select: { id: true, soNumber: true },
    });
    if (!salesOrder) {
      console.error(`[ZmatanaData] SO ${soNumber} not found in DB`);
      return NextResponse.json(
        { error: `Sales order not found: ${soNumber}` },
        { status: 404 },
      );
    }

    // Pull a description from the product DB so the dispatch email reads
    // cleanly. Falls back to null when the substitute isn't in the static DB
    // (rare — every code in the JSON corresponds to a real plant SKU).
    const product = getProduct(materialCode);
    const materialDescription = product?.material_description ?? null;

    // We intentionally do NOT touch orderQuantity here — VA02 set the desired
    // qty when it swapped the SO line; ZMatana only fetches batch + free stock.
    await prisma.material.upsert({
      where: {
        salesOrderId_material_batch: {
          salesOrderId: salesOrder.id,
          material: materialCode,
          batch,
        },
      },
      update: {
        materialDescription,
        availableStock: body.available_stock_for_so ?? null,
        ...(body.order_weight_kg != null ? { orderWeightKg: body.order_weight_kg } : {}),
      },
      create: {
        salesOrderId: salesOrder.id,
        material: materialCode,
        materialDescription,
        batch,
        orderQuantity: 0, // VA02 already sets this on the existing row; this branch is only hit when ZMatana returns a NEW batch we hadn't seen.
        availableStock: body.available_stock_for_so ?? null,
        orderWeightKg: body.order_weight_kg ?? null,
      },
    });
    console.log(
      `[ZmatanaData] Upserted Material(${materialCode}, batch=${batch}, avail=${body.available_stock_for_so ?? '?'}) for SO ${soNumber}`,
    );

    // Audit-trail event so the planner sees lone_zmatana as a completed
    // milestone on its next call.
    try {
      const { emitEvent } = await import('@/lib/scenario-events');
      await emitEvent({
        salesOrderId: salesOrder.id,
        type: 'step_completed',
        payload: {
          kind: 'lone_zmatana',
          scenario_key: 'planner',
          sap_output: {
            material: materialCode,
            batch,
            available: body.available_stock_for_so,
          },
          summary: `${materialCode} batch=${batch} avail=${body.available_stock_for_so ?? '?'}`,
        },
      });
    } catch {
      // Audit emission must never break the primary flow.
    }

    // Mark the WorkQueue row done + nudge the planner to advance.
    if (body.work_id) {
      try {
        const { markDone, pumpQueue } = await import('@/lib/work-queue');
        await markDone(body.work_id);
        await pumpQueue();
      } catch (workErr) {
        console.error(
          `[ZmatanaData] markDone failed for work_id=${body.work_id}: ${workErr instanceof Error ? workErr.message : String(workErr)}`,
        );
      }
      try {
        const { maybeAdvanceScenario } = await import('@/lib/scenario-engine');
        await maybeAdvanceScenario(salesOrder.id);
      } catch (advErr) {
        console.error(
          `[ZmatanaData] maybeAdvanceScenario failed for SO ${soNumber}: ${advErr instanceof Error ? advErr.message : String(advErr)}`,
        );
      }
    }

    return NextResponse.json({
      success: true,
      so_number: soNumber,
      material: materialCode,
      batch,
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    const errStack = error instanceof Error ? error.stack : undefined;
    console.error(`[ZmatanaData] UNHANDLED ERROR: ${errMsg}`);
    console.error(`[ZmatanaData] Stack:`, errStack || error);
    return NextResponse.json(
      { error: 'Internal server error', details: errMsg },
      { status: 500 },
    );
  }
}
