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
import { getMessageRfc822Id } from './gmail';

export type Stakeholder = 'branch' | 'plant';

export interface PoThreadAnchor {
  threadId: string;
  rfc822MessageId: string;
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

  if (anchorMsgId) return { threadId, rfc822MessageId: anchorMsgId };

  // Lazy resolve via the NEW ORDER message — only happens for branch threads
  // captured from intake before we ever sent the first outbound on them.
  if (stakeholder === 'branch' && po.salesOrders[0]?.originalMessageId) {
    const rfc822 = await getMessageRfc822Id(po.salesOrders[0].originalMessageId);
    if (rfc822) {
      await prisma.purchaseOrder.update({
        where: { id: purchaseOrderId },
        data: { branchAnchorMsgId: rfc822 },
      });
      return { threadId, rfc822MessageId: rfc822 };
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
