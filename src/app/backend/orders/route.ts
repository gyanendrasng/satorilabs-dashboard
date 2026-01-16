import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { nanoid } from 'nanoid';

// GET - List all purchase orders with nested sales orders and items
export async function GET(request: Request) {
  try {
    const session = await auth.api.getSession({
      headers: request.headers,
    });

    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const purchaseOrders = await prisma.purchaseOrder.findMany({
      orderBy: {
        createdAt: 'desc',
      },
      include: {
        salesOrders: {
          orderBy: {
            createdAt: 'asc',
          },
          include: {
            items: {
              orderBy: {
                lsNumber: 'asc',
              },
            },
            invoice: true,
          },
        },
      },
    });

    return NextResponse.json({ purchaseOrders });
  } catch (error) {
    console.error('[/backend/orders] GET Error:', error);
    return NextResponse.json(
      {
        error: 'Internal server error',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}

// POST - Create a new purchase order
export async function POST(request: Request) {
  try {
    const session = await auth.api.getSession({
      headers: request.headers,
    });

    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { customerName, poNumber } = await request.json();

    if (!customerName) {
      return NextResponse.json(
        { error: 'Customer name is required' },
        { status: 400 }
      );
    }

    // Auto-generate PO number if not provided
    const finalPoNumber = poNumber || `PO-${Date.now()}-${nanoid(4)}`;

    const purchaseOrder = await prisma.purchaseOrder.create({
      data: {
        customerName,
        poNumber: finalPoNumber,
      },
    });

    return NextResponse.json({ purchaseOrder });
  } catch (error) {
    console.error('[/backend/orders] POST Error:', error);
    return NextResponse.json(
      {
        error: 'Internal server error',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
