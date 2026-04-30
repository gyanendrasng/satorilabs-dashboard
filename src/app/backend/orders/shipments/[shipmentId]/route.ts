import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { triggerVto1n } from '@/lib/auto-gui-trigger';

/**
 * PATCH /backend/orders/shipments/[shipmentId]
 *
 * Operator fills per-truck details from the dashboard. Each truck = one
 * Shipment row. When LR number + LR date are present (and the bundle's
 * vehicle number + Shipment's OBD are already set), VT01N is auto-fired
 * for THIS Shipment only.
 *
 * Body (all optional; only fields present in the body are updated):
 *   {
 *     lrNumber?:     string,
 *     lrDate?:       string (ISO date),
 *     plantCode?:    string,
 *     shipmentType?: string,
 *     notes?:        string
 *   }
 *
 * Response:
 *   { shipment: <updated row>, vto1nTriggered: boolean, reason?: string }
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ shipmentId: string }> }
) {
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { shipmentId } = await params;
    const body = await request.json();

    const update: {
      lrNumber?: string | null;
      lrDate?: Date | null;
      plantCode?: string | null;
      shipmentType?: string | null;
      notes?: string | null;
    } = {};
    if (body.lrNumber !== undefined) update.lrNumber = body.lrNumber || null;
    if (body.lrDate !== undefined) update.lrDate = body.lrDate ? new Date(body.lrDate) : null;
    if (body.plantCode !== undefined) update.plantCode = body.plantCode || null;
    if (body.shipmentType !== undefined) update.shipmentType = body.shipmentType || null;
    if (body.notes !== undefined) update.notes = body.notes || null;

    const shipment = await prisma.shipment.update({
      where: { id: shipmentId },
      data: update,
      include: { bundle: true, salesOrder: true },
    });

    // VT01N gate: needs LR no, LR date, OBD, and a vehicle on the Bundle
    // (operator set it via the vehicle-details email reply earlier). Only
    // trigger when status is still 'created' to avoid re-firing.
    let vto1nTriggered = false;
    let reason: string | undefined;
    if (shipment.status !== 'created') {
      reason = `shipment is in state '${shipment.status}', not 'created'`;
    } else if (!shipment.lrNumber || !shipment.lrDate) {
      reason = 'lrNumber and lrDate required';
    } else if (!shipment.obdNumber) {
      reason = 'shipment has no obdNumber yet (waiting on ZLOAD3-B1 callback)';
    } else if (!shipment.bundle.vehicleNumber) {
      reason = `bundle ${shipment.bundle.bundleNumber} has no vehicleNumber yet (waiting on vehicle-details reply)`;
    } else {
      try {
        await triggerVto1n(shipmentId);
        vto1nTriggered = true;
      } catch (err) {
        reason = err instanceof Error ? err.message : String(err);
        console.error(`[PATCH shipments/${shipmentId}] triggerVto1n threw:`, err);
      }
    }

    return NextResponse.json({ shipment, vto1nTriggered, reason });
  } catch (error) {
    console.error('[PATCH shipments] Error:', error);
    return NextResponse.json(
      { error: 'Internal server error', details: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
