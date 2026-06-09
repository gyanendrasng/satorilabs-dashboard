import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

// PATCH - Update vehicle/transport details on a Bundle
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ bundleId: string }> }
) {
  try {
    const session = await auth.api.getSession({
      headers: request.headers,
    });

    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { bundleId } = await params;
    const body = await request.json();

    const existing = await prisma.bundle.findUnique({ where: { id: bundleId } });
    if (!existing) {
      return NextResponse.json({ error: 'Bundle not found' }, { status: 404 });
    }

    const normalize = (v: unknown) => {
      if (v === undefined) return undefined;
      if (v === null) return null;
      const s = String(v).trim();
      return s.length === 0 ? null : s;
    };

    const bundle = await prisma.bundle.update({
      where: { id: bundleId },
      data: {
        ...(body.vehicleNumber !== undefined && { vehicleNumber: normalize(body.vehicleNumber) }),
        ...(body.driverMobile !== undefined && { driverMobile: normalize(body.driverMobile) }),
        ...(body.containerNumber !== undefined && { containerNumber: normalize(body.containerNumber) }),
        ...(body.transportId !== undefined && { transportId: normalize(body.transportId) }),
        ...(body.sealNumber !== undefined && { sealNumber: normalize(body.sealNumber) }),
      },
      select: {
        id: true,
        bundleNumber: true,
        vehicleNumber: true,
        driverMobile: true,
        containerNumber: true,
        transportId: true,
        sealNumber: true,
        status: true,
      },
    });

    return NextResponse.json({ bundle });
  } catch (error) {
    console.error('[/backend/orders/bundles/[bundleId]] PATCH Error:', error);
    return NextResponse.json(
      {
        error: 'Internal server error',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
