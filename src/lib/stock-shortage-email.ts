import { prisma } from './prisma';
import { sendPlainEmail, sendReplyEmail, getMessageRfc822Id } from './gmail';
import type { StockShortage } from './stock-precheck';
import { resolvePoThreadAnchor, capturePoThreadAnchor, withPurposeLine } from './po-thread';

const BRANCH_EMAIL = process.env.BRANCH_EMAIL || '';

/**
 * Ask how to proceed when a modification can't be fully stocked. Always goes to
 * the BRANCH: even a plant-initiated change is funnelled through the branch
 * (we send a plant_change_notification, the branch approves, then the branch
 * makes every downstream decision), so the "how do you want to proceed on the
 * short stock" question is always a branch conversation.
 */
export async function sendStockShortageInquiryEmail(args: {
  salesOrderId: string;
  triggerEmailId: string;
  shortages: StockShortage[];
  log: (msg: string) => void;
}): Promise<{ messageId: string; threadId: string } | null> {
  const { salesOrderId, shortages, log } = args;

  if (!BRANCH_EMAIL) {
    log(`[StockShort] BRANCH_EMAIL not configured — skipping`);
    return null;
  }

  const so = await prisma.salesOrder.findUnique({
    where: { id: salesOrderId },
    select: { soNumber: true, purchaseOrderId: true },
  });
  if (!so) {
    log(`[StockShort] SO ${salesOrderId} not found`);
    return null;
  }

  const lines = shortages.map(
    (s) => `  - ${s.material}: you requested ${s.requested} units, only ${s.available} available`,
  );

  const body = [
    `Hi team,`,
    ``,
    `We checked stock against your modification request for SO ${so.soNumber}`,
    `and the following items are short:`,
    ``,
    ...lines,
    ``,
    `Please let us know how you'd like to proceed for each short item:`,
    `  - drop the line entirely, or`,
    `  - keep the existing ordered quantity, or`,
    `  - request a different (smaller) quantity.`,
    ``,
    `We'll re-run the modification once we have your decision.`,
    ``,
    `Thanks.`,
  ].join('\n');

  const purposeLabel = `Stock Short - SO ${so.soNumber}`;

  // Ride the per-PO branch conversation (Re: <NEW ORDER subject>).
  const anchor = so.purchaseOrderId
    ? await resolvePoThreadAnchor(so.purchaseOrderId, 'branch')
    : null;
  const subject = anchor?.subject ?? purposeLabel;
  const sendBody = withPurposeLine(purposeLabel, body);

  let sent: { messageId: string; threadId: string };
  try {
    if (anchor) {
      sent = await sendReplyEmail(BRANCH_EMAIL, subject, sendBody, anchor.threadId, anchor.rfc822MessageId);
    } else {
      sent = await sendPlainEmail(BRANCH_EMAIL, subject, sendBody);
    }
  } catch (err) {
    log(`[StockShort] reply-in-thread failed (${err instanceof Error ? err.message : err}); sending as new email`);
    sent = await sendPlainEmail(BRANCH_EMAIL, subject, sendBody);
  }

  if (so.purchaseOrderId && !anchor) {
    const rfc822 = await getMessageRfc822Id(sent.messageId);
    if (rfc822) await capturePoThreadAnchor(so.purchaseOrderId, 'branch', sent.threadId, rfc822);
  }

  await prisma.email.create({
    data: {
      salesOrderId,
      purchaseOrderId: so.purchaseOrderId,
      gmailMessageId: sent.messageId,
      gmailThreadId: sent.threadId,
      recipientEmail: BRANCH_EMAIL,
      subject,
      status: 'sent',
      emailType: 'stock_short_inquiry',
      sentBody: sendBody,
      relatedMaterials: JSON.stringify({ version: 'stock-short-v1', shortages }),
    },
  });

  try {
    const { emitEvent } = await import('./scenario-events');
    await emitEvent({
      salesOrderId,
      type: 'email_sent',
      payload: {
        emailType: 'stock_short_inquiry',
        recipient: BRANCH_EMAIL,
        subject,
        body_excerpt: sendBody.slice(0, 200),
        gmailMessageId: sent.messageId,
        shortages,
      },
    });
  } catch {
    // Event emission must never break the primary flow.
  }

  log(`[StockShort] Sent to branch for SO ${so.soNumber} (${shortages.length} short item(s))`);
  return sent;
}
