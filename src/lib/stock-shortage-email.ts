import { prisma } from './prisma';
import { sendPlainEmail, sendReplyEmail, getMessageRfc822Id } from './gmail';
import type { StockShortage } from './stock-precheck';
import { resolvePoThreadAnchor, capturePoThreadAnchor } from './po-thread';

const BRANCH_EMAIL = process.env.BRANCH_EMAIL || '';
const PLANT_EMAIL = process.env.PLANT_EMAIL || '';

export async function sendStockShortageInquiryEmail(args: {
  salesOrderId: string;
  triggerEmailId: string;
  shortages: StockShortage[];
  // Who originally requested the increase. Determines who gets the shortfall
  // inquiry — replies go back to the same party that asked.
  requestSource: 'branch' | 'plant';
  log: (msg: string) => void;
}): Promise<{ messageId: string; threadId: string } | null> {
  const { salesOrderId, shortages, requestSource, log } = args;

  const recipient = requestSource === 'plant' ? PLANT_EMAIL : BRANCH_EMAIL;
  if (!recipient) {
    log(`[StockShort] ${requestSource === 'plant' ? 'PLANT_EMAIL' : 'BRANCH_EMAIL'} not configured — skipping`);
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

  const subject = `Stock Short - SO ${so.soNumber}`;

  const anchor = so.purchaseOrderId
    ? await resolvePoThreadAnchor(so.purchaseOrderId, requestSource)
    : null;

  let sent: { messageId: string; threadId: string };
  try {
    if (anchor) {
      sent = await sendReplyEmail(recipient, subject, body, anchor.threadId, anchor.rfc822MessageId);
    } else {
      sent = await sendPlainEmail(recipient, subject, body);
    }
  } catch (err) {
    log(`[StockShort] reply-in-thread failed (${err instanceof Error ? err.message : err}); sending as new email`);
    sent = await sendPlainEmail(recipient, subject, body);
  }

  if (so.purchaseOrderId && !anchor) {
    const rfc822 = await getMessageRfc822Id(sent.messageId);
    if (rfc822) {
      await capturePoThreadAnchor(so.purchaseOrderId, requestSource, sent.threadId, rfc822);
    }
  }

  await prisma.email.create({
    data: {
      salesOrderId,
      purchaseOrderId: so.purchaseOrderId,
      gmailMessageId: sent.messageId,
      gmailThreadId: sent.threadId,
      recipientEmail: recipient,
      subject,
      status: 'sent',
      emailType: 'stock_short_inquiry',
      sentBody: body,
      relatedMaterials: JSON.stringify({ version: 'stock-short-v1', shortages, requestSource }),
    },
  });

  try {
    const { emitEvent } = await import('./scenario-events');
    await emitEvent({
      salesOrderId,
      type: 'email_sent',
      payload: {
        emailType: 'stock_short_inquiry',
        recipient,
        subject,
        body_excerpt: body.slice(0, 200),
        gmailMessageId: sent.messageId,
        shortages,
        requestSource,
      },
    });
  } catch {
    // Event emission must never break the primary flow.
  }

  log(`[StockShort] Sent to ${requestSource} for SO ${so.soNumber} (${shortages.length} short item(s))`);
  return sent;
}
