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
 * - file: File (single LS file, filename is the LS number e.g., "1234567890.PDF")
 *
 * SO number is read from the CurrentSO singleton.
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

    // Read SO number from CurrentSO singleton
    const currentSO = await prisma.currentSO.findFirst();
    if (!currentSO) {
      return NextResponse.json(
        { error: 'No current SO number set' },
        { status: 404 }
      );
    }
    const soNumber = currentSO.soNumber;

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

    // No email sent — that's /initial-data's job (ZLOAD3-A, Stage 2)

    return NextResponse.json({
      success: true,
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
