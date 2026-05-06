import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { assembleAndSendCombinedEmail } from '@/lib/auto-gui-trigger';

/**
 * POST /backend/dev/resend-ls-dispatch
 *
 * Re-fires the combined ls_dispatch (Dispatch Approval Request) email for a
 * PO using already-persisted Material rows. Use when the original send failed
 * (e.g. Gmail invalid_grant) and visibility data is already stored — avoids
 * burning another ZSO-VISIBILITY round-trip via the rerun-visibility script.
 *
 * Body: { "poNumber": "AUTO-..." } OR { "purchaseOrderId": "cmosw..." }
 */
export async function POST(req: Request) {
  let body: { poNumber?: string; purchaseOrderId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  let purchaseOrderId = body.purchaseOrderId;
  if (!purchaseOrderId && body.poNumber) {
    const po = await prisma.purchaseOrder.findUnique({
      where: { poNumber: body.poNumber },
      select: { id: true },
    });
    if (!po) {
      return NextResponse.json({ error: `PO ${body.poNumber} not found` }, { status: 404 });
    }
    purchaseOrderId = po.id;
  }
  if (!purchaseOrderId) {
    return NextResponse.json(
      { error: 'Provide poNumber or purchaseOrderId' },
      { status: 400 }
    );
  }

  // Wipe any previous ls_dispatch row for this PO so assembly creates a fresh
  // one on send (the function exits early if one already exists).
  const cleared = await prisma.email.deleteMany({
    where: { purchaseOrderId, emailType: 'ls_dispatch' },
  });

  const result = await assembleAndSendCombinedEmail(purchaseOrderId);
  return NextResponse.json({
    success: result.success,
    purchaseOrderId,
    clearedPriorEmails: cleared.count,
    logs: result.logs,
  });
}
