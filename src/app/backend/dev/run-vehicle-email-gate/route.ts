import { NextResponse } from 'next/server';
import { checkAndSendCombinedVehicleEmailForPo } from '@/lib/auto-gui-trigger';

/**
 * POST /backend/dev/run-vehicle-email-gate
 *
 * Manually invoke the combined-vehicle-details email gate for a PO. Use
 * after flipping a failed ZLOAD1 work_queue row to 'done' when the gate
 * didn't auto-fire (the natural callback already happened before the flip).
 *
 * Body: { "purchaseOrderId": "cmoswa4sc000bqj1hi4tkvnu1" }
 */
export async function POST(req: Request) {
  let body: { purchaseOrderId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.purchaseOrderId) {
    return NextResponse.json(
      { error: 'purchaseOrderId is required' },
      { status: 400 }
    );
  }

  const result = await checkAndSendCombinedVehicleEmailForPo(body.purchaseOrderId);
  return NextResponse.json({
    sent: result.sent,
    logs: result.logs,
  });
}
