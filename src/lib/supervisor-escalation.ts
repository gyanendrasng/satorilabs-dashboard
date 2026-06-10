/**
 * Supervisor escalation.
 *
 * When the planner emits `email_supervisor_question` or the dispatcher
 * cannot classify a reply, `escalateToSupervisor` is called. This:
 *   1. Sends a `supervisor_inquiry` email to SUPERVISOR_EMAIL with the
 *      original SO context, the unclassifiable text, and a question.
 *   2. Records an Email row tied to the SO with emailType='supervisor_inquiry'
 *      and supervisorHops incremented from the trigger email.
 *   3. Emits an `email_escalated` scenario event for audit.
 *   4. Caps the loop at 3 hops — if the supervisor's reply also classifies
 *      as 'other', after 3 round-trips the chain aborts.
 *
 * The supervisor's reply lands on the supervisor_inquiry thread. The reply
 * pipeline (checkForReplies → handleReplyV2 → classifyReply) re-classifies
 * the supervisor's instruction; if it now picks a concrete action, the
 * dispatcher executes it. If it picks 'other' again, this function is
 * called recursively with an incremented hop counter.
 */
import { prisma } from './prisma';
import { sendPlainEmail } from './gmail';
import { renderEmailThreadForSO } from './email-thread';

const SUPERVISOR_EMAIL = process.env.SUPERVISOR_EMAIL || 'amanrai369@gmail.com';
const HOP_LIMIT = 3;

export type SupervisorEscalationResult =
  | { sent: true; supervisorEmailId: string; hops: number }
  | { sent: false; reason: 'hop_limit_exceeded' | 'no_supervisor_configured' | 'send_failed'; hops: number };

export async function escalateToSupervisor(args: {
  salesOrderId: string;
  /** The Email row whose reply we couldn't classify. */
  triggerEmailId: string;
  /** Description + question from classifyReply's `other` action. */
  description: string;
  suggested_question_for_supervisor: string;
  /** The original LLM reasoning. */
  reasoning?: string;
  log: (m: string) => void;
}): Promise<SupervisorEscalationResult> {
  const { salesOrderId, triggerEmailId, description, suggested_question_for_supervisor, reasoning, log } = args;

  if (!SUPERVISOR_EMAIL) {
    log('[Supervisor] SUPERVISOR_EMAIL not configured — cannot escalate');
    return { sent: false, reason: 'no_supervisor_configured', hops: 0 };
  }

  const trigger = await prisma.email.findUnique({
    where: { id: triggerEmailId },
    select: { id: true, supervisorHops: true, purchaseOrderId: true },
  });
  if (!trigger) {
    log(`[Supervisor] Trigger email ${triggerEmailId} not found`);
    return { sent: false, reason: 'send_failed', hops: 0 };
  }

  const nextHops = (trigger.supervisorHops ?? 0) + 1;
  if (nextHops > HOP_LIMIT) {
    log(`[Supervisor] Hop limit (${HOP_LIMIT}) exceeded — aborting escalation chain`);
    return { sent: false, reason: 'hop_limit_exceeded', hops: nextHops };
  }

  // Pull the rendered thread for context (recent N messages, chronological).
  const threadContext = await renderEmailThreadForSO({ salesOrderId, maxMessages: 8 }).catch(() => '');

  const so = await prisma.salesOrder.findUnique({
    where: { id: salesOrderId },
    select: { soNumber: true, purchaseOrderId: true },
  });
  if (!so) {
    log(`[Supervisor] SO ${salesOrderId} not found`);
    return { sent: false, reason: 'send_failed', hops: nextHops };
  }

  const subject = `Supervisor needed — SO ${so.soNumber} (hop ${nextHops}/${HOP_LIMIT})`;
  const body = [
    `Hi,`,
    ``,
    `An automated dispatch decision could not be made for Sales Order ${so.soNumber}.`,
    ``,
    `What the sender is asking for:`,
    `  ${description}`,
    ``,
    `Question for you:`,
    `  ${suggested_question_for_supervisor}`,
    ``,
    reasoning ? `Why the system couldn't decide:\n  ${reasoning}\n` : '',
    `---`,
    `Email thread for context:`,
    ``,
    threadContext || '(no thread context available)',
    ``,
    `Please reply with your decision. The system will re-classify your reply and act on it.`,
  ].filter((s) => s !== null).join('\n');

  let sent: { messageId: string; threadId: string };
  try {
    sent = await sendPlainEmail(SUPERVISOR_EMAIL, subject, body);
  } catch (err) {
    log(`[Supervisor] sendPlainEmail failed: ${err instanceof Error ? err.message : String(err)}`);
    return { sent: false, reason: 'send_failed', hops: nextHops };
  }

  const inquiryEmail = await prisma.email.create({
    data: {
      salesOrderId,
      purchaseOrderId: so.purchaseOrderId ?? trigger.purchaseOrderId ?? null,
      gmailMessageId: sent.messageId,
      gmailThreadId: sent.threadId,
      recipientEmail: SUPERVISOR_EMAIL,
      subject,
      status: 'sent',
      emailType: 'supervisor_inquiry',
      sentBody: body,
      supervisorHops: nextHops,
      relatedMaterials: JSON.stringify({
        version: 'supervisor-inquiry-v1',
        description,
        suggested_question_for_supervisor,
        triggerEmailId,
      }),
    },
  });

  // Mark the trigger email as awaiting supervisor — surface on dashboard.
  await prisma.email.update({
    where: { id: triggerEmailId },
    data: { awaitingSupervisor: true },
  });

  // Audit event.
  try {
    const { emitEvent } = await import('./scenario-events');
    await emitEvent({
      salesOrderId,
      type: 'email_escalated',
      payload: {
        triggerEmailId,
        supervisorEmailId: inquiryEmail.id,
        hops: nextHops,
        description,
        suggested_question_for_supervisor,
      },
    });
  } catch {
    // Event emission must never break the primary flow.
  }

  log(`[Supervisor] Escalated SO ${so.soNumber} to ${SUPERVISOR_EMAIL} (hop ${nextHops}/${HOP_LIMIT}, emailId=${inquiryEmail.id})`);
  return { sent: true, supervisorEmailId: inquiryEmail.id, hops: nextHops };
}
