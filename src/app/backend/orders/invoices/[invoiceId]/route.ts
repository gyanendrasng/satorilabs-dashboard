import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

// PATCH - Update invoice (shipment details)
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ invoiceId: string }> }
) {
  try {
    const session = await auth.api.getSession({
      headers: request.headers,
    });

    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { invoiceId } = await params;
    const body = await request.json();

    // Find the invoice
    const existing = await prisma.invoice.findUnique({
      where: { id: invoiceId },
    });

    if (!existing) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
    }

    // Update invoice with shipment details (LR/vehicle moved to SalesOrder)
    const invoice = await prisma.invoice.update({
      where: { id: invoiceId },
      data: {
        shipmentType: body.shipmentType ?? existing.shipmentType,
        plantCode: body.plantCode ?? existing.plantCode,
        notes: body.notes ?? existing.notes,
        status: body.status ?? existing.status,
        amount: body.amount ?? existing.amount,
      },
    });

    return NextResponse.json({ invoice });
  } catch (error) {
    console.error('[/backend/orders/invoices] PATCH Error:', error);
    return NextResponse.json(
      {
        error: 'Internal server error',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}

// GET - Get invoice by ID
export async function GET(
  request: Request,
  { params }: { params: Promise<{ invoiceId: string }> }
) {
  try {
    const session = await auth.api.getSession({
      headers: request.headers,
    });

    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { invoiceId } = await params;

    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: {
        salesOrder: true,
      },
    });

    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
    }

    return NextResponse.json({ invoice });
  } catch (error) {
    console.error('[/backend/orders/invoices] GET Error:', error);
    return NextResponse.json(
      {
        error: 'Internal server error',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
