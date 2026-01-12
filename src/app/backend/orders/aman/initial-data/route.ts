import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { validateAmanApiKey } from '@/lib/aman-auth';

interface InitialDataItem {
  lsNumber: string;
  material: string;
  materialDescription?: string;
  orderQuantity?: number;
  orderWeight?: number;
}

interface InitialDataPayload {
  soNumber: string;
  items: InitialDataItem[];
}

// POST - Aman API 1: Add initial order data (LS, Material, Description, Qty, Weight)
export async function POST(request: Request) {
  try {
    // Validate API key
    const authResult = validateAmanApiKey(request);
    if (!authResult.valid) {
      return authResult.error;
    }

    const body: InitialDataPayload = await request.json();
    const { soNumber, items } = body;

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

    // Find the Sales Order by soNumber
    const salesOrder = await prisma.salesOrder.findFirst({
      where: { soNumber },
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
          { error: 'Each item must have lsNumber and material' },
          { status: 400 }
        );
      }
    }

    // Upsert items (create or update)
    const results = await Promise.all(
      items.map(async (item) => {
        return prisma.loadingSlipItem.upsert({
          where: {
            lsNumber_material: {
              lsNumber: item.lsNumber,
              material: item.material,
            },
          },
          create: {
            salesOrderId: salesOrder.id,
            lsNumber: item.lsNumber,
            material: item.material,
            materialDescription: item.materialDescription || null,
            orderQuantity: item.orderQuantity || null,
            orderWeight: item.orderWeight || null,
          },
          update: {
            materialDescription: item.materialDescription || null,
            orderQuantity: item.orderQuantity || null,
            orderWeight: item.orderWeight || null,
          },
        });
      })
    );

    return NextResponse.json({
      success: true,
      message: `${results.length} item(s) processed`,
      items: results,
    });
  } catch (error) {
    console.error('[Aman API 1 - Initial Data] Error:', error);
    return NextResponse.json(
      {
        error: 'Internal server error',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
