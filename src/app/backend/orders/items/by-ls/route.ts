import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

// PATCH - Update all loading slip items by lsNumber
export async function PATCH(request: Request) {
  try {
    const body = await request.json();
    const { lsNumber, status } = body;

    if (!lsNumber) {
      return NextResponse.json(
        { error: 'lsNumber is required' },
        { status: 400 }
      );
    }

    if (!status) {
      return NextResponse.json(
        { error: 'status is required' },
        { status: 400 }
      );
    }

    const result = await prisma.loadingSlipItem.updateMany({
      where: { lsNumber },
      data: { status },
    });

    return NextResponse.json({
      success: true,
      updated: result.count,
      lsNumber,
      status,
    });
  } catch (error) {
    console.error('[/backend/orders/items/by-ls] PATCH Error:', error);
    return NextResponse.json(
      {
        error: 'Internal server error',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
