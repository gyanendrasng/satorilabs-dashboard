import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { assembleAndSendCombinedEmail } from '@/lib/auto-gui-trigger';

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
  materials: VisibilityMaterial[];
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
    for (const raw of materials) {
      const materialCode = raw.material ?? raw.material_code ?? '';
      if (!materialCode) {
        console.warn(`[VisibilityData] Skipping material row missing code:`, raw);
        skipped++;
        continue;
      }
      const rawBatch = raw.batch ?? raw.batch_number ?? '';
      const batch = rawBatch || 'N/A';
      await prisma.material.upsert({
        where: {
          salesOrderId_material_batch: {
            salesOrderId: salesOrder.id,
            material: materialCode,
            batch,
          },
        },
        update: {
          materialDescription: raw.material_description ?? null,
          orderQuantity: raw.order_quantity,
          availableStock: raw.available_stock_for_so ?? null,
          orderWeightKg: raw.order_weight_kg ?? null,
        },
        create: {
          salesOrderId: salesOrder.id,
          material: materialCode,
          materialDescription: raw.material_description ?? null,
          batch,
          orderQuantity: raw.order_quantity,
          availableStock: raw.available_stock_for_so ?? null,
          orderWeightKg: raw.order_weight_kg ?? null,
        },
      });
      persisted++;
    }
    console.log(
      `[VisibilityData] Persisted ${persisted}/${materials.length} Material row(s) for SO ${soNumber}${skipped > 0 ? ` (${skipped} skipped — missing code)` : ''}`
    );

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
