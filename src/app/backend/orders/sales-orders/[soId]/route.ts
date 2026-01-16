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
    const body = await request.json();

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
        ...(body.soNumber !== undefined && { soNumber: body.soNumber }),
        ...(body.vehicleNumber !== undefined && { vehicleNumber: body.vehicleNumber || null }),
        ...(body.transportId !== undefined && { transportId: body.transportId || null }),
        ...(body.driverMobile !== undefined && { driverMobile: body.driverMobile || null }),
        ...(body.containerNumber !== undefined && { containerNumber: body.containerNumber || null }),
        ...(body.sealNumber !== undefined && { sealNumber: body.sealNumber || null }),
        ...(body.weight !== undefined && { weight: body.weight || null }),
        ...(body.containerType !== undefined && { containerType: body.containerType || null }),
        ...(body.deliveryLocations !== undefined && { deliveryLocations: body.deliveryLocations || null }),
        ...(body.specialInstructions !== undefined && { specialInstructions: body.specialInstructions || null }),
        ...(body.lrNumber !== undefined && { lrNumber: body.lrNumber || null }),
        ...(body.lrDate !== undefined && { lrDate: body.lrDate ? new Date(body.lrDate) : null }),
        ...(body.status !== undefined && { status: body.status }),
        ...(body.requiresInput !== undefined && { requiresInput: body.requiresInput }),
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
        invoice: true,
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
