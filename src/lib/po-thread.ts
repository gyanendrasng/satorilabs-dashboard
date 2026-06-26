/**
 * Per-PO stakeholder thread anchors.
 *
 * Every PO has at most one canonical Gmail thread per stakeholder:
 *   - branchThreadId / branchAnchorMsgId — branch ↔ AI conversation
 *   - plantThreadId  / plantAnchorMsgId  — plant ↔ AI conversation
 *
 * `resolvePoThreadAnchor` returns the existing anchor if set, else null.
 * `capturePoThreadAnchor` is called by senders right after the FIRST outbound
 * to a stakeholder lands — it stamps the thread + RFC822 message-id onto the
 * PO so every subsequent outbound to the same stakeholder replies into it.
 */
import { prisma } from './prisma';
import { getMessageRfc822Id, getMessageSubject } from './gmail';

export type Stakeholder = 'branch' | 'plant';

export interface PoThreadAnchor {
  threadId: string;
  rfc822MessageId: string;
  /**
   * The subject every outbound on this thread should use so the recipient's
   * mail client keeps them in ONE conversation. For branch this is
   * `Re: <NEW ORDER subject>`. Undefined when no subject is on file (legacy
   * PO with no captured branchSubject and no resolvable original) — callers
   * fall back to their own per-step subject.
   */
  subject?: string;
}

/**
 * Normalize a subject for a reply: ensure exactly one leading `Re:` so Gmail
 * groups the message into the original conversation (it strips a single
 * `Re:`/`Fwd:` when matching). Idempotent — `Re: Re: x` collapses to `Re: x`.
 */
export function branchReplySubject(rawSubject: string): string {
  const stripped = rawSubject.replace(/^\s*(re|fwd|fw)\s*:\s*/i, '').trim();
  return `Re: ${stripped}`;
}

/**
 * Because every email on a stakeholder thread now shares ONE subject, the
 * per-step purpose moves into the body's first line so the recipient can still
 * tell at a glance what a message is about. `label` is the old descriptive
 * subject (e.g. "2nd Release Confirmation - SO 123").
 */
export function withPurposeLine(label: string, body: string): string {
  return `${label}\n\n${body}`;
}

/** HTML variant of {@link withPurposeLine} for HTML email bodies. */
export function withPurposeLineHtml(label: string, html: string): string {
  return `<p><strong>${label}</strong></p>\n${html}`;
}

/**
 * Deterministic umbrella subject for a plant's per-(PO, plant) thread. Every
 * outbound to that plant for the PO (loading slips, stock-short, change
 * notices, clarifications) shares it so the plant sees one conversation.
 */
export function plantThreadSubject(poNumber: string): string {
  return `Loading Slips - PO ${poNumber}`;
}

/** Deterministic umbrella subject for production's per-PO thread. */
export function productionThreadSubject(poNumber: string): string {
  return `Material readiness - PO ${poNumber}`;
}

/**
 * Look up the canonical thread anchor for (po, stakeholder). Returns null
 * when no anchor exists yet — the caller should then open a fresh thread
 * and immediately call `capturePoThreadAnchor` with the result.
 *
 * When the PO row stores `*ThreadId` but `*AnchorMsgId` is null (the case
 * for branch threads inherited from the NEW ORDER intake — we know the
 * thread but never sent into it), we resolve the RFC822 id lazily via Gmail
 * using `SalesOrder.originalMessageId` from any SO on the PO.
 */
export async function resolvePoThreadAnchor(
  purchaseOrderId: string,
  stakeholder: Stakeholder,
): Promise<PoThreadAnchor | null> {
  const po = await prisma.purchaseOrder.findUnique({
    where: { id: purchaseOrderId },
    select: {
      branchThreadId: true,
      branchAnchorMsgId: true,
      branchSubject: true,
      plantThreadId: true,
      plantAnchorMsgId: true,
      salesOrders: {
        select: { originalMessageId: true, originalThreadId: true },
        where: { originalMessageId: { not: null } },
        take: 1,
      },
    },
  });
  if (!po) return null;

  const threadId = stakeholder === 'branch' ? po.branchThreadId : po.plantThreadId;
  const anchorMsgId = stakeholder === 'branch' ? po.branchAnchorMsgId : po.plantAnchorMsgId;

  if (!threadId) return null;

  // Resolve the branch reply subject (Re: <NEW ORDER subject>). Lazy-fetch and
  // persist branchSubject from the NEW ORDER message if intake didn't capture
  // it (legacy POs). Undefined when nothing is resolvable — caller falls back.
  let subject: string | undefined;
  if (stakeholder === 'branch') {
    let raw = po.branchSubject ?? null;
    if (!raw && po.salesOrders[0]?.originalMessageId) {
      const fetched = await getMessageSubject(po.salesOrders[0].originalMessageId);
      if (fetched) {
        raw = fetched;
        await prisma.purchaseOrder.update({
          where: { id: purchaseOrderId },
          data: { branchSubject: fetched },
        });
      }
    }
    if (raw) subject = branchReplySubject(raw);
  }

  if (anchorMsgId) return { threadId, rfc822MessageId: anchorMsgId, subject };

  // Lazy resolve via the NEW ORDER message — only happens for branch threads
  // captured from intake before we ever sent the first outbound on them.
  if (stakeholder === 'branch' && po.salesOrders[0]?.originalMessageId) {
    const rfc822 = await getMessageRfc822Id(po.salesOrders[0].originalMessageId);
    if (rfc822) {
      await prisma.purchaseOrder.update({
        where: { id: purchaseOrderId },
        data: { branchAnchorMsgId: rfc822 },
      });
      return { threadId, rfc822MessageId: rfc822, subject };
    }
  }
  return null;
}

/**
 * Persist the thread anchor for (po, stakeholder) when the FIRST outbound to
 * that stakeholder has just gone out. No-op if an anchor is already stored
 * — once a thread is claimed for a stakeholder, it stays.
 */
export async function capturePoThreadAnchor(
  purchaseOrderId: string,
  stakeholder: Stakeholder,
  threadId: string,
  rfc822MessageId: string,
): Promise<void> {
  const po = await prisma.purchaseOrder.findUnique({
    where: { id: purchaseOrderId },
    select: { branchThreadId: true, plantThreadId: true },
  });
  if (!po) return;

  const alreadySet = stakeholder === 'branch' ? po.branchThreadId : po.plantThreadId;
  if (alreadySet) return;

  await prisma.purchaseOrder.update({
    where: { id: purchaseOrderId },
    data:
      stakeholder === 'branch'
        ? { branchThreadId: threadId, branchAnchorMsgId: rfc822MessageId }
        : { plantThreadId: threadId, plantAnchorMsgId: rfc822MessageId },
  });
}

// ---------------------------------------------------------------------------
// Per-(PO, recipient) thread anchors — for PLANT (one thread per plant a PO
// dispatches to) and PRODUCTION (one thread per PO). Backed by the
// PoRecipientThread table, keyed on (purchaseOrderId, recipientEmail).
// ---------------------------------------------------------------------------

export interface RecipientThreadAnchor {
  threadId: string;
  /** In-Reply-To target; null if the anchor row predates an rfc822 capture. */
  rfc822MessageId: string | null;
  /** Fixed subject every email in this thread shares. */
  subject: string;
}

/**
 * Resolve the per-(PO, recipient) thread anchor, or null when none exists yet.
 * On null the caller opens a fresh thread and calls `captureRecipientThreadAnchor`.
 */
export async function resolveRecipientThreadAnchor(
  purchaseOrderId: string,
  recipientEmail: string,
): Promise<RecipientThreadAnchor | null> {
  const row = await prisma.poRecipientThread.findUnique({
    where: { purchaseOrderId_recipientEmail: { purchaseOrderId, recipientEmail } },
    select: { threadId: true, anchorMsgId: true, subject: true },
  });
  if (!row) return null;
  return { threadId: row.threadId, rfc822MessageId: row.anchorMsgId, subject: row.subject };
}

/**
 * Persist the per-(PO, recipient) thread anchor after the first outbound to
 * that recipient. First claim wins — a later call for the same (PO, recipient)
 * is a no-op so the thread + subject stay stable.
 */
export async function captureRecipientThreadAnchor(args: {
  purchaseOrderId: string;
  recipientEmail: string;
  kind: 'plant' | 'production';
  threadId: string;
  rfc822MessageId: string | null;
  subject: string;
}): Promise<void> {
  const { purchaseOrderId, recipientEmail, kind, threadId, rfc822MessageId, subject } = args;
  await prisma.poRecipientThread.upsert({
    where: { purchaseOrderId_recipientEmail: { purchaseOrderId, recipientEmail } },
    create: { purchaseOrderId, recipientEmail, kind, threadId, anchorMsgId: rfc822MessageId, subject },
    update: {}, // first claim wins; keep the original thread + subject
  });
}
