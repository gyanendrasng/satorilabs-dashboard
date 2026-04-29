import { NextResponse } from 'next/server';
import { linkLsiToBundle } from '@/lib/bundler';
import { prisma } from '@/lib/prisma';
import { uploadToS3 } from '@/lib/s3';
import { sendReplyEmail, sendPlainEmail, getMessageRfc822Id } from '@/lib/gmail';

const BRANCH_EMAIL = process.env.BRANCH_EMAIL || '';

/**
 * POST /backend/orders/aman/zload1-data
 *
 * Receives LS file from Aman (auto_gui2) after executing ZLOAD1 (Stage 1).
 * ZLOAD1 creates loading slips in SAP — this endpoint stores the file but
 * does NOT email to plant. Emailing is handled by /initial-data (ZLOAD3-A, Stage 2).
 *
 * Expected: multipart/form-data with:
 * - so_number: string (preferred - SAP sales order number from auto_gui2)
 * - file: File (single LS file, filename is the LS number e.g., "1234567890.PDF")
 *
 * SO lookup priority: so_number form field → CurrentSO singleton.
 */
export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const soNumberField = formData.get('so_number') as string | null;

    console.log(`[ZLOAD1 Data] Received callback — file: ${file?.name || 'none'}, size: ${file?.size || 0}, so_number: ${soNumberField || 'not provided'}`);

    // Log all form data keys for debugging
    const keys: string[] = [];
    formData.forEach((_, key) => keys.push(key));
    console.log(`[ZLOAD1 Data] Form data keys: ${keys.join(', ')}`);

    if (!file) {
      return NextResponse.json(
        { error: 'No file received' },
        { status: 400 }
      );
    }

    // Extract LS number from filename (e.g., "1234567890.PDF" -> "1234567890")
    const lsNumber = file.name.replace(/\.[^.]+$/, '').trim();

    if (!lsNumber) {
      return NextResponse.json(
        { error: 'Could not extract LS number from filename' },
        { status: 400 }
      );
    }

    // SO lookup priority: so_number form field → CurrentSO singleton
    let soNumber = formData.get('so_number') as string | null;
    if (!soNumber) {
      const currentSO = await prisma.currentSO.findFirst();
      if (!currentSO) {
        return NextResponse.json(
          { error: 'No current SO number set and so_number not provided' },
          { status: 404 }
        );
      }
      soNumber = currentSO.soNumber;
    }

    // Find the sales order
    const salesOrder = await prisma.salesOrder.findFirst({
      where: { soNumber },
      select: { id: true, soNumber: true, originalThreadId: true, originalMessageId: true, purchaseOrderId: true },
    });

    if (!salesOrder) {
      return NextResponse.json(
        { error: `Sales order not found: ${soNumber}` },
        { status: 404 }
      );
    }

    // Upload file to R2
    const fileBuffer = Buffer.from(await file.arrayBuffer());
    const contentType = /\.pdf$/i.test(file.name) ? 'application/pdf' : 'application/octet-stream';
    const s3Key = `ls-files/${salesOrder.soNumber}/${file.name}`;
    await uploadToS3(s3Key, fileBuffer, contentType);

    // Create or update LoadingSlipItem
    let loadingSlipItem = await prisma.loadingSlipItem.findFirst({
      where: {
        salesOrderId: salesOrder.id,
        lsNumber,
      },
    });

    if (!loadingSlipItem) {
      loadingSlipItem = await prisma.loadingSlipItem.create({
        data: {
          salesOrderId: salesOrder.id,
          lsNumber,
          material: 'PENDING',
          fileUrl: s3Key,
          status: 'pending',
        },
      });
    } else {
      // ZLOAD3-A (/initial-data) may have created this record first — just update fileUrl
      loadingSlipItem = await prisma.loadingSlipItem.update({
        where: { id: loadingSlipItem.id },
        data: { fileUrl: s3Key },
      });
    }

    console.log(`[ZLOAD1 Data] Stored LS file — SO: ${soNumber}, LS: ${lsNumber}, file: ${file.name}, s3Key: ${s3Key}, itemId: ${loadingSlipItem.id}`);

    // Update SO status to ls_created
    await prisma.salesOrder.update({
      where: { id: salesOrder.id },
      data: { status: 'ls_created' },
    });

    // Bundles + vehicle-details emails were created at dispatch-confirmation
    // time (before ZLOAD1 fired) so the truck count was settled with the
    // branch already.
    //
    // auto_gui2's `meta` passthrough merges the bundle_id we sent in /chat
    // into this multipart callback (see services/gui_service.py send_data).
    // When present, set LSI.bundleId directly. Otherwise fall back to the
    // material-lookup heuristic.
    try {
      const incomingBundleId = (formData.get('bundle_id') as string | null) || null;
      if (incomingBundleId) {
        await prisma.loadingSlipItem.update({
          where: { id: loadingSlipItem.id },
          data: { bundleId: incomingBundleId },
        });
        console.log(`[ZLOAD1 Data] Linked LSI ${loadingSlipItem.id} to Bundle ${incomingBundleId} (via meta)`);
      } else {
        await linkLsiToBundle(loadingSlipItem.id);
      }
    } catch (linkErr) {
      console.error(
        `[ZLOAD1 Data] Failed to link LSI ${loadingSlipItem.id} to bundle:`,
        linkErr
      );
    }

    return NextResponse.json({
      success: true,
      so_number: soNumber,
      soNumber,
      lsNumber,
      fileUrl: s3Key,
    });
  } catch (error) {
    console.error('[Aman API - ZLOAD1 Data] Error:', error);
    return NextResponse.json(
      {
        error: 'Internal server error',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
