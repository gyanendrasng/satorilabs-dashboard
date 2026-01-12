import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

// PATCH - Update a sales order
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ soId: string }> }
) {
  try {
    const session = await auth.api.getSession({
      headers: request.headers,
    });

    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { soId } = await params;
    const { soNumber, vehicleNumber, transportId } = await request.json();

    // Verify SO exists
    const existingSO = await prisma.salesOrder.findUnique({
      where: { id: soId },
    });

    if (!existingSO) {
      return NextResponse.json(
        { error: 'Sales order not found' },
        { status: 404 }
      );
    }

    const salesOrder = await prisma.salesOrder.update({
      where: { id: soId },
      data: {
        ...(soNumber !== undefined && { soNumber }),
        ...(vehicleNumber !== undefined && { vehicleNumber: vehicleNumber || null }),
        ...(transportId !== undefined && { transportId: transportId || null }),
      },
    });

    return NextResponse.json({ salesOrder });
  } catch (error) {
    console.error('[/backend/orders/sales-orders/[soId]] PATCH Error:', error);
    return NextResponse.json(
      {
        error: 'Internal server error',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}

// GET - Get a single sales order with items
export async function GET(
  request: Request,
  { params }: { params: Promise<{ soId: string }> }
) {
  try {
    const session = await auth.api.getSession({
      headers: request.headers,
    });

    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { soId } = await params;

    const salesOrder = await prisma.salesOrder.findUnique({
      where: { id: soId },
      include: {
        purchaseOrder: true,
        items: {
          orderBy: { lsNumber: 'asc' },
        },
      },
    });

    if (!salesOrder) {
      return NextResponse.json(
        { error: 'Sales order not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({ salesOrder });
  } catch (error) {
    console.error('[/backend/orders/sales-orders/[soId]] GET Error:', error);
    return NextResponse.json(
      {
        error: 'Internal server error',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
