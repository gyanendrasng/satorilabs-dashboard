/**
 * Scenario registry — the deterministic lookup table that maps
 *   (emailType, stage, intent, modification?) → ordered step list
 *
 * The classifier returns intent+modification; deriveStage() returns stage from
 * DB state. The scenario engine looks up the matching Scenario here and walks
 * its `steps` one external event at a time (SAP /step-status callback, email
 * reply, plant invoice arrival, VT01N UI click).
 *
 * Each row in Intent_Classification.xlsx (in-scope subset) maps to one entry
 * in SCENARIOS. The trigger-mapping table in the plan documents the StepKind
 * → existing trigger function correspondence.
 */
import { prisma } from './prisma';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export type ScenarioEmailType = 'branch' | 'plant';

export type Stage =
  | 'before_ls'                   // visibility done OR pending; no LS files yet
  | 'after_ls_before_invoice'     // LS files exist, vehicle not yet placed
  | 'after_vehicle_placement'     // Bundle.vehicleNumber set; no plant_ls email yet
  | 'after_email_to_plant'        // plant_ls email sent; no plant invoice yet
  | 'after_plant_invoice'         // plant invoice received; VT01N pending or done
  | 'after_invoice'               // shipment phase (back-compat alias)
  | 'anytime';                    // Anytime intents (Seeking Order Update, Others)

export type Intent =
  | 'release_all'
  | 'release_part'
  | 'wait'
  | 'modify'
  | 'new_so'                      // R4 — NEW ORDER inbound
  | '2nd_release'                 // R5, R6 — branch confirms 2nd release
  | 'discount_confirm'            // R7 — branch acks discount code
  | 'clarify_weight'              // R8 — vehicle weight clarification
  | 'vehicle_details'             // R10 — branch shares vehicle details
  | 'status_update'               // R9 — Seeking Order Update
  | 'other'                       // R11, R45 — catch-all → escalate
  | 'invoice_sent';               // R44 — plant invoice arrival

export type Modification =
  | 'increase' | 'decrease' | 'delete'
  | 'inc_dec'  | 'inc_del'  | 'dec_del';

export type StepKind =
  // ZSO_Visibility + Zmatana — single step (Zmatana is part of the auto_gui2
  // ZSO-VISIBILITY pipeline, not a separate transaction).
  | 'zso_visibility'                  // triggerZsoVisibility
  // ZMatana standalone — fetches batch + availability for a specific material
  // code WITHOUT re-running ZSO_Visibility. Used after stock_precheck
  // substitutes a short material with a cross-plant equivalent.
  | 'lone_zmatana'                    // triggerLoneZmatana
  // Free-stock pre-check against the synced inventory_snapshot DB. Replaces
  // the spreadsheet's "Zmatana" Step 2 for increase-shaped modifications:
  // short → email branch & abort scenario; sufficient → advance to VA02.
  | 'stock_precheck'
  // Post-plant-intimation guard. After plant_ls has been sent, bundles are
  // frozen — LSIs cannot migrate between bundles. This step is a pure
  // arithmetic helper (no SAP call) that decides, per material delta,
  // whether the increase fits in the current bundle (→ zload2), an alternate
  // bundle (→ zload1 in append mode), or no bundle at all (→ ask branch to
  // raise a new SO). The planner reads the verdict from the audit trail.
  | 'bundle_capacity_assessment'
  | 'va02'                            // triggerVa02
  | 'mb51'                            // daily FCFS reactivator — wait intent step
  | 'zload1'                          // triggerZload1 (via dispatch-confirmation path)
  | 'zload2'                          // triggerZload2
  | 'zloading_close'                  // triggerZloadingClose (== ZLOAD_Delete)
  | 'email_2nd_release'               // NEW — sendSecondReleaseEmail
  | 'email_confirm_product_details'   // reuse assembleAndSendCombinedEmail (ls_dispatch)
  | 'email_confirm_bundle_details'    // reuse sendDispatchConfirmationEmail
  | 'email_to_branch_for_vehicle'     // reuse sendCombinedVehicleDetailsEmailForPo
  | 'email_to_plant'                  // reuse sendLSEmail (per-LSI). Vehicle-details path: forwards EVERY LS of the affected bundles.
  | 'email_modified_ls_to_plant'      // Post-modification: forward ONLY the LSs touched by the preceding zload2 / zloading_close steps. Does NOT extract vehicle details.
  | 'email_to_branch_notifying_plant_change'  // NEW — sendPlantChangeNotificationEmail (R46-R51)
  | 'email_order_status'              // NEW — sendOrderStatusEmail (R9 Seeking Order Update auto-reply)
  // Planner-authored questions. Each carries its question text (and, for the
  // supervisor variant, a list of options the planner is weighing) on the
  // PlannedStep itself. The executor sends the email, persists it in 'sent'
  // status so the cron polls the thread, and pauses the scenario; the reply
  // re-enters handleReplyV2 like any other inbound and lets the planner act
  // on the clarification.
  | 'email_clarify_branch'            // Ask BRANCH to clarify an ambiguous / incomplete reply
  | 'email_clarify_plant'             // Ask PLANT to clarify an ambiguous / incomplete reply
  | 'email_supervisor_question'       // Ask the SUPERVISOR which option to pursue when stuck
  // Rule 6e Phase 1.5 — bundle_capacity_assessment returned overflow; ask the
  // branch to opt in to a partial dispatch + raise a new SO for the spill
  // BEFORE we touch SAP. Non-terminal: the branch's reply re-enters Phase 1.6.
  | 'email_branch_overflow_request'
  // Tells the branch their post-plant increase cannot be accommodated within
  // the existing bundle plan and asks them to raise a new SO for the
  // overflow. Terminal (the new SO arrives as a fresh NEW ORDER email).
  | 'email_branch_request_new_so'
  | 'process_plant_invoice'           // plant replied with invoice PDF → checkAndSendBatchToAman
  | 'process_tonnage_reply'           // branch replied to tonnage_inquiry → extract tonnage, write to PO.weightage
  | 'await_plant_invoice'             // sentinel — engine pauses; plant reply advances it
  | 'await_vt01n';                    // sentinel — engine pauses; VT01N enqueue advances it

export interface Step {
  kind: StepKind;
  label?: string;
  awaitsCallback?: boolean;     // SAP step — pause until /step-status reports done
  awaitsBranchReply?: boolean;  // email step — pause until branch/plant replies
}

// -----------------------------------------------------------------------------
// Outbound-email step kinds — the steps that send a message to branch/plant and
// then pause for a reply. The engine's segmented model assumes every generated
// plan ENDS on one of these (so the next inbound re-drives the planner). Used to
// decide, after an engine-fetch step completes, whether to re-plan (plan ended
// on a non-email fetch step → bridge a re-plan) or wait for a reply (plan ended
// on an email → do nothing). See replanAfterEngineFetch in scenario-engine.ts.
// -----------------------------------------------------------------------------
export const OUTBOUND_EMAIL_KINDS: ReadonlySet<StepKind> = new Set<StepKind>([
  'email_2nd_release',
  'email_confirm_product_details',
  'email_confirm_bundle_details',
  'email_to_branch_for_vehicle',
  'email_to_plant',
  'email_modified_ls_to_plant',
  'email_to_branch_notifying_plant_change',
  'email_order_status',
  'email_clarify_branch',
  'email_clarify_plant',
  'email_supervisor_question',
  'email_branch_overflow_request',
  'email_branch_request_new_so',
]);

/** True when the plan's LAST step sends an outbound email (a wait-for-reply
 *  boundary). Empty plans → false. */
export function planEndsWithOutboundEmail(steps: ReadonlyArray<{ kind: StepKind }>): boolean {
  if (steps.length === 0) return false;
  return OUTBOUND_EMAIL_KINDS.has(steps[steps.length - 1].kind);
}

export interface Scenario {
  key: string;
  description: string;
  steps: Step[];
}

// -----------------------------------------------------------------------------
// Lookup key helpers
// -----------------------------------------------------------------------------

export function scenarioKey(
  emailType: ScenarioEmailType,
  stage: Stage,
  intent: Intent,
  modification: Modification | undefined,
): string {
  return `${emailType}|${stage}|${intent}|${modification ?? '-'}`;
}

// -----------------------------------------------------------------------------
// SCENARIOS registry — REMOVED.
//
// The sheet-driven scenario registry has been replaced by the LLM planner
// (src/lib/llm-planner.ts). On each inbound email, the planner emits a step
// list directly; no scenario_key lookup is performed. The Scenario / Step /
// StepKind / Stage / Intent / Modification types are still exported because
// the engine and planner share that vocabulary.
//
// `deriveStage` is retained because it remains useful as a contextual signal
// in the planner's user prompt (and is still surfaced in audit/dashboard).
// -----------------------------------------------------------------------------


// -----------------------------------------------------------------------------
// deriveStage — pure function on DB state. The three buckets are detected from
// SalesOrder.status + presence of LoadingSlipItem.fileUrl + Shipment.status,
// matching the predicates documented in the plan.
// -----------------------------------------------------------------------------

export async function deriveStage(salesOrderId: string): Promise<Stage> {
  // Pull the minimum we need in one go. The triage logic is in-process to
  // keep it auditable; if performance ever matters this can be replaced
  // with raw SQL.
  //
  // The 7 stages cascade top-to-bottom — first match wins. Each check looks
  // for evidence that the SO has progressed past that milestone.
  const so = await prisma.salesOrder.findUnique({
    where: { id: salesOrderId },
    select: {
      status: true,
      // "LS exists" = at least one LoadingSlip row created by /zload1-data.
      loadingSlips: {
        select: { id: true },
        take: 1,
      },
      // VT01N evidence — shipment row in a post-create status.
      shipments: {
        select: { status: true },
        where: { status: { in: ['shipment-triggered', 'shipped'] } },
        take: 1,
      },
      // Plant invoice arrival — a real Invoice row (1:1 with SO).
      invoice: { select: { id: true } },
      // Vehicle placement is captured per-Bundle on the parent PurchaseOrder.
      // Any bundle with a vehicleNumber means the branch has shared transport
      // for at least one truck on this PO.
      purchaseOrder: {
        select: {
          bundles: {
            select: { vehicleNumber: true },
            where: { vehicleNumber: { not: null } },
            take: 1,
          },
        },
      },
      // plant_ls email outbound = "LS forwarded to plant". The presence of
      // a sent row signals we've moved past After-Vehicle-Placement.
      emails: {
        select: { id: true, emailType: true, status: true },
        where: { emailType: 'plant_ls' },
      },
    },
  });

  if (!so) {
    // Caller bug; default to the safest stage so we don't accidentally pick a
    // post-LS scenario for a non-existent SO.
    return 'before_ls';
  }

  // Stage 7 (terminal) — VT01N completed OR SO marked completed.
  if (
    so.shipments.length > 0 ||
    so.status === 'in-progress' ||
    so.status === 'completed'
  ) {
    return 'after_invoice';
  }

  // Stage 6 — plant invoice arrived (Invoice row created by ZLOAD3
  // processing-data callback), VT01N not yet done. We don't treat a
  // plant_ls reply as proof of invoice arrival because the reply could be
  // a modification request instead.
  if (so.invoice) {
    return 'after_plant_invoice';
  }

  // Stage 5 — plant_ls email is out the door, awaiting plant invoice.
  const plantLsSent = so.emails.find((e) => e.status === 'sent');
  if (plantLsSent) {
    return 'after_email_to_plant';
  }

  // Stage 4 — at least one bundle on the parent PO has a vehicleNumber, but
  // we haven't yet forwarded the LS to the plant.
  if ((so.purchaseOrder?.bundles?.length ?? 0) > 0) {
    return 'after_vehicle_placement';
  }

  // Stage 3 — LoadingSlip row(s) exist (ZLOAD1 ran), but no vehicle yet.
  if (so.status === 'ls_created' && so.loadingSlips.length > 0) {
    return 'after_ls_before_invoice';
  }

  // Stage 1 — nothing has happened beyond the NEW ORDER intake.
  // ('anytime' is never DB-derived; the classifier picks it when an email
  // matches an Anytime intent regardless of computed stage.)
  return 'before_ls';
}

