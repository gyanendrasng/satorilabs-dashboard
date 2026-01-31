import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { validateAmanApiKey } from '@/lib/aman-auth';
import { sendLSEmail } from '@/lib/email-service';

/**
 * POST /backend/orders/aman/initial-data
 *
 * Receives LS PDFs from Aman (auto_gui2) after executing ZLOAD3.
 * For each PDF received:
 * 1. Creates/updates LoadingSlipItem with lsNumber
 * 2. Fetches SalesOrder vehicle details
 * 3. Sends email to plant with LS PDF attached
 * 4. Creates Email record for tracking
 *
 * Expected: multipart/form-data with:
 * - soNumber: string (Sales Order number)
 * - files: File[] (LS PDF files, filename is the LS number e.g., "1001234.pdf")
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
    const soNumber = formData.get('soNumber') as string;

    if (!soNumber) {
      return NextResponse.json(
        { error: 'soNumber is required' },
        { status: 400 }
      );
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

    // Process all LS PDF files
    const files = formData.getAll('files') as File[];
    if (files.length === 0) {
      return NextResponse.json(
        { error: 'No PDF files received' },
        { status: 400 }
      );
    }

    const results: Array<{
      lsNumber: string;
      emailSent: boolean;
      messageId?: string;
      error?: string;
    }> = [];

    for (const file of files) {
      // Extract LS number from filename (e.g., "1001234.pdf" -> "1001234")
      const lsNumber = file.name.replace(/\.pdf$/i, '');
      const itemMeta = itemsData[lsNumber] || {};

      try {
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
              status: 'pending',
            },
          });
        } else if (itemMeta.material) {
          // Update with metadata if provided
          loadingSlipItem = await prisma.loadingSlipItem.update({
            where: { id: loadingSlipItem.id },
            data: {
              material: itemMeta.material,
              materialDescription: itemMeta.materialDescription || loadingSlipItem.materialDescription,
              orderQuantity: itemMeta.orderQuantity || loadingSlipItem.orderQuantity,
              orderWeight: itemMeta.orderWeight || loadingSlipItem.orderWeight,
            },
          });
        }

        // Get PDF buffer
        const pdfBuffer = Buffer.from(await file.arrayBuffer());

        // Send email to plant
        const { messageId } = await sendLSEmail(
          loadingSlipItem.id,
          salesOrder.soNumber,
          lsNumber,
          pdfBuffer,
          {
            vehicleNumber: salesOrder.vehicleNumber,
            driverMobile: salesOrder.driverMobile,
            containerNumber: salesOrder.containerNumber,
            transportId: salesOrder.transportId,
          }
        );

        // Update LoadingSlipItem status
        await prisma.loadingSlipItem.update({
          where: { id: loadingSlipItem.id },
          data: { status: 'in-progress' },
        });

        results.push({
          lsNumber,
          emailSent: true,
          messageId,
        });
      } catch (error) {
        console.error(`Error processing LS ${lsNumber}:`, error);
        results.push({
          lsNumber,
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
