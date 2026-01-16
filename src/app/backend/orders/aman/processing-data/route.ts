import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { validateAmanApiKey } from '@/lib/aman-auth';

interface ProcessingDataItem {
  lsNumber: string;
  material: string;
  grnNumber?: string;
}

interface ProcessingDataPayload {
  soNumber: string;
  hrjInvoiceNumber?: string; // Now at SO/Invoice level
  outboundDeliveryNumber?: string; // Now at SO/Invoice level
  items: ProcessingDataItem[];
}

// POST - Aman API 2: Add post-processing data (GRN per item, HRJ Invoice/OBD at SO level)
export async function POST(request: Request) {
  try {
    // Validate API key
    const authResult = validateAmanApiKey(request);
    if (!authResult.valid) {
      return authResult.error;
    }

    const body: ProcessingDataPayload = await request.json();
    const { soNumber, hrjInvoiceNumber, outboundDeliveryNumber, items } = body;

    if (!soNumber) {
      return NextResponse.json(
        { error: 'soNumber is required' },
        { status: 400 }
      );
    }

    if (!items || !Array.isArray(items) || items.length === 0) {
      return NextResponse.json(
        { error: 'items array is required and must not be empty' },
        { status: 400 }
      );
    }

    // Find the Sales Order by soNumber to verify it exists
    const salesOrder = await prisma.salesOrder.findFirst({
      where: { soNumber },
      include: { invoice: true },
    });

    if (!salesOrder) {
      return NextResponse.json(
        { error: `Sales Order with soNumber '${soNumber}' not found` },
        { status: 404 }
      );
    }

    // Validate all items have required fields
    for (const item of items) {
      if (!item.lsNumber || !item.material) {
        return NextResponse.json(
          { error: 'Each item must have lsNumber and material to identify the record' },
          { status: 400 }
        );
      }
    }

    // Update items with GRN Number only
    const results = [];
    const notFound = [];

    for (const item of items) {
      // Find existing item
      const existingItem = await prisma.loadingSlipItem.findUnique({
        where: {
          lsNumber_material: {
            lsNumber: item.lsNumber,
            material: item.material,
          },
        },
      });

      if (!existingItem) {
        notFound.push({ lsNumber: item.lsNumber, material: item.material });
        continue;
      }

      // Update with GRN Number only
      const updated = await prisma.loadingSlipItem.update({
        where: {
          lsNumber_material: {
            lsNumber: item.lsNumber,
            material: item.material,
          },
        },
        data: {
          grnNumber: item.grnNumber ?? existingItem.grnNumber,
        },
      });

      results.push(updated);
    }

    // Create or Update Invoice if HRJ Invoice Number is provided
    let invoice = null;
    if (hrjInvoiceNumber) {
      if (salesOrder.invoice) {
        // Update existing Invoice
        invoice = await prisma.invoice.update({
          where: { id: salesOrder.invoice.id },
          data: {
            invoiceNumber: hrjInvoiceNumber,
            obdNumber: outboundDeliveryNumber ?? salesOrder.invoice.obdNumber,
            status: 'created',
          },
        });
      } else {
        // Create new Invoice
        invoice = await prisma.invoice.create({
          data: {
            salesOrderId: salesOrder.id,
            invoiceNumber: hrjInvoiceNumber,
            obdNumber: outboundDeliveryNumber,
            status: 'created',
          },
        });
      }
    }

    return NextResponse.json({
      success: true,
      message: `${results.length} item(s) updated`,
      items: results,
      invoice: invoice,
      ...(notFound.length > 0 && {
        notFound: {
          count: notFound.length,
          items: notFound,
        },
      }),
    });
  } catch (error) {
    console.error('[Aman API 2 - Processing Data] Error:', error);
    return NextResponse.json(
      {
        error: 'Internal server error',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
