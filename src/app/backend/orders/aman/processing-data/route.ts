import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

interface SAPResultRow {
  sales_order: string;
  material_doc: string;
  delivery_no: string;
  invoice_no: string;
  status?: string;
}

// POST - Aman API 2: Accept flat array of SAP ZSO_AUTO results from auto_gui2
export async function POST(request: Request) {
  try {
    const body = await request.json();

    // Accept flat array directly, or wrapped object with so_number
    const rows: SAPResultRow[] = Array.isArray(body) ? body : body.items ?? body.data;

    if (!rows || !Array.isArray(rows) || rows.length === 0) {
      return NextResponse.json(
        { error: 'Expected a JSON array of {sales_order, material_doc, delivery_no, invoice_no} objects' },
        { status: 400 }
      );
    }

    // SO lookup priority: body.so_number → rows[0].sales_order → CurrentSO singleton
    let soNumber = body.so_number as string | undefined;
    if (!soNumber) {
      soNumber = rows[0]?.sales_order;
    }
    if (!soNumber) {
      const currentSO = await prisma.currentSO.findFirst();
      soNumber = currentSO?.soNumber ?? undefined;
    }

    if (!soNumber) {
      return NextResponse.json(
        { error: 'Could not determine soNumber from payload or CurrentSO' },
        { status: 400 }
      );
    }

    // Find the Sales Order
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

    // Extract SO-level fields (same across all rows)
    const invoiceNo = rows[0]?.invoice_no;
    const deliveryNo = rows[0]?.delivery_no;

    // Create or update Invoice
    let invoice;
    if (salesOrder.invoice) {
      invoice = await prisma.invoice.update({
        where: { id: salesOrder.invoice.id },
        data: {
          ...(invoiceNo && { invoiceNumber: invoiceNo }),
          ...(deliveryNo && { obdNumber: deliveryNo }),
          sapResults: JSON.stringify(rows),
          status: 'created',
        },
      });
    } else {
      invoice = await prisma.invoice.create({
        data: {
          salesOrderId: salesOrder.id,
          invoiceNumber: invoiceNo || 'PENDING',
          obdNumber: deliveryNo,
          sapResults: JSON.stringify(rows),
          status: 'created',
        },
      });
    }

    return NextResponse.json({
      success: true,
      so_number: soNumber,
      message: `Invoice ${invoice.invoiceNumber} saved with ${rows.length} SAP result row(s)`,
      invoice,
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
