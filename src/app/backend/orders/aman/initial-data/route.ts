import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { validateAmanApiKey } from '@/lib/aman-auth';
import { sendLSEmail } from '@/lib/email-service';
import { uploadToS3 } from '@/lib/s3';

/**
 * POST /backend/orders/aman/initial-data
 *
 * Receives LS files (XLS/PDF) from Aman (auto_gui2) after executing ZLOAD3-A.
 * For each file received:
 * 1. Reads SO number from CurrentSO singleton (or uses provided soNumber)
 * 2. Uploads file to R2: ls-files/{soNumber}/{filename}
 * 3. Creates/updates LoadingSlipItem with fileUrl
 * 4. Sends email to plant with LS file attached
 * 5. Creates Email record for tracking
 *
 * Expected: multipart/form-data with:
 * - soNumber: string (optional - will read from CurrentSO if not provided)
 * - file: File (single LS file, filename is the LS number e.g., "1001234.xls")
 * OR
 * - files: File[] (multiple LS files)
 *
 * Optional JSON fields in form data:
 * - items: JSON string of InitialDataItem[] for additional item data
 */
export async function POST(request: Request) {
  try {
    // Validate API key
    const authResult = validateAmanApiKey(request);
    if (!authResult.valid) {
      return authResult.error;
    }

    const formData = await request.formData();
    let soNumber = formData.get('soNumber') as string | null;

    // If soNumber not provided, read from CurrentSO singleton
    if (!soNumber) {
      const currentSO = await prisma.currentSO.findFirst();
      if (!currentSO) {
        return NextResponse.json(
          { error: 'No current SO number set and soNumber not provided' },
          { status: 404 }
        );
      }
      soNumber = currentSO.soNumber;
    }

    // Find the sales order
    const salesOrder = await prisma.salesOrder.findFirst({
      where: { soNumber },
      select: {
        id: true,
        soNumber: true,
        vehicleNumber: true,
        driverMobile: true,
        containerNumber: true,
        transportId: true,
      },
    });

    if (!salesOrder) {
      return NextResponse.json(
        { error: `Sales order not found: ${soNumber}` },
        { status: 404 }
      );
    }

    // Parse optional items JSON for additional metadata
    const itemsJson = formData.get('items') as string | null;
    let itemsData: Record<
      string,
      {
        material?: string;
        materialDescription?: string;
        orderQuantity?: number;
        orderWeight?: number;
      }
    > = {};

    if (itemsJson) {
      try {
        const parsedItems = JSON.parse(itemsJson) as Array<{
          lsNumber: string;
          material?: string;
          materialDescription?: string;
          orderQuantity?: number;
          orderWeight?: number;
        }>;
        for (const item of parsedItems) {
          itemsData[item.lsNumber] = item;
        }
      } catch {
        console.warn('Failed to parse items JSON, continuing without metadata');
      }
    }

    // Get files - support both single 'file' and multiple 'files'
    const singleFile = formData.get('file') as File | null;
    const multipleFiles = formData.getAll('files') as File[];
    const files = singleFile ? [singleFile] : multipleFiles;

    if (files.length === 0) {
      return NextResponse.json(
        { error: 'No files received' },
        { status: 400 }
      );
    }

    const results: Array<{
      lsNumber: string;
      fileUrl: string;
      emailSent: boolean;
      messageId?: string;
      error?: string;
    }> = [];

    for (const file of files) {
      // Extract LS number from filename (e.g., "1001234.xls" or "1001234.pdf" -> "1001234")
      const lsNumber = file.name.replace(/\.(xls|xlsx|pdf)$/i, '').trim();
      const itemMeta = itemsData[lsNumber] || {};

      // Determine content type
      const isXls = /\.xls$/i.test(file.name);
      const isXlsx = /\.xlsx$/i.test(file.name);
      const contentType = isXls
        ? 'application/vnd.ms-excel'
        : isXlsx
          ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          : 'application/pdf';

      try {
        // Get file buffer
        const fileBuffer = Buffer.from(await file.arrayBuffer());

        // Upload to R2: ls-files/{soNumber}/{filename}
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
          // Create new LoadingSlipItem
          loadingSlipItem = await prisma.loadingSlipItem.create({
            data: {
              salesOrderId: salesOrder.id,
              lsNumber,
              material: itemMeta.material || 'PENDING',
              materialDescription: itemMeta.materialDescription || null,
              orderQuantity: itemMeta.orderQuantity || null,
              orderWeight: itemMeta.orderWeight || null,
              fileUrl: s3Key,
              status: 'pending',
            },
          });
        } else {
          // Update existing LoadingSlipItem with fileUrl and optional metadata
          loadingSlipItem = await prisma.loadingSlipItem.update({
            where: { id: loadingSlipItem.id },
            data: {
              fileUrl: s3Key,
              ...(itemMeta.material && { material: itemMeta.material }),
              ...(itemMeta.materialDescription && { materialDescription: itemMeta.materialDescription }),
              ...(itemMeta.orderQuantity && { orderQuantity: itemMeta.orderQuantity }),
              ...(itemMeta.orderWeight && { orderWeight: itemMeta.orderWeight }),
            },
          });
        }

        // Send email to plant
        const { messageId } = await sendLSEmail(
          loadingSlipItem.id,
          salesOrder.soNumber,
          lsNumber,
          fileBuffer,
          {
            vehicleNumber: salesOrder.vehicleNumber,
            driverMobile: salesOrder.driverMobile,
            containerNumber: salesOrder.containerNumber,
            transportId: salesOrder.transportId,
          },
          file.name // pass original filename for email attachment
        );

        // Update LoadingSlipItem status
        await prisma.loadingSlipItem.update({
          where: { id: loadingSlipItem.id },
          data: { status: 'in-progress' },
        });

        results.push({
          lsNumber,
          fileUrl: s3Key,
          emailSent: true,
          messageId,
        });
      } catch (error) {
        console.error(`Error processing LS ${lsNumber}:`, error);
        results.push({
          lsNumber,
          fileUrl: '',
          emailSent: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    // Update sales order status
    await prisma.salesOrder.update({
      where: { id: salesOrder.id },
      data: { status: 'in-progress' },
    });

    return NextResponse.json({
      success: true,
      soNumber,
      processed: results.length,
      results,
    });
  } catch (error) {
    console.error('[Aman API - Initial Data] Error:', error);
    return NextResponse.json(
      {
        error: 'Internal server error',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
