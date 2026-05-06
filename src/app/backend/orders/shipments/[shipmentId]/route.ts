import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { triggerVto1n } from '@/lib/auto-gui-trigger';

/**
 * PATCH /backend/orders/shipments/[shipmentId]
 *
 * Per-shipment "provide shipment details" handler. Updates LR/vehicle/etc.
 * scoped to ONE Shipment (and its linked Bundle), then fires VTO1N-B for
 * just that shipment. Replaces the older SO-level PATCH-then-loop path,
 * which fired VTO1N for every Shipment in 'created' state of the SO.
 *
 * Body (all optional except lrNumber + lrDate):
 *   {
 *     lrNumber, lrDate,                                    // shipment-level
 *     vehicleNumber, driverMobile, containerNumber, transportId,  // bundle-level
 *     shipmentType, plantCode, notes                       // legacy Invoice mirror
 *   }
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ shipmentId: string }> }
) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { shipmentId } = await context.params;

  let body: {
    lrNumber?: string;
    lrDate?: string;
    vehicleNumber?: string;
    driverMobile?: string;
    containerNumber?: string;
    transportId?: string;
    shipmentType?: string;
    plantCode?: string;
    notes?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.lrNumber || !body.lrDate) {
    return NextResponse.json(
      { error: 'lrNumber and lrDate are required' },
      { status: 400 }
    );
  }

  const shipment = await prisma.shipment.findUnique({
    where: { id: shipmentId },
    include: { bundle: true, salesOrder: true },
  });
  if (!shipment) {
    return NextResponse.json({ error: 'Shipment not found' }, { status: 404 });
  }

  const lrDate = new Date(body.lrDate);
  if (Number.isNaN(lrDate.getTime())) {
    return NextResponse.json({ error: 'Invalid lrDate' }, { status: 400 });
  }

  // Update Shipment LR fields
  const updatedShipment = await prisma.shipment.update({
    where: { id: shipmentId },
    data: {
      lrNumber: body.lrNumber,
      lrDate,
    },
  });

  // Bundle-level vehicle overrides (only the keys that were sent)
  const bundleUpdate: Record<string, string> = {};
  if (body.vehicleNumber) bundleUpdate.vehicleNumber = body.vehicleNumber;
  if (body.driverMobile) bundleUpdate.driverMobile = body.driverMobile;
  if (body.containerNumber) bundleUpdate.containerNumber = body.containerNumber;
  if (body.transportId) bundleUpdate.transportId = body.transportId;
  if (Object.keys(bundleUpdate).length > 0) {
    await prisma.bundle.update({
      where: { id: shipment.bundleId },
      data: bundleUpdate,
    });
  }

  // Legacy Invoice mirror for back-compat with older UI fields
  const invoiceUpdate: Record<string, string> = {};
  if (body.shipmentType) invoiceUpdate.shipmentType = body.shipmentType;
  if (body.plantCode) invoiceUpdate.plantCode = body.plantCode;
  if (body.notes) invoiceUpdate.notes = body.notes;
  if (Object.keys(invoiceUpdate).length > 0) {
    await prisma.invoice.updateMany({
      where: { salesOrderId: shipment.salesOrderId },
      data: invoiceUpdate,
    });
  }

  // Fire VTO1N-B for ONLY this shipment.
  let vto1nTriggered = 0;
  try {
    await triggerVto1n(shipmentId);
    vto1nTriggered = 1;
  } catch (err) {
    console.error(`[Shipment PATCH] triggerVto1n failed for ${shipmentId}:`, err);
    return NextResponse.json(
      {
        shipment: updatedShipment,
        vto1nTriggered: 0,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  }

  return NextResponse.json({ shipment: updatedShipment, vto1nTriggered });
}
