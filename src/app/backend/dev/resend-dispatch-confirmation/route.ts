import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { sendDispatchConfirmationEmail } from '@/lib/auto-gui-trigger';

/**
 * POST /backend/dev/resend-dispatch-confirmation
 *
 * One-shot helper to re-send the dispatch_confirmation email for a PO using
 * the latest stored plans + bundle layout. Useful when the email format has
 * changed and we want to re-send without rerunning the whole branch-reply
 * → vehicle-split pipeline (which would require fresh Gmail replies).
 *
 * Body: { poNumber: "AUTO-..." }  OR  { emailId: "<dispatch_confirmation row id>" }
 *
 * Behavior:
 *   1. Find the most recent dispatch_confirmation Email row for the PO.
 *   2. Parse its relatedMaterials JSON (plans, twoVehicles, totals).
 *   3. Use the original ls_dispatch row as the threadAnchor so the new
 *      email lands in the same Gmail thread.
 *   4. Delete the old dispatch_confirmation row.
 *   5. Call sendDispatchConfirmationEmail — recomputes bundles via
 *      computeBundlesForPo and renders bundle-wise.
 */
export async function POST(req: Request) {
  let body: { poNumber?: string; emailId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.poNumber && !body.emailId) {
    return NextResponse.json(
      { error: 'Provide poNumber or emailId in the body' },
      { status: 400 }
    );
  }

  const existing = body.emailId
    ? await prisma.email.findFirst({
        where: { id: body.emailId, emailType: 'dispatch_confirmation' },
      })
    : await prisma.email.findFirst({
        where: {
          emailType: 'dispatch_confirmation',
          purchaseOrder: { poNumber: body.poNumber! },
        },
        orderBy: { sentAt: 'desc' },
      });

  if (!existing || !existing.purchaseOrderId || !existing.relatedMaterials) {
    return NextResponse.json(
      { error: 'No dispatch_confirmation row with relatedMaterials found' },
      { status: 404 }
    );
  }

  const meta = JSON.parse(existing.relatedMaterials) as {
    plans: Parameters<typeof sendDispatchConfirmationEmail>[0]['plans'];
    twoVehicles: boolean;
    totalTonnes: number;
    capacityTonnes: number;
  };

  const lsDispatch = await prisma.email.findFirst({
    where: { purchaseOrderId: existing.purchaseOrderId, emailType: 'ls_dispatch' },
    orderBy: { sentAt: 'asc' },
  });
  if (!lsDispatch) {
    return NextResponse.json(
      { error: 'Original ls_dispatch row missing — cannot anchor reply to thread' },
      { status: 404 }
    );
  }

  const logs: string[] = [];
  const log = (m: string) => {
    const t = `[${new Date().toISOString()}] ${m}`;
    console.log(t);
    logs.push(t);
  };

  log(`[ResendDispatchConfirm] Re-sending for PO ${body.poNumber ?? existing.purchaseOrderId} — deleting old row ${existing.id}`);
  await prisma.email.delete({ where: { id: existing.id } });

  await sendDispatchConfirmationEmail({
    purchaseOrderId: existing.purchaseOrderId,
    plans: meta.plans,
    twoVehicles: meta.twoVehicles,
    totalTonnes: meta.totalTonnes,
    capacityTonnes: meta.capacityTonnes,
    log,
  });

  return NextResponse.json({ success: true, deletedEmailId: existing.id, logs });
}
