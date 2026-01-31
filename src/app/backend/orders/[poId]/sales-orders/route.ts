import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import axios from 'axios';

const AUTO_GUI_HOST = process.env.AUTO_GUI_HOST || '20.244.42.146';

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
    const body = await request.json();
    const {
      soNumber,
      vehicleNumber,
      transportId,
      driverMobile,
      containerNumber,
      sealNumber,
      weight,
      containerType,
      deliveryLocations,
      specialInstructions,
    } = body;

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
        driverMobile: driverMobile || null,
        containerNumber: containerNumber || null,
        sealNumber: sealNumber || null,
        weight: weight || null,
        containerType: containerType || null,
        deliveryLocations: deliveryLocations || null,
        specialInstructions: specialInstructions || null,
      },
    });

    // Fire-and-forget: Call Aman's auto_gui2 API in background
    axios
      .post(`http://${AUTO_GUI_HOST}:8000/chat`, {
        instruction: `VPN is connected and SAP is logged in. Run the SAP Transaction ZLOAD3 for Sales order number ${soNumber}.`,
        transaction_code: 'ZLOAD3',
      })
      .then(() => console.log(`[sales-orders] auto_gui2 ZLOAD3 triggered for SO ${soNumber}`))
      .catch((err) => console.error(`[sales-orders] auto_gui2 error:`, err.message));

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
