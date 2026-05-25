/**
 * Renders the email thread for a SalesOrder as plain text, chronological.
 * Used by the LLM scenario selector so it can reason about the full
 * conversation, not just the latest reply.
 *
 * Pulls every Email row tied to the SO OR to its PurchaseOrder (for multi-SO
 * combined emails like ls_dispatch). Outbound = the email we sent. Inbound =
 * the reply we received on that thread (stored as replyHtml on the same row).
 *
 * For each row we may emit ONE or TWO entries (the outbound and, if a reply
 * exists, the inbound). Default cap: last 8 entries.
 */
import { prisma } from './prisma';

function stripHtml(s: string): string {
  return s
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function renderEmailThreadForSO(args: {
  salesOrderId: string;
  maxMessages?: number;
}): Promise<string> {
  const maxMessages = args.maxMessages ?? 8;

  // Get the SO so we can also pull PO-level emails.
  const so = await prisma.salesOrder.findUnique({
    where: { id: args.salesOrderId },
    select: { purchaseOrderId: true, soNumber: true },
  });
  if (!so) return '(no SO found)';

  const rows = await prisma.email.findMany({
    where: {
      OR: [
        { salesOrderId: args.salesOrderId },
        ...(so.purchaseOrderId ? [{ purchaseOrderId: so.purchaseOrderId }] : []),
      ],
    },
    orderBy: { sentAt: 'asc' },
    select: {
      sentAt: true,
      repliedAt: true,
      recipientEmail: true,
      subject: true,
      status: true,
      emailType: true,
      sentBody: true,
      replyHtml: true,
    },
  });

  if (rows.length === 0) return '(no emails on this SO yet)';

  type Entry = {
    direction: 'OUTBOUND' | 'INBOUND';
    timestamp: Date;
    counterparty: string;
    subject: string;
    body: string;
    emailType: string | null;
  };
  const entries: Entry[] = [];

  for (const r of rows) {
    if (r.sentBody) {
      entries.push({
        direction: 'OUTBOUND',
        timestamp: r.sentAt,
        counterparty: r.recipientEmail,
        subject: r.subject,
        body: stripHtml(r.sentBody).slice(0, 1500),
        emailType: r.emailType,
      });
    }
    if (r.replyHtml && r.repliedAt) {
      entries.push({
        direction: 'INBOUND',
        timestamp: r.repliedAt,
        counterparty: r.recipientEmail,
        subject: `Re: ${r.subject}`,
        body: stripHtml(r.replyHtml).slice(0, 1500),
        emailType: r.emailType,
      });
    }
  }

  // Keep the most recent `maxMessages` entries.
  entries.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const trimmed = entries.slice(-maxMessages);

  return trimmed
    .map((e) => {
      const iso = e.timestamp.toISOString();
      const dirLabel = e.direction === 'OUTBOUND' ? `OUTBOUND to ${e.counterparty}` : `INBOUND from ${e.counterparty}`;
      const typeLabel = e.emailType ? ` [type=${e.emailType}]` : '';
      return `[${iso}] ${dirLabel}${typeLabel} — Subject: "${e.subject}"\n  Body: ${e.body}`;
    })
    .join('\n\n');
}
