import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

// POST - Add a sales order to a purchase order
export async function POST(
  request: Request,
  { params }: { params: Promise<{ poId: string }> }
) {
  try {
    const session = await auth.api.getSession({
      headers: request.headers,
    });

    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { poId } = await params;
    const { soNumber, vehicleNumber, transportId } = await request.json();

    if (!soNumber) {
      return NextResponse.json(
        { error: 'SO Number is required' },
        { status: 400 }
      );
    }

    // Verify PO exists
    const purchaseOrder = await prisma.purchaseOrder.findUnique({
      where: { id: poId },
      include: { salesOrders: true },
    });

    if (!purchaseOrder) {
      return NextResponse.json(
        { error: 'Purchase order not found' },
        { status: 404 }
      );
    }

    // Check max 4 SO per PO
    if (purchaseOrder.salesOrders.length >= 4) {
      return NextResponse.json(
        { error: 'Maximum 4 sales orders allowed per purchase order' },
        { status: 400 }
      );
    }

    const salesOrder = await prisma.salesOrder.create({
      data: {
        purchaseOrderId: poId,
        soNumber,
        vehicleNumber: vehicleNumber || null,
        transportId: transportId || null,
      },
    });

    return NextResponse.json({ salesOrder });
  } catch (error) {
    console.error('[/backend/orders/[poId]/sales-orders] POST Error:', error);
    return NextResponse.json(
      {
        error: 'Internal server error',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
