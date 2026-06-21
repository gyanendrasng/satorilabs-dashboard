/**
 * Renders the email thread for a SalesOrder as a chat-style transcript,
 * oldest first, with the latest inbound clearly tagged so the LLM planner
 * can see "this is the message you're responding to."
 *
 * Pulls every Email row tied to the SO OR to its PurchaseOrder. Each row
 * may emit one OUTBOUND turn and (if a reply exists) one INBOUND turn.
 *
 * Default cap is generous (last 50 turns) — modification flows can run
 * deep and the planner has to see the full history to avoid replaying
 * an earlier stage.
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
  const maxMessages = args.maxMessages ?? 50;

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
      replyPdfUrl: true,
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
    /** Inbound reply carried a PDF attachment (e.g. a plant invoice). The
     *  planner can't see attachments otherwise, so we surface it explicitly. */
    hasPdf: boolean;
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
        hasPdf: false,
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
        hasPdf: !!r.replyPdfUrl,
      });
    }
  }

  // Oldest first; keep the most recent `maxMessages` entries.
  entries.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const trimmed = entries.slice(-maxMessages);

  // Tag the most recent INBOUND so the LLM sees "this is the message
  // you're replying to" without having to compare timestamps.
  let latestInboundIdx = -1;
  for (let i = trimmed.length - 1; i >= 0; i--) {
    if (trimmed[i].direction === 'INBOUND') {
      latestInboundIdx = i;
      break;
    }
  }

  return trimmed
    .map((e, i) => {
      const turn = `Turn ${i + 1}`;
      const iso = e.timestamp.toISOString();
      const dirLabel =
        e.direction === 'OUTBOUND'
          ? `US → ${e.counterparty}`
          : `${e.counterparty} → US`;
      const typeLabel = e.emailType ? ` [type=${e.emailType}]` : '';
      const marker = i === latestInboundIdx ? '   ← LATEST INBOUND (plan for THIS)' : '';
      // Make a received PDF unmissable — the LLM otherwise sees only the text
      // body and assumes no invoice was attached.
      const pdfTag = e.hasPdf ? '\n[PDF ATTACHMENT RECEIVED]' : '';
      return `--- ${turn} [${iso}] ${dirLabel}${typeLabel}${marker} ---\nSubject: ${e.subject}\n${e.body}${pdfTag}`;
    })
    .join('\n\n');
}
