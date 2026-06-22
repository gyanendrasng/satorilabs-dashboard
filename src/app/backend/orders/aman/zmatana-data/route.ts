import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getProduct } from '@/lib/product-db';

/** One material row in a LONE-ZMATANA response. Mirrors the visibility-data
 *  material shape. */
interface ZmatanaMaterial {
  material?: string;
  material_code?: string;
  material_description?: string | null;
  /** Batch returned by SAP for this material on this SO. */
  batch?: string;
  batch_number?: string;
  /** Quantity SAP read off the SO line for this material (optional). */
  order_quantity?: number | null;
  /** Per-SO availability, equivalent to the visibility-data shape. */
  available_stock_for_so?: number | null;
  /** Optional weight (kg) if SAP returns it. */
  order_weight_kg?: number | null;
}

interface ZmatanaPayload extends ZmatanaMaterial {
  work_id?: string;
  so_number?: string;
  soNumber?: string;
  /** Multi-material response (preferred): one LONE-ZMATANA run carries every
   *  requested material, mirroring ZSO-VISIBILITY. The top-level single-material
   *  fields above remain accepted for backward compatibility. Entries may be
   *  bare code strings (echoed meta.materials) — normalized before use. */
  materials?: Array<ZmatanaMaterial | string>;
}

/**
 * POST /backend/orders/aman/zmatana-data
 *
 * Callback for the standalone ZMatana SAP transaction (`LONE-ZMATANA`).
 * Triggered by the planner's `lone_zmatana` step to fetch the batch + per-SO
 * availability of materials whose quantity just changed (post-plant_ls
 * increase) or that VA02 swapped (cross-plant substitution).
 *
 * Accepts a multi-material `materials[]` array (one LONE-ZMATANA run reports
 * every requested material, mirroring ZSO-VISIBILITY) and, for backward
 * compatibility, the legacy single-material top-level shape. Upserts one
 * Material row per (salesOrderId, material) — sets `availableStock` + batch
 * (and weight if present), pulls `materialDescription` from the product DB.
 *
 * Does not assemble any email; the planner's next step handles notification.
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

    // Normalize to a material list. Preferred: a `materials[]` array (one
    // LONE-ZMATANA run reports every requested material). Fallback: the legacy
    // single-material top-level fields.
    // Some auto_gui2 responses send each entry as a bare code STRING (echoing
    // the request's meta.materials) instead of an object. Normalize so a string
    // "CODE" becomes { material: "CODE" } rather than being skipped.
    const rawMaterials: ZmatanaMaterial[] =
      Array.isArray(body.materials) && body.materials.length > 0
        ? body.materials.map((m) =>
            typeof m === 'string' ? ({ material: m } as ZmatanaMaterial) : m,
          )
        : [body];

    if (!soNumber) {
      return NextResponse.json({ error: 'so_number is required' }, { status: 400 });
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

    // Upsert one Material row per material in the response.
    const summaries: string[] = [];
    let persisted = 0;
    for (const m of rawMaterials) {
      const materialCode = m.material || m.material_code;
      if (!materialCode) {
        console.warn(`[ZmatanaData] Skipping material row missing code:`, m);
        continue;
      }
      // Only treat a NON-EMPTY value as a real batch. auto_gui2 sometimes echoes
      // entries as bare code strings (no batch) — see the normalization above —
      // which previously became 'N/A' and OVERWROTE an already-fetched real
      // batch (e.g. "P") on update, breaking the downstream ZLOAD2 PDF reconcile.
      const rawBatch = (m.batch || m.batch_number || '').trim();
      const batch = rawBatch || 'N/A';

      // Description from the product DB; payload value wins when SAP supplies
      // one, else fall back to the static DB (null when neither has it).
      const product = getProduct(materialCode);
      const materialDescription =
        m.material_description ?? product?.material_description ?? null;

      // We do NOT touch orderQuantity OR orderWeightKg on update. Both are
      // FULL-order fields owned by the SO line (VA02 sets the quantity; the
      // weight is the whole order's weight). A delta-scoped LONE-ZMATANA run
      // reports order_quantity/order_weight_kg for ONLY the added units (e.g.
      // 10 units / 95 kg), so writing order_weight_kg here would replace the
      // full-order weight (210 units / 1995 kg) with the delta weight and break
      // the bundler/capacity formula (dispatchQuantity/orderQuantity)*orderWeightKg.
      // LONE-ZMATANA only fetches batch + free stock. `batch` IS updated:
      // SAP may report a reordered / augmented batch string for a material we
      // already have a row for. One row per (SO, material).
      await prisma.material.upsert({
        where: {
          salesOrderId_material: {
            salesOrderId: salesOrder.id,
            material: materialCode,
          },
        },
        update: {
          // Only overwrite the description when we actually resolved one. A
          // delta-scoped LONE-ZMATANA carries no material_description, and a SAP
          // code absent from the static product DB (e.g. YAFPLNA00000043P)
          // resolves to null here — writing that would WIPE the real description
          // set by ZSO-VISIBILITY. The downstream ZLOAD1/ZLOAD2 PDF reconcile
          // matches LSI rows by (description, batch); a nulled description makes
          // it skip the row and fall back to the family prefix, mangling the LSI
          // material code (YAFPLNA00000043P → "OAFFJ"). Same guard as `batch`.
          ...(materialDescription ? { materialDescription } : {}),
          // Only overwrite batch when SAP actually returned one — never clobber
          // an existing real batch with the 'N/A' fallback from a bare-string echo.
          ...(rawBatch ? { batch } : {}),
          availableStock: m.available_stock_for_so ?? null,
        },
        create: {
          salesOrderId: salesOrder.id,
          material: materialCode,
          materialDescription,
          batch,
          // Only hit when SAP reports a material with no prior row on this SO.
          orderQuantity: m.order_quantity ?? 0,
          availableStock: m.available_stock_for_so ?? null,
          orderWeightKg: m.order_weight_kg ?? null,
        },
      });
      persisted++;
      summaries.push(`${materialCode} batch=${batch} avail=${m.available_stock_for_so ?? '?'}`);
    }

    if (persisted === 0) {
      return NextResponse.json(
        { error: 'no material rows with a material code in payload' },
        { status: 400 },
      );
    }
    console.log(
      `[ZmatanaData] Upserted ${persisted} Material row(s) for SO ${soNumber}: ${summaries.join('; ')}`,
    );

    // Live-update Bundle.totalWeightKg for any bundle that holds Material
    // rows on this SO. ZMatana on a substitute material refreshes weight,
    // and the parent VA02 → ZSO_Visibility step may have already updated
    // the swapped line's qty — both are weight inputs we need rolled up.
    try {
      const { recomputeBundleWeightsForSo } = await import('@/lib/bundle-capacity');
      const touched = await recomputeBundleWeightsForSo(salesOrder.id);
      if (touched > 0) {
        console.log(`[ZmatanaData] Recomputed Bundle.totalWeightKg for ${touched} bundle(s) of SO ${soNumber}`);
      }
    } catch (recomputeErr) {
      console.warn(
        `[ZmatanaData] Bundle weight recompute failed for SO ${soNumber}: ${recomputeErr instanceof Error ? recomputeErr.message : String(recomputeErr)}`,
      );
    }

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
            materials: rawMaterials
              .filter((m) => m.material || m.material_code)
              .map((m) => ({
                material: m.material ?? m.material_code,
                batch: (m.batch || m.batch_number || '') || 'N/A',
                available: m.available_stock_for_so,
              })),
          },
          summary: summaries.join('; '),
        },
      });
    } catch {
      // Audit emission must never break the primary flow.
    }

    // Mark the WorkQueue row done (fast, awaited — it's part of accepting this
    // callback). pumpQueue nudges the next queued work; keep it awaited too,
    // it's cheap (DB + a fire-and-forget /chat).
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

      // Re-plan WITHOUT blocking this callback's HTTP response.
      // replanAfterEngineFetch re-enters the LLM planner (10s+ per call), and
      // when the planner re-emits lone_zmatana it re-plans again — together that
      // can exceed auto_gui2's 30s send timeout, so auto_gui2 marks the POST
      // failed even though we've already persisted the SAP data and marked the
      // work done above. The planner advance is independent of the ACK, so fire
      // it in the background. This process is long-lived (PM2), so the promise
      // runs to completion after the response is sent.
      // NOTE: on a serverless host, swap this for waitUntil() so it isn't killed.
      void (async () => {
        try {
          const { maybeAdvanceScenario, replanAfterEngineFetch } = await import('@/lib/scenario-engine');
          // Advance any in-flight plan first (no-op for a single-step lone_zmatana
          // plan, which completes on fire). Then re-enter the planner: lone_zmatana
          // is an engine-only fetch step that ends a plan WITHOUT an outbound email,
          // and the branch has already replied — so nothing else would re-drive the
          // planner to emit the next phase (Rule 6e Phase 2.75). This bridges that.
          await maybeAdvanceScenario(salesOrder.id);
          await replanAfterEngineFetch(salesOrder.id);
        } catch (advErr) {
          console.error(
            `[ZmatanaData] background advance/replan failed for SO ${soNumber}: ${advErr instanceof Error ? advErr.message : String(advErr)}`,
          );
        }
      })();
    }

    // Respond immediately — the SAP data is persisted and the work row is done.
    return NextResponse.json({
      success: true,
      so_number: soNumber,
      persisted,
      materials: summaries,
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
