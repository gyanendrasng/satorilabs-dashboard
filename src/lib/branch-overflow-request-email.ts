/**
 * Sent by the engine when `bundle_capacity_assessment` returns
 * `partial_overflow` (or `needs_new_so`) for at least one material AND the
 * planner has decided to ask the branch to opt in to the partial dispatch
 * BEFORE touching SAP. The email shows the placed vs overflow split per
 * material and asks the branch to either confirm we proceed with the
 * partial qty (in which case a new SO is needed for the overflow) or to
 * revise their ask.
 *
 * Mirrors the structure of `branch-new-so-email.ts` so the look-and-feel is
 * familiar (same in-thread anchoring, same Email row shape). Distinct
 * emailType `overflow_request` so the planner / cron can tell the two
 * branch-facing prompts apart.
 *
 * Engine handler is `case 'email_branch_overflow_request':` in
 * scenario-engine.ts. Branch reply comes back as a normal Email row with
 * status='replied' and lands in handleReplyV2 → planner Rule 6e Phase 1.6.
 */

import { prisma } from './prisma';
import { sendPlainEmail, sendReplyEmail, getMessageRfc822Id } from './gmail';
import { resolvePoThreadAnchor, capturePoThreadAnchor, withPurposeLine } from './po-thread';
import { kgPerUnitOf, kgToUnits } from './units';

const BRANCH_EMAIL = process.env.BRANCH_EMAIL || '';

export interface BranchOverflowItem {
  material: string;
  placedKg: number;
  overflowKg: number;
}

export async function sendBranchOverflowRequestEmail(args: {
  salesOrderId: string;
  items: BranchOverflowItem[];
  /**
   * How the overflow will be handled once the branch confirms:
   *   'new_so'     (default) — post-plant_ls flow: branch raises a fresh SO.
   *   'new_bundle' — LS-created "preserve" flow: we add an extra vehicle
   *                  (new bundle) on the same PO; branch just confirms.
   */
  resolution?: 'new_so' | 'new_bundle';
  log: (msg: string) => void;
}): Promise<{ messageId: string; threadId: string } | null> {
  const { salesOrderId, items, log } = args;
  const resolution = args.resolution ?? 'new_so';

  if (!BRANCH_EMAIL) {
    log('[BranchOverflow] BRANCH_EMAIL not configured — skipping');
    return null;
  }
  if (items.length === 0) {
    log('[BranchOverflow] No overflow items — skipping (planner should not have emitted this step)');
    return null;
  }

  const so = await prisma.salesOrder.findUnique({
    where: { id: salesOrderId },
    select: {
      soNumber: true,
      purchaseOrderId: true,
      purchaseOrder: { select: { poNumber: true } },
      materials: { select: { material: true, materialDescription: true, orderWeightKg: true, orderQuantity: true } },
    },
  });
  if (!so) {
    log(`[BranchOverflow] SO ${salesOrderId} not found`);
    return null;
  }

  // Material description + kgPerUnit lookup so the body reads in human terms
  // (units, not codes or kg).
  const descByCode = new Map<string, string | null>();
  const kgPerUnitByCode = new Map<string, number>();
  for (const m of so.materials) {
    descByCode.set(m.material, m.materialDescription ?? null);
    kgPerUnitByCode.set(m.material, kgPerUnitOf(m.orderWeightKg ? Number(m.orderWeightKg) : 0, m.orderQuantity));
  }

  const lines = items.map((it) => {
    const desc = descByCode.get(it.material) || it.material;
    const kpu = kgPerUnitByCode.get(it.material) ?? 0;
    const placed = kgToUnits(it.placedKg, kpu);
    const overflow = kgToUnits(it.overflowKg, kpu);
    return `  - ${desc} — can fit ${placed} units in this dispatch; ${overflow} units overflow`;
  });

  const body = resolution === 'new_bundle'
    ? [
        `Hi,`,
        ``,
        `Thank you for the increase request on SO ${so.soNumber}.`,
        ``,
        `The existing bundles can't fully absorb the increase, so an additional vehicle (a new bundle) is needed for the overflow:`,
        ``,
        ...lines,
        ``,
        `If you'd like us to proceed — keeping the existing loading slips and adding one more vehicle for the overflow above — please reply "confirm" or "proceed".`,
        ``,
        `If you'd like to revise the requested quantity instead, just reply with the new number and we'll re-check.`,
        ``,
        `Thanks.`,
      ].join('\n')
    : [
        `Hi,`,
        ``,
        `Thank you for the increase request on SO ${so.soNumber}.`,
        ``,
        `Based on the bundles already shared with the plant, we can only partially accommodate your request:`,
        ``,
        ...lines,
        ``,
        `For the overflow above, please raise a fresh Sales Order — those units cannot fit into the current dispatch's bundles.`,
        ``,
        `If you'd like us to proceed with the partial quantities listed above (matching what fits in the current bundles) while you raise the new SO separately, please reply "confirm" or "proceed".`,
        ``,
        `If you'd like to revise the requested quantity instead, just reply with the new number and we'll re-check.`,
        ``,
        `Thanks.`,
      ].join('\n');

  const purposeLabel = `Action required — partial dispatch for SO ${so.soNumber}`;

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
    log(`[BranchOverflow] reply-in-thread failed (${err instanceof Error ? err.message : err}); sending as new email`);
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
      emailType: 'overflow_request',
      sentBody: sendBody,
      relatedMaterials: JSON.stringify({ version: 'overflow-request-v1', items }),
    },
  });

  try {
    const { emitEvent } = await import('./scenario-events');
    await emitEvent({
      salesOrderId,
      type: 'email_sent',
      payload: {
        emailType: 'overflow_request',
        recipient: BRANCH_EMAIL,
        subject,
        body_excerpt: sendBody.slice(0, 200),
        gmailMessageId: sent.messageId,
        items,
      },
    });
  } catch {
    // Event emission must never break the primary flow.
  }

  log(`[BranchOverflow] Sent to branch for SO ${so.soNumber} (${items.length} overflow item(s))`);
  return sent;
}
