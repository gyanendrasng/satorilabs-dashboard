import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { uploadToS3 } from '@/lib/s3';

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
      select: { id: true, soNumber: true },
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

    // Update SO status to ls_created
    await prisma.salesOrder.update({
      where: { id: salesOrder.id },
      data: { status: 'ls_created' },
    });

    // Trigger ZLOAD3-A automatically (fire-and-forget)
    const AUTO_GUI_HOST = process.env.AUTO_GUI_HOST || 'localhost';
    const AUTO_GUI_PORT = process.env.AUTO_GUI_PORT || '8000';
    fetch(`http://${AUTO_GUI_HOST}:${AUTO_GUI_PORT}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instruction: `VPN is connected and SAP is logged in. Run the SAP Transaction ZLOAD3-A for Sales order number ${soNumber}.`,
        transaction_code: 'ZLOAD3-A',
        so_number: soNumber,
      }),
    })
      .then(() => console.log(`[ZLOAD1 Data] ZLOAD3-A triggered for SO ${soNumber}`))
      .catch((err) => console.error(`[ZLOAD1 Data] ZLOAD3-A trigger failed for SO ${soNumber}:`, err.message));

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
