import { prisma } from './prisma';
import { sendPlainEmail, sendReplyEmail, getMessageRfc822Id } from './gmail';
import type { StockShortage } from './stock-precheck';

const BRANCH_EMAIL = process.env.BRANCH_EMAIL || '';

export async function sendStockShortageInquiryEmail(args: {
  salesOrderId: string;
  triggerEmailId: string;
  shortages: StockShortage[];
  log: (msg: string) => void;
}): Promise<{ messageId: string; threadId: string } | null> {
  const { salesOrderId, triggerEmailId, shortages, log } = args;

  if (!BRANCH_EMAIL) {
    log('[StockShort] BRANCH_EMAIL not configured — skipping');
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

  const trigger = triggerEmailId
    ? await prisma.email.findUnique({
        where: { id: triggerEmailId },
        select: { gmailThreadId: true, gmailMessageId: true },
      })
    : null;

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

  let sent: { messageId: string; threadId: string };
  try {
    if (trigger?.gmailThreadId && trigger.gmailMessageId) {
      const rfc822Id = await getMessageRfc822Id(trigger.gmailMessageId);
      if (rfc822Id) {
        sent = await sendReplyEmail(BRANCH_EMAIL, subject, body, trigger.gmailThreadId, rfc822Id);
      } else {
        sent = await sendPlainEmail(BRANCH_EMAIL, subject, body);
      }
    } else {
      sent = await sendPlainEmail(BRANCH_EMAIL, subject, body);
    }
  } catch (err) {
    log(`[StockShort] reply-in-thread failed (${err instanceof Error ? err.message : err}); sending as new email`);
    sent = await sendPlainEmail(BRANCH_EMAIL, subject, body);
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
      sentBody: body,
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
        body_excerpt: body.slice(0, 200),
        gmailMessageId: sent.messageId,
        shortages,
      },
    });
  } catch {
    // Event emission must never break the primary flow.
  }

  log(`[StockShort] Sent for SO ${so.soNumber} (${shortages.length} short item(s))`);
  return sent;
}
