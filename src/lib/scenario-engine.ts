/**
 * Scenario engine — the state-machine that walks a Scenario's step list, one
 * external event at a time. Persists progress in ScenarioProgress so we
 * survive process restarts and serverless cold starts.
 *
 * Entry points:
 *   - handleReplyV2:        invoked from handleBranchReply (feature-flag gated)
 *                           or from email-reply-checker for plant modifications
 *   - handleSecondReleaseReply: invoked from email-reply-checker when a branch
 *                           reply lands on a '2nd_release' email
 *   - maybeAdvanceScenario: called from /step-status and from
 *                           checkAndSendBatchToAman / triggerVto1n success paths
 *
 * The engine is dormant when SCENARIO_ENGINE_ENABLED !== 'true'.
 */
import { prisma } from './prisma';
import {
  sendPlainEmail,
  sendReplyEmail,
  getMessageRfc822Id,
} from './gmail';
import { type BranchReplyIntent } from './branch-reply-classifier';
import { classifyDispatchConfirmation } from './dispatch-confirmation-classifier';
import {
  SCENARIOS,
  deriveStage,
  type Scenario,
  type ScenarioEmailType,
  type Step,
  type StepKind,
} from './dispatch-scenarios';
import type { WorkStep } from './work-queue';
import {
  triggerVa02,
  triggerZsoVisibility,
  triggerZload2,
  triggerZloadingClose,
  checkAndSendCombinedVehicleEmailForPo,
  fanOutZload1ForPo,
} from './auto-gui-trigger';

const BRANCH_EMAIL = process.env.BRANCH_EMAIL || '';

export function isScenarioEngineEnabled(): boolean {
  return (process.env.SCENARIO_ENGINE_ENABLED ?? 'false').toLowerCase() === 'true';
}

/**
 * Phase 2 unified-classifier flag. When true, handleReplyV2 dispatches non-
 * scenario LLM actions (dispatch_confirmation_decision, vehicle_details_extraction,
 * etc.) to the appropriate refactored handler with pre-classified fields,
 * instead of coercing them to 'unknown' (today's behavior).
 *
 * Defaults to false — until Phase 3 collapses the email-reply-checker switch,
 * the only callers of handleReplyV2 are scenario-shaped emails, so the
 * dispatcher's non-scenario branches stay dormant.
 */
export function isUnifiedClassifierEnabled(): boolean {
  return (process.env.UNIFIED_CLASSIFIER_ENABLED ?? 'false').toLowerCase() === 'true';
}

// -----------------------------------------------------------------------------
// Plant-reply classifier — same shape as classifyBranchReply but tighter prompt.
// Plants only send `modify` (a quantity correction) or an invoice PDF.
// The legacy `classifyPlantReply` was removed in Phase E — the LLM
// scenario selector in src/lib/scenario-selector.ts handles both branch
// and plant senders through a single Manager prompt with sender-filtered
// valid scenario keys.
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// 2nd-release email — the only genuinely new email type
// -----------------------------------------------------------------------------

/**
 * Send the "Email for 2nd Release" — after VA02 has set new order quantities,
 * we ask the branch to confirm the revised plan before re-running visibility.
 * Modeled on sendDispatchConfirmationEmail in auto-gui-trigger.ts.
 */
export async function sendSecondReleaseEmail(args: {
  salesOrderId: string;
  modifications: BranchReplyIntent['materials'];
  threadAnchor: { gmailThreadId: string | null; gmailMessageId: string | null } | null;
  log: (msg: string) => void;
}): Promise<{ messageId: string; threadId: string } | null> {
  const { salesOrderId, modifications, threadAnchor, log } = args;

  if (!BRANCH_EMAIL) {
    log('[2ndRelease] BRANCH_EMAIL not configured — skipping');
    return null;
  }

  const so = await prisma.salesOrder.findUnique({
    where: { id: salesOrderId },
    select: { soNumber: true, purchaseOrderId: true },
  });
  if (!so) {
    log(`[2ndRelease] SO ${salesOrderId} not found`);
    return null;
  }

  const lines = modifications
    .filter((m) => m.operation && m.operation !== 'keep')
    .map((m) => {
      const op = m.operation ?? 'keep';
      const qty = m.quantity ?? 0;
      if (op === 'delete') return `  - Delete material ${m.material_code}`;
      return `  - ${op === 'increase' ? 'Increase' : 'Decrease'} ${m.material_code} → ${qty}`;
    });

  const body = [
    `Hi,`,
    ``,
    `We have updated SO ${so.soNumber} with the following changes:`,
    ``,
    ...lines,
    ``,
    `Please confirm we should proceed with the revised plan (reply "yes" to confirm).`,
    ``,
    `Thanks.`,
  ].join('\n');

  const subject = `2nd Release Confirmation - SO ${so.soNumber}`;

  let sent: { messageId: string; threadId: string };
  try {
    if (threadAnchor?.gmailThreadId && threadAnchor.gmailMessageId) {
      const rfc822Id = await getMessageRfc822Id(threadAnchor.gmailMessageId);
      if (rfc822Id) {
        sent = await sendReplyEmail(BRANCH_EMAIL, subject, body, threadAnchor.gmailThreadId, rfc822Id);
      } else {
        sent = await sendPlainEmail(BRANCH_EMAIL, subject, body);
      }
    } else {
      sent = await sendPlainEmail(BRANCH_EMAIL, subject, body);
    }
  } catch (err) {
    log(`[2ndRelease] reply-in-thread failed (${err instanceof Error ? err.message : err}); sending as new email`);
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
      emailType: '2nd_release',
      workflowState: 'awaiting_2nd_release_reply',
      sentBody: body,
      relatedMaterials: JSON.stringify({ version: '2nd-release-v1', modifications }),
    },
  });

  // Audit-log emission for the dashboard timeline.
  try {
    const { emitEvent } = await import('./scenario-events');
    await emitEvent({
      salesOrderId,
      type: 'email_sent',
      payload: {
        emailType: '2nd_release',
        recipient: BRANCH_EMAIL,
        subject,
        body_excerpt: body.slice(0, 200),
        gmailMessageId: sent.messageId,
      },
    });
  } catch {
    // Event emission must never break the primary flow.
  }

  log(`[2ndRelease] Sent for SO ${so.soNumber} (${lines.length} change(s))`);
  return sent;
}

/**
 * Branch replied to a '2nd_release' email. yes → advance scenario, no/ambiguous
 * → abort scenario so an operator can review.
 */
export async function handleSecondReleaseReply(
  emailId: string,
  replyHtml: string,
  /**
   * Phase 2 (unified classifier): when the dispatcher has already classified
   * via `classifyReply` (action='2nd_release_decision'), it passes the
   * decision here. Skips the internal `classifyDispatchConfirmation` call.
   */
  preClassified?: { decision: 'yes' | 'no' | 'ambiguous' },
): Promise<{ success: boolean; logs: string[] }> {
  const logs: string[] = [];
  const log = (m: string) => {
    const t = `[${new Date().toISOString()}] ${m}`;
    console.log(t);
    logs.push(t);
  };

  const email = await prisma.email.findUnique({ where: { id: emailId } });
  if (!email || !email.salesOrderId) {
    log(`[2ndRelease] Email or salesOrderId missing on ${emailId}`);
    return { success: false, logs };
  }

  let intent: 'yes' | 'no' | 'ambiguous';
  if (preClassified) {
    intent = preClassified.decision;
    log(`[2ndRelease] using pre-classified decision=${intent}`);
  } else {
    try {
      const ai = await classifyDispatchConfirmation(replyHtml);
      intent = ai.intent;
      log(`[2ndRelease] AI intent=${intent} reason="${ai.reason}"`);
    } catch (aiErr) {
      log(`[2ndRelease] classifier failed: ${aiErr instanceof Error ? aiErr.message : String(aiErr)}`);
      intent = 'ambiguous';
    }
  }

  await prisma.email.update({
    where: { id: emailId },
    data: { status: 'replied', repliedAt: new Date(), replyHtml, workflowState: 'completed' },
  });

  if (intent === 'yes') {
    log(`[2ndRelease] Confirmed — advancing scenario for SO ${email.salesOrderId}`);
    await advanceScenario(email.salesOrderId);
    return { success: true, logs };
  }

  // no / ambiguous → abort the scenario so an operator can take over
  log(`[2ndRelease] Not a clean yes — aborting scenario for SO ${email.salesOrderId}`);
  const { emitEvent } = await import('./scenario-events');
  const active = await prisma.scenarioProgress.findFirst({
    where: {
      salesOrderId: email.salesOrderId,
      state: { notIn: ['completed', 'aborted', 'failed'] },
    },
    orderBy: { createdAt: 'desc' },
  });
  if (active) {
    await prisma.scenarioProgress.update({
      where: { id: active.id },
      data: { state: 'aborted', error: `2nd_release reply intent=${intent}` },
    });
    await emitEvent({
      salesOrderId: email.salesOrderId,
      scenarioProgressId: active.id,
      type: 'scenario_aborted',
      payload: { scenario_key: active.scenarioKey, reason: `2nd_release reply intent=${intent}` },
    });
  }
  return { success: true, logs };
}

// -----------------------------------------------------------------------------
// Main entry: handleReplyV2 — Phase E (LLM-as-scenario-selector)
//
// 1. Loads the email + SO.
// 2. Detects active scenario (most recent non-terminal ScenarioProgress).
// 3. Renders the email thread + builds material list + filters valid keys.
// 4. Calls the LLM Manager (selectScenarioForReply).
// 5. Handles 4 outcomes:
//    a. fresh + valid key       → create new ScenarioProgress, fire step 0
//    b. fresh + 'unknown'       → escalate (aborted ScenarioProgress)
//    c. mid-flow + abort_and_replace → abort old + start new
//    d. mid-flow + escalate     → abort old (operator review)
// 6. Emits ScenarioEvent at every transition.
// -----------------------------------------------------------------------------

export async function handleReplyV2(args: {
  emailId: string;
  replyHtml: string;
  originalEmailHtml: string;
  sourceEmailType: ScenarioEmailType;
}): Promise<{ success: boolean; matched: boolean; logs: string[] }> {
  const logs: string[] = [];
  const log = (m: string) => {
    const t = `[${new Date().toISOString()}] ${m}`;
    console.log(t);
    logs.push(t);
  };

  const { classifyReply } = await import('./reply-classifier');
  type ReplyClsModule = typeof import('./reply-classifier');
  type ReplyCls = Awaited<ReturnType<ReplyClsModule['classifyReply']>>;
  const { renderEmailThreadForSO } = await import('./email-thread');
  const { getValidScenarioKeys } = await import('./dispatch-scenarios');
  const { emitEvent, getRecentEventsForSO } = await import('./scenario-events');

  const email = await prisma.email.findUnique({
    where: { id: args.emailId },
    include: { salesOrder: true },
  });
  if (!email || !email.salesOrderId || !email.salesOrder) {
    log(`[ENGINE] Email ${args.emailId} has no SalesOrder — cannot route`);
    return { success: false, matched: false, logs };
  }

  // event: email_received
  await emitEvent({
    salesOrderId: email.salesOrderId,
    type: 'email_received',
    payload: {
      emailId: email.id,
      emailType: email.emailType,
      sender: args.sourceEmailType,
      subject: email.subject,
      body_excerpt: stripAndExcerpt(args.replyHtml, 300),
      gmailMessageId: email.gmailMessageId,
    },
  });

  // Ensure the trigger Email row records this reply BEFORE we render the
  // thread. In production the cron does this in email-reply-checker.ts:120,
  // but defending against harness/test paths that skip that step.
  if (!email.replyHtml) {
    await prisma.email.update({
      where: { id: email.id },
      data: { replyHtml: args.replyHtml, repliedAt: email.repliedAt ?? new Date() },
    });
  }

  // Find active scenario (most recent non-terminal).
  const activeProgress = await prisma.scenarioProgress.findFirst({
    where: {
      salesOrderId: email.salesOrderId,
      state: { notIn: ['completed', 'aborted', 'failed'] },
    },
    orderBy: { createdAt: 'desc' },
  });

  const stage = await deriveStage(email.salesOrderId);
  const validKeys = getValidScenarioKeys(args.sourceEmailType, stage);
  const emailThread = await renderEmailThreadForSO({ salesOrderId: email.salesOrderId });
  const materialRows = await prisma.material.findMany({
    where: { salesOrderId: email.salesOrderId },
    select: { material: true, batch: true, orderQuantity: true, availableStock: true },
  });

  // Build active-scenario context for the selector if applicable.
  let activeScenarioContext: Parameters<ReplyClsModule['classifyReply']>[0]['activeScenario'] = null;
  if (activeProgress) {
    const scenarioDef = SCENARIOS[activeProgress.scenarioKey];
    if (scenarioDef) {
      const recentEvents = await getRecentEventsForSO({ salesOrderId: email.salesOrderId, limit: 30 });
      const stepsAlreadyExecuted = recentEvents
        .filter((e) => e.type === 'step_completed' && e.scenarioProgressId === activeProgress.id)
        .map((e) => ({
          stepIndex: (e.payload.step_index as number) ?? -1,
          kind: String(e.payload.kind ?? ''),
          completedAt: e.createdAt.toISOString(),
        }))
        .filter((s) => s.stepIndex >= 0)
        .sort((a, b) => a.stepIndex - b.stepIndex);
      activeScenarioContext = {
        scenarioKey: activeProgress.scenarioKey,
        description: scenarioDef.description,
        currentStepIndex: activeProgress.currentStepIndex,
        steps: scenarioDef.steps.map((s) => s.kind),
        stepsAlreadyExecuted,
      };
    }
  }

  // Call the unified LLM classifier.
  let cls: ReplyCls;
  try {
    cls = await classifyReply({
      soNumber: email.salesOrder.soNumber,
      sender: args.sourceEmailType,
      stage,
      emailThread,
      materials: materialRows,
      validKeys,
      activeScenario: activeScenarioContext,
      triggerEmailType: email.emailType ?? null,
      gmailMessageId: email.gmailMessageId,
    });
  } catch (err) {
    log(`[ENGINE] Classifier failed: ${err instanceof Error ? err.message : err}`);
    await emitEvent({
      salesOrderId: email.salesOrderId,
      type: 'scenario_aborted',
      payload: { reason: `classifier_error: ${err instanceof Error ? err.message : String(err)}` },
    });
    return { success: false, matched: false, logs };
  }

  // ─── Phase 2 dispatcher (gated by UNIFIED_CLASSIFIER_ENABLED) ───────
  // When the flag is on AND the LLM picked a non-scenario action, route to
  // the appropriate refactored handler with pre-classified fields. When the
  // flag is off, OR the action is 'scenario', fall through to the existing
  // scenario logic below (which projects scenario fields out of `cls`).
  if (isUnifiedClassifierEnabled() && cls.action !== 'scenario') {
    return dispatchNonScenarioAction(cls, {
      emailId: args.emailId,
      salesOrderId: email.salesOrderId,
      replyHtml: args.replyHtml,
      log,
      logs,
    });
  }

  // Project the union → legacy ScenarioSelection shape so the existing
  // scenario logic compiles unchanged. Non-scenario actions reaching here
  // (i.e. unified flag OFF) are coerced to 'unknown' so the engine uses its
  // existing escalation path.
  const selection: {
    scenario_key: string;
    reasoning: string;
    escalate_reason?: string;
    materials: Array<{ material_code: string; batch: string; operation?: 'keep' | 'increase' | 'decrease' | 'delete'; quantity: number }>;
    action_on_active?: 'abort_and_replace' | 'escalate' | null;
  } = cls.action === 'scenario'
    ? {
        scenario_key: cls.scenario_key,
        reasoning: cls.reasoning,
        escalate_reason: cls.escalate_reason,
        materials: cls.materials,
        action_on_active: cls.action_on_active ?? null,
      }
    : {
        scenario_key: 'unknown',
        reasoning: 'reasoning' in cls ? (cls as { reasoning?: string }).reasoning ?? '' : '',
        escalate_reason: `Classifier picked action="${cls.action}" but unified flag is off; coerced to unknown`,
        materials: [],
        action_on_active: activeProgress ? 'escalate' : null,
      };

  log(
    `[ENGINE] SO ${email.salesOrder.soNumber}: stage=${stage} scenario_key=${selection.scenario_key}` +
      (selection.action_on_active ? ` action_on_active=${selection.action_on_active}` : '') +
      ` reasoning="${selection.reasoning}"`,
  );

  await emitEvent({
    salesOrderId: email.salesOrderId,
    scenarioProgressId: activeProgress?.id ?? null,
    type: 'classifier_decision',
    payload: {
      scenario_key: selection.scenario_key,
      reasoning: selection.reasoning,
      escalate_reason: selection.escalate_reason,
      action_on_active: selection.action_on_active,
      stage,
      sender: args.sourceEmailType,
    },
  });

  // ─── Handle each outcome ───────────────────────────────────────────

  // (b) and (d): scenario_key === 'unknown' OR mid-flow escalate
  const isUnknown = selection.scenario_key === 'unknown';
  const isMidFlowEscalate = activeProgress && selection.action_on_active === 'escalate';
  if (isUnknown || isMidFlowEscalate) {
    const reason = selection.escalate_reason ?? selection.reasoning ?? 'LLM escalated';
    // If we have an active scenario, mark it aborted.
    if (activeProgress) {
      await prisma.scenarioProgress.update({
        where: { id: activeProgress.id },
        data: { state: 'aborted', error: `[mid-flow escalate] ${reason}` },
      });
      await emitEvent({
        salesOrderId: email.salesOrderId,
        scenarioProgressId: activeProgress.id,
        type: 'scenario_aborted',
        payload: { scenario_key: activeProgress.scenarioKey, reason: `mid-flow escalate: ${reason}` },
      });
    }
    // Create a "marker" aborted ScenarioProgress so the dashboard sees the escalation.
    const escalated = await prisma.scenarioProgress.create({
      data: {
        salesOrderId: email.salesOrderId,
        scenarioKey: 'unknown',
        currentStepIndex: 0,
        state: 'aborted',
        classifierOutput: JSON.stringify(selection),
        triggerEmailId: email.id,
        error: reason,
      },
    });
    await emitEvent({
      salesOrderId: email.salesOrderId,
      scenarioProgressId: escalated.id,
      type: 'scenario_aborted',
      payload: { scenario_key: 'unknown', reason },
    });
    log(`[ENGINE] handled — escalated (${isUnknown ? 'unknown' : 'mid_flow_escalate'}): ${reason}`);
    return { success: true, matched: false, logs };
  }

  // (c): mid-flow abort_and_replace
  if (activeProgress && selection.action_on_active === 'abort_and_replace') {
    await prisma.scenarioProgress.update({
      where: { id: activeProgress.id },
      data: { state: 'aborted', error: 'superseded by classifier decision' },
    });
    await emitEvent({
      salesOrderId: email.salesOrderId,
      scenarioProgressId: activeProgress.id,
      type: 'scenario_aborted',
      payload: {
        scenario_key: activeProgress.scenarioKey,
        reason: `superseded by new scenario ${selection.scenario_key}`,
      },
    });
    log(`[ENGINE] mid-flow abort_and_replace: ${activeProgress.scenarioKey} → ${selection.scenario_key}`);
  }

  // (a) and (c continuation): create new ScenarioProgress and fire step 0
  const scenario = SCENARIOS[selection.scenario_key];
  if (!scenario) {
    // Shouldn't happen — the selector validated the key against validKeys.
    log(`[ENGINE] BUG: validated key ${selection.scenario_key} missing from SCENARIOS — escalating`);
    const broken = await prisma.scenarioProgress.create({
      data: {
        salesOrderId: email.salesOrderId,
        scenarioKey: 'unknown',
        currentStepIndex: 0,
        state: 'aborted',
        classifierOutput: JSON.stringify(selection),
        triggerEmailId: email.id,
        error: `validated key ${selection.scenario_key} missing from SCENARIOS`,
      },
    });
    await emitEvent({
      salesOrderId: email.salesOrderId,
      scenarioProgressId: broken.id,
      type: 'scenario_aborted',
      payload: { scenario_key: selection.scenario_key, reason: 'registry miss after validation' },
    });
    return { success: true, matched: false, logs };
  }

  const newProgress = await prisma.scenarioProgress.create({
    data: {
      salesOrderId: email.salesOrderId,
      scenarioKey: scenario.key,
      currentStepIndex: 0,
      state: 'ready',
      classifierOutput: JSON.stringify(selection),
      triggerEmailId: email.id,
    },
  });
  await prisma.salesOrder.update({
    where: { id: email.salesOrderId },
    data: { intentLabel: scenario.key },
  });
  await emitEvent({
    salesOrderId: email.salesOrderId,
    scenarioProgressId: newProgress.id,
    type: 'scenario_started',
    payload: {
      scenario_key: scenario.key,
      trigger_email_id: email.id,
      step_count: scenario.steps.length,
    },
  });

  log(`[ENGINE] handled — scenario=${scenario.key} (${scenario.steps.length} step(s))`);

  // Fire step 0.
  await executeScenario({ salesOrderId: email.salesOrderId, log });

  return { success: true, matched: true, logs };
}

// -----------------------------------------------------------------------------
// Phase 2: dispatcher for non-scenario classifier actions. Called from
// handleReplyV2 when UNIFIED_CLASSIFIER_ENABLED=true and the LLM picked
// something other than 'scenario'. Routes to the refactored handlers with
// pre-classified fields so each handler skips its own classifier call.
// -----------------------------------------------------------------------------

async function dispatchNonScenarioAction(
  cls: Exclude<Awaited<ReturnType<typeof import('./reply-classifier').classifyReply>>, { action: 'scenario' }>,
  ctx: {
    emailId: string;
    salesOrderId: string;
    replyHtml: string;
    log: (m: string) => void;
    logs: string[];
  },
): Promise<{ success: boolean; matched: boolean; logs: string[] }> {
  const { emailId, replyHtml, log, logs } = ctx;
  log(`[ENGINE] dispatching non-scenario action=${cls.action}`);

  const {
    handleDispatchConfirmation,
    handleVehicleSplitConfirmation,
    handleVehicleDetailsReply,
    handleProductionReply,
    handleProductionConfirmation,
  } = await import('./auto-gui-trigger');
  const { emitEvent } = await import('./scenario-events');

  await emitEvent({
    salesOrderId: ctx.salesOrderId,
    type: 'classifier_decision',
    payload: {
      action: cls.action,
      reasoning: 'reasoning' in cls ? cls.reasoning : undefined,
    },
  });

  switch (cls.action) {
    case 'dispatch_confirmation_decision': {
      const r = await handleDispatchConfirmation(emailId, replyHtml, { decision: cls.decision });
      return { success: r.success, matched: true, logs: [...logs, ...r.logs] };
    }
    case '2nd_release_decision': {
      const r = await handleSecondReleaseReply(emailId, replyHtml, { decision: cls.decision });
      return { success: r.success, matched: true, logs: [...logs, ...r.logs] };
    }
    case 'vehicle_split_decision': {
      const r = await handleVehicleSplitConfirmation(emailId, replyHtml, {
        decision: cls.decision,
        amendments: cls.amendments,
      });
      return { success: r.success, matched: true, logs: [...logs, ...r.logs] };
    }
    case 'vehicle_details_extraction': {
      const r = await handleVehicleDetailsReply(emailId, replyHtml, ctx.salesOrderId, {
        vehicles: cls.vehicles.map((v) => ({
          bundleNumber: v.bundleNumber,
          vehicleNumber: v.vehicleNumber,
          driverMobile: v.driverMobile,
          containerNumber: v.containerNumber,
        })),
      });
      return { success: r.success, matched: true, logs: [...logs, ...r.logs] };
    }
    case 'production_timeline': {
      const r = await handleProductionReply(emailId, replyHtml, { days: cls.days });
      return { success: r.success, matched: true, logs: [...logs, ...r.logs] };
    }
    case 'production_confirmation': {
      const r = await handleProductionConfirmation(emailId, replyHtml, {
        decision: cls.decision,
        additionalDays: cls.additionalDays,
      });
      return { success: r.success, matched: true, logs: [...logs, ...r.logs] };
    }
    case 'invoice_pdf': {
      // Delegate to the legacy invoice-batching path. Same code today's
      // email-reply-checker would have run after PDF extraction.
      const { checkAndSendBatchToAman } = await import('./auto-gui-trigger');
      const email = await prisma.email.findUnique({
        where: { id: emailId },
        include: { loadingSlipItem: true },
      });
      const bundleId = email?.loadingSlipItem?.bundleId ?? null;
      const r = await checkAndSendBatchToAman(ctx.salesOrderId, bundleId);
      return { success: r.success, matched: true, logs: [...logs, ...r.logs] };
    }
    case 'new_order': {
      // NEW ORDER emails shouldn't reach handleReplyV2 — they go through the
      // separate checkForNewEmails cron path. Flag as a bug.
      log(`[ENGINE] BUG: new_order action reached handleReplyV2 (emailId=${emailId})`);
      await emitEvent({
        salesOrderId: ctx.salesOrderId,
        type: 'scenario_aborted',
        payload: { reason: 'new_order_in_reply_path' },
      });
      return { success: false, matched: false, logs };
    }
    case 'other': {
      log(
        `[ENGINE] LLM classified as 'other' — description="${cls.description}" question="${cls.suggested_question_for_supervisor}"`,
      );
      const { escalateToSupervisor } = await import('./supervisor-escalation');
      const result = await escalateToSupervisor({
        salesOrderId: ctx.salesOrderId,
        triggerEmailId: emailId,
        description: cls.description,
        suggested_question_for_supervisor: cls.suggested_question_for_supervisor,
        reasoning: cls.reasoning,
        log,
      });

      if (!result.sent && result.reason === 'hop_limit_exceeded') {
        // Mark the active scenario (if any) aborted so the dashboard reflects
        // the dead-end and operators stop seeing the SO as "in flight."
        const activeProgress = await prisma.scenarioProgress.findFirst({
          where: {
            salesOrderId: ctx.salesOrderId,
            state: { notIn: ['completed', 'aborted', 'failed'] },
          },
          orderBy: { createdAt: 'desc' },
        });
        if (activeProgress) {
          await prisma.scenarioProgress.update({
            where: { id: activeProgress.id },
            data: { state: 'aborted', error: 'supervisor_hop_limit_exceeded' },
          });
        }
        await emitEvent({
          salesOrderId: ctx.salesOrderId,
          type: 'scenario_aborted',
          payload: { reason: 'supervisor_hop_limit_exceeded', hops: result.hops },
        });
        return { success: false, matched: false, logs };
      }
      return { success: result.sent, matched: !result.sent ? false : true, logs };
    }
  }
}

// Helper used above for compact email excerpts in event payloads.
function stripAndExcerpt(html: string, maxLen: number): string {
  const stripped = html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length <= maxLen ? stripped : stripped.slice(0, maxLen) + '…';
}

// -----------------------------------------------------------------------------
// executeScenario — fire JUST the current step, persist state, return.
// Called every time the scenario should advance (initial entry + each callback).
// -----------------------------------------------------------------------------

export async function executeScenario(args: {
  salesOrderId: string;
  log?: (msg: string) => void;
}): Promise<void> {
  const log = args.log ?? ((m: string) => console.log(`[${new Date().toISOString()}] ${m}`));

  // The most recent non-terminal progress is the "active" one — there can
  // be multiple historical rows per SO (aborted, completed) since the unique
  // constraint was dropped in Phase E.
  const progress = await prisma.scenarioProgress.findFirst({
    where: {
      salesOrderId: args.salesOrderId,
      state: { notIn: ['completed', 'aborted', 'failed'] },
    },
    orderBy: { createdAt: 'desc' },
  });
  if (!progress) {
    log(`[ENGINE] No active ScenarioProgress for SO ${args.salesOrderId} — no-op`);
    return;
  }
  if (['completed', 'aborted', 'failed'].includes(progress.state)) {
    log(`[ENGINE] ScenarioProgress in terminal state ${progress.state} — no-op`);
    return;
  }

  const scenario = SCENARIOS[progress.scenarioKey];
  const { emitEvent } = await import('./scenario-events');
  if (!scenario) {
    log(`[ENGINE] Unknown scenarioKey ${progress.scenarioKey} — marking failed`);
    await prisma.scenarioProgress.update({
      where: { id: progress.id },
      data: { state: 'failed', error: 'unknown scenarioKey' },
    });
    await emitEvent({
      salesOrderId: args.salesOrderId,
      scenarioProgressId: progress.id,
      type: 'scenario_failed',
      payload: { scenario_key: progress.scenarioKey, reason: 'unknown scenarioKey' },
    });
    return;
  }

  // Past the end? Mark completed.
  if (progress.currentStepIndex >= scenario.steps.length) {
    log(`[ENGINE] Scenario ${scenario.key} completed for SO ${args.salesOrderId}`);
    await prisma.scenarioProgress.update({
      where: { id: progress.id },
      data: { state: 'completed' },
    });
    await emitEvent({
      salesOrderId: args.salesOrderId,
      scenarioProgressId: progress.id,
      type: 'scenario_completed',
      payload: { scenario_key: scenario.key, step_count: scenario.steps.length },
    });
    return;
  }

  const step = scenario.steps[progress.currentStepIndex];
  log(
    `[ENGINE] SO ${args.salesOrderId} firing step ${progress.currentStepIndex + 1}/${scenario.steps.length}: ${step.kind}${
      step.label ? ` (${step.label})` : ''
    }`
  );
  await emitEvent({
    salesOrderId: args.salesOrderId,
    scenarioProgressId: progress.id,
    type: 'step_fired',
    payload: { step_index: progress.currentStepIndex, kind: step.kind, label: step.label ?? null, scenario_key: scenario.key },
  });

  try {
    const next = await fireStep(step, progress, scenario, log);
    if (next === 'advance_now') {
      // No-op step — emit step_completed immediately, advance, and recurse.
      await emitEvent({
        salesOrderId: args.salesOrderId,
        scenarioProgressId: progress.id,
        type: 'step_completed',
        payload: { step_index: progress.currentStepIndex, kind: step.kind, scenario_key: scenario.key },
      });
      await prisma.scenarioProgress.update({
        where: { id: progress.id },
        data: { currentStepIndex: progress.currentStepIndex + 1, state: 'ready' },
      });
      await executeScenario({ salesOrderId: args.salesOrderId, log });
      return;
    }
    // Otherwise the step set its own pause state inside fireStep.
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`[ENGINE] step ${step.kind} threw: ${message}`);
    await prisma.scenarioProgress.update({
      where: { id: progress.id },
      data: { state: 'failed', error: message },
    });
    await emitEvent({
      salesOrderId: args.salesOrderId,
      scenarioProgressId: progress.id,
      type: 'scenario_failed',
      payload: { step_index: progress.currentStepIndex, kind: step.kind, error: message },
    });
  }
}

// -----------------------------------------------------------------------------
// fireStep — dispatch table from StepKind to existing trigger functions
// Returns 'advance_now' for no-op steps so executeScenario can recurse without
// waiting for an external callback.
// -----------------------------------------------------------------------------

type FireResult = 'pause' | 'advance_now';

async function fireStep(
  step: Step,
  progress: { id: string; salesOrderId: string; classifierOutput: string },
  _scenario: Scenario,
  log: (msg: string) => void,
): Promise<FireResult> {
  // classifierOutput is JSON of ScenarioSelection in Phase E, but legacy
  // rows (Phase D) stored BranchReplyIntent. Both share the {materials} shape
  // with {material_code, batch, operation, quantity}, so the field accesses
  // below work for both.
  type ClassifierMaterialShape = {
    material_code: string;
    batch?: string;
    operation?: 'keep' | 'increase' | 'decrease' | 'delete';
    quantity?: number;
  };
  const classification = JSON.parse(progress.classifierOutput) as {
    materials: ClassifierMaterialShape[];
  };

  switch (step.kind) {
    // -------- Pre-VA02 free-stock gate (replaces "Zmatana" Step 2) --------
    case 'stock_precheck': {
      const { runStockPrecheck } = await import('./stock-precheck');
      const result = await runStockPrecheck({
        salesOrderId: progress.salesOrderId,
        classification: {
          materials: classification.materials.map((m) => ({
            material_code: m.material_code,
            operation: m.operation ?? 'keep',
            quantity: m.quantity ?? 0,
          })),
        },
      });

      if (result.outcome === 'sufficient') {
        log('[ENGINE] stock_precheck — sufficient, advancing to VA02');
        return 'advance_now';
      }

      if (result.outcome === 'plant_unknown') {
        log('[ENGINE] stock_precheck — plant_unknown, aborting scenario');
        await prisma.scenarioProgress.update({
          where: { id: progress.id },
          data: {
            state: 'aborted',
            error: 'plant_unknown — cannot resolve SO plant for stock precheck',
          },
        });
        try {
          const { emitEvent } = await import('./scenario-events');
          await emitEvent({
            salesOrderId: progress.salesOrderId,
            scenarioProgressId: progress.id,
            type: 'scenario_aborted',
            payload: { reason: 'plant_unknown' },
          });
        } catch {}
        return 'pause';
      }

      // 'short' — email branch and abort. Branch's reply will re-enter the
      // classifier and start a fresh scenario (typically modify|delete or
      // modify|decrease) via the standard reply pipeline.
      const triggerEmailId = (
        await prisma.scenarioProgress.findUnique({
          where: { id: progress.id },
          select: { triggerEmailId: true },
        })
      )?.triggerEmailId ?? '';
      const { sendStockShortageInquiryEmail } = await import('./stock-shortage-email');
      await sendStockShortageInquiryEmail({
        salesOrderId: progress.salesOrderId,
        triggerEmailId,
        shortages: result.shortages,
        log,
      });
      await prisma.scenarioProgress.update({
        where: { id: progress.id },
        data: { state: 'aborted', error: 'stock_short — branch asked to confirm' },
      });
      try {
        const { emitEvent } = await import('./scenario-events');
        await emitEvent({
          salesOrderId: progress.salesOrderId,
          scenarioProgressId: progress.id,
          type: 'scenario_aborted',
          payload: { reason: 'stock_short', shortages: result.shortages, plant: result.plant },
        });
      } catch {}
      log(`[ENGINE] stock_precheck — short on ${result.shortages.length} item(s); inquiry email sent; scenario aborted`);
      return 'pause';
    }

    // -------- SAP transactions --------
    case 'va02': {
      const soNumber = await soNumberFor(progress.salesOrderId);
      const items = classification.materials
        .filter((m) => m.operation === 'increase' || m.operation === 'decrease')
        .map((m) => ({ material: m.material_code, orderQuantity: m.quantity ?? 0 }));
      if (items.length === 0) {
        log('[ENGINE] va02 step has no inc/dec materials in classifier output — skipping');
        return 'advance_now';
      }
      await triggerVa02(soNumber, items);
      await markAwaitingCallback(progress.id);
      return 'pause';
    }

    case 'zso_visibility': {
      const soNumber = await soNumberFor(progress.salesOrderId);
      await triggerZsoVisibility(soNumber);
      await markAwaitingCallback(progress.id);
      return 'pause';
    }

    case 'mb51': {
      // MB51 is the daily FCFS reactivator; it isn't a per-SO transaction we
      // fire on demand. We park the SO on the daily sweep — when MB51 finds
      // fresh stock for one of its open MaterialShortage rows, the existing
      // shortage-reactivator triggers ZSO-VISIBILITY which re-enters the
      // engine via the next branch reply.
      await prisma.scenarioProgress.update({
        where: { id: progress.id },
        data: { state: 'awaiting_callback' },
      });
      log('[ENGINE] Parked on mb51 — daily FCFS reactivator will resume on stock arrival');
      return 'pause';
    }

    case 'zload2': {
      // ZLOAD2 is keyed on LS number, not SO. Find an LSI for this SO.
      const lsi = await prisma.loadingSlipItem.findFirst({
        where: { salesOrderId: progress.salesOrderId },
        select: { lsNumber: true },
      });
      if (!lsi?.lsNumber) {
        throw new Error(`No LoadingSlipItem.lsNumber found for SO ${progress.salesOrderId}`);
      }
      const items = classification.materials
        .filter((m) => m.operation === 'increase' || m.operation === 'decrease')
        .map((m) => ({
          material: m.material_code,
          batch: m.batch ?? '',
          orderQuantity: m.quantity ?? 0,
        }));
      if (items.length === 0) {
        log('[ENGINE] zload2 step has no inc/dec materials — skipping');
        return 'advance_now';
      }
      await triggerZload2(lsi.lsNumber, items);
      await markAwaitingCallback(progress.id);
      return 'pause';
    }

    case 'zloading_close': {
      const soNumber = await soNumberFor(progress.salesOrderId);
      const codes = classification.materials
        .filter((m) => m.operation === 'delete')
        .map((m) => m.material_code);
      if (codes.length === 0) {
        log('[ENGINE] zloading_close step has no delete materials — skipping');
        return 'advance_now';
      }
      await triggerZloadingClose(soNumber, codes);
      await markAwaitingCallback(progress.id);
      return 'pause';
    }

    case 'zload1': {
      // Fan out ZLOAD1 per (Bundle, SO) pair via the shared helper. Same
      // code path as handleDispatchConfirmation's 'yes' branch, so the
      // /step-status callback advances the engine on each completion.
      const so = await prisma.salesOrder.findUnique({
        where: { id: progress.salesOrderId },
        select: { purchaseOrderId: true },
      });
      if (!so?.purchaseOrderId) {
        throw new Error(`SO ${progress.salesOrderId} has no purchaseOrderId for ZLOAD1 fan-out`);
      }
      const fanOut = await fanOutZload1ForPo(so.purchaseOrderId, log);
      if (fanOut.fired === 0) {
        log('[ENGINE] zload1 fan-out fired 0 rows — advancing immediately');
        return 'advance_now';
      }
      await markAwaitingCallback(progress.id);
      return 'pause';
    }

    // -------- existing email senders --------
    case 'email_confirm_product_details': {
      // This is the existing `ls_dispatch` email. If we're in a fresh
      // release_all/release_part scenario it should already be sent (it's
      // what triggered this whole flow). If we're post-VA02 and re-running
      // visibility, the /visibility-data callback will re-send it. Either
      // way the engine just waits for the branch reply.
      log('[ENGINE] email_confirm_product_details — relying on existing ls_dispatch send path');
      await markAwaitingReply(progress.id);
      return 'pause';
    }

    case 'email_confirm_bundle_details': {
      log('[ENGINE] email_confirm_bundle_details — relying on existing dispatch_confirmation send path');
      await markAwaitingReply(progress.id);
      return 'pause';
    }

    case 'email_to_branch_for_vehicle': {
      const so = await prisma.salesOrder.findUnique({
        where: { id: progress.salesOrderId },
        select: { purchaseOrderId: true },
      });
      if (so?.purchaseOrderId) {
        await checkAndSendCombinedVehicleEmailForPo(so.purchaseOrderId);
      }
      await markAwaitingReply(progress.id);
      return 'pause';
    }

    case 'email_to_plant': {
      // LS-to-plant emails are sent from handleVehicleDetailsReply once vehicle
      // details land. For the engine's purposes this step is fire-and-forget:
      // we don't re-send here, we just advance (the email goes out from the
      // existing pipeline; the engine's role is to track the milestone).
      log('[ENGINE] email_to_plant — existing pipeline sends LS to plant on vehicle reply');
      return 'advance_now';
    }

    case 'email_2nd_release': {
      const classBranch = classification as BranchReplyIntent;
      const triggerEmail = await prisma.email.findUnique({
        where: { id: (await loadProgress(progress.id)).triggerEmailId ?? '' },
        select: { gmailThreadId: true, gmailMessageId: true },
      }).catch(() => null);
      await sendSecondReleaseEmail({
        salesOrderId: progress.salesOrderId,
        modifications: classBranch.materials,
        threadAnchor: triggerEmail
          ? { gmailThreadId: triggerEmail.gmailThreadId, gmailMessageId: triggerEmail.gmailMessageId }
          : null,
        log,
      });
      await markAwaitingReply(progress.id);
      return 'pause';
    }

    // -------- sentinels: pause until an existing pipeline reports back --------
    case 'await_plant_invoice': {
      await prisma.scenarioProgress.update({
        where: { id: progress.id },
        data: { state: 'awaiting_plant_invoice' },
      });
      log('[ENGINE] Paused on await_plant_invoice — checkAndSendBatchToAman will advance');
      return 'pause';
    }

    case 'await_vt01n': {
      await prisma.scenarioProgress.update({
        where: { id: progress.id },
        data: { state: 'awaiting_vt01n' },
      });
      log('[ENGINE] Paused on await_vt01n — triggerVto1n will advance');
      return 'pause';
    }
  }

  // Exhaustive — TS will catch missing kinds at compile time.
  const _exhaustive: never = step.kind;
  throw new Error(`Unhandled StepKind: ${_exhaustive}`);
}

// -----------------------------------------------------------------------------
// advanceScenario / maybeAdvanceScenario — called by external events
// -----------------------------------------------------------------------------

export async function advanceScenario(salesOrderId: string): Promise<void> {
  const progress = await prisma.scenarioProgress.findFirst({
    where: {
      salesOrderId,
      state: { notIn: ['completed', 'aborted', 'failed'] },
    },
    orderBy: { createdAt: 'desc' },
  });
  if (!progress) return;

  const scenario = SCENARIOS[progress.scenarioKey];

  // Emit step_completed for the step that just finished (the one at the
  // current index BEFORE we increment). This is the source-of-truth marker
  // for "step N is done" — the LLM uses it to compute stepsAlreadyExecuted
  // in mid-flow re-entry.
  if (scenario) {
    const completedStep = scenario.steps[progress.currentStepIndex];
    if (completedStep) {
      const { emitEvent } = await import('./scenario-events');
      await emitEvent({
        salesOrderId,
        scenarioProgressId: progress.id,
        type: 'step_completed',
        payload: {
          step_index: progress.currentStepIndex,
          kind: completedStep.kind,
          scenario_key: progress.scenarioKey,
        },
      });
    }
  }

  await prisma.scenarioProgress.update({
    where: { id: progress.id },
    data: {
      currentStepIndex: progress.currentStepIndex + 1,
      state: 'ready',
    },
  });
  await executeScenario({ salesOrderId });
}

/**
 * Safe no-op when flag off / no progress row. Called from /step-status
 * (with workStep set), from checkAndSendBatchToAman, and from triggerVto1n.
 *
 * If workStep is provided, we only advance when the scenario's current step
 * matches that workStep — this prevents an unrelated SAP completion (e.g.
 * a queued VA02 from a different scenario) from skipping a step in this one.
 */
export async function maybeAdvanceScenario(
  salesOrderId: string | null | undefined,
  workStep?: WorkStep,
): Promise<void> {
  if (!salesOrderId) return;
  if (!isScenarioEngineEnabled()) return;

  const progress = await prisma.scenarioProgress.findFirst({
    where: {
      salesOrderId,
      state: { notIn: ['completed', 'aborted', 'failed'] },
    },
    orderBy: { createdAt: 'desc' },
  });
  if (!progress) return;

  const scenario = SCENARIOS[progress.scenarioKey];
  if (!scenario) return;

  const currentStep = scenario.steps[progress.currentStepIndex];
  if (!currentStep) return;

  // Guard: workStep, if provided, must match the StepKind of the current step.
  if (workStep) {
    const expected = STEP_TO_WORK_STEP[currentStep.kind];
    if (expected && expected !== workStep) {
      // Not the step we're waiting on — ignore.
      return;
    }
  }

  await advanceScenario(salesOrderId);
}

// Maps engine StepKind → the WorkStep that completes it. Only steps that fire
// a WorkQueue row have an entry. Used by maybeAdvanceScenario to make sure
// we're advancing on the right callback.
const STEP_TO_WORK_STEP: Partial<Record<StepKind, WorkStep>> = {
  va02: 'va02',
  zso_visibility: 'visibility',
  zload1: 'zload1',
  zload2: 'zload2',
  zloading_close: 'zloading_close',
  mb51: 'mb51',
};

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

async function markAwaitingCallback(progressId: string): Promise<void> {
  await prisma.scenarioProgress.update({
    where: { id: progressId },
    data: { state: 'awaiting_callback' },
  });
}

async function markAwaitingReply(progressId: string): Promise<void> {
  await prisma.scenarioProgress.update({
    where: { id: progressId },
    data: { state: 'awaiting_reply' },
  });
}

async function soNumberFor(salesOrderId: string): Promise<string> {
  const so = await prisma.salesOrder.findUnique({
    where: { id: salesOrderId },
    select: { soNumber: true },
  });
  if (!so?.soNumber) throw new Error(`SO ${salesOrderId} has no soNumber`);
  return so.soNumber;
}

async function loadProgress(id: string) {
  const p = await prisma.scenarioProgress.findUnique({ where: { id } });
  if (!p) throw new Error(`ScenarioProgress ${id} not found`);
  return p;
}
