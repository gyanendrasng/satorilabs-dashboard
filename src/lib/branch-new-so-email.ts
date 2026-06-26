/**
 * Sent by the engine when `bundle_capacity_assessment` returns `needs_new_so`
 * for at least one item — i.e. the branch asked for a post-plant-intimation
 * increase that no existing bundle on the PO can absorb. The message asks
 * them to raise a fresh SO for the overflow units; the original SO ships
 * as planned. Terminal — no follow-up reply re-enters this flow.
 *
 * Mirrors the structure of `stock-shortage-email.ts` so the email looks
 * familiar to the branch (same in-thread anchoring, same subject style).
 */

import { prisma } from './prisma';
import { sendPlainEmail, sendReplyEmail, getMessageRfc822Id } from './gmail';
import { resolvePoThreadAnchor, capturePoThreadAnchor, withPurposeLine } from './po-thread';
import { kgPerUnitOf, kgToUnits } from './units';

const BRANCH_EMAIL = process.env.BRANCH_EMAIL || '';

export interface BranchNewSoOverflowItem {
  material: string;
  deltaKg: number;
}

export async function sendBranchRequestNewSoEmail(args: {
  salesOrderId: string;
  triggerEmailId: string;
  /** Materials whose increase cannot be accommodated within the current PO's bundle plan. */
  overflow: BranchNewSoOverflowItem[];
  log: (msg: string) => void;
}): Promise<{ messageId: string; threadId: string } | null> {
  const { salesOrderId, overflow, log } = args;

  if (!BRANCH_EMAIL) {
    log('[BranchNewSo] BRANCH_EMAIL not configured — skipping');
    return null;
  }
  if (overflow.length === 0) {
    log('[BranchNewSo] No overflow items — skipping (planner should not have emitted this step)');
    return null;
  }

  const so = await prisma.salesOrder.findUnique({
    where: { id: salesOrderId },
    select: {
      soNumber: true,
      purchaseOrderId: true,
      purchaseOrder: { select: { poNumber: true } },
      materials: { select: { material: true, orderWeightKg: true, orderQuantity: true } },
    },
  });
  if (!so) {
    log(`[BranchNewSo] SO ${salesOrderId} not found`);
    return null;
  }

  // kgPerUnit lookup so overflow reads in units (boxes), not kg.
  const kgPerUnitByCode = new Map<string, number>();
  for (const m of so.materials) {
    kgPerUnitByCode.set(m.material, kgPerUnitOf(m.orderWeightKg ? Number(m.orderWeightKg) : 0, m.orderQuantity));
  }

  const lines = overflow.map((o) => {
    const units = kgToUnits(o.deltaKg, kgPerUnitByCode.get(o.material) ?? 0);
    return `  - ${o.material}: requested an increase of ${units} units`;
  });

  const body = [
    `Hi team,`,
    ``,
    `Thank you for the increase request on SO ${so.soNumber}. We checked the bundle plan for PO ${so.purchaseOrder?.poNumber ?? ''} and unfortunately we are unable to accommodate the following additional units within the existing dispatch:`,
    ``,
    ...lines,
    ``,
    `The loading slips for this PO have already been shared with the plant and every truck is at full capacity, so we cannot add the extra units to the current run without breaking the agreed loading plan.`,
    ``,
    `Please raise a fresh sales order for the additional units. SO ${so.soNumber} will ship as originally planned, and the new SO will go through the standard intake on our side.`,
    ``,
    `Thanks for your understanding.`,
  ].join('\n');

  const purposeLabel = `New SO Required - Overflow on SO ${so.soNumber}`;

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
    log(`[BranchNewSo] reply-in-thread failed (${err instanceof Error ? err.message : err}); sending as new email`);
    sent = await sendPlainEmail(BRANCH_EMAIL, subject, sendBody);
  }

  if (so.purchaseOrderId && !anchor) {
    const rfc822 = await getMessageRfc822Id(sent.messageId);
    if (rfc822) {
      await capturePoThreadAnchor(so.purchaseOrderId, 'branch', sent.threadId, rfc822);
    }
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
      emailType: 'branch_request_new_so',
      sentBody: sendBody,
      relatedMaterials: JSON.stringify({ version: 'branch-new-so-v1', overflow }),
    },
  });

  try {
    const { emitEvent } = await import('./scenario-events');
    await emitEvent({
      salesOrderId,
      type: 'email_sent',
      payload: {
        emailType: 'branch_request_new_so',
        recipient: BRANCH_EMAIL,
        subject,
        body_excerpt: sendBody.slice(0, 200),
        gmailMessageId: sent.messageId,
        overflow,
      },
    });
  } catch {
    // Event emission must never break the primary flow.
  }

  log(`[BranchNewSo] Sent to branch for SO ${so.soNumber} (${overflow.length} overflow item(s))`);
  return sent;
}
