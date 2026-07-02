import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { assembleAndSendCombinedEmail } from '@/lib/auto-gui-trigger';
import { sanitizeText } from '@/lib/text-normalize';

const BRANCH_EMAIL = process.env.BRANCH_EMAIL || '';

interface VisibilityMaterial {
  material: string;
  material_description?: string | null;
  batch: string;
  order_quantity: number;
  available_stock_for_so?: number | null;
  order_weight_kg?: number | null;
  // Legacy fallback fields (older auto_gui2 versions)
  material_code?: string;
  batch_number?: string;
}

interface VisibilityPayload {
  so_number?: string;
  soNumber?: string;
  email_body?: string; // legacy; no longer required — dashboard composes the HTML itself
  // Entries are normally objects; some flows (LONE-ZMATANA echo) send bare code
  // strings. Both are normalized to VisibilityMaterial before use.
  materials: Array<VisibilityMaterial | string>;
}

/**
 * POST /backend/orders/aman/visibility-data
 *
 * Receives ZSO-VISIBILITY response from Aman (auto_gui2). Multi-SO pipeline:
 *
 *   1. Mark this SO's `visibilityState='received'`.
 *   2. Buffer per-SO email_body + materials onto a `ls_dispatch_buffered` Email row.
 *   3. If another sibling SO in the same PO is still `visibilityState='queued'`,
 *      flip it to 'firing' and fire its ZSO-VISIBILITY (serial pipeline).
 *   4. Else (this was the last SO), call assembleAndSendCombinedEmail()
 *      to send ONE combined email to the branch with sections per SO.
 */
export async function POST(request: Request) {
  try {
    const rawText = await request.text();
    console.log(`[VisibilityData] Raw body (${rawText.length} chars):`, rawText.slice(0, 500));

    let body: VisibilityPayload;
    try {
      body = JSON.parse(rawText);
    } catch {
      console.error(`[VisibilityData] JSON parse failed. Full body:`, rawText);
      return NextResponse.json(
        { error: 'Invalid JSON in request body', receivedPreview: rawText.slice(0, 200) },
        { status: 400 }
      );
    }

    console.log(`[VisibilityData] Parsed payload keys:`, Object.keys(body));
    console.log(`[VisibilityData] so_number=${body.so_number}, soNumber=${body.soNumber}, materials=${body.materials?.length}, email_body length=${body.email_body?.length}`);

    const { email_body, materials } = body;

    if (!materials || !Array.isArray(materials) || materials.length === 0) {
      return NextResponse.json(
        { error: 'materials array is required and must not be empty' },
        { status: 400 }
      );
    }

    // SO lookup priority: so_number → soNumber → CurrentSO singleton
    let soNumber = body.so_number || body.soNumber;
    if (!soNumber) {
      const currentSO = await prisma.currentSO.findFirst();
      if (!currentSO) {
        return NextResponse.json(
          { error: 'No current SO number set and soNumber not provided' },
          { status: 404 }
        );
      }
      soNumber = currentSO.soNumber;
      console.log(`[VisibilityData] Fell back to CurrentSO="${soNumber}"`);
    }

    const salesOrder = await prisma.salesOrder.findFirst({
      where: { soNumber },
      include: { purchaseOrder: true },
    });

    if (!salesOrder) {
      console.error(`[VisibilityData] SO ${soNumber} not found in DB`);
      return NextResponse.json(
        { error: `Sales order not found: ${soNumber}` },
        { status: 404 }
      );
    }
    console.log(`[VisibilityData] Found SO ${soNumber} (id=${salesOrder.id}, PO=${salesOrder.purchaseOrder.poNumber})`);

    if (!BRANCH_EMAIL) {
      return NextResponse.json(
        { error: 'BRANCH_EMAIL environment variable not configured' },
        { status: 500 }
      );
    }

    // Step 1: mark this SO's visibility as received
    await prisma.salesOrder.update({
      where: { id: salesOrder.id },
      data: { visibilityState: 'received' },
    });

    // Step 1b: persist materials in the dedicated Material table (queryable).
    // Normalize legacy field names so old auto_gui2 payloads still work.
    // Out-of-stock items often arrive with batch='' — store them with the
    // 'N/A' sentinel so they remain queryable and surface in the dispatch
    // email (matches existing convention, e.g. YOGRFL0000000SMP|N/A|10|0).
    let persisted = 0;
    let skipped = 0;
    for (const rawEntry of materials) {
      // Defensive: some auto_gui2 responses (notably the LONE-ZMATANA flow,
      // which echoes the request's `meta.materials` string array) send each
      // entry as a bare code string instead of an object. Normalize so a
      // string "CODE" is treated as { material: "CODE" } rather than skipped.
      const raw: VisibilityMaterial =
        typeof rawEntry === 'string' ? ({ material: rawEntry } as VisibilityMaterial) : rawEntry;
      const materialCode = raw.material ?? raw.material_code ?? '';
      if (!materialCode) {
        console.warn(`[VisibilityData] Skipping material row missing code:`, rawEntry);
        skipped++;
        continue;
      }
      const rawBatch = raw.batch ?? raw.batch_number ?? '';
      const hasBatch = rawBatch.length > 0;
      const batch = rawBatch || 'N/A';
      const hasOrderQty = typeof raw.order_quantity === 'number' && Number.isFinite(raw.order_quantity);

      // A sparse entry (e.g. a bare code echoed by the LONE-ZMATANA flow) carries
      // no batch/qty/stock. We must NOT overwrite the existing row's real data
      // with nulls, nor try to CREATE a row without the required orderQuantity.
      // So: build an update that only sets fields actually present, and skip the
      // create path entirely when there's no orderQuantity to seed it with.
      const existing = await prisma.material.findUnique({
        where: { salesOrderId_material: { salesOrderId: salesOrder.id, material: materialCode } },
        select: { id: true },
      });

      if (!existing && !hasOrderQty) {
        console.warn(
          `[VisibilityData] Sparse material entry (no order_quantity) and no existing row for ${materialCode} — skipping`,
        );
        skipped++;
        continue;
      }

      // Only include fields the payload actually provided, so a sparse entry
      // doesn't clobber a fully-populated existing row.
      const data: Record<string, unknown> = {};
      // Only overwrite the description when THIS run actually carries one — never
      // wipe a good description from a prior run with null. A later ZSO-VISIBILITY
      // run whose LLM failed to extract a product's description would otherwise
      // blank it, and ZLOAD1/2's PDF reconcile then skips the row and falls back
      // to the family prefix ("OT2FJ"), corrupting plant routing + weight + email.
      // Mirrors the guard in zmatana-data. Sanitise so stored text is free of the
      // invisible chars that break matching.
      const cleanDesc = sanitizeText(raw.material_description);
      if (cleanDesc) data.materialDescription = cleanDesc;
      if (hasBatch) data.batch = batch;
      if (hasOrderQty) data.orderQuantity = raw.order_quantity;
      if (raw.available_stock_for_so !== undefined && raw.available_stock_for_so !== null) {
        data.availableStock = raw.available_stock_for_so;
      }
      if (raw.order_weight_kg !== undefined && raw.order_weight_kg !== null) {
        data.orderWeightKg = raw.order_weight_kg;
      }

      if (existing) {
        if (Object.keys(data).length > 0) {
          await prisma.material.update({
            where: { salesOrderId_material: { salesOrderId: salesOrder.id, material: materialCode } },
            data,
          });
        }
      } else {
        // hasOrderQty is guaranteed here. batch defaults to N/A if absent.
        await prisma.material.create({
          data: {
            salesOrderId: salesOrder.id,
            material: materialCode,
            materialDescription: sanitizeText(raw.material_description) || null,
            batch,
            orderQuantity: raw.order_quantity as number,
            availableStock: raw.available_stock_for_so ?? null,
            orderWeightKg: raw.order_weight_kg ?? null,
          },
        });
      }
      persisted++;
    }
    console.log(
      `[VisibilityData] Persisted ${persisted}/${materials.length} Material row(s) for SO ${soNumber}${skipped > 0 ? ` (${skipped} skipped — missing code)` : ''}`
    );

    // Live-update Bundle.totalWeightKg for every bundle that holds a Material
    // we just upserted. ZSO-VISIBILITY refreshes per-line weight + orderQuantity
    // (after VA02 increases / decreases on the SO), so any bundle already
    // linked to those Materials is now stale. No-op on the initial pre-bundle
    // path where no Material has bundleId yet.
    try {
      const { recomputeBundleWeightsForSo } = await import('@/lib/bundle-capacity');
      const touched = await recomputeBundleWeightsForSo(salesOrder.id);
      if (touched > 0) {
        console.log(`[VisibilityData] Recomputed Bundle.totalWeightKg for ${touched} bundle(s) of SO ${soNumber}`);
      }
    } catch (recomputeErr) {
      console.warn(
        `[VisibilityData] Bundle weight recompute failed for SO ${soNumber}: ${recomputeErr instanceof Error ? recomputeErr.message : String(recomputeErr)}`,
      );
    }

    // Audit-trail event so the LLM planner sees ZSO-VISIBILITY as a
    // completed milestone the next time it builds a plan for this SO.
    try {
      const { emitEvent } = await import('@/lib/scenario-events');
      const asMat = (m: VisibilityMaterial | string): VisibilityMaterial =>
        typeof m === 'string' ? ({ material: m } as VisibilityMaterial) : m;
      const matSample = materials.slice(0, 3).map((rawM) => {
        const m = asMat(rawM);
        const code = m.material ?? m.material_code ?? '?';
        const avail = m.available_stock_for_so ?? '?';
        return `${code}=${avail}`;
      }).join(', ');
      const more = materials.length > 3 ? `, +${materials.length - 3} more` : '';
      await emitEvent({
        salesOrderId: salesOrder.id,
        type: 'step_completed',
        payload: {
          kind: 'zso_visibility',
          scenario_key: 'cron-driven',
          sap_output: {
            materials: materials.map((rawM) => {
              const m = asMat(rawM);
              return {
                material: m.material ?? m.material_code,
                ordered: m.order_quantity,
                available: m.available_stock_for_so,
              };
            }),
          },
          summary: `materials ${matSample}${more}`,
        },
      });
    } catch {
      // Audit emission must never break the primary flow.
    }

    // Step 2: buffer the per-SO email body + materials (raw JSON, for combined-email assembly).
    const materialsJson = JSON.stringify(materials);
    await prisma.email.create({
      data: {
        salesOrderId: salesOrder.id,
        purchaseOrderId: salesOrder.purchaseOrderId,
        gmailMessageId: `pending-${randomUUID()}`,
        gmailThreadId: '',
        recipientEmail: BRANCH_EMAIL,
        subject: '(buffered)',
        status: 'queued',
        emailType: 'ls_dispatch_buffered',
        workflowState: 'buffering',
        relatedMaterials: materialsJson,
        sentBody: email_body || null, // legacy; combined email body is now generated from Material rows

      },
    });
    console.log(`[VisibilityData] Buffered visibility output for SO ${soNumber}`);

    // Step 3: queue advancement is now handled by /step-status (the WorkQueue).
    // Here we only check whether all SOs in the PO have their visibility
    // result and, if so, assemble the combined dispatch email. The next
    // queued ZSO-VISIBILITY fires after auto_gui2 calls /step-status with
    // status='done' for this work item.
    const remainingNotReceived = await prisma.salesOrder.count({
      where: {
        purchaseOrderId: salesOrder.purchaseOrderId,
        visibilityState: { notIn: ['received', 'failed'] },
      },
    });

    if (remainingNotReceived > 0) {
      return NextResponse.json({
        success: true,
        so_number: soNumber,
        soNumber,
        buffered: true,
        remainingNotReceived,
      });
    }

    // All SOs in the PO are settled — assemble and send the combined email.
    console.log(`[VisibilityData] All SOs in PO ${salesOrder.purchaseOrder.poNumber} settled — assembling combined email`);
    const result = await assembleAndSendCombinedEmail(salesOrder.purchaseOrderId);

    return NextResponse.json({
      success: result.success,
      so_number: soNumber,
      soNumber,
      buffered: true,
      combinedEmailSent: result.success && !result.alreadySent,
      combinedEmailAlreadySent: !!result.alreadySent,
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    const errStack = error instanceof Error ? error.stack : undefined;
    console.error(`[VisibilityData] UNHANDLED ERROR: ${errMsg}`);
    console.error(`[VisibilityData] Stack:`, errStack || error);
    return NextResponse.json(
      { error: 'Internal server error', details: errMsg },
      { status: 500 }
    );
  }
}
