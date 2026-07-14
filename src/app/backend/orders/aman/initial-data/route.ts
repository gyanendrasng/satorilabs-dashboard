import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { sendLSEmail } from '@/lib/email-service';
import { uploadToS3 } from '@/lib/s3';

/**
 * POST /backend/orders/aman/initial-data
 *
 * Receives LS files (XLS/PDF) from Aman (auto_gui2) after executing ZLOAD3-A.
 * Per file:
 *   1. Resolve SO from `so_number` form field (legacy: `soNumber` / CurrentSO).
 *   2. Upload the file to R2 at `ls-files/{soNumber}/{filename}`.
 *   3. Find the LoadingSlip created earlier by /zload1-data and update its
 *      fileUrl. If it doesn't exist, log and store the file on a bare LSI
 *      (loadingSlipId=NULL) — the LS link will get repaired on the next
 *      ZLOAD1 callback for the same lsNumber.
 *   4. Find-or-create LoadingSlipItem, populate the `items` metadata.
 *   5. Send the plant_ls email tagged to the LoadingSlip (so per-LS replies
 *      route cleanly).
 *
 * Schema (post-refactor):
 *   LoadingSlip = one plant's shipment within a bundle. Owns `fileUrl`.
 *   LoadingSlipItem = one SKU line on an LS.
 */
export async function POST(request: Request) {
  try {
    const formData = await request.formData();

    // SO lookup priority: so_number → soNumber → CurrentSO singleton
    let soNumber =
      (formData.get('so_number') as string | null) ||
      (formData.get('soNumber') as string | null);

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

    // Optional `items` JSON: per-LS metadata (material, qty, weight).
    const itemsJson = formData.get('items') as string | null;
    const itemsData: Record<
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

    // Accept either a single `file` or multiple `files`.
    const singleFile = formData.get('file') as File | null;
    const multipleFiles = formData.getAll('files') as File[];
    const files = singleFile ? [singleFile] : multipleFiles;

    if (files.length === 0) {
      return NextResponse.json({ error: 'No files received' }, { status: 400 });
    }

    const results: Array<{
      lsNumber: string;
      fileUrl: string;
      emailSent: boolean;
      messageId?: string;
      error?: string;
    }> = [];

    for (const file of files) {
      const lsNumber = file.name.replace(/\.(xls|xlsx|pdf)$/i, '').trim();
      const itemMeta = itemsData[lsNumber] || {};

      const isXls = /\.xls$/i.test(file.name);
      const isXlsx = /\.xlsx$/i.test(file.name);
      const contentType = isXls
        ? 'application/vnd.ms-excel'
        : isXlsx
          ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          : 'application/pdf';

      try {
        const fileBuffer = Buffer.from(await file.arrayBuffer());
        const s3Key = `ls-files/${salesOrder.soNumber}/${file.name}`;
        await uploadToS3(s3Key, fileBuffer, contentType);

        // Try to find the LoadingSlip created earlier by /zload1-data.
        // If found, update its fileUrl (the file from ZLOAD3-A often has
        // more detail than the ZLOAD1 file).
        const loadingSlip = await prisma.loadingSlip.findUnique({
          where: { lsNumber },
          select: { id: true },
        });
        if (loadingSlip) {
          await prisma.loadingSlip.update({
            where: { id: loadingSlip.id },
            data: { fileUrl: s3Key },
          });
        } else {
          console.warn(
            `[Initial Data] No LoadingSlip row for LS ${lsNumber} (SO ${soNumber}). ` +
              `ZLOAD1 callback may not have landed yet. Storing LSI with loadingSlipId=NULL; ` +
              `/zload1-data will link it when it arrives.`
          );
        }

        // Find-or-create the LSI. The unique index on (lsNumber, material)
        // means we can't blindly create — search first.
        let loadingSlipItem = await prisma.loadingSlipItem.findFirst({
          where: { salesOrderId: salesOrder.id, lsNumber },
        });

        if (!loadingSlipItem) {
          loadingSlipItem = await prisma.loadingSlipItem.create({
            data: {
              salesOrderId: salesOrder.id,
              loadingSlipId: loadingSlip?.id ?? null,
              lsNumber,
              material: itemMeta.material || 'PENDING',
              materialDescription: itemMeta.materialDescription || null,
              orderQuantity: itemMeta.orderQuantity || null,
              orderWeight: itemMeta.orderWeight || null,
              status: 'pending',
            },
          });
        } else {
          loadingSlipItem = await prisma.loadingSlipItem.update({
            where: { id: loadingSlipItem.id },
            data: {
              ...(loadingSlip && { loadingSlipId: loadingSlip.id }),
              ...(itemMeta.material && { material: itemMeta.material }),
              ...(itemMeta.materialDescription && {
                materialDescription: itemMeta.materialDescription,
              }),
              ...(itemMeta.orderQuantity && { orderQuantity: itemMeta.orderQuantity }),
              ...(itemMeta.orderWeight && { orderWeight: itemMeta.orderWeight }),
            },
          });
        }

        // Send the plant_ls email. The Email row gets `loadingSlipId` set
        // inside sendLSEmail so per-LS replies route to the right LS.
        const { messageId } = await sendLSEmail(
          loadingSlipItem.id,
          salesOrder.id,
          salesOrder.soNumber,
          lsNumber,
          fileBuffer,
          {
            vehicleNumber: salesOrder.vehicleNumber,
            driverMobile: salesOrder.driverMobile,
            containerNumber: salesOrder.containerNumber,
            transportId: salesOrder.transportId,
          },
          file.name
        );

        await prisma.loadingSlipItem.update({
          where: { id: loadingSlipItem.id },
          data: { status: 'in-progress' },
        });

        if (loadingSlip) {
          await prisma.loadingSlip.update({
            where: { id: loadingSlip.id },
            data: { status: 'sent_to_plant' },
          });
        }

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

    await prisma.salesOrder.update({
      where: { id: salesOrder.id },
      data: { status: 'in-progress' },
    });

    return NextResponse.json({
      success: true,
      so_number: soNumber,
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
