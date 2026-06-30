/**
 * Scenario engine — the state-machine that walks a planner-emitted step
 * list, one external event at a time. Persists progress in ScenarioProgress
 * so we survive process restarts and serverless cold starts.
 *
 * Entry points:
 *   - handleReplyV2:        invoked from email-reply-checker for every
 *                           SO-tied inbound. Calls the LLM planner and
 *                           walks the returned step list.
 *   - handleSecondReleaseReply: thin wrapper around handleReplyV2 kept for
 *                           external callers (test scripts).
 *   - maybeAdvanceScenario: called from /step-status and from
 *                           checkAndSendBatchToAman / triggerVto1n success paths.
 *
 * The engine is dormant when SCENARIO_ENGINE_ENABLED !== 'true'.
 */
import { prisma } from './prisma';
import {
  sendPlainEmail,
  sendReplyEmail,
  getMessageRfc822Id,
} from './gmail';
import {
  deriveStage,
  planEndsWithOutboundEmail,
  type Step,
  type StepKind,
} from './dispatch-scenarios';
import type { PlannedStep } from './llm-planner';

// Per-material modification shape used by the planner-driven email senders
// (sendSecondReleaseEmail, sendPlantChangeNotificationEmail). The planner emits
// args of this shape; the senders render them into the outbound body.
type EmailMaterialMod = {
  material_code: string;
  batch: string;
  quantity: number;
  operation?: 'keep' | 'increase' | 'decrease' | 'delete';
};

// -----------------------------------------------------------------------------
// Planner-mode step list: every active ScenarioProgress in the new code path
// carries its step list as JSON in `generatedSteps`. Helpers below read that
// list, with a defensive fallback to an empty array if the column is null
// (shouldn't happen in practice — handleReplyV2 always populates it).
// -----------------------------------------------------------------------------

interface PlanView {
  /** The step list in execution order. */
  steps: Step[];
  /** Index after which the walker pauses (last step that fires before pause). */
  stopAfterIndex: number;
  /** The raw PlannedStep entries — kind + optional rationale, no data values. */
  plannedSteps: PlannedStep[];
}

function plannedStepToStep(p: PlannedStep): Step {
  return {
    kind: p.kind,
    label: p.rationale ? p.rationale.slice(0, 80) : undefined,
  };
}

function readPlanFromProgress(progress: { generatedSteps: string | null; stopAfterIndex: number | null }): PlanView {
  if (!progress.generatedSteps) {
    return { steps: [], stopAfterIndex: -1, plannedSteps: [] };
  }
  let plannedSteps: PlannedStep[] = [];
  try {
    plannedSteps = JSON.parse(progress.generatedSteps) as PlannedStep[];
    if (!Array.isArray(plannedSteps)) plannedSteps = [];
  } catch {
    plannedSteps = [];
  }
  return {
    steps: plannedSteps.map(plannedStepToStep),
    stopAfterIndex: progress.stopAfterIndex ?? plannedSteps.length - 1,
    plannedSteps,
  };
}

// -----------------------------------------------------------------------------
// Safety net: if the planner emitted zload2 / zloading_close in this plan
// but FORGOT to also emit a follow-on plant-email step, inject the right
// one ourselves so the plant always sees the modification. Log loudly so
// the regression is visible.
//
// Decision matrix (mirrors planner Rule 10b-i / 10b-ii / Rule 11):
//   - No prior `email_sent plant_ls` event in audit AND zload2/zloading_close
//     just fired → inject `email_to_plant` (full LS set, vehicle details from
//     bundle).
//   - At least one prior `email_sent plant_ls` event → inject
//     `email_modified_ls_to_plant` (touched LSs only, in-thread).
//
// Returns true when a step was injected (and the caller should resume the
// step-firing path against the updated plan), false when no injection was
// needed (the caller should mark the scenario completed normally).
// -----------------------------------------------------------------------------
async function maybeInjectMissingPlantEmail(args: {
  progressId: string;
  salesOrderId: string;
  plannedSteps: PlannedStep[];
  currentStopAfterIndex: number;
  log: (msg: string) => void;
}): Promise<boolean> {
  const { progressId, salesOrderId, plannedSteps, currentStopAfterIndex, log } = args;

  // Did this plan fire any LS-mutating SAP step?
  const modKinds = new Set<string>(['zload2', 'zloading_close']);
  const hasModStep = plannedSteps.some((s) => modKinds.has(s.kind));
  if (!hasModStep) return false;

  // Did this plan ALSO already include a step that terminates the modify
  // cycle cleanly? `email_2nd_release` is branch-bound (the branch performs
  // the 2nd release in SAP) — but it still counts here, because emitting it
  // is the planner's legitimate stop point in the pre-plant_ls modify cycle:
  // zloading_close (all) → va02 → email_2nd_release [pause for branch ack].
  // If we excluded it, the safety net would spuriously inject email_to_plant
  // in this intermediate state — but there are no LSs yet (we just wiped
  // them), so that injection would have nothing to talk about.
  const plantEmailKinds = new Set<string>([
    'email_to_plant',
    'email_modified_ls_to_plant',
    'email_2nd_release',
  ]);
  const hasPlantEmailStep = plannedSteps.some((s) => plantEmailKinds.has(s.kind));
  if (hasPlantEmailStep) return false;

  // Gap detected. Pick the right plant-email step based on whether the
  // plant has been intimated previously for this SO.
  const priorPlantLs = await prisma.email.findFirst({
    where: {
      salesOrderId,
      emailType: 'plant_ls',
      status: { in: ['sent', 'replied', 'processed'] },
    },
    select: { id: true },
  });
  const injectedKind: 'email_to_plant' | 'email_modified_ls_to_plant' = priorPlantLs
    ? 'email_modified_ls_to_plant'
    : 'email_to_plant';

  // ── LOUD LOGGING — surface the planner failure ──
  const stepList = plannedSteps.map((s) => s.kind).join(' → ');
  log(
    `[ENGINE][SAFETY NET] ⚠️ PLANNER GAP DETECTED for SO ${salesOrderId}: ` +
      `plan emitted [${stepList}] which contains a LS-mutating step but NO follow-on plant email. ` +
      `Auto-injecting "${injectedKind}" so the plant receives the modification. ` +
      `THIS IS A FALLBACK — the planner should have emitted this step itself. Investigate the planner prompt / response.`,
  );
  console.error(
    `[scenario-engine SAFETY NET] Planner failed to emit plant-email step after ${plannedSteps.filter((s) => modKinds.has(s.kind)).map((s) => s.kind).join(',')} for SO ${salesOrderId}; injecting ${injectedKind}. Plan was: ${stepList}`,
  );

  // For email_to_plant the planner normally supplies args.vehicles — derive
  // from existing Bundle rows on the PO. For email_modified_ls_to_plant no
  // args are needed (the engine scans WorkQueue for touched LSs).
  let injectedStep: PlannedStep;
  if (injectedKind === 'email_to_plant') {
    const so = await prisma.salesOrder.findUnique({
      where: { id: salesOrderId },
      select: { purchaseOrderId: true },
    });
    let vehicles: Array<{ bundleNumber: number; vehicleNumber: string; driverMobile: string; containerNumber: string }> = [];
    if (so?.purchaseOrderId) {
      const bundles = await prisma.bundle.findMany({
        where: { purchaseOrderId: so.purchaseOrderId },
        orderBy: { bundleNumber: 'asc' },
        select: {
          bundleNumber: true,
          vehicleNumber: true,
          driverMobile: true,
          containerNumber: true,
        },
      });
      vehicles = bundles
        .filter((b) => b.vehicleNumber && b.driverMobile)
        .map((b) => ({
          bundleNumber: b.bundleNumber,
          vehicleNumber: b.vehicleNumber!,
          driverMobile: b.driverMobile!,
          containerNumber: b.containerNumber ?? '',
        }));
    }
    if (vehicles.length === 0) {
      log(
        `[ENGINE][SAFETY NET] Cannot auto-inject email_to_plant for SO ${salesOrderId} — no bundles have vehicle details on file. ` +
          `Marking scenario completed without injection; the operator will need to re-trigger.`,
      );
      console.error(
        `[scenario-engine SAFETY NET] email_to_plant injection skipped for SO ${salesOrderId} — no bundle vehicle details available`,
      );
      return false;
    }
    injectedStep = {
      kind: 'email_to_plant',
      rationale: '[SAFETY NET] auto-injected because the planner emitted zload2/zloading_close without a follow-on plant email',
      args: { vehicles },
    };
  } else {
    injectedStep = {
      kind: 'email_modified_ls_to_plant',
      rationale: '[SAFETY NET] auto-injected because the planner emitted zload2/zloading_close without a follow-on plant email',
    };
  }

  // Persist the appended step and bump stopAfterIndex so the walker
  // actually fires it (instead of pausing before it).
  const newPlannedSteps = [...plannedSteps, injectedStep];
  const newStopAfterIndex = Math.max(currentStopAfterIndex, newPlannedSteps.length - 1);
  await prisma.scenarioProgress.update({
    where: { id: progressId },
    data: {
      generatedSteps: JSON.stringify(newPlannedSteps),
      stopAfterIndex: newStopAfterIndex,
    },
  });

  // Emit an audit event so the planner sees the fallback on its next plan.
  try {
    const { emitEvent } = await import('./scenario-events');
    await emitEvent({
      salesOrderId,
      scenarioProgressId: progressId,
      type: 'safety_net_injection',
      payload: {
        injectedKind,
        priorPlannedSteps: plannedSteps.map((s) => s.kind),
        reason: 'planner emitted zload2/zloading_close without a follow-on plant email',
      },
    });
  } catch {
    // Audit emission must never break the primary flow.
  }

  return true;
}

// -----------------------------------------------------------------------------
// loadTriggerReply — fetch the inbound reply that triggered the current plan.
//
// Each ScenarioProgress carries `triggerEmailId` — the Email row whose reply
// caused this plan to be built. fireStep cases that need to extract data
// from the reply (modification lists, vehicle details, plant invoice PDF)
// call this once at the top of the case and pass the result into their
// dedicated extractor function.
// -----------------------------------------------------------------------------

export interface TriggerReply {
  emailId: string;
  emailType: string | null;
  replyHtml: string;
  /** The email this is a reply to was sent to / received from this party. */
  sender: 'branch' | 'plant' | 'production';
  gmailThreadId: string | null;
  gmailMessageId: string | null;
  hasPdfAttachment: boolean;
  replyPdfUrl: string | null;
}

async function loadTriggerReply(progressId: string): Promise<TriggerReply | null> {
  const progress = await prisma.scenarioProgress.findUnique({
    where: { id: progressId },
    select: { triggerEmailId: true },
  });
  if (!progress?.triggerEmailId) return null;

  const email = await prisma.email.findUnique({
    where: { id: progress.triggerEmailId },
    select: {
      id: true,
      emailType: true,
      replyHtml: true,
      gmailThreadId: true,
      gmailMessageId: true,
      replyPdfUrl: true,
      recipientEmail: true,
    },
  });
  if (!email?.replyHtml) return null;

  // Sender inference: we sent this email TO recipientEmail. Their reply came
  // FROM that address. emailType tells us which role we sent to.
  let sender: 'branch' | 'plant' | 'production' = 'branch';
  if (email.emailType === 'plant_ls') sender = 'plant';
  else if (email.emailType === 'production_inquiry' || email.emailType === 'production_reminder') sender = 'production';

  return {
    emailId: email.id,
    emailType: email.emailType ?? null,
    replyHtml: email.replyHtml,
    sender,
    gmailThreadId: email.gmailThreadId,
    gmailMessageId: email.gmailMessageId,
    hasPdfAttachment: !!email.replyPdfUrl,
    replyPdfUrl: email.replyPdfUrl ?? null,
  };
}
import type { WorkStep } from './work-queue';
import {
  triggerVa02,
  mergeVa02Flush,
  triggerZsoVisibility,
  triggerZload2,
  triggerZloadingClose,
  checkAndSendCombinedVehicleEmailForPo,
  fanOutZload1ForPo,
} from './auto-gui-trigger';
import type { PendingSoChange } from './auto-gui-trigger';

const BRANCH_EMAIL = process.env.BRANCH_EMAIL || '';
const PLANT_EMAIL = process.env.PLANT_EMAIL || '';

export function isScenarioEngineEnabled(): boolean {
  return (process.env.SCENARIO_ENGINE_ENABLED ?? 'false').toLowerCase() === 'true';
}

// Segmented-execution semantics are now the only mode: every scenario walks
// up to the first outbound email and marks itself `completed`. The next
// inbound re-enters the planner from scratch. The legacy "one ScenarioProgress
// runs end-to-end with multiple awaiting_reply pauses" model has been
// retired; the previous gate (isSegmentedExecutionEnabled / SEGMENTED_EXECUTION_ENABLED)
// is removed. Likewise the unified-classifier gate (UNIFIED_CLASSIFIER_ENABLED)
// is gone — the planner is the single entry point for every inbound.

// -----------------------------------------------------------------------------
// 2nd-release email
// -----------------------------------------------------------------------------

/**
 * Send the "Email for 2nd Release" — after VA02 has set new order quantities,
 * we ask the branch to confirm the revised plan before re-running visibility.
 * Modeled on sendDispatchConfirmationEmail in auto-gui-trigger.ts.
 */
export async function sendSecondReleaseEmail(args: {
  salesOrderId: string;
  modifications: EmailMaterialMod[];
  log: (msg: string) => void;
}): Promise<{ messageId: string; threadId: string } | null> {
  const { salesOrderId, modifications, log } = args;

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

  // Build the body in two sections:
  //   (a) CHANGES — the diff the branch requested, so the plant sees exactly
  //       what's new vs the first release.
  //   (b) REVISED DISPATCH PLAN — every material on the SO with its FINAL
  //       quantity, so the plant has the complete picture without having to
  //       reconcile against an earlier email.
  //
  // Source of truth for the "previous quantity" (the LHS of "200 → 210"): the
  // physical loading-slip quantity (LSI), NOT Material.dispatchQuantity.
  // VA02 fires immediately BEFORE this email (Phase 2: stock_precheck → va02 →
  // email_2nd_release) and now bumps dispatchQuantity to the new total (210) so
  // the later bundle-confirmation line can read it. Reading dispatchQuantity
  // here would therefore show the no-op "210 → 210". The loading slips are not
  // touched until ZLOAD2 (Phase 3), so LSI still holds the pre-increase qty
  // (200) — the correct "was" value. Same rationale as `lsiQtyByCode` in
  // sendDispatchConfirmationWithUpcomingChanges.
  const soMaterials = await prisma.material.findMany({
    where: { salesOrderId },
    select: {
      material: true,
      materialDescription: true,
      batch: true,
      orderQuantity: true,
      dispatchQuantity: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  // Physical pre-change quantity per material, summed across its loading-slip
  // items. Empty when no LS exist yet (pre-LS path) — fall back to
  // dispatchQuantity/orderQuantity in that case.
  const lsiRows = await prisma.loadingSlipItem.findMany({
    where: { salesOrderId },
    select: { material: true, orderQuantity: true },
  });
  const lsiQtyByCode = new Map<string, number>();
  for (const r of lsiRows) {
    lsiQtyByCode.set(r.material, (lsiQtyByCode.get(r.material) ?? 0) + (r.orderQuantity ?? 0));
  }

  // Index modifications by material code for quick lookup.
  const modsByCode = new Map<string, EmailMaterialMod>();
  for (const m of modifications) {
    if (m.operation && m.operation !== 'keep') modsByCode.set(m.material_code, m);
  }

  // (a) CHANGES section — diff only.
  const changeLines: string[] = [];
  for (const m of soMaterials) {
    const mod = modsByCode.get(m.material);
    if (!mod) continue;
    const op = mod.operation ?? 'keep';
    const desc = m.materialDescription || m.material;
    // "was" = pre-change physical LS qty when loading slips exist (VA02 has
    // already mutated dispatchQuantity by now); fall back to the Material
    // fields only on the pre-LS path where no LSI row exists.
    const wasQty = lsiQtyByCode.get(m.material) ?? m.dispatchQuantity ?? m.orderQuantity ?? 0;
    if (op === 'delete') {
      changeLines.push(`  - Delete ${desc} (Batch ${m.batch}) — was ${wasQty}`);
    } else if (op === 'increase' || op === 'decrease') {
      const newQty = mod.quantity ?? 0;
      const verb = op === 'increase' ? 'Increase' : 'Decrease';
      changeLines.push(`  - ${verb} ${desc} (Batch ${m.batch}): ${wasQty} → ${newQty}`);
    }
  }
  // If a modification refers to a material code we don't have on the SO
  // (rare — typically a typo in the branch reply), include it bare so the
  // plant at least sees the request and can flag it.
  for (const [code, mod] of modsByCode.entries()) {
    if (soMaterials.some((m) => m.material === code)) continue;
    const op = mod.operation ?? 'keep';
    const qty = mod.quantity ?? 0;
    changeLines.push(
      op === 'delete'
        ? `  - Delete material ${code} (no matching Material row on SO — flag for review)`
        : `  - ${op === 'increase' ? 'Increase' : 'Decrease'} ${code} → ${qty} (no matching Material row on SO — flag for review)`
    );
  }

  // (b) REVISED DISPATCH PLAN — every material with its final quantity.
  const planLines: string[] = [];
  for (const m of soMaterials) {
    const mod = modsByCode.get(m.material);
    const op = mod?.operation ?? 'keep';
    const desc = m.materialDescription || m.material;
    let finalQty: number | null;
    if (op === 'delete') finalQty = null; // removed
    else if (op === 'increase' || op === 'decrease') finalQty = mod?.quantity ?? 0;
    else finalQty = m.dispatchQuantity ?? m.orderQuantity ?? 0;

    if (finalQty === null) {
      planLines.push(`  - ${desc} (Batch ${m.batch}): REMOVED`);
    } else {
      planLines.push(`  - ${desc} (Batch ${m.batch}): ${finalQty}`);
    }
  }

  const body = [
    `Hi,`,
    ``,
    `We have updated SO ${so.soNumber}.`,
    ``,
    changeLines.length > 0 ? `Changes:` : `Changes: (none extracted)`,
    ...(changeLines.length > 0 ? changeLines : []),
    ``,
    `Revised dispatch plan (full):`,
    ...(planLines.length > 0 ? planLines : ['  (no materials on this SO)']),
    ``,
    `Please perform the second release in SAP with the revised plan above and confirm.`,
    ``,
    `Thanks.`,
  ].join('\n');

  const purposeLabel = `2nd Release Confirmation - SO ${so.soNumber}`;

  // Anchor on the per-PO branch thread. 2nd_release is now branch-bound — the
  // branch performs the 2nd release in SAP — so this email rides the branch
  // conversation, not the plant one.
  const { resolvePoThreadAnchor, capturePoThreadAnchor, withPurposeLine } = await import('./po-thread');
  const anchor = so.purchaseOrderId
    ? await resolvePoThreadAnchor(so.purchaseOrderId, 'branch')
    : null;

  // One shared subject per branch conversation; per-step purpose moves to the
  // body's first line. Legacy POs with no captured subject fall back to the
  // descriptive label so they still get a meaningful subject.
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
    log(`[2ndRelease] reply-in-thread failed (${err instanceof Error ? err.message : err}); sending as new email`);
    sent = await sendPlainEmail(BRANCH_EMAIL, subject, sendBody);
  }

  // Capture the branch anchor on first send (no-op if already set).
  if (so.purchaseOrderId && !anchor) {
    const rfc822 = await getMessageRfc822Id(sent.messageId);
    if (rfc822) {
      await capturePoThreadAnchor(so.purchaseOrderId, 'branch', sent.threadId, rfc822);
    }
  }

  // Open a new dispatch round on the PO. This is the single moment that bumps
  // the counter — the downstream ls_dispatch / dispatch_confirmation emails
  // (sent after re-visibility) inherit this round, so their idempotency guards
  // no longer collide with the previous round's emails.
  let newRound: number | null = null;
  if (so.purchaseOrderId) {
    const updated = await prisma.purchaseOrder.update({
      where: { id: so.purchaseOrderId },
      data: { dispatchRound: { increment: 1 } },
      select: { dispatchRound: true },
    });
    newRound = updated.dispatchRound;
    log(`[2ndRelease] PO ${so.purchaseOrderId} advanced to dispatchRound=${newRound}`);
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
      sentBody: sendBody,
      relatedMaterials: JSON.stringify({ version: '2nd-release-v1', modifications }),
      dispatchRound: newRound,
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
        body_excerpt: sendBody.slice(0, 200),
        gmailMessageId: sent.messageId,
      },
    });
  } catch {
    // Event emission must never break the primary flow.
  }

  log(`[2ndRelease] Sent for SO ${so.soNumber} (${changeLines.length} change(s), ${planLines.length} line(s) in plan)`);
  return sent;
}

// -----------------------------------------------------------------------------
// Order-status auto-reply — R9 "Seeking Order Update"
// -----------------------------------------------------------------------------

/**
 * Send a compact status reply to the branch summarizing the SO's current
 * workflow position. Reuses the same `renderAuditTrailForSO` timeline we feed
 * the classifier — recent events are usually what the branch is asking about
 * ("Has the LS been created? Has the truck left?"). Stays in-thread when
 * possible so the branch sees the answer threaded under their question.
 */
export async function sendOrderStatusEmail(args: {
  salesOrderId: string;
  log: (msg: string) => void;
}): Promise<{ messageId: string; threadId: string } | null> {
  const { salesOrderId, log } = args;

  if (!BRANCH_EMAIL) {
    log('[OrderStatus] BRANCH_EMAIL not configured — skipping');
    return null;
  }

  const so = await prisma.salesOrder.findUnique({
    where: { id: salesOrderId },
    select: { soNumber: true, purchaseOrderId: true, status: true },
  });
  if (!so) {
    log(`[OrderStatus] SO ${salesOrderId} not found`);
    return null;
  }

  const { renderAuditTrailForSO } = await import('./audit-trail');
  const timeline = await renderAuditTrailForSO({ salesOrderId, maxEvents: 20 });

  const body = [
    `Hi,`,
    ``,
    `Current status for SO ${so.soNumber}: ${so.status ?? 'in-progress'}`,
    ``,
    `Recent activity:`,
    timeline || '  (no recorded events yet)',
    ``,
    `Let us know if you need anything else.`,
  ].join('\n');

  const purposeLabel = `Order status — SO ${so.soNumber}`;

  const { resolvePoThreadAnchor, capturePoThreadAnchor, withPurposeLine } = await import('./po-thread');
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
    log(`[OrderStatus] reply-in-thread failed (${err instanceof Error ? err.message : err}); sending as new email`);
    sent = await sendPlainEmail(BRANCH_EMAIL, subject, sendBody);
  }
  if (so.purchaseOrderId && !anchor) {
    const rfc822 = await getMessageRfc822Id(sent.messageId);
    if (rfc822) await capturePoThreadAnchor(so.purchaseOrderId, 'branch', sent.threadId, rfc822);
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
      emailType: 'order_status',
      workflowState: 'completed',
      sentBody: sendBody,
    },
  });

  try {
    const { emitEvent } = await import('./scenario-events');
    await emitEvent({
      salesOrderId,
      type: 'email_sent',
      payload: {
        emailType: 'order_status',
        recipient: BRANCH_EMAIL,
        subject,
        body_excerpt: sendBody.slice(0, 200),
        gmailMessageId: sent.messageId,
      },
    });
  } catch {
    // Event emission must never break the primary flow.
  }

  log(`[OrderStatus] Sent for SO ${so.soNumber}`);
  return sent;
}

// -----------------------------------------------------------------------------
// Plant-change notification — R46-R51 "Email to Branch notifying plant change"
// -----------------------------------------------------------------------------

/**
 * Plant proposed a modification (R46-R51 LS Modification flow). Before we
 * actually apply it in SAP we tell the branch what the plant wants and wait
 * for their ack. The branch ack arrives as a fresh inbound that the
 * classifier picks up as a separate scenario row.
 *
 * Generic template — the user can iterate on the wording later once they
 * see how branches respond.
 */
export async function sendPlantChangeNotificationEmail(args: {
  salesOrderId: string;
  modifications: EmailMaterialMod[];
  log: (msg: string) => void;
}): Promise<{ messageId: string; threadId: string } | null> {
  const { salesOrderId, modifications, log } = args;

  if (!BRANCH_EMAIL) {
    log('[PlantChangeNotify] BRANCH_EMAIL not configured — skipping');
    return null;
  }

  const so = await prisma.salesOrder.findUnique({
    where: { id: salesOrderId },
    select: { soNumber: true, purchaseOrderId: true },
  });
  if (!so) {
    log(`[PlantChangeNotify] SO ${salesOrderId} not found`);
    return null;
  }

  const lines = (modifications ?? [])
    .filter((m) => m.operation && m.operation !== 'keep')
    .map((m) => {
      const op = m.operation ?? 'keep';
      const qty = m.quantity ?? 0;
      if (op === 'delete') return `  - Plant wants to delete material ${m.material_code}`;
      return `  - Plant wants to ${op === 'increase' ? 'increase' : 'decrease'} ${m.material_code} → ${qty}`;
    });

  const body = [
    `Hi,`,
    ``,
    `The plant has proposed the following changes to SO ${so.soNumber}:`,
    ``,
    ...(lines.length > 0 ? lines : ['  (no specific line changes captured — see plant email for details)']),
    ``,
    `Please confirm whether to proceed with the plant's proposal (reply "yes" to accept).`,
    ``,
    `Thanks.`,
  ].join('\n');

  const purposeLabel = `Plant-proposed change — SO ${so.soNumber}`;

  const { resolvePoThreadAnchor, capturePoThreadAnchor, withPurposeLine } = await import('./po-thread');
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
    log(`[PlantChangeNotify] reply-in-thread failed (${err instanceof Error ? err.message : err}); sending as new email`);
    sent = await sendPlainEmail(BRANCH_EMAIL, subject, sendBody);
  }
  if (so.purchaseOrderId && !anchor) {
    const rfc822 = await getMessageRfc822Id(sent.messageId);
    if (rfc822) await capturePoThreadAnchor(so.purchaseOrderId, 'branch', sent.threadId, rfc822);
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
      emailType: 'plant_change_notification',
      workflowState: 'awaiting_branch_ack',
      sentBody: sendBody,
      relatedMaterials: JSON.stringify({ version: 'plant-change-v1', modifications }),
    },
  });

  try {
    const { emitEvent } = await import('./scenario-events');
    await emitEvent({
      salesOrderId,
      type: 'email_sent',
      payload: {
        emailType: 'plant_change_notification',
        recipient: BRANCH_EMAIL,
        subject,
        body_excerpt: sendBody.slice(0, 200),
        gmailMessageId: sent.messageId,
      },
    });
  } catch {
    // Event emission must never break the primary flow.
  }

  log(`[PlantChangeNotify] Sent for SO ${so.soNumber} (${lines.length} change(s))`);
  return sent;
}

// -----------------------------------------------------------------------------
// Planner-authored questions — clarification (branch/plant) + supervisor.
//
// Three variants share the same machinery: send an outbound email whose body
// is text the planner authored verbatim, persist the Email row with the right
// emailType so the cron picks up the reply and routes it back through the
// planner. Each pauses the scenario at this step; the inbound reply triggers
// a fresh planNextSteps call which sees the full thread including the
// question and the answer.
// -----------------------------------------------------------------------------

async function sendPlannerQuestionEmail(args: {
  recipient: string;
  recipientRole: 'branch' | 'plant' | 'supervisor';
  salesOrderId: string;
  triggerEmailId: string;
  question: string;
  options?: string[];
  emailType: 'branch_clarify' | 'plant_clarify' | 'supervisor_question';
  log: (msg: string) => void;
  /** Force a fresh thread (do NOT anchor on the per-PO stakeholder thread).
   *  Used when fanning out to MULTIPLE plants: the per-PO "plant" anchor is a
   *  single thread, so anchoring would funnel every plant's clarification into
   *  one plant's thread. A fresh email per plant keeps them correctly separate. */
  freshThread?: boolean;
}): Promise<{ messageId: string; threadId: string } | null> {
  const { recipient, recipientRole, salesOrderId, triggerEmailId, question, options, emailType, log, freshThread } = args;

  if (!recipient) {
    log(`[PlannerQ:${recipientRole}] no recipient address configured — skipping`);
    return null;
  }

  const so = await prisma.salesOrder.findUnique({
    where: { id: salesOrderId },
    select: { soNumber: true, purchaseOrderId: true, purchaseOrder: { select: { poNumber: true } } },
  });
  if (!so) {
    log(`[PlannerQ:${recipientRole}] SO ${salesOrderId} not found`);
    return null;
  }

  // Body: just the question, with an optional numbered options list for the
  // supervisor variant. We deliberately do NOT paste the full email thread —
  // for branch/plant the question goes in-thread so they see context above
  // it; for supervisor we send a fresh thread and the planner is expected to
  // include the relevant background in the question itself (rule 16).
  const bodyLines: string[] = ['Hi,', '', question.trim()];
  if (options && options.length > 0) {
    bodyLines.push('', 'Options being considered:');
    options.forEach((opt, idx) => bodyLines.push(`  ${idx + 1}. ${opt.trim()}`));
    bodyLines.push('', 'Please reply with the option number or your own instruction.');
  }
  bodyLines.push('', 'Thanks.');
  const body = bodyLines.join('\n');

  const purposeLabel =
    recipientRole === 'supervisor'
      ? `Supervisor needed — SO ${so.soNumber}`
      : `Clarification needed — SO ${so.soNumber}`;

  // Resolve the right thread + shared subject for this recipient:
  //   branch  → the per-PO branch conversation (Re: <NEW ORDER subject>).
  //   plant   → the per-(PO, plant) thread keyed by the plant's email, so all
  //             of that plant's conversation (LS + clarifications) is one thread.
  //   supervisor → always a fresh thread with its own descriptive subject.
  const {
    resolvePoThreadAnchor,
    capturePoThreadAnchor,
    resolveRecipientThreadAnchor,
    captureRecipientThreadAnchor,
    plantThreadSubject,
    withPurposeLine,
  } = await import('./po-thread');

  let threadId: string | null = null;
  let inReplyTo: string | null = null;
  let subject = purposeLabel; // supervisor / fallback
  // For a plant first-send we must capture the new thread under the umbrella
  // plant subject so later loading slips join it.
  let capturePlant = false;

  if (recipientRole === 'branch' && so.purchaseOrderId && !freshThread) {
    const a = await resolvePoThreadAnchor(so.purchaseOrderId, 'branch');
    if (a) {
      threadId = a.threadId;
      inReplyTo = a.rfc822MessageId;
      if (a.subject) subject = a.subject;
    }
  } else if (recipientRole === 'plant' && so.purchaseOrderId && !freshThread) {
    const a = await resolveRecipientThreadAnchor(so.purchaseOrderId, recipient);
    if (a) {
      threadId = a.threadId;
      inReplyTo = a.rfc822MessageId;
      subject = a.subject;
    } else if (so.purchaseOrder?.poNumber) {
      subject = plantThreadSubject(so.purchaseOrder.poNumber);
      capturePlant = true;
    }
  }

  const sendBody = withPurposeLine(purposeLabel, body);
  let sent: { messageId: string; threadId: string };
  try {
    if (threadId) {
      sent = await sendReplyEmail(recipient, subject, sendBody, threadId, inReplyTo ?? '');
    } else {
      sent = await sendPlainEmail(recipient, subject, sendBody);
    }
  } catch (err) {
    log(`[PlannerQ:${recipientRole}] reply-in-thread failed (${err instanceof Error ? err.message : err}); sending as new email`);
    sent = await sendPlainEmail(recipient, subject, sendBody);
  }
  // Capture the anchor on first send so subsequent emails join this thread.
  if (recipientRole === 'branch' && so.purchaseOrderId && !threadId && !freshThread) {
    const rfc822 = await getMessageRfc822Id(sent.messageId);
    if (rfc822) await capturePoThreadAnchor(so.purchaseOrderId, 'branch', sent.threadId, rfc822);
  } else if (recipientRole === 'plant' && so.purchaseOrderId && capturePlant) {
    const rfc822 = await getMessageRfc822Id(sent.messageId);
    await captureRecipientThreadAnchor({
      purchaseOrderId: so.purchaseOrderId,
      recipientEmail: recipient,
      kind: 'plant',
      threadId: sent.threadId,
      rfc822MessageId: rfc822 ?? null,
      subject,
    });
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
      emailType,
      workflowState: 'awaiting_reply',
      sentBody: sendBody,
      relatedMaterials: JSON.stringify({
        version: 'planner-question-v1',
        triggerEmailId,
        question,
        options: options ?? [],
      }),
    },
  });

  try {
    const { emitEvent } = await import('./scenario-events');
    await emitEvent({
      salesOrderId,
      type: 'email_sent',
      payload: {
        emailType,
        recipient,
        subject,
        body_excerpt: sendBody.slice(0, 200),
        gmailMessageId: sent.messageId,
        question,
        options: options ?? [],
      },
    });
  } catch {
    // Event emission must never break the primary flow.
  }

  log(`[PlannerQ:${recipientRole}] Sent for SO ${so.soNumber} (question="${question.slice(0, 80)}${question.length > 80 ? '…' : ''}")`);
  return sent;
}

/**
 * Branch replied to a '2nd_release' email. In planner mode this routes through
 * the unified `handleReplyV2` — the planner reads the audit trail (sees
 * email_2nd_release was sent), reads the email thread (sees "yes" / "no" /
 * etc.), and emits the next step list. Kept as a wrapper so external callers
 * don't have to change.
 */
export async function handleSecondReleaseReply(
  emailId: string,
  replyHtml: string,
  // Unused in planner mode (LLM reads the reply text directly), kept for
  // backwards compatibility with legacy callers.
  _preClassified?: { decision: 'yes' | 'no' | 'ambiguous' },
): Promise<{ success: boolean; logs: string[] }> {
  const r = await handleReplyV2({
    emailId,
    replyHtml,
    originalEmailHtml: '',
    // 2nd_release is branch-bound — the branch performs the 2nd release in
    // SAP — so the reply on that thread comes from the branch.
    sourceEmailType: 'branch',
  });
  return { success: r.success, logs: r.logs };
}

// -----------------------------------------------------------------------------
// Main entry: handleReplyV2 — LLM planner dispatch
//
// 1. Loads the email + SO.
// 2. Detects active scenario (most recent non-terminal ScenarioProgress).
// 3. Calls planNextSteps (src/lib/llm-planner.ts) with the SO's audit trail
//    + email thread; the planner emits the next step list including args.
// 4. Creates a new ScenarioProgress and walks the step list up to the next
//    outbound email. Aborts any prior in-flight scenario for this SO.
// 5. Emits ScenarioEvent at every transition.
//
// ⚠️  BEFORE EDITING handleReplyV2 — read docs/email-reply-detection.md.
// The replyHtml-overwrite invariant (§6 of that doc) is load-bearing for
// follow-up reply detection; flipping it back to "preserve prior reply"
// silently breaks the cron's ability to surface a 2nd reply on the same
// thread. Update the doc's change log if you change behavior here.
// -----------------------------------------------------------------------------

export async function handleReplyV2(args: {
  emailId: string;
  replyHtml: string;
  originalEmailHtml: string;
  sourceEmailType: 'branch' | 'plant';
}): Promise<{ success: boolean; matched: boolean; logs: string[] }> {
  const logs: string[] = [];
  const log = (m: string) => {
    const t = `[${new Date().toISOString()}] ${m}`;
    console.log(t);
    logs.push(t);
  };

  const { planNextSteps } = await import('./llm-planner');
  const { emitEvent } = await import('./scenario-events');

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
      // Surface a received PDF (e.g. a plant invoice) so the planner's audit
      // trail shows it. Without this the LLM only sees the reply text and
      // assumes no invoice arrived, looping on await_plant_invoice.
      hasPdfAttachment: !!email.replyPdfUrl,
    },
  });

  // Ensure the trigger Email row records this reply AND transitions out of
  // the cron's pending-reply set. Without flipping status/workflowState
  // here the next cron tick re-picks this row, re-classifies the same
  // thread, and re-fires whatever the plan emits — exactly the
  // duplicate-ZLOAD1 bug we hit in prod.
  //
  // CRITICAL: always overwrite `replyHtml` with the latest reply. The
  // poller now polls `status='replied'` rows too (so follow-up replies on
  // the same thread are detected); if we kept the prior replyHtml, the
  // planner would re-read the OLD reply on the next round even though a
  // newer one has arrived. ProcessedEmail dedup at the message-id level
  // is what prevents re-firing the same reply twice.
  await prisma.email.update({
    where: { id: email.id },
    data: {
      replyHtml: args.replyHtml,
      repliedAt: new Date(),
      status: 'replied',
      workflowState: 'completed',
    },
  });

  // Abort any prior non-terminal ScenarioProgress. The planner builds a fresh
  // plan per inbound; there's no notion of "continuing" a prior plan — once
  // the next email arrives, the prior plan is superseded.
  const activeProgress = await prisma.scenarioProgress.findFirst({
    where: {
      salesOrderId: email.salesOrderId,
      state: { notIn: ['completed', 'aborted', 'failed'] },
    },
    orderBy: { createdAt: 'desc' },
  });
  if (activeProgress) {
    await prisma.scenarioProgress.update({
      where: { id: activeProgress.id },
      data: { state: 'aborted', error: 'superseded by new inbound email' },
    });

    // Cancel still-queued SAP work the aborted plan enqueued. Anything
    // already `firing` or `done` we leave alone — auto_gui2 is running it
    // or has run it. Only `queued` rows are safe to cancel here.
    const cancelled = await prisma.workQueue.updateMany({
      where: {
        salesOrderId: email.salesOrderId,
        state: 'queued',
      },
      data: { state: 'cancelled', finishedAt: new Date() },
    });
    if (cancelled.count > 0) {
      log(`[ENGINE] Cancelled ${cancelled.count} queued WorkQueue row(s) from aborted plan ${activeProgress.id}`);
    }

    await emitEvent({
      salesOrderId: email.salesOrderId,
      scenarioProgressId: activeProgress.id,
      type: 'scenario_aborted',
      payload: {
        scenario_key: activeProgress.scenarioKey,
        reason: 'superseded by new inbound email',
        cancelled_work_count: cancelled.count,
      },
    });
    log(`[ENGINE] Aborted prior plan ${activeProgress.id} (was at step ${activeProgress.currentStepIndex}) — superseded by new inbound`);
  }

  // Build a fresh plan from the LLM.
  let plan: Awaited<ReturnType<typeof planNextSteps>>;
  try {
    plan = await planNextSteps({
      salesOrderId: email.salesOrderId,
      triggerEmailId: email.id,
      sender: args.sourceEmailType,
    });
  } catch (err) {
    log(`[ENGINE] Planner failed: ${err instanceof Error ? err.message : err}`);
    await emitEvent({
      salesOrderId: email.salesOrderId,
      type: 'scenario_aborted',
      payload: { reason: `planner_error: ${err instanceof Error ? err.message : String(err)}` },
    });
    return { success: false, matched: false, logs };
  }

  log(
    `[ENGINE] SO ${email.salesOrder.soNumber}: planner produced ${plan.steps.length} step(s) ` +
      `(stopAfter=${plan.stopAfterIndex}, escalate=${plan.escalate}); rationale="${plan.rationale}"`,
  );

  await emitEvent({
    salesOrderId: email.salesOrderId,
    scenarioProgressId: null,
    type: 'classifier_decision',
    payload: {
      scenario_key: 'llm-planned',
      reasoning: plan.rationale,
      escalate: plan.escalate,
      escalation_question: plan.escalationQuestion ?? null,
      planned_steps: plan.steps.map((s) => s.kind),
      stop_after_index: plan.stopAfterIndex,
      sender: args.sourceEmailType,
    },
  });

  // Escalate path: write an aborted marker row + send the supervisor inquiry
  // (existing helper). Don't fire any steps.
  if (plan.escalate) {
    const escalated = await prisma.scenarioProgress.create({
      data: {
        salesOrderId: email.salesOrderId,
        scenarioKey: 'llm-planned',
        currentStepIndex: 0,
        state: 'aborted',
        classifierOutput: JSON.stringify({ escalate: true, rationale: plan.rationale, question: plan.escalationQuestion }),
        triggerEmailId: email.id,
        generatedSteps: JSON.stringify([]),
        stopAfterIndex: -1,
        plannerRationale: plan.rationale,
        error: plan.escalationQuestion ?? 'planner requested escalation',
      },
    });
    await emitEvent({
      salesOrderId: email.salesOrderId,
      scenarioProgressId: escalated.id,
      type: 'scenario_aborted',
      payload: { scenario_key: 'llm-planned', reason: plan.escalationQuestion ?? 'planner requested escalation' },
    });
    log(`[ENGINE] Planner requested escalation: ${plan.escalationQuestion ?? '(no question)'}`);
    // TODO: trigger supervisor email here once we re-wire escalateToSupervisor
    return { success: true, matched: false, logs };
  }

  // Empty plan = nothing to do (e.g. the email is just "thanks"). Mark
  // completed immediately so the dashboard sees the no-op.
  if (plan.steps.length === 0) {
    const noop = await prisma.scenarioProgress.create({
      data: {
        salesOrderId: email.salesOrderId,
        scenarioKey: 'llm-planned',
        currentStepIndex: 0,
        state: 'completed',
        classifierOutput: JSON.stringify({ rationale: plan.rationale }),
        triggerEmailId: email.id,
        generatedSteps: JSON.stringify([]),
        stopAfterIndex: -1,
        plannerRationale: plan.rationale,
      },
    });
    await emitEvent({
      salesOrderId: email.salesOrderId,
      scenarioProgressId: noop.id,
      type: 'scenario_completed',
      payload: { scenario_key: 'llm-planned', step_count: 0 },
    });
    log(`[ENGINE] Planner returned no-op (empty step list) — nothing to fire`);
    return { success: true, matched: true, logs };
  }

  // Create the new ScenarioProgress row carrying the plan as JSON, then walk it.
  const newProgress = await prisma.scenarioProgress.create({
    data: {
      salesOrderId: email.salesOrderId,
      scenarioKey: 'llm-planned',
      currentStepIndex: 0,
      state: 'ready',
      classifierOutput: JSON.stringify({ rationale: plan.rationale }),
      triggerEmailId: email.id,
      generatedSteps: JSON.stringify(plan.steps),
      stopAfterIndex: plan.stopAfterIndex,
      plannerRationale: plan.rationale,
    },
  });
  await prisma.salesOrder.update({
    where: { id: email.salesOrderId },
    data: { intentLabel: 'llm-planned' },
  });
  await emitEvent({
    salesOrderId: email.salesOrderId,
    scenarioProgressId: newProgress.id,
    type: 'scenario_started',
    payload: {
      scenario_key: 'llm-planned',
      trigger_email_id: email.id,
      step_count: plan.steps.length,
      planned_steps: plan.steps.map((s) => s.kind),
    },
  });

  log(`[ENGINE] handled — plan with ${plan.steps.length} step(s): ${plan.steps.map((s) => s.kind).join(', ')}`);

  // Fire step 0; executeScenario walks until stopAfterIndex is reached.
  await executeScenario({ salesOrderId: email.salesOrderId, log });

  return { success: true, matched: true, logs };
}

/**
 * Handle the three sheet-defined Anytime intents that have zero steps:
 *  - branch|anytime|status_update|-  → reply with current SO status
 *  - branch|anytime|other|-          → escalate to supervisor
 *  - plant|anytime|other|-           → escalate to supervisor
 *
 * Each terminates the scenario immediately after the outbound action.
 */
async function handleAnytimeIntent(args: {
  scenarioKey: string;
  progressId: string;
  email: { id: string; salesOrderId: string | null; gmailThreadId: string | null; gmailMessageId: string | null };
  log: (m: string) => void;
}): Promise<void> {
  const { scenarioKey, progressId, email, log } = args;
  const { emitEvent } = await import('./scenario-events');

  if (!email.salesOrderId) {
    log(`[ENGINE] Anytime intent ${scenarioKey} but no salesOrderId — marking failed`);
    await prisma.scenarioProgress.update({
      where: { id: progressId },
      data: { state: 'failed', error: 'no salesOrderId for Anytime intent' },
    });
    return;
  }

  if (scenarioKey === 'branch|anytime|status_update|-') {
    await sendOrderStatusEmail({
      salesOrderId: email.salesOrderId,
      log,
    });
  } else if (scenarioKey === 'branch|anytime|other|-' || scenarioKey === 'plant|anytime|other|-') {
    const { escalateToSupervisor } = await import('./supervisor-escalation');
    const sender = scenarioKey === 'plant|anytime|other|-' ? 'plant' : 'branch';
    await escalateToSupervisor({
      salesOrderId: email.salesOrderId,
      triggerEmailId: email.id,
      description: `${sender} sent an email that did not match any known sheet intent`,
      suggested_question_for_supervisor: `How should we respond to this ${sender} email? See thread for context.`,
      reasoning: `Classifier picked the catch-all Anytime "${sender}" intent because none of the stage-specific intents matched.`,
      log,
    });
  } else {
    log(`[ENGINE] BUG: unknown Anytime scenarioKey ${scenarioKey}`);
  }

  await prisma.scenarioProgress.update({
    where: { id: progressId },
    data: { state: 'completed' },
  });
  await emitEvent({
    salesOrderId: email.salesOrderId,
    scenarioProgressId: progressId,
    type: 'scenario_completed',
    payload: { scenario_key: scenarioKey, step_count: 0, kind: 'anytime' },
  });
}

// Helper used by handleReplyV2 for compact email excerpts in event payloads.
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
  // be multiple historical rows per SO (aborted, completed) since each new
  // inbound starts a fresh ScenarioProgress.
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

  // Planner-mode: read the JSON-stored step list off ScenarioProgress.
  const plan = readPlanFromProgress(progress);
  const { emitEvent } = await import('./scenario-events');
  if (plan.steps.length === 0) {
    log(`[ENGINE] ScenarioProgress ${progress.id} has no generated steps — marking completed (no-op plan)`);
    await prisma.scenarioProgress.update({
      where: { id: progress.id },
      data: { state: 'completed' },
    });
    await emitEvent({
      salesOrderId: args.salesOrderId,
      scenarioProgressId: progress.id,
      type: 'scenario_completed',
      payload: { scenario_key: progress.scenarioKey, step_count: 0 },
    });
    return;
  }

  // Past the end? Or past the planner's stopAfterIndex? Mark completed —
  // UNLESS the safety net detects a planner gap (zload2/zloading_close
  // fired but no follow-on plant email). In that case inject the missing
  // step and continue.
  if (
    progress.currentStepIndex >= plan.steps.length ||
    progress.currentStepIndex > plan.stopAfterIndex
  ) {
    const gapFilled = await maybeInjectMissingPlantEmail({
      progressId: progress.id,
      salesOrderId: args.salesOrderId,
      plannedSteps: plan.plannedSteps,
      currentStopAfterIndex: plan.stopAfterIndex,
      log,
    });
    if (gapFilled) {
      // Re-read plan with the injected step; fall through to the regular
      // step-firing path below. currentStepIndex now points at the injected step.
      const refreshed = await prisma.scenarioProgress.findUnique({ where: { id: progress.id } });
      if (refreshed) {
        const newPlan = readPlanFromProgress(refreshed);
        plan.steps = newPlan.steps;
        plan.plannedSteps = newPlan.plannedSteps;
        plan.stopAfterIndex = newPlan.stopAfterIndex;
        progress.currentStepIndex = refreshed.currentStepIndex;
      }
    } else {
      log(`[ENGINE] Plan completed for SO ${args.salesOrderId} (idx=${progress.currentStepIndex}, stopAfter=${plan.stopAfterIndex})`);
      await prisma.scenarioProgress.update({
        where: { id: progress.id },
        data: { state: 'completed' },
      });
      await emitEvent({
        salesOrderId: args.salesOrderId,
        scenarioProgressId: progress.id,
        type: 'scenario_completed',
        payload: { scenario_key: progress.scenarioKey, step_count: plan.steps.length },
      });
      return;
    }
  }

  const step = plan.steps[progress.currentStepIndex];
  const plannedStep = plan.plannedSteps[progress.currentStepIndex];
  log(
    `[ENGINE] SO ${args.salesOrderId} firing step ${progress.currentStepIndex + 1}/${plan.steps.length}: ${step.kind}${
      step.label ? ` (${step.label})` : ''
    }`
  );
  await emitEvent({
    salesOrderId: args.salesOrderId,
    scenarioProgressId: progress.id,
    type: 'step_fired',
    payload: {
      step_index: progress.currentStepIndex,
      kind: step.kind,
      label: step.label ?? null,
      scenario_key: progress.scenarioKey,
      rationale: plannedStep?.rationale ?? null,
    },
  });

  try {
    const next = await fireStep(step, progress, plannedStep, log);
    if (next === 'advance_now') {
      // No-op step — emit step_completed immediately, advance, and recurse.
      const sapOutput = await collectSapOutputForStep(args.salesOrderId, step.kind);
      await emitEvent({
        salesOrderId: args.salesOrderId,
        scenarioProgressId: progress.id,
        type: 'step_completed',
        payload: {
          step_index: progress.currentStepIndex,
          kind: step.kind,
          scenario_key: progress.scenarioKey,
          ...(sapOutput ? { sap_output: sapOutput } : {}),
        },
      });
      await prisma.scenarioProgress.update({
        where: { id: progress.id },
        data: { currentStepIndex: progress.currentStepIndex + 1, state: 'ready' },
      });
      // Check if we've reached the planner-defined stop point.
      const nextIndex = progress.currentStepIndex + 1;
      if (nextIndex > plan.stopAfterIndex) {
        await prisma.scenarioProgress.update({
          where: { id: progress.id },
          data: { state: 'completed' },
        });
        await emitEvent({
          salesOrderId: args.salesOrderId,
          scenarioProgressId: progress.id,
          type: 'scenario_completed',
          payload: { scenario_key: progress.scenarioKey, step_count: plan.steps.length },
        });
        return;
      }
      await executeScenario({ salesOrderId: args.salesOrderId, log });
      return;
    }
    if (next === 'complete_segment') {
      // An outbound email fired. Per planner contract, this is where we pause
      // (stop_after_index typically points at this step). Mark completed; the
      // next inbound email will trigger a fresh planNextSteps call.
      const sapOutput = await collectSapOutputForStep(args.salesOrderId, step.kind);
      await emitEvent({
        salesOrderId: args.salesOrderId,
        scenarioProgressId: progress.id,
        type: 'step_completed',
        payload: {
          step_index: progress.currentStepIndex,
          kind: step.kind,
          scenario_key: progress.scenarioKey,
          ...(sapOutput ? { sap_output: sapOutput } : {}),
        },
      });
      await prisma.scenarioProgress.update({
        where: { id: progress.id },
        data: { currentStepIndex: progress.currentStepIndex + 1, state: 'completed' },
      });
      await emitEvent({
        salesOrderId: args.salesOrderId,
        scenarioProgressId: progress.id,
        type: 'scenario_completed',
        payload: { scenario_key: progress.scenarioKey, step_count: plan.steps.length, kind: 'segment_boundary' },
      });
      log(`[ENGINE] Segment boundary on ${step.kind} — plan completed for SO ${args.salesOrderId}`);
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

type FireResult = 'pause' | 'advance_now' | 'complete_segment';

async function fireStep(
  step: Step,
  progress: { id: string; salesOrderId: string; classifierOutput: string },
  _plannedStep: PlannedStep | undefined,
  log: (msg: string) => void,
): Promise<FireResult> {
  // Planner-driven mode: each step carries its own `args` (read by the LLM
  // planner directly from the email thread). Handlers coerce those args into
  // the typed Prisma payloads via `./planner-step-args`. No second LLM extractor
  // runs here. DB-only steps (zso_visibility, zload1, ...) ignore args.

  switch (step.kind) {
    // -------- Pre-VA02 free-stock gate (replaces "Zmatana" Step 2) --------
    case 'stock_precheck': {
      const { runStockPrecheck } = await import('./stock-precheck');
      const { coerceStockPrecheckArgs } = await import('./planner-step-args');
      const materials = coerceStockPrecheckArgs(_plannedStep);
      const result = await runStockPrecheck({
        salesOrderId: progress.salesOrderId,
        classification: {
          materials: materials.map((m) => ({
            material_code: m.material_code,
            operation: m.operation,
            quantity: m.quantity,
          })),
        },
      });

      if (result.outcome === 'sufficient') {
        // Emit a step_completed carrying the per-material 3-way availability so
        // the LS-created "don't preserve" path (Rule 6b A1/A2/A3) can read it.
        // For a plain decrease/delete step perMaterial is [] — harmless.
        if (result.perMaterial.length > 0) {
          try {
            const { emitEvent } = await import('./scenario-events');
            await emitEvent({
              salesOrderId: progress.salesOrderId,
              scenarioProgressId: progress.id,
              type: 'step_completed',
              payload: {
                kind: 'stock_precheck',
                scenario_key: 'planner',
                perMaterial: result.perMaterial,
              },
            });
          } catch {}
        }
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

      if (result.outcome === 'substituted') {
        // Every short line was covered by a cross-plant equivalent. The
        // current plan can't continue as-is — its va02 step still carries
        // the ORIGINAL material codes. Emit step_completed with the
        // substitutions payload (so the audit trail records it), mark the
        // current scenario completed, and re-enter handleReplyV2 against
        // the same trigger email. The fresh planner call will see the
        // substitutions in audit and emit va02 (with substitute codes) →
        // lone_zmatana → email_2nd_release per Rule 6c of the manager prompt.
        log(`[ENGINE] stock_precheck — substituted ${result.substitutions.length} line(s) via cross-plant equivalents: ${result.substitutions.map((s) => `${s.originalMaterial}→${s.substituteMaterial}@${s.substitutePlant}`).join(', ')}`);
        try {
          const { emitEvent } = await import('./scenario-events');
          await emitEvent({
            salesOrderId: progress.salesOrderId,
            scenarioProgressId: progress.id,
            type: 'step_completed',
            payload: {
              kind: 'stock_precheck',
              scenario_key: 'planner',
              substitutions: result.substitutions,
              perMaterial: result.perMaterial,
            },
          });
        } catch {}

        // Terminate the current scenario and re-plan against the same trigger.
        await prisma.scenarioProgress.update({
          where: { id: progress.id },
          data: { state: 'completed' },
        });
        const triggerEmailId = (
          await prisma.scenarioProgress.findUnique({
            where: { id: progress.id },
            select: { triggerEmailId: true },
          })
        )?.triggerEmailId;
        if (triggerEmailId) {
          const trigger = await prisma.email.findUnique({
            where: { id: triggerEmailId },
            select: { replyHtml: true, recipientEmail: true },
          });
          if (trigger?.replyHtml) {
            const sender: 'branch' | 'plant' =
              PLANT_EMAIL && trigger.recipientEmail === PLANT_EMAIL ? 'plant' : 'branch';
            log(`[ENGINE] stock_precheck — re-entering handleReplyV2 with substituted audit trail`);
            const r = await handleReplyV2({
              emailId: triggerEmailId,
              replyHtml: trigger.replyHtml,
              originalEmailHtml: '',
              sourceEmailType: sender,
            });
            for (const line of r.logs) log(line);
          }
        }
        return 'pause';
      }

      // 'short' — email the party that requested the increase and abort.
      // Their reply re-enters via the standard reply pipeline.
      //
      // Mixed-result case: result may also carry `substitutions` for lines
      // that DID get covered. We emit a step_completed event for those (so
      // the planner can still use them on its next call) AND send the
      // shortage email for the remaining gap.
      //
      // Always include the per-material 3-way availability so the LS-created
      // "don't preserve" path can tell A2 (partial) from A3 (none) when the
      // branch replies to the shortage inquiry.
      try {
        const { emitEvent } = await import('./scenario-events');
        await emitEvent({
          salesOrderId: progress.salesOrderId,
          scenarioProgressId: progress.id,
          type: 'step_completed',
          payload: {
            kind: 'stock_precheck',
            scenario_key: 'planner',
            ...(result.substitutions && result.substitutions.length > 0
              ? { substitutions: result.substitutions, partial: true }
              : {}),
            perMaterial: result.perMaterial,
          },
        });
      } catch {}
      if (result.substitutions && result.substitutions.length > 0) {
        log(`[ENGINE] stock_precheck — MIXED: ${result.substitutions.length} substituted, ${result.shortages.length} still short`);
      }
      const triggerEmailId = (
        await prisma.scenarioProgress.findUnique({
          where: { id: progress.id },
          select: { triggerEmailId: true },
        })
      )?.triggerEmailId ?? '';
      // Stock-short proceed question always goes to the branch — even a
      // plant-initiated change is funnelled through branch approval first.
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

    case 'bundle_capacity_assessment': {
      // Post-plant-intimation guard. Compute, per item, whether the requested
      // increase fits in the current bundle, an alternate bundle on the same
      // PO, or no bundle at all. Emit a step_completed event with the
      // per-item verdicts, terminate the current scenario, and re-enter
      // handleReplyV2 against the same trigger email — the next plan call
      // will see the verdicts in the audit trail and pick the right per-item
      // step path (Rule 11). Mirrors the stock_precheck → substituted re-plan
      // pattern.

      // Resolve the trigger email for THIS branch reply once — used both to
      // scope the loop guard below and to re-enter handleReplyV2 afterwards.
      const triggerEmailId = (
        await prisma.scenarioProgress.findUnique({
          where: { id: progress.id },
          select: { triggerEmailId: true },
        })
      )?.triggerEmailId ?? null;

      // Loop guard — SCOPED TO THE CURRENT BRANCH REPLY (triggerEmailId), NOT
      // all-time. A genuine loop is the planner re-emitting the assessment over
      // and over WITHIN one branch reply (ignoring the verdicts already in the
      // audit trail — a Gemini/GPT confusion mode). Distinct branch-driven
      // cycles are NOT a loop: e.g. the branch increases material A (assessment
      // runs), the stock precheck comes back short, then the branch asks to
      // increase material B (assessment runs again). Each is a fresh, legitimate
      // request arriving on its OWN trigger email and must start the count from
      // zero. Every re-plan within one reply re-enters handleReplyV2 with the
      // same triggerEmailId, so all its ScenarioProgress rows share it; a new
      // reply gets a new one. Counting only assessment completions under THIS
      // reply's progress rows resets the guard per cycle while still catching a
      // real same-reply loop.
      const cycleProgressIds = triggerEmailId
        ? (
            await prisma.scenarioProgress.findMany({
              where: { triggerEmailId },
              select: { id: true },
            })
          ).map((p) => p.id)
        : [progress.id];
      const recentAssessments = await prisma.scenarioEvent.count({
        where: {
          salesOrderId: progress.salesOrderId,
          scenarioProgressId: { in: cycleProgressIds },
          type: 'step_completed',
          payload: { contains: '"kind":"bundle_capacity_assessment"' },
        },
      });
      const LOOP_THRESHOLD = 3;
      if (recentAssessments >= LOOP_THRESHOLD) {
        const errMsg =
          `bundle_capacity_assessment loop guard tripped: this branch reply already ` +
          `has ${recentAssessments} prior assessment completions in audit. The planner ` +
          `is re-emitting the assessment instead of routing per-item per Rule 6e. ` +
          `Likely cause: the planner is not reading the \`verdicts:\` summary off ` +
          `the latest step_completed line. Marking scenario failed for supervisor review.`;
        log(`[ENGINE] ${errMsg}`);
        await prisma.scenarioProgress.update({
          where: { id: progress.id },
          data: { state: 'failed', error: errMsg },
        });
        try {
          const { emitEvent } = await import('./scenario-events');
          await emitEvent({
            salesOrderId: progress.salesOrderId,
            scenarioProgressId: progress.id,
            type: 'scenario_failed',
            payload: {
              error: errMsg,
              priorAssessmentCount: recentAssessments,
            },
          });
        } catch {}
        return 'pause';
      }

      const { coerceBundleCapacityArgs } = await import('./planner-step-args');
      const { assessPostLsIncrease } = await import('./bundle-capacity');
      const { items, overflowMode, decreases } = coerceBundleCapacityArgs(_plannedStep);
      let result;
      try {
        result = await assessPostLsIncrease({
          salesOrderId: progress.salesOrderId,
          items: items.map((i) => ({ material: i.material, deltaKg: i.deltaKg })),
          overflowMode,
          decreases,
        });
      } catch (assessErr) {
        log(`[ENGINE] bundle_capacity_assessment — helper failed: ${assessErr instanceof Error ? assessErr.message : String(assessErr)}`);
        await prisma.scenarioProgress.update({
          where: { id: progress.id },
          data: { state: 'failed', error: `bundle_capacity_assessment: ${assessErr instanceof Error ? assessErr.message : String(assessErr)}` },
        });
        return 'pause';
      }

      // Annotate each verdict with the deltaKg the planner asked us to
      // assess. Surfacing this in the audit trail lets the planner distinguish
      // "verdict for the prior 209-unit ask" from "verdict for the new
      // 202-unit ask" — without this the trail just says
      // `material=needs_new_so` for both rounds and the LLM can't tell which
      // delta the verdict belongs to.
      const deltaByMaterial = new Map<string, number>(items.map((i) => [i.material, i.deltaKg]));
      const verdictsWithDelta = result.verdicts.map((v) => ({
        ...v,
        assessedDeltaKg: deltaByMaterial.get(v.material) ?? null,
      }));
      log(
        `[ENGINE] bundle_capacity_assessment — verdicts: ${verdictsWithDelta.map((v) => {
          const allocSummary = v.allocations.length > 0
            ? ' alloc=[' + v.allocations.map((a) => `${a.kind}:${Math.round(a.kg)}kg`).join('+') + ']'
            : '';
          const overflowSummary = v.overflowKg > 0 ? ` overflow=${Math.round(v.overflowKg)}kg` : '';
          const deltaSummary = v.assessedDeltaKg !== null ? `@${v.assessedDeltaKg}kg` : '';
          return `${v.material}:${v.verdict}${deltaSummary}${allocSummary}${overflowSummary}`;
        }).join(', ')}`,
      );
      // Apply the concurrent decreases/deletes VIRTUALLY: set each material's
      // dispatchQuantity to the new lower total (0 = delete) so the dispatch
      // approval + confirmation emails and bundle tonnage reflect it. We do NOT
      // touch orderQuantity / orderWeightKg — the SO line is reconciled in SAP
      // later (Phase 3 zload2/zloading_close → next VA02 flush). Record the
      // before/after units for the confirmation email's decrease lines.
      const decreaseLines: Array<{ material: string; fromQty: number; toQty: number }> = [];
      for (const dec of decreases) {
        const lsis = await prisma.loadingSlipItem.findMany({
          where: { salesOrderId: progress.salesOrderId, material: dec.material, loadingSlipId: { not: null } },
          select: { orderQuantity: true },
        });
        const fromQty = lsis.reduce((s, l) => s + (l.orderQuantity ?? 0), 0);
        await prisma.material.updateMany({
          where: { salesOrderId: progress.salesOrderId, material: dec.material },
          data: { dispatchQuantity: dec.toQty },
        });
        decreaseLines.push({ material: dec.material, fromQty, toQty: dec.toQty });
      }
      if (decreaseLines.length > 0) {
        log(
          `[ENGINE] bundle_capacity_assessment — virtual decrease applied (display only): ` +
            decreaseLines.map((d) => `${d.material} ${d.fromQty}→${d.toQty}`).join(', '),
        );
      }

      try {
        const { emitEvent } = await import('./scenario-events');
        await emitEvent({
          salesOrderId: progress.salesOrderId,
          scenarioProgressId: progress.id,
          type: 'step_completed',
          payload: {
            kind: 'bundle_capacity_assessment',
            scenario_key: 'planner',
            verdicts: verdictsWithDelta,
            capacityKg: result.capacityKg,
            decreases: decreaseLines,
          },
        });
      } catch {}

      // Terminate the current scenario and re-plan against the same trigger
      // email so the planner picks the per-item path now that the verdicts
      // are in audit.
      await prisma.scenarioProgress.update({
        where: { id: progress.id },
        data: { state: 'completed' },
      });
      // triggerEmailId was resolved at the top of this case (loop-guard scope).
      if (triggerEmailId) {
        const trigger = await prisma.email.findUnique({
          where: { id: triggerEmailId },
          select: { replyHtml: true, recipientEmail: true },
        });
        if (trigger?.replyHtml) {
          const sender: 'branch' | 'plant' =
            PLANT_EMAIL && trigger.recipientEmail === PLANT_EMAIL ? 'plant' : 'branch';
          log('[ENGINE] bundle_capacity_assessment — re-entering handleReplyV2 with verdicts in audit');
          const r = await handleReplyV2({
            emailId: triggerEmailId,
            replyHtml: trigger.replyHtml,
            originalEmailHtml: '',
            sourceEmailType: sender,
          });
          for (const line of r.logs) log(line);
        }
      }
      return 'pause';
    }

    // -------- SAP transactions --------
    case 'va02': {
      // VA02 in SAP changes SO line quantities. V3.0 lets the planner emit
      // inc / dec / del directly here — but ONLY in the no-loading-slips window
      // (pre-LS, or the recreate path where a zloading_close all earlier in the
      // SAME plan wiped the slips). In the preserve / post-plant windows the
      // planner emits increases only; decreases/deletes are applied to the
      // loading slips (zload2 / zloading_close set Material.pendingSoOp) and the
      // SO line is reconciled HERE, when a VA02 runs anyway. So this handler
      // applies BOTH the planner's inc/dec/del AND any pending dec/del flush.
      const { coerceVa02Args } = await import('./planner-step-args');
      const items = coerceVa02Args(_plannedStep);
      const setItems = items.filter(
        (it): it is { material: string; op: 'inc' | 'dec'; orderQuantity: number } =>
          it.op !== 'del' && typeof it.orderQuantity === 'number',
      );
      const delItems = items.filter((it) => it.op === 'del');
      const soNumber = await soNumberFor(progress.salesOrderId);

      // Load pending dec/del for THIS SO and merge them with the planner items.
      const pendingRows = await prisma.material.findMany({
        where: { salesOrderId: progress.salesOrderId, pendingSoOp: { not: null } },
        select: { material: true, pendingSoOp: true, pendingSoQty: true },
      });
      const pending: PendingSoChange[] = pendingRows
        .filter((p) => p.pendingSoOp === 'dec' || p.pendingSoOp === 'del')
        .map((p) => ({
          material: p.material,
          pendingSoOp: p.pendingSoOp as 'dec' | 'del',
          pendingSoQty: p.pendingSoQty,
        }));

      const merged = mergeVa02Flush(items, pending);
      const describe = merged
        .map((m) => ('op' in m ? `${m.material}→DELETE` : `${m.material}→${m.orderQuantity}`))
        .join(', ');
      log(`[ENGINE] va02 firing for ${merged.length} line(s) (planner: ${setItems.length} inc/dec + ${delItems.length} del; ${pending.length} pending dec/del): ${describe}`);
      await triggerVa02(soNumber, merged);

      // Persist the planner's inc/dec targets onto the SO line. coerceVa02Args
      // returns the new ABSOLUTE total per material (e.g. 210 up, or 150 down),
      // which is exactly what we just sent to SAP — so the DB Material must match.
      // Without this, the surgical flow left orderQuantity stuck at the old value
      // because nothing else writes it: visibility-data isn't called in this flow
      // and zmatana-data deliberately skips orderQuantity.
      //
      // CRITICAL — keep all THREE related fields on the same basis, or every
      // downstream weight/qty calc breaks:
      //   - orderQuantity : the new SO-line total (the value sent to SAP).
      //   - orderWeightKg : the FULL-order weight; its basis IS orderQuantity, so
      //                     it must scale proportionally (kgPerUnit stays constant).
      //                     Moving orderQuantity alone would skew kgPerUnit and the
      //                     diff/bundle lines (the SO 3382184 inflation bug).
      //   - dispatchQuantity : the branch is releasing the new total, so it tracks
      //                     orderQuantity exactly. Do NOT clamp by availableStock —
      //                     that value is the STALE pre-change stock; stock_precheck
      //                     already validated the released qty before VA02 fired.
      // A decrease (op:'dec') uses the SAME math downward — set to the new total
      // and rescale weight so kgPerUnit stays constant.
      for (const it of setItems) {
        const rows = await prisma.material.findMany({
          where: { salesOrderId: progress.salesOrderId, material: it.material },
          select: { id: true, orderQuantity: true, orderWeightKg: true },
        });
        for (const row of rows) {
          // Per-unit weight from the OLD basis (before we overwrite orderQuantity).
          const oldQty = row.orderQuantity || 0;
          const oldWeight = row.orderWeightKg ? Number(row.orderWeightKg) : 0;
          const kgPerUnit = oldQty > 0 && oldWeight > 0 ? oldWeight / oldQty : 0;
          const newWeight = kgPerUnit > 0 ? kgPerUnit * it.orderQuantity : oldWeight;
          await prisma.material.update({
            where: { id: row.id },
            data: {
              orderQuantity: it.orderQuantity,
              orderWeightKg: newWeight,
              dispatchQuantity: it.orderQuantity,
            },
          });
        }
      }

      // Planner-emitted deletes remove the SO line entirely.
      for (const it of delItems) {
        await prisma.material.deleteMany({
          where: { salesOrderId: progress.salesOrderId, material: it.material },
        });
      }

      // Optimistically reconcile the DB + clear the pending flags. There is no
      // per-material VA02 callback to hang a precise clear on (step-status only
      // flips the WorkQueue row), and VA02 is the only flush trigger — so we
      // apply at fire time. If VA02 fails in SAP the WorkQueue row retries; the
      // LS already reflects the change, so the bounded inconsistency is the SO
      // line briefly showing the intended value before SAP confirms.
      const plannerCodes = new Set(items.map((i) => i.material));
      for (const p of pending) {
        if (plannerCodes.has(p.material)) {
          // Superseded by a fresh planner op this cycle (applied above) — drop
          // the stale pending change so it isn't double-applied.
          await prisma.material.updateMany({
            where: { salesOrderId: progress.salesOrderId, material: p.material },
            data: { pendingSoOp: null, pendingSoQty: null },
          });
        } else if (p.pendingSoOp === 'del') {
          await prisma.material.deleteMany({
            where: { salesOrderId: progress.salesOrderId, material: p.material },
          });
        } else {
          // Flush a pending decrease: lower the SO line AND scale orderWeightKg
          // so kgPerUnit stays invariant (mirrors the increase path), keeping
          // bundle tonnage correct after the flush.
          const row = await prisma.material.findFirst({
            where: { salesOrderId: progress.salesOrderId, material: p.material },
            select: { orderQuantity: true, orderWeightKg: true },
          });
          const newQty = p.pendingSoQty ?? 0;
          const oldQty = row?.orderQuantity ?? 0;
          const oldWeight = row?.orderWeightKg ? Number(row.orderWeightKg) : 0;
          const newWeight = oldQty > 0 && oldWeight > 0 ? (oldWeight * newQty) / oldQty : oldWeight;
          await prisma.material.updateMany({
            where: { salesOrderId: progress.salesOrderId, material: p.material },
            data: { orderQuantity: newQty, orderWeightKg: newWeight, pendingSoOp: null, pendingSoQty: null },
          });
        }
      }

      await markAwaitingCallback(progress.id);
      return 'pause';
    }

    case 'zso_visibility': {
      // BACKSTOP: never run ZSO_Visibility once loading slips exist. Bundles are
      // frozen for composition the moment any LS exists, and the visibility
      // callback fans out a fresh ls_dispatch + re-reads the full SO — the
      // surgical/preserve flow (Rule 6e) deliberately replaces that with
      // lone_zmatana. If the planner misroutes a frozen-bundle 2nd_release ack
      // here (Rule 8 vs Rule 6e collision), refuse rather than corrupt the flow.
      const lsExists = await prisma.loadingSlip.findFirst({
        where: { salesOrderId: progress.salesOrderId },
        select: { id: true },
      });
      if (lsExists) {
        log(
          '[ENGINE] zso_visibility REFUSED — loading slips exist (bundles frozen); ' +
            'the surgical flow must use lone_zmatana, not a visibility fan-out. ' +
            'Failing so the planner re-routes via Rule 6e.',
        );
        await prisma.scenarioProgress.update({
          where: { id: progress.id },
          data: {
            state: 'failed',
            error:
              'zso_visibility refused: loading slips exist (bundles frozen). Use lone_zmatana (Rule 6e), not visibility.',
          },
        });
        return 'pause';
      }
      const soNumber = await soNumberFor(progress.salesOrderId);
      await triggerZsoVisibility(soNumber);
      await markAwaitingCallback(progress.id);
      return 'pause';
    }

    case 'lone_zmatana': {
      // After stock_precheck substituted a material with a cross-plant
      // equivalent and va02 swapped the SO line, run ZMatana standalone to
      // populate the substitute Material's batch + availableStock. One
      // WorkQueue row per material; /backend/orders/aman/zmatana-data is
      // the callback.
      const { coerceLoneZmatanaArgs } = await import('./planner-step-args');
      const { triggerLoneZmatana } = await import('./auto-gui-trigger');
      const items = coerceLoneZmatanaArgs(_plannedStep);
      const soNumber = await soNumberFor(progress.salesOrderId);
      const describe = items
        .map((i) => (i.delta !== undefined ? `${i.code}(Δ${i.delta})` : i.code))
        .join(', ');
      log(`[ENGINE] lone_zmatana firing for ${items.length} material(s): ${describe}`);
      const lz = await triggerLoneZmatana(soNumber, items.map((i) => ({ material: i.code, delta: i.delta })));

      // Newly fired OR an identical transaction is still RUNNING (queued/firing):
      // WAIT for the response. The transaction's /zmatana-data callback drives the
      // single re-plan once the data is back. Do NOT re-invoke the planner here —
      // re-planning mid-transaction (or re-firing) is what produced the re-run loop.
      if (lz.fired || lz.existingState === 'queued' || lz.existingState === 'firing') {
        if (!lz.fired) {
          log(`[ENGINE] lone_zmatana — identical transaction already ${lz.existingState}; waiting for its response (not re-planning)`);
        }
        await markAwaitingCallback(progress.id);
        return 'pause';
      }

      // existingState === 'done' (or no row): the response already came back and
      // the callback already re-planned once — the planner is re-emitting a step
      // that has already finished this cycle. STOP: do not re-fire, do not
      // re-invoke the planner (no loop). Complete this no-op segment. With real
      // SAP data the planner emits the NEXT step instead of re-emitting, so this
      // is the rare safety net, not the happy path.
      log('[ENGINE] lone_zmatana — already completed this cycle; not re-generating (stop, no re-plan)');
      return 'advance_now';
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
      // ZLOAD2 revises existing LS quantities. CRITICAL: it MUST be fired
      // against the specific LS that actually carries the material being
      // modified. SAP opens the LS, expects the material to be on it, and
      // fails outright otherwise.
      //
      // The planner emits {lsNumber?, material, batch?, qty} per revision.
      // When lsNumber/batch are omitted we resolve them via the LSI table
      // (the source of truth for "which materials sit on which LS").
      const { coerceZload2Args } = await import('./planner-step-args');
      const requested = coerceZload2Args(_plannedStep);

      // Fallback batch lookup: when the planner omits batch, Material rows
      // hold the SO-level batch — same as the pre-arg-era resolution path.
      const materialRows = await prisma.material.findMany({
        where: { salesOrderId: progress.salesOrderId },
        select: { material: true, batch: true },
      });
      const batchByCode = new Map<string, string>();
      for (const row of materialRows) {
        if (row.batch && !batchByCode.has(row.material)) {
          batchByCode.set(row.material, row.batch);
        }
      }

      // Group revisions by LS. One ZLOAD2 call per LS.
      type LsBucket = { lsNumber: string; items: Array<{ material: string; batch: string; orderQuantity: number }> };
      const byLs = new Map<string, LsBucket>();
      const unresolved: string[] = [];
      const ambiguous: string[] = [];

      for (const r of requested) {
        // Resolve (lsNumber, batch) for this revision.
        // 1. If both planner-supplied, use as-is.
        // 2. If only material is supplied, find LSI rows for (so, material)
        //    and disambiguate.
        let targetLs = r.lsNumber;
        let targetBatch = r.batch;

        if (!targetLs || !targetBatch) {
          const lsiRows = await prisma.loadingSlipItem.findMany({
            where: {
              salesOrderId: progress.salesOrderId,
              material: r.material,
              ...(targetLs ? { lsNumber: targetLs } : {}),
              ...(targetBatch ? { batch: targetBatch } : {}),
            },
            select: { lsNumber: true, batch: true },
          });
          if (lsiRows.length === 0) {
            unresolved.push(r.material);
            continue;
          }
          const distinctTargets = new Set(lsiRows.map((row) => `${row.lsNumber}|${row.batch}`));
          if (distinctTargets.size > 1) {
            ambiguous.push(`${r.material} → ${[...distinctTargets].join(' / ')}`);
            continue;
          }
          const hit = lsiRows[0];
          targetLs = targetLs ?? hit.lsNumber;
          targetBatch = targetBatch ?? hit.batch ?? batchByCode.get(r.material);
        }
        if (!targetLs) {
          unresolved.push(`${r.material} (no LS found)`);
          continue;
        }
        if (!targetBatch) {
          unresolved.push(`${r.material} (no batch on LSI or Material)`);
          continue;
        }
        let bucket = byLs.get(targetLs);
        if (!bucket) {
          bucket = { lsNumber: targetLs, items: [] };
          byLs.set(targetLs, bucket);
        }
        bucket.items.push({ material: r.material, batch: targetBatch, orderQuantity: r.orderQuantity });
      }

      if (unresolved.length > 0) {
        log(`[ENGINE] zload2 — cannot resolve LS for: ${unresolved.join(', ')}. Aborting.`);
        await prisma.scenarioProgress.update({
          where: { id: progress.id },
          data: { state: 'failed', error: `zload2 LS lookup failed: ${unresolved.join(', ')}` },
        });
        return 'pause';
      }
      if (ambiguous.length > 0) {
        log(`[ENGINE] zload2 — material spans multiple (LS, batch) targets and the branch reply didn't disambiguate: ${ambiguous.join(' ; ')}. Aborting — needs operator input.`);
        await prisma.scenarioProgress.update({
          where: { id: progress.id },
          data: { state: 'failed', error: `zload2 ambiguous targets: ${ambiguous.join('; ')}` },
        });
        return 'pause';
      }
      if (byLs.size === 0) {
        log('[ENGINE] zload2 — no LS buckets formed; skipping');
        return 'advance_now';
      }

      log(`[ENGINE] zload2 firing across ${byLs.size} LS(s): ${[...byLs.values()].map((b) => `LS ${b.lsNumber} → ${b.items.map((i) => `${i.material}/${i.batch}→${i.orderQuantity}`).join(',')}`).join(' | ')}`);
      for (const bucket of byLs.values()) {
        await triggerZload2(bucket.lsNumber, bucket.items);
      }

      // Record a PENDING SO-line decrease — but ONLY for a GENUINE decrease.
      // A decrease LOWERS an existing LS line; the SO line (orderQuantity) is
      // then flushed down to match on the next va02 (va02 itself only applies
      // increases directly). Two NON-decrease cases must be excluded:
      //   1. same-bundle increase (Rule 6e): zload2 carries the new LS total
      //      (e.g. 210), already written to the SO line by the Phase-2 va02, so
      //      qty == cur — excluded by the `< cur` test.
      //   2. split-across-bundles increase: zload2 carries only the portion that
      //      fits THIS bundle (e.g. 213 of a 250 SO line) while a sibling zload1
      //      appends the overflow (37) to a NEW LS. Here qty (213) < cur (250)
      //      even though it is an INCREASE — so `< cur` ALONE wrongly flags a
      //      decrease, which a later va02 then flushes onto the SO line
      //      (orderQuantity 250 → 213; the SO 3382184 / YAFPLNA bug, which also
      //      made SAP try to lower the SO line).
      // The reliable discriminator: an increase RAISES the revised LS line; a
      // decrease LOWERS it. So additionally require the new qty to be BELOW the
      // LS's PRIOR quantity. LSI rows still hold their pre-zload2 quantities here
      // (the /zload2-data callback updates them later), so this read is the prior.
      const priorLsiRows = await prisma.loadingSlipItem.findMany({
        where: { salesOrderId: progress.salesOrderId },
        select: { lsNumber: true, material: true, batch: true, orderQuantity: true },
      });
      const priorQtyByKey = new Map<string, number>();
      for (const l of priorLsiRows) {
        priorQtyByKey.set(`${l.lsNumber}|${l.material}|${l.batch}`, l.orderQuantity ?? 0);
      }
      const curRows = await prisma.material.findMany({
        where: { salesOrderId: progress.salesOrderId, material: { in: requested.map((r) => r.material) } },
        select: { material: true, orderQuantity: true },
      });
      const curByCode = new Map(curRows.map((m) => [m.material, m.orderQuantity]));
      for (const bucket of byLs.values()) {
        for (const item of bucket.items) {
          const cur = curByCode.get(item.material);
          const priorOnThisLs = priorQtyByKey.get(`${bucket.lsNumber}|${item.material}|${item.batch}`) ?? 0;
          // Genuine decrease only when BOTH hold: the result is below the SO line
          // AND this existing LS line actually shrank. A split-increase portion
          // raises the LS line (overflow routes to a NEW LS), so it is skipped.
          if (cur !== undefined && item.orderQuantity < cur && item.orderQuantity < priorOnThisLs) {
            // LS revised down now; SO line flushed to match on the next va02.
            await prisma.material.updateMany({
              where: { salesOrderId: progress.salesOrderId, material: item.material },
              data: { pendingSoOp: 'dec', pendingSoQty: item.orderQuantity },
            });
          }
        }
      }

      await markAwaitingCallback(progress.id);
      return 'pause';
    }

    case 'zloading_close': {
      // ZLOAD_Delete — two modes:
      //   1. WIPE-ALL (args.all=true) — pre-plant_ls modify cycle. Enumerate
      //      every LSI on this SO, group by LS, fan out one triggerZloadingClose
      //      per LS with the full material list (in SAP, deleting every line
      //      of an LS deletes the LS itself). Guarded by the bundle-freeze
      //      invariant: refuse if any LS on this SO has reached `sent_to_plant`
      //      (or later).
      //   2. SURGICAL (args.deletes=[...]) — post-plant_ls per-material delete
      //      (Rule 11). Existing behavior: resolve lsNumber via LSI when omitted,
      //      fan out per LS.
      const { coerceZloadingCloseArgs } = await import('./planner-step-args');
      const coerced = coerceZloadingCloseArgs(_plannedStep);

      const byLs = new Map<string, Set<string>>();

      if (coerced.mode === 'all') {
        // Bundle-freeze invariant: refuse wipe-all once plant_ls has been sent.
        // Mirrors BundlesFrozenError in the bundler; protects against accidental
        // composition migration even if the planner emits the wrong shape.
        const sentLs = await prisma.loadingSlip.count({
          where: {
            salesOrder: { id: progress.salesOrderId },
            status: { in: ['sent_to_plant', 'invoiced', 'completed'] },
          },
        });
        if (sentLs > 0) {
          const errMsg =
            `zloading_close (all) refused: SO has ${sentLs} LS already sent_to_plant — ` +
            `post-intimation modifications must use bundle_capacity_assessment + per-material ` +
            `zload2/zload1-append per Rule 6e/Rule 11.`;
          log(`[ENGINE] ${errMsg}`);
          await prisma.scenarioProgress.update({
            where: { id: progress.id },
            data: { state: 'failed', error: errMsg },
          });
          return 'pause';
        }

        // Enumerate every LSI on this SO, group by lsNumber.
        const lsiRows = await prisma.loadingSlipItem.findMany({
          where: { salesOrderId: progress.salesOrderId },
          select: { lsNumber: true, material: true },
        });
        if (lsiRows.length === 0) {
          log('[ENGINE] zloading_close (all) — no LSI rows on this SO; nothing to close. Advancing.');
          return 'advance_now';
        }
        for (const r of lsiRows) {
          const bucket = byLs.get(r.lsNumber) ?? new Set<string>();
          bucket.add(r.material);
          byLs.set(r.lsNumber, bucket);
        }
        log(`[ENGINE] zloading_close (all) — wiping ${byLs.size} LS(s) across SO ${progress.salesOrderId}: ${[...byLs.keys()].join(', ')}`);
      } else {
        // Surgical: resolve each material → its LS via the LSI table when
        // lsNumber isn't supplied by the planner.
        const unresolved: string[] = [];
        for (const d of coerced.deletions) {
          if (d.lsNumber) {
            const bucket = byLs.get(d.lsNumber) ?? new Set<string>();
            bucket.add(d.material);
            byLs.set(d.lsNumber, bucket);
            continue;
          }
          const lsiRows = await prisma.loadingSlipItem.findMany({
            where: { salesOrderId: progress.salesOrderId, material: d.material },
            select: { lsNumber: true },
          });
          if (lsiRows.length === 0) {
            unresolved.push(d.material);
            continue;
          }
          for (const r of lsiRows) {
            const bucket = byLs.get(r.lsNumber) ?? new Set<string>();
            bucket.add(d.material);
            byLs.set(r.lsNumber, bucket);
          }
        }

        if (unresolved.length > 0) {
          log(`[ENGINE] zloading_close — no LSI found for: ${unresolved.join(', ')}. Aborting (cannot determine which LS to close on).`);
          await prisma.scenarioProgress.update({
            where: { id: progress.id },
            data: { state: 'failed', error: `zloading_close LS lookup failed: ${unresolved.join(', ')}` },
          });
          return 'pause';
        }
      }

      if (byLs.size === 0) {
        log('[ENGINE] zloading_close — no LS buckets formed; skipping');
        return 'advance_now';
      }

      log(`[ENGINE] zloading_close firing across ${byLs.size} LS(s): ${[...byLs.entries()].map(([ls, ms]) => `LS ${ls} → ${[...ms].join(',')}`).join(' | ')}`);
      for (const [lsNumber, materialsForLs] of byLs.entries()) {
        await triggerZloadingClose(lsNumber, [...materialsForLs]);
      }

      // ── DB-side cleanup for wipe-all mode ───────────────────────────────
      // ZLOADING_CLOSE deletes the LSs in SAP, but nothing else cleans up
      // the dashboard DB. When the planner later fires
      // `email_confirm_bundle_details`, the bundler reads existing
      // Bundle/LoadingSlip rows and compares against the new Material plan.
      // If the new plan happens to match (same materials, same quantities,
      // same packing) the bundler short-circuits with "re-bundle no-op",
      // leaving the old Bundle rows in place. Then ZLOAD1 fan-out finds the
      // PRIOR work_queue rows (state='done') and dedups against them — so
      // the fresh ZLOAD1 never fires in SAP.
      //
      // The fix: when mode='all', delete the SO's LoadingSlipItem +
      // LoadingSlip rows + Bundle backlinks immediately. Bundle rows
      // themselves are kept (they're at PO scope and may also serve other
      // SOs on the same PO), but their `loadingSlips` relation is now
      // empty. Then nuke the dedup-blocking prior ZLOAD1 / ZLOAD2 work_queue
      // rows for this SO so the post-cycle ZLOAD1 fan-out is treated as
      // first-time fire.
      //
      // We do this AFTER enqueuing the SAP work (so a planner mistake that
      // refuses the SAP step doesn't also blow away the DB), but BEFORE
      // pausing for callback — the bundler that runs in a later plan call
      // must see clean state.
      if (coerced.mode === 'all') {
        const lsRows = await prisma.loadingSlip.findMany({
          where: { salesOrderId: progress.salesOrderId },
          select: { id: true, lsNumber: true },
        });
        const lsIds = lsRows.map((r) => r.id);
        const lsNumbers = lsRows.map((r) => r.lsNumber);

        if (lsIds.length > 0) {
          await prisma.loadingSlipItem.deleteMany({
            where: { salesOrderId: progress.salesOrderId },
          });
          await prisma.loadingSlip.deleteMany({
            where: { id: { in: lsIds } },
          });
          // Clear bundleId backlinks on this SO's Materials so the bundler
          // treats them as freshly-staged (Materials themselves stay; their
          // dispatchQuantity is what VA02 / ZSO_Visibility updated).
          await prisma.material.updateMany({
            where: { salesOrderId: progress.salesOrderId, bundleId: { not: null } },
            data: { bundleId: null },
          });
          log(
            `[ENGINE] zloading_close (all): wiped ${lsIds.length} LoadingSlip + LSIs ` +
              `+ Material.bundleId backlinks for SO ${progress.salesOrderId}`,
          );
        }

        // Bust prior ZLOAD1/ZLOAD2 dedup rows on this SO so the next ZLOAD1
        // fan-out doesn't get short-circuited by "Skipping duplicate". We
        // keep the WorkQueue rows themselves as audit history (state stays
        // 'done') but remove the dedup_key so the (SO, bundleNumber) key
        // becomes free again. The cheapest way: rewrite payload to a sentinel
        // dedup_key per-row.
        const priorZloads = await prisma.workQueue.findMany({
          where: {
            salesOrderId: progress.salesOrderId,
            step: { in: ['zload1', 'zload2'] },
            state: { in: ['queued', 'firing', 'done'] },
          },
          select: { id: true, payload: true },
        });
        for (const w of priorZloads) {
          try {
            const p = JSON.parse(w.payload);
            if (p?.meta?.dedup_key) {
              p.meta.dedup_key = `wiped-by-zloading-close-all:${w.id}`;
              await prisma.workQueue.update({
                where: { id: w.id },
                data: { payload: JSON.stringify(p) },
              });
            }
          } catch {
            // Payload not JSON — leave it alone; the dedup check looks for
            // the literal `"dedup_key":"..."` substring so non-JSON rows
            // never match anyway.
          }
        }
        if (priorZloads.length > 0) {
          log(
            `[ENGINE] zloading_close (all): voided dedup_key on ${priorZloads.length} ` +
              `prior zload1/zload2 work_queue row(s) so the post-cycle fan-out fires fresh ` +
              `(LS numbers were: ${lsNumbers.join(', ')})`,
          );
        }
      }

      // SURGICAL mode only (Rule 11 per-material branch delete): record the
      // SO-line delete as PENDING so the next VA02 removes the line. The LS was
      // just closed above; the SO line lags until then. The wipe-all branch
      // must NOT set pending — its materials are re-staged for re-bundling, not
      // removed from the order.
      if (coerced.mode === 'surgical') {
        for (const d of coerced.deletions) {
          await prisma.material.updateMany({
            where: { salesOrderId: progress.salesOrderId, material: d.material },
            data: { pendingSoOp: 'del', pendingSoQty: null },
          });
        }
      }

      await markAwaitingCallback(progress.id);
      return 'pause';
    }

    case 'zload1': {
      // Two modes:
      //   1. Initial — no args; fan out per (Bundle, SO) from the SO's
      //      computed bundles via fanOutZload1ForPo (which calls the bundler).
      //   2. Append — args.appendToBundleId + args.materials; issue a single
      //      new LS onto the named existing bundle for the appended materials.
      //      Used post-plant-intimation when bundle_capacity_assessment
      //      returns fits_other_bundle. Bypasses the bundler entirely so the
      //      BundlesFrozenError guard never fires.
      const { coerceZload1AppendArgs } = await import('./planner-step-args');
      const appendArgs = coerceZload1AppendArgs(_plannedStep);

      if (appendArgs) {
        // New-bundle overflow leg (LS-created "preserve" path): create a fresh
        // bundle (extra vehicle), link the overflow material(s) to it, then
        // append the new LS. The zload1-data callback requires the bundle to
        // pre-exist, so creation MUST happen before the fan-out fires.
        let targetBundleId = appendArgs.appendToBundleId;
        if (appendArgs.createNewBundle) {
          const soForBundle = await prisma.salesOrder.findUnique({
            where: { id: progress.salesOrderId },
            select: { purchaseOrderId: true },
          });
          if (!soForBundle?.purchaseOrderId) {
            throw new Error(`SO ${progress.salesOrderId} has no purchaseOrderId for new-bundle ZLOAD1-append`);
          }
          const { createSingleBundleForPo } = await import('./bundler');
          const created = await createSingleBundleForPo(soForBundle.purchaseOrderId);
          targetBundleId = created.bundleId;
          log(`[ENGINE] zload1 (new bundle) — created Bundle ${created.bundleNumber} (id=${created.bundleId}) for overflow`);
          // Link the overflow material(s) on this SO to the new bundle so the
          // bundle-weight recompute + downstream grouping see the membership.
          const codes = appendArgs.materials.map((m) => m.code);
          const linked = await prisma.material.updateMany({
            where: { salesOrderId: progress.salesOrderId, material: { in: codes } },
            data: { bundleId: targetBundleId },
          });
          log(`[ENGINE] zload1 (new bundle) — linked ${linked.count} Material row(s) [${codes.join(', ')}] to Bundle ${created.bundleNumber}`);
        }
        if (!targetBundleId) {
          throw new Error('zload1 append: no target bundle (neither appendToBundleId nor createNewBundle resolved)');
        }
        const { fanOutZload1AppendToBundle } = await import('./auto-gui-trigger');
        const fanOut = await fanOutZload1AppendToBundle({
          salesOrderId: progress.salesOrderId,
          appendToBundleId: targetBundleId,
          materials: appendArgs.materials.map((m) => ({
            material_code: m.code,
            batch: m.batch,
            quantity: m.qty,
          })),
          log,
        });
        if (fanOut.fired === 0) {
          log('[ENGINE] zload1 (append) fired 0 rows — advancing immediately');
          return 'advance_now';
        }
        await markAwaitingCallback(progress.id);
        return 'pause';
      }

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

    // -------- email senders --------
    // Each outbound email step marks the scenario `completed` and stops;
    // the next inbound email triggers a fresh planner call.
    case 'email_confirm_product_details': {
      // Normal path (post-zso_visibility): the ls_dispatch email was already
      // auto-sent by visibility-data → assembleAndSendCombinedEmail. Nothing
      // to send here; just wait.
      //
      // Post-plant_ls partial-allocation path (Rule 6e Phase 2.75): we skipped
      // zso_visibility, so visibility-data never fired and no ls_dispatch went
      // out at the current dispatchRound. Detect that case and call
      // assembleAndSendCombinedEmail ourselves. The function's round-scoped
      // idempotency guard ensures this is a no-op when an ls_dispatch is
      // already on file for the current round — keeping behaviour identical
      // for the normal path.
      const so = await prisma.salesOrder.findUnique({
        where: { id: progress.salesOrderId },
        select: { purchaseOrderId: true, purchaseOrder: { select: { dispatchRound: true } } },
      });
      if (so?.purchaseOrderId) {
        const currentRound = so.purchaseOrder?.dispatchRound ?? 1;
        const existing = await prisma.email.findFirst({
          where: {
            purchaseOrderId: so.purchaseOrderId,
            emailType: 'ls_dispatch',
            status: { in: ['sent', 'replied'] },
            dispatchRound: currentRound,
          },
          select: { id: true },
        });
        if (!existing) {
          log(
            `[ENGINE] email_confirm_product_details — no ls_dispatch at dispatchRound=${currentRound}; ` +
              `actively sending one (post-plant_ls partial-allocation flow)`,
          );
          const { assembleAndSendCombinedEmail } = await import('./auto-gui-trigger');
          const r = await assembleAndSendCombinedEmail(so.purchaseOrderId);
          for (const line of r.logs) log(line);
        } else {
          log(`[ENGINE] email_confirm_product_details — ls_dispatch already on file for round ${currentRound}; waiting for branch reply`);
        }
      } else {
        log(`[ENGINE] email_confirm_product_details — SO has no PO; waiting for branch reply`);
      }
      return 'complete_segment';
      await markAwaitingReply(progress.id);
      return 'pause';
    }

    case 'email_confirm_bundle_details': {
      // Build the release plan from Material rows and send the
      // dispatch_confirmation email. The planner owns the decision to emit
      // this step — if a prior dispatch_confirmation already covers what's
      // needed, the planner reads its audit trail (rule 5) and doesn't emit.
      // The engine no longer second-guesses with a round-scoped duplicate
      // check.
      const { sendDispatchConfirmationEmail } = await import('./auto-gui-trigger');
      const so = await prisma.salesOrder.findUnique({
        where: { id: progress.salesOrderId },
        select: { soNumber: true, purchaseOrderId: true },
      });
      if (!so?.purchaseOrderId) {
        log('[ENGINE] email_confirm_bundle_details — no PO; segment-completing');
        return 'complete_segment';
        await markAwaitingReply(progress.id);
        return 'pause';
      }

      // Post-plant_ls partial-allocation branch (Rule 6e Phase 2.875).
      //
      // When the audit trail has a `step_completed bundle_capacity_assessment`
      // newer than the latest `email_received` AND any LS for this SO is
      // already `sent_to_plant`, we are in the slicing flow: the bundler is
      // frozen and there are upcoming ZLOAD2 / ZLOAD1-append legs to confirm.
      // Route to the sibling renderer that reads the existing bundle plan
      // straight from DB and annotates the upcoming changes (no bundler call).
      //
      // Existing callers fall through to the original path below unchanged —
      // this branch fires ONLY when the markers explicitly match.
      const latestAssessment = await prisma.scenarioEvent.findFirst({
        where: {
          salesOrderId: progress.salesOrderId,
          type: 'step_completed',
          payload: { contains: '"kind":"bundle_capacity_assessment"' },
        },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true, payload: true },
      });
      // We used to gate on "assessment newer than latest email_received", but
      // by Phase 2.875 several inbounds have stacked (branch confirms material
      // list, branch will confirm bundle plan, etc.) so that comparison is
      // always false and the engine fell back to the bundler-preview path.
      // The bundler then renders "X moved to Bundle -1" because its proposed
      // plan doesn't carry the surgical-flow material at all.
      //
      // The right gate is just: a bundle_capacity_assessment exists AND any LS
      // exists. Both imply we're in the surgical/preserve flow where bundles
      // are frozen for composition; the bundler-preview path MUST be skipped.
      if (latestAssessment !== null) {
        // Fire the upcoming-changes renderer whenever loading slips EXIST for
        // this SO — not only once they're sent_to_plant. The LS-created-but-
        // not-sent "preserve" flow runs the same surgical assessment, so it
        // must reach this renderer too (bundles are frozen for composition the
        // moment any LS exists).
        const anyLsExists = await prisma.loadingSlip.findFirst({
          where: { salesOrderId: progress.salesOrderId },
          select: { id: true },
        });
        if (anyLsExists) {
          // Decode the verdict's allocations + overflow off the audit payload.
          // The shape was written by `case 'bundle_capacity_assessment':` and
          // mirrors `CapacityVerdict[]` from bundle-capacity.ts.
          type StoredVerdict = {
            material: string;
            verdict: 'fully_allocated' | 'partial_overflow' | 'needs_new_so' | 'allocated_with_new_bundle';
            allocations?: Array<{ kind: 'same_bundle' | 'other_bundle' | 'new_bundle'; bundleId: string | null; kg: number }>;
            overflowKg?: number;
          };
          type StoredDecrease = { material: string; fromQty: number; toQty: number };
          let verdicts: StoredVerdict[] = [];
          let storedDecreases: StoredDecrease[] = [];
          try {
            const parsed = latestAssessment ? JSON.parse(latestAssessment.payload) : null;
            verdicts = Array.isArray(parsed?.verdicts) ? parsed.verdicts : [];
            storedDecreases = Array.isArray(parsed?.decreases) ? parsed.decreases : [];
          } catch {
            verdicts = [];
            storedDecreases = [];
          }

          const allocations = verdicts.flatMap((v) =>
            (v.allocations ?? []).map((a) => ({
              material: v.material,
              kind: a.kind,
              bundleId: a.bundleId,
              kg: a.kg,
            })),
          );
          const overflowItems = verdicts
            .filter((v) => typeof v.overflowKg === 'number' && v.overflowKg > 0)
            .map((v) => ({ material: v.material, overflowKg: v.overflowKg as number }));

          if (allocations.length === 0) {
            log(
              '[ENGINE] email_confirm_bundle_details — post-plant_ls assessment present but allocations empty; ' +
                'segment-completing (planner should have routed to email_branch_request_new_so instead)',
            );
            return 'complete_segment';
          }

          const { sendDispatchConfirmationWithUpcomingChanges } = await import('./auto-gui-trigger');
          await sendDispatchConfirmationWithUpcomingChanges({
            purchaseOrderId: so.purchaseOrderId,
            salesOrderId: progress.salesOrderId,
            allocations,
            overflowItems,
            decreases: storedDecreases,
            log,
          });
          log(
            `[ENGINE] email_confirm_bundle_details — sent post-plant_ls dispatch_confirmation ` +
              `(${allocations.length} allocation(s), overflow=${overflowItems.length}, decrease=${storedDecreases.length})`,
          );
          return 'complete_segment';
        }
      }

      // Recompute the per-material dispatch quantity from scratch on every
      // run: min(orderQuantity, availableStock). Reading a prior round's
      // `dispatchQuantity` here was the source of the cross-round staleness
      // bug — after branch revised orderQuantity 250 → 257, the previous
      // value kept being returned.
      const materials = await prisma.material.findMany({
        where: { salesOrderId: progress.salesOrderId },
      });
      const items = materials
        .map((m) => {
          const qty = Math.min(m.orderQuantity ?? 0, m.availableStock ?? 0);
          return {
            material_code: m.material,
            batch: m.batch ?? '',
            quantity: qty,
            weight_kg: m.orderWeightKg ? Number(m.orderWeightKg) : 0,
          };
        })
        .filter((it) => it.quantity > 0);

      if (items.length === 0) {
        log('[ENGINE] email_confirm_bundle_details — no items with qty>0; segment-completing without email');
        return 'complete_segment';
        await markAwaitingReply(progress.id);
        return 'pause';
      }

      // Persist the freshly computed dispatchQuantity so downstream bundling
      // (`computeBundlesForPo` inside sendDispatchConfirmationEmail) and
      // `fanOutZload1ForPo` read from a stable source.
      for (const m of materials) {
        const qty = Math.min(m.orderQuantity ?? 0, m.availableStock ?? 0);
        if (m.dispatchQuantity !== qty) {
          await prisma.material.update({ where: { id: m.id }, data: { dispatchQuantity: qty } });
        }
      }

      const totalKg = items.reduce((s, it) => s + it.weight_kg, 0);
      const poForCap = await prisma.purchaseOrder.findUnique({
        where: { id: so.purchaseOrderId },
        select: { weightage: true },
      });
      const capacityTonnes = poForCap?.weightage ? Number(poForCap.weightage) : 0;

      const plan = {
        soNumber: so.soNumber,
        salesOrderId: progress.salesOrderId,
        items,
        totalWeightKg: totalKg,
      };

      // Per-PO branch thread anchoring is handled inside sendDispatchConfirmationEmail.
      await sendDispatchConfirmationEmail({
        purchaseOrderId: so.purchaseOrderId,
        plans: [plan],
        twoVehicles: false,
        totalTonnes: totalKg / 1000,
        capacityTonnes,
        log,
      });

      log(`[ENGINE] email_confirm_bundle_details — dispatch_confirmation sent (${items.length} item(s), ${(totalKg / 1000).toFixed(2)}t)`);
      return 'complete_segment';
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
      return 'complete_segment';
      await markAwaitingReply(progress.id);
      return 'pause';
    }

    case 'email_to_plant': {
      // Branch's vehicle-details reply has arrived; persist on the Bundle
      // and forward LS PDFs to the plant. Vehicle details come from the
      // planner step args — no second LLM extractor here.
      const trigger = await loadTriggerReply(progress.id);
      if (!trigger) {
        log('[ENGINE] email_to_plant — no trigger reply; cannot proceed. Aborting.');
        await prisma.scenarioProgress.update({
          where: { id: progress.id },
          data: { state: 'failed', error: 'email_to_plant step but no trigger reply' },
        });
        return 'pause';
      }
      const { coerceVehiclesArgs } = await import('./planner-step-args');
      const vehicles = coerceVehiclesArgs(_plannedStep);
      const { handleVehicleDetailsReply } = await import('./auto-gui-trigger');
      const result = await handleVehicleDetailsReply(
        trigger.emailId,
        trigger.replyHtml,
        progress.salesOrderId,
        { vehicles },
      );
      for (const line of result.logs) log(line);
      return 'complete_segment';
      return 'advance_now';
    }

    case 'email_modified_ls_to_plant': {
      // Two modes, decided by whether the plant has EVER been intimated:
      //
      //  (1) FIRST SEND (no prior plant_ls email exists): the plant has never
      //      seen any LS for this SO — forward the FULL set of LoadingSlips,
      //      not just the touched ones. This is the terminal email of the
      //      LS-created-but-not-sent "preserve" modify flow, where plant_ls
      //      was never sent. (email_to_plant can't be used here — its handler
      //      requires a vehicle-details trigger reply this flow doesn't have.)
      //
      //  (2) FOLLOW-UP (a prior plant_ls exists): post-modification — forward
      //      ONLY the LSs touched by the preceding zload2/zloading_close steps
      //      in THIS plan (each WorkQueue row's meta.ls_number).
      //
      // Neither mode extracts vehicle details (bundles already carry them).
      const priorPlantLs = await prisma.email.findFirst({
        where: {
          salesOrderId: progress.salesOrderId,
          emailType: 'plant_ls',
          status: { in: ['sent', 'replied', 'processed'] },
        },
        select: { id: true },
      });
      const firstSend = !priorPlantLs;

      const progressRow = await prisma.scenarioProgress.findUnique({
        where: { id: progress.id },
        select: { createdAt: true },
      });
      const scenarioStartedAt = progressRow?.createdAt ?? new Date(0);

      let modifiedSlips: Array<{
        id: string;
        salesOrderId: string;
        lsNumber: string;
        fileUrl: string | null;
        bundle: { vehicleNumber: string | null; driverMobile: string | null; containerNumber: string | null } | null;
      }>;

      if (firstSend) {
        // First intimation — send every LS on the SO.
        modifiedSlips = await prisma.loadingSlip.findMany({
          where: { salesOrderId: progress.salesOrderId },
          include: {
            bundle: { select: { vehicleNumber: true, driverMobile: true, containerNumber: true } },
          },
        });
        if (modifiedSlips.length === 0) {
          log('[ENGINE] email_modified_ls_to_plant — first send but no LoadingSlip rows on SO; nothing to forward.');
          return 'advance_now';
        }
        log(`[ENGINE] email_modified_ls_to_plant — FIRST SEND (no prior plant_ls): forwarding ALL ${modifiedSlips.length} LS(s) to plant.`);
      } else {
        // Follow-up — the LSs changed in THIS scenario, which is BOTH:
        //   (a) existing LSs revised by zload2 / zloading_close (keyed by the
        //       planner-supplied meta.ls_number on those work rows), AND
        //   (b) brand-NEW LSs created by a ZLOAD1-APPEND leg (other_bundle /
        //       new_bundle). The append's LS number is assigned by SAP and
        //       returned in the zload1-data callback — it's NOT on the work row
        //       — so we find those by creation time within this scenario.
        // Missing (b) was the bug: an other_bundle increase created a new LS the
        // plant was never told about (only the zload2-revised LS got forwarded).
        const modWork = await prisma.workQueue.findMany({
          where: {
            salesOrderId: progress.salesOrderId,
            step: { in: ['zload2', 'zloading_close'] },
            createdAt: { gte: scenarioStartedAt },
          },
          select: { payload: true },
          orderBy: { createdAt: 'asc' },
        });

        const touchedLsNumbers = new Set<string>();
        for (const w of modWork) {
          try {
            const parsed = JSON.parse(w.payload) as { meta?: { ls_number?: string } };
            const lsNum = parsed.meta?.ls_number;
            if (lsNum) touchedLsNumbers.add(lsNum);
          } catch {
            // ignore — payload should always be valid JSON, but never break
            // the email step over a parse error in a sibling row
          }
        }

        modifiedSlips = await prisma.loadingSlip.findMany({
          where: {
            salesOrderId: progress.salesOrderId,
            OR: [
              ...(touchedLsNumbers.size > 0 ? [{ lsNumber: { in: [...touchedLsNumbers] } }] : []),
              // (b) ZLOAD1-append LS(s) created during this scenario.
              { createdAt: { gte: scenarioStartedAt } },
            ],
          },
          include: {
            bundle: { select: { vehicleNumber: true, driverMobile: true, containerNumber: true } },
          },
        });

        if (modifiedSlips.length === 0) {
          log('[ENGINE] email_modified_ls_to_plant — no revised or newly-appended LS in this scenario; nothing to forward.');
          return 'advance_now';
        }
      }

      const { downloadFromS3 } = await import('./s3');
      const { sendLSEmail } = await import('./email-service');
      const soRow = await prisma.salesOrder.findUnique({
        where: { id: progress.salesOrderId },
        select: { soNumber: true, vehicleNumber: true, driverMobile: true, containerNumber: true },
      });
      const soNumber = soRow?.soNumber ?? '';

      log(`[ENGINE] email_modified_ls_to_plant — forwarding ${modifiedSlips.length} modified LS(s) to plant for SO ${soNumber}: [${modifiedSlips.map((s) => s.lsNumber).join(', ')}]`);

      for (const ls of modifiedSlips) {
        try {
          if (!ls.fileUrl) {
            log(`[ENGINE] email_modified_ls_to_plant — LS ${ls.lsNumber} has no fileUrl; skipping (was /zload2-data missing the PDF persist?)`);
            continue;
          }
          const pdfBuffer = await downloadFromS3(ls.fileUrl);
          const filename = ls.fileUrl.split('/').pop() || `${ls.lsNumber}.pdf`;
          const vehicleForEmail = ls.bundle
            ? {
                vehicleNumber: ls.bundle.vehicleNumber,
                driverMobile: ls.bundle.driverMobile,
                containerNumber: ls.bundle.containerNumber,
              }
            : {
                vehicleNumber: soRow?.vehicleNumber ?? null,
                driverMobile: soRow?.driverMobile ?? null,
                containerNumber: soRow?.containerNumber ?? null,
              };
          const anchorLsi = await prisma.loadingSlipItem.findFirst({
            where: { loadingSlipId: ls.id },
            select: { id: true },
          });
          if (!anchorLsi) {
            log(`[ENGINE] email_modified_ls_to_plant — LS ${ls.lsNumber} has no LSI rows; skipping plant email`);
            continue;
          }
          await sendLSEmail(
            anchorLsi.id,
            ls.salesOrderId,
            soNumber,
            ls.lsNumber,
            pdfBuffer,
            vehicleForEmail,
            filename,
          );
          log(`[ENGINE] email_modified_ls_to_plant — sent revised LS ${ls.lsNumber} to plant`);
        } catch (sendErr) {
          log(`[ENGINE] email_modified_ls_to_plant — failed to send LS ${ls.lsNumber}: ${sendErr instanceof Error ? sendErr.message : String(sendErr)}`);
        }
      }

      return 'complete_segment';
      return 'advance_now';
    }

    case 'process_plant_invoice': {
      // Plant replied with an invoice PDF on plant_ls. The PDF was already
      // uploaded to R2 by the email-reply-checker pre-pass (Email.replyPdfUrl
      // is populated). Fire the batch sender (ZLOAD3-B1) which reads PDFs
      // by SO/bundle.
      //
      // bundleId resolution: the trigger email is the plant_ls reply, which
      // links to a LoadingSlip (Email.loadingSlipId). That LS knows its
      // bundle. For older plant_ls emails that only have loadingSlipItemId,
      // fall back to LSI → LoadingSlip → Bundle.
      const trigger = await loadTriggerReply(progress.id);
      const triggerEmailRow = trigger
        ? await prisma.email.findUnique({
            where: { id: trigger.emailId },
            include: {
              loadingSlip: { select: { bundleId: true } },
              loadingSlipItem: { select: { loadingSlip: { select: { bundleId: true } } } },
            },
          })
        : null;
      const bundleId =
        triggerEmailRow?.loadingSlip?.bundleId ??
        triggerEmailRow?.loadingSlipItem?.loadingSlip?.bundleId ??
        null;
      const { checkAndSendBatchToAman } = await import('./auto-gui-trigger');
      const r = await checkAndSendBatchToAman(progress.salesOrderId, bundleId);
      for (const line of r.logs) log(line);
      return 'advance_now';
    }

    case 'process_tonnage_reply': {
      // Branch replied to a tonnage_inquiry with the vehicle tonnage. The
      // planner reads the reply and emits { tonnage: { value, unit } } on
      // the step; the coercion helper handles kg→t conversion.
      const so = await prisma.salesOrder.findUnique({
        where: { id: progress.salesOrderId },
        select: { purchaseOrderId: true, soNumber: true },
      });
      if (!so?.purchaseOrderId) {
        log(`[ENGINE] process_tonnage_reply — SO ${progress.salesOrderId} has no purchaseOrderId.`);
        return 'advance_now';
      }

      const { coerceTonnageArgs } = await import('./planner-step-args');
      const tonnes = coerceTonnageArgs(_plannedStep);

      await prisma.purchaseOrder.update({
        where: { id: so.purchaseOrderId },
        data: { weightage: tonnes },
      });
      log(`[ENGINE] process_tonnage_reply — set po.weightage=${tonnes} t for PO ${so.purchaseOrderId} (SO ${so.soNumber})`);

      // ─── Auto-resume the PO ───────────────────────────────────────────
      // Tonnage is a PO-level unblock. There are two possible held states
      // depending on when the branch finally answered:
      //
      //   (A) ZSO-VISIBILITY was DEFERRED at NEW ORDER time (strict gate
      //       in checkForNewEmails). SalesOrders are still in
      //       visibilityState='queued'. Fire ZSO-VISIBILITY now — the rest
      //       of the flow follows naturally.
      //
      //   (B) ZSO-VISIBILITY already ran (older NEW ORDERs predating the
      //       strict gate, or partial-PO replays), ls_dispatch was replied
      //       to, but dispatch_confirmation never went out because the
      //       bundler had no tonnage. Re-fire dispatch_confirmation.
      //
      // Both blocks are no-ops when their predicate doesn't match, so the
      // overall handler is idempotent.
      try {
        // (A) Fire any deferred ZSO-VISIBILITY.
        const queuedSos = await prisma.salesOrder.findMany({
          where: { purchaseOrderId: so.purchaseOrderId, visibilityState: 'queued' },
          select: { id: true, soNumber: true },
          orderBy: { createdAt: 'asc' },
        });
        if (queuedSos.length > 0) {
          const { triggerZsoVisibility } = await import('./auto-gui-trigger');
          for (const qso of queuedSos) {
            await prisma.salesOrder.update({
              where: { id: qso.id },
              data: { visibilityState: 'firing' },
            });
            try {
              await triggerZsoVisibility(qso.soNumber);
              log(`[ENGINE] auto-resume: enqueued deferred ZSO-VISIBILITY for SO ${qso.soNumber}`);
            } catch (visErr) {
              log(
                `[ENGINE] auto-resume: ZSO-VISIBILITY enqueue failed for SO ${qso.soNumber}: ${visErr instanceof Error ? visErr.message : String(visErr)}`
              );
            }
          }
        }
      } catch (resumeErr) {
        log(
          `[ENGINE] auto-resume (visibility) failed for PO ${so.purchaseOrderId}: ${resumeErr instanceof Error ? resumeErr.message : String(resumeErr)}`
        );
      }

      // (B) Re-fire dispatch_confirmation for any SO whose ls_dispatch was
      //     already replied to but never produced a dispatch_confirmation
      //     (because the bundler bailed on the missing weightage).
      try {
        const po = await prisma.purchaseOrder.findUnique({
          where: { id: so.purchaseOrderId },
          select: {
            id: true,
            poNumber: true,
            dispatchRound: true,
            salesOrders: { select: { id: true, soNumber: true, releasePlan: true } },
          },
        });
        if (po) {
          const currentRound = po.dispatchRound ?? 1;
          const { sendDispatchConfirmationEmail } = await import('./auto-gui-trigger');

          // Find ls_dispatch replies + dispatch_confirmation sends, per SO.
          for (const sibling of po.salesOrders) {
            const lsDispatchReplied = await prisma.email.findFirst({
              where: {
                purchaseOrderId: po.id,
                emailType: 'ls_dispatch',
                status: 'replied',
                dispatchRound: currentRound,
              },
              orderBy: { sentAt: 'desc' },
              select: { id: true, gmailThreadId: true, gmailMessageId: true },
            });
            if (!lsDispatchReplied) continue;

            const dcSent = await prisma.email.findFirst({
              where: {
                salesOrderId: sibling.id,
                emailType: 'dispatch_confirmation',
                status: { in: ['sent', 'replied'] },
                dispatchRound: currentRound,
              },
              select: { id: true },
            });
            if (dcSent) continue;

            // Reconstruct the plan from the SO's stored releasePlan (set
            // when ls_dispatch was originally assembled).
            if (!sibling.releasePlan) {
              log(`[ENGINE] auto-resume: SO ${sibling.soNumber} has no releasePlan — skipping`);
              continue;
            }
            let plan: import('./auto-gui-trigger').SoReleasePlan;
            try {
              plan = JSON.parse(sibling.releasePlan);
            } catch {
              log(`[ENGINE] auto-resume: SO ${sibling.soNumber} releasePlan JSON invalid — skipping`);
              continue;
            }
            const totalTonnes = (plan.totalWeightKg ?? 0) / 1000;

            log(`[ENGINE] auto-resume: re-firing dispatch_confirmation for SO ${sibling.soNumber} (tonnage now ${tonnes} t)`);
            await sendDispatchConfirmationEmail({
              purchaseOrderId: po.id,
              plans: [plan],
              twoVehicles: false,
              totalTonnes,
              capacityTonnes: tonnes,
              log,
            });
          }
        }
      } catch (resumeErr) {
        log(
          `[ENGINE] auto-resume after tonnage failed for PO ${so.purchaseOrderId}: ${resumeErr instanceof Error ? resumeErr.message : String(resumeErr)}`
        );
        // Auto-resume is best-effort. The next inbound on any sibling SO
        // will trigger a fresh planner cycle that sees the now-set tonnage
        // and emits dispatch_confirmation again.
      }

      return 'advance_now';
    }

    case 'email_2nd_release': {
      // Ask the BRANCH to perform the second release after the post-VA02
      // plan. The planner emits the modification list as step args (read
      // from the email thread). Overflow (if any) was already acknowledged
      // by the branch upstream via email_branch_overflow_request (Rule 6e
      // Phase 1.5); no need to repeat it here.
      const { coerceEmailMaterialsArgs } = await import('./planner-step-args');
      const summary = coerceEmailMaterialsArgs(_plannedStep, 'email_2nd_release');
      // sendSecondReleaseEmail expects EmailMaterialMod[] shape:
      // { material_code, batch, operation, quantity }
      const modifications: EmailMaterialMod[] = summary.map((m) => ({
        material_code: m.material_code,
        batch: '',
        operation: m.operation === 'inc' ? 'increase' : m.operation === 'dec' ? 'decrease' : 'delete',
        quantity: m.quantity,
      }));
      await sendSecondReleaseEmail({
        salesOrderId: progress.salesOrderId,
        modifications,
        log,
      });
      return 'complete_segment';
      await markAwaitingReply(progress.id);
      return 'pause';
    }

    case 'email_to_branch_notifying_plant_change': {
      // R46-R51 — branch needs to ack plant-proposed modifications before we
      // touch SAP. Plant's proposed materials come from the planner step args.
      const { coerceEmailMaterialsArgs } = await import('./planner-step-args');
      const summary = coerceEmailMaterialsArgs(_plannedStep, 'email_to_branch_notifying_plant_change');
      const modifications: EmailMaterialMod[] = summary.map((m) => ({
        material_code: m.material_code,
        batch: '',
        operation: m.operation === 'inc' ? 'increase' : m.operation === 'dec' ? 'decrease' : 'delete',
        quantity: m.quantity,
      }));
      await sendPlantChangeNotificationEmail({
        salesOrderId: progress.salesOrderId,
        modifications,
        log,
      });
      return 'complete_segment';
      await markAwaitingReply(progress.id);
      return 'pause';
    }

    case 'email_order_status': {
      // R9 — Seeking Order Update auto-reply. Per-PO branch thread anchoring
      // is handled inside sendOrderStatusEmail.
      await sendOrderStatusEmail({
        salesOrderId: progress.salesOrderId,
        log,
      });
      return 'complete_segment';
      return 'advance_now';
    }

    // -------- planner-authored questions: clarification + supervisor --------
    case 'email_clarify_branch':
    case 'email_clarify_plant':
    case 'email_supervisor_question': {
      // The planner wrote the exact question on the PlannedStep itself.
      // We never re-author or paraphrase it.
      const question = (_plannedStep?.question ?? '').trim();
      if (!question) {
        log(`[ENGINE] ${step.kind} — planner emitted this step without a question. Marking failed.`);
        await prisma.scenarioProgress.update({
          where: { id: progress.id },
          data: { state: 'failed', error: `${step.kind} step had empty question` },
        });
        return 'pause';
      }

      // sendPlannerQuestionEmail anchors on the per-PO stakeholder thread
      // internally — no external thread anchor needed. Look up the trigger
      // only so we can pass its id for audit purposes.
      const trigger = await prisma.scenarioProgress.findUnique({
        where: { id: progress.id },
        select: { triggerEmailId: true },
      });
      const triggerEmail = trigger?.triggerEmailId
        ? await prisma.email.findUnique({
            where: { id: trigger.triggerEmailId },
            select: { id: true },
          })
        : null;

      let recipients: string[];
      let recipientRole: 'branch' | 'plant' | 'supervisor';
      let emailType: 'branch_clarify' | 'plant_clarify' | 'supervisor_question';
      if (step.kind === 'email_clarify_branch') {
        recipients = [process.env.BRANCH_EMAIL || ''];
        recipientRole = 'branch';
        emailType = 'branch_clarify';
      } else if (step.kind === 'email_clarify_plant') {
        recipientRole = 'plant';
        emailType = 'plant_clarify';
        // An SO/PO can span MULTIPLE plants (each loading slip has its own
        // plantEmail). A clarification must reach EVERY distinct plant, not
        // just the env fallback — mirror the per-plant fan-out that
        // email_modified_ls_to_plant / sendLSEmail already do. Fall back to
        // PLANT_EMAIL only when no loading slips exist yet (pre-LS clarify).
        const so = await prisma.salesOrder.findUnique({
          where: { id: progress.salesOrderId },
          select: { purchaseOrderId: true },
        });
        const lsRows = so?.purchaseOrderId
          ? await prisma.loadingSlip.findMany({
              where: { salesOrder: { purchaseOrderId: so.purchaseOrderId } },
              select: { plantEmail: true },
            })
          : [];
        const distinctPlants = [
          ...new Set(lsRows.map((r) => r.plantEmail).filter((e): e is string => !!e)),
        ];
        recipients = distinctPlants.length > 0 ? distinctPlants : [process.env.PLANT_EMAIL || ''];
        if (distinctPlants.length > 1) {
          log(`[ENGINE] email_clarify_plant — fanning out to ${distinctPlants.length} distinct plants`);
        }
      } else {
        recipients = [process.env.SUPERVISOR_EMAIL || 'amanrai369@gmail.com'];
        recipientRole = 'supervisor';
        emailType = 'supervisor_question';
      }

      // When fanning out to >1 plant, each must get its own fresh thread — the
      // per-PO "plant" anchor is a single thread and would otherwise funnel them
      // all into one plant's conversation.
      const multiPlant = recipientRole === 'plant' && recipients.length > 1;
      for (const recipient of recipients) {
        await sendPlannerQuestionEmail({
          recipient,
          recipientRole,
          salesOrderId: progress.salesOrderId,
          triggerEmailId: triggerEmail?.id ?? '',
          question,
          options: _plannedStep?.options,
          emailType,
          log,
          freshThread: multiPlant,
        });
      }

      // Pause until the recipient replies. The cron's reply-checker will
      // pick up their reply (status='sent', workflowState='awaiting_reply')
      // and route it back through handleReplyV2 → planNextSteps, which now
      // sees the question + answer in the thread.
      return 'complete_segment';
      await markAwaitingReply(progress.id);
      return 'pause';
    }

    case 'email_branch_overflow_request': {
      // Rule 6e Phase 1.5 — bundle_capacity_assessment returned
      // partial_overflow (or needs_new_so) for at least one material AND
      // the planner wants the branch to acknowledge the partial dispatch
      // BEFORE we touch SAP. Sends a "partial dispatch, please confirm"
      // email showing the placed vs overflow split per material. Branch
      // reply lands as a normal Email row + email_received audit event;
      // the planner picks it up via Rule 6e Phase 1.6 on the next plan
      // call and decides confirm → Phase 2 / revise → Phase 1 / ambiguous
      // → clarify.
      const { coerceBranchOverflowArgs } = await import('./planner-step-args');
      const { sendBranchOverflowRequestEmail } = await import('./branch-overflow-request-email');
      const { items, resolution } = coerceBranchOverflowArgs(_plannedStep);
      await sendBranchOverflowRequestEmail({
        salesOrderId: progress.salesOrderId,
        items,
        resolution,
        log,
      });
      log(`[ENGINE] email_branch_overflow_request — sent for ${items.length} item(s) (resolution=${resolution}); awaiting branch reply`);
      return 'complete_segment';
      await markAwaitingReply(progress.id);
      return 'pause';
    }

    case 'email_branch_request_new_so': {
      // Terminal step on the post-plant-intimation no-capacity path. Tells
      // the branch the requested increase doesn't fit and asks them to
      // raise a new SO for the overflow.
      const { coerceBranchNewSoArgs } = await import('./planner-step-args');
      const { sendBranchRequestNewSoEmail } = await import('./branch-new-so-email');
      const overflow = coerceBranchNewSoArgs(_plannedStep);
      const trigger = await prisma.scenarioProgress.findUnique({
        where: { id: progress.id },
        select: { triggerEmailId: true },
      });
      await sendBranchRequestNewSoEmail({
        salesOrderId: progress.salesOrderId,
        triggerEmailId: trigger?.triggerEmailId ?? '',
        overflow,
        log,
      });
      await prisma.scenarioProgress.update({
        where: { id: progress.id },
        data: { state: 'completed' },
      });
      log(`[ENGINE] email_branch_request_new_so — sent for ${overflow.length} overflow item(s); scenario completed`);
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

/**
 * Pull the SAP transaction's persisted output for a just-completed step so we
 * can surface it in the `step_completed` audit event. Returns null when the
 * step kind has no captured SAP output (email steps, sentinels, etc.) — the
 * caller leaves `sap_output` off the payload in that case.
 *
 * Important: these reads are best-effort. If a DB lookup fails or the SAP
 * fields are still null (race), we return null and the audit event still
 * records the step as completed without the output blob.
 */
async function collectSapOutputForStep(
  salesOrderId: string,
  stepKind: StepKind,
): Promise<Record<string, unknown> | null> {
  try {
    switch (stepKind) {
      case 'zload1': {
        // ZLOAD1 creates LoadingSlipItems. Surface the LS numbers + per-LSI
        // material+quantity so the audit reads like "LS-12345 created with M-A=100".
        const lsis = await prisma.loadingSlipItem.findMany({
          where: { salesOrderId, lsNumber: { not: '' } },
          select: { lsNumber: true, material: true, orderQuantity: true },
          orderBy: { createdAt: 'desc' },
          take: 10,
        });
        if (lsis.length === 0) return null;
        return {
          ls_count: lsis.length,
          loading_slips: lsis.map((l) => ({
            ls: l.lsNumber,
            material: l.material,
            quantity: l.orderQuantity,
          })),
        };
      }
      case 'zload2':
      case 'zloading_close': {
        // Revised quantities live on LSI as well. Surface a compact summary.
        const lsis = await prisma.loadingSlipItem.findMany({
          where: { salesOrderId },
          select: { lsNumber: true, material: true, orderQuantity: true, status: true },
          orderBy: { updatedAt: 'desc' },
          take: 10,
        });
        if (lsis.length === 0) return null;
        return {
          ls_count: lsis.length,
          loading_slips: lsis.map((l) => ({
            ls: l.lsNumber,
            material: l.material,
            quantity: l.orderQuantity,
            status: l.status,
          })),
        };
      }
      case 'va02': {
        // VA02 updates Material.dispatchQuantity. Surface the post-change values.
        const mats = await prisma.material.findMany({
          where: { salesOrderId },
          select: { material: true, batch: true, orderQuantity: true, dispatchQuantity: true },
          take: 10,
        });
        if (mats.length === 0) return null;
        return {
          materials: mats.map((m) => ({
            material: m.material,
            batch: m.batch,
            ordered: m.orderQuantity,
            dispatch: m.dispatchQuantity,
          })),
        };
      }
      case 'zso_visibility': {
        // ZSO-VISIBILITY refreshes Material.availableStock. Surface the
        // updated availability.
        const mats = await prisma.material.findMany({
          where: { salesOrderId },
          select: { material: true, availableStock: true, orderQuantity: true },
          take: 10,
        });
        if (mats.length === 0) return null;
        return {
          materials: mats.map((m) => ({
            material: m.material,
            ordered: m.orderQuantity,
            available: m.availableStock,
          })),
        };
      }
      case 'await_plant_invoice': {
        // ZLOAD3+ZSO_Auto creates the Invoice row. Surface its identifiers.
        const inv = await prisma.invoice.findUnique({
          where: { salesOrderId },
          select: { invoiceNumber: true, obdNumber: true, amount: true },
        });
        if (!inv) return null;
        return {
          invoice_number: inv.invoiceNumber,
          obd_number: inv.obdNumber,
          amount: inv.amount?.toString() ?? null,
        };
      }
      case 'await_vt01n': {
        // VT01N creates Shipment rows. Surface their statuses.
        const shipments = await prisma.shipment.findMany({
          where: { salesOrderId },
          select: { obdNumber: true, status: true, shipmentTriggeredAt: true },
          orderBy: { createdAt: 'desc' },
          take: 5,
        });
        if (shipments.length === 0) return null;
        return {
          shipment_count: shipments.length,
          shipments: shipments.map((s) => ({
            obd: s.obdNumber,
            status: s.status,
            triggered_at: s.shipmentTriggeredAt?.toISOString() ?? null,
          })),
        };
      }
      default:
        return null;
    }
  } catch {
    // SAP-output capture is best-effort; never break the engine if a DB read
    // throws. The step still emits step_completed without the output blob.
    return null;
  }
}

export async function advanceScenario(salesOrderId: string): Promise<void> {
  const progress = await prisma.scenarioProgress.findFirst({
    where: {
      salesOrderId,
      state: { notIn: ['completed', 'aborted', 'failed'] },
    },
    orderBy: { createdAt: 'desc' },
  });
  if (!progress) return;

  const plan = readPlanFromProgress(progress);

  // Emit step_completed for the step that just finished (the one at the
  // current index BEFORE we increment).
  const completedStep = plan.steps[progress.currentStepIndex];
  if (completedStep) {
    const { emitEvent } = await import('./scenario-events');
    const sapOutput = await collectSapOutputForStep(salesOrderId, completedStep.kind);
    await emitEvent({
      salesOrderId,
      scenarioProgressId: progress.id,
      type: 'step_completed',
      payload: {
        step_index: progress.currentStepIndex,
        kind: completedStep.kind,
        scenario_key: progress.scenarioKey,
        ...(sapOutput ? { sap_output: sapOutput } : {}),
      },
    });
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

  const plan = readPlanFromProgress(progress);
  const currentStep = plan.steps[progress.currentStepIndex];
  if (!currentStep) return;

  // Guard: workStep, if provided, must match the StepKind of the current step.
  if (workStep) {
    const expected = STEP_TO_WORK_STEP[currentStep.kind];
    if (expected && expected !== workStep) {
      // Not the step we're waiting on — ignore.
      return;
    }
  }

  // Multi-fire barrier: a SINGLE engine step can enqueue MORE THAN ONE WorkQueue
  // row — zload2 and zloading_close fire one row per loading slip, so a modify
  // that touches materials on different LSs of the same bundle fans out into
  // several SAP transactions. Each row's completion calls back here, but the
  // step is only truly finished when EVERY one of its rows is done. Advancing on
  // the FIRST callback lets the next step read half-applied SAP state — the
  // reported bug: the vehicle-details email ran between the two zload2 callbacks
  // and printed a bundle weight that counted the increased LS but not yet the
  // decreased one (~11.44 t instead of ~10.78 t).
  //
  // So: while any sibling row for this SO + step is still queued/firing, hold —
  // the LAST row's callback finds none pending and advances. The just-completed
  // row is already `done` (markDone runs before this in /step-status), so it is
  // not counted. This relies on auto_gui2 posting the data callback
  // (e.g. /zload2-data, which reconciles LSIs + recomputes Bundle.totalWeightKg)
  // BEFORE the step-status 'done' webhook — the same ordering the zload1
  // vehicle-email gate already depends on — so "all rows done" ⇒ "all data
  // reconciled". Single-fire and sentinel steps (va02, await_vt01n, …) have ≤1
  // matching row, so this is a harmless no-op for them.
  const barrierStep = STEP_TO_WORK_STEP[currentStep.kind];
  if (barrierStep) {
    const pending = await prisma.workQueue.count({
      where: {
        salesOrderId,
        step: barrierStep,
        state: { in: ['queued', 'firing'] },
      },
    });
    if (pending > 0) {
      console.log(
        `[ENGINE] maybeAdvanceScenario — ${currentStep.kind} for SO ${salesOrderId} still has ` +
          `${pending} ${barrierStep} transaction(s) in flight; holding until all complete`,
      );
      return;
    }
  }

  await advanceScenario(salesOrderId);
}

/**
 * Re-enter the planner from scratch after an engine-only step (one that fetches
 * data and completes WITHOUT sending an outbound email) finishes.
 *
 * The engine's segmented model assumes every plan ends in an outbound email, so
 * the NEXT inbound re-drives the planner. But a data-fetch step like
 * `lone_zmatana` ends a plan with no email — and the branch has already replied,
 * so no inbound is coming. The flow would park forever. This bridges that gap:
 * once the fetch's callback has persisted its data and emitted `step_completed`,
 * we replay the original trigger email through handleReplyV2 so the planner sees
 * the new audit state and emits the next phase (e.g. Rule 6e Phase 2.75 →
 * email_confirm_bundle_details).
 *
 * No-op unless the SO's latest scenario is `completed` (the fetch plan just
 * finished) and we can resolve the trigger reply. Idempotent enough: the
 * planner reads the audit trail and will only emit steps not already present.
 */
export async function replanAfterEngineFetch(
  salesOrderId: string | null | undefined,
): Promise<void> {
  if (!salesOrderId) return;
  if (!isScenarioEngineEnabled()) return;

  // The fetch plan should have just completed. If a non-terminal plan is still
  // in flight, leave it alone — maybeAdvanceScenario owns that case.
  const inFlight = await prisma.scenarioProgress.findFirst({
    where: { salesOrderId, state: { notIn: ['completed', 'aborted', 'failed'] } },
    select: { id: true },
  });
  if (inFlight) return;

  const latest = await prisma.scenarioProgress.findFirst({
    where: { salesOrderId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, state: true, generatedSteps: true, stopAfterIndex: true },
  });
  if (!latest || latest.state !== 'completed') return;

  // Don't re-plan while a SAP transaction for this SO is still in-flight — WAIT
  // for its response (its own callback drives the re-plan once the data lands).
  // Re-planning mid-transaction is what re-generated the same step in a loop.
  const inFlightWork = await prisma.workQueue.findFirst({
    where: { salesOrderId, state: { in: ['queued', 'firing'] } },
    select: { id: true, step: true, state: true },
  });
  if (inFlightWork) {
    console.log(
      `[ENGINE] replanAfterEngineFetch — SAP work ${inFlightWork.step} still ${inFlightWork.state} for SO ${salesOrderId}; waiting for its response (not re-planning)`,
    );
    return;
  }

  // Don't re-plan if the just-completed plan ENDED with an outbound email — the
  // engine is correctly paused for the branch/plant reply, which will re-drive
  // the planner. Only bridge a re-plan when the plan ended on a (completed)
  // non-email SAP/engine-fetch step — the case this function exists for.
  if (planEndsWithOutboundEmail(readPlanFromProgress(latest).steps)) {
    console.log(
      `[ENGINE] replanAfterEngineFetch — last plan ended with an outbound email for SO ${salesOrderId}; waiting for the reply (not re-planning)`,
    );
    return;
  }

  const trigger = await loadTriggerReply(latest.id);
  if (!trigger) {
    console.warn(`[ENGINE] replanAfterEngineFetch — no trigger reply for SO ${salesOrderId}; cannot re-plan`);
    return;
  }

  console.log(`[ENGINE] replanAfterEngineFetch — re-entering handleReplyV2 for SO ${salesOrderId} after engine fetch`);
  const r = await handleReplyV2({
    emailId: trigger.emailId,
    replyHtml: trigger.replyHtml,
    originalEmailHtml: '',
    sourceEmailType: trigger.sender === 'production' ? 'branch' : trigger.sender,
  });
  for (const line of r.logs) console.log(line);
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
