/**
 * Scenario registry — the deterministic lookup table that maps
 *   (emailType, stage, intent, modification?) → ordered step list
 *
 * The classifier returns intent+modification; deriveStage() returns stage from
 * DB state. The scenario engine looks up the matching Scenario here and walks
 * its `steps` one external event at a time (SAP /step-status callback, email
 * reply, plant invoice arrival, VT01N UI click).
 *
 * Each row in Intent Classification.xlsx (in-scope subset) maps to one entry
 * in SCENARIOS. The trigger-mapping table in the plan documents the StepKind
 * → existing trigger function correspondence.
 */
import { prisma } from './prisma';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export type ScenarioEmailType = 'branch' | 'plant';

export type Stage =
  | 'before_ls'                  // visibility done OR pending; no LS files yet
  | 'after_ls_before_invoice'    // LS files exist, no plant invoice received
  | 'after_invoice';             // shipment phase

export type Intent =
  | 'release_all'
  | 'release_part'
  | 'wait'
  | 'modify';

export type Modification =
  | 'increase' | 'decrease' | 'delete'
  | 'inc_dec'  | 'inc_del'  | 'dec_del';

export type StepKind =
  // ZSO_Visibility + Zmatana — single step (Zmatana is part of the auto_gui2
  // ZSO-VISIBILITY pipeline, not a separate transaction).
  | 'zso_visibility'                  // triggerZsoVisibility
  // Free-stock pre-check against the synced inventory_snapshot DB. Replaces
  // the spreadsheet's "Zmatana" Step 2 for increase-shaped modifications:
  // short → email branch & abort scenario; sufficient → advance to VA02.
  | 'stock_precheck'
  | 'va02'                            // triggerVa02
  | 'mb51'                            // daily FCFS reactivator — wait intent step
  | 'zload1'                          // triggerZload1 (via dispatch-confirmation path)
  | 'zload2'                          // triggerZload2
  | 'zloading_close'                  // triggerZloadingClose (== ZLOAD_Delete)
  | 'email_2nd_release'               // NEW — sendSecondReleaseEmail
  | 'email_confirm_product_details'   // reuse assembleAndSendCombinedEmail (ls_dispatch)
  | 'email_confirm_bundle_details'    // reuse sendDispatchConfirmationEmail
  | 'email_to_branch_for_vehicle'     // reuse sendCombinedVehicleDetailsEmailForPo
  | 'email_to_plant'                  // reuse sendLSEmail (per-LSI)
  | 'await_plant_invoice'             // sentinel — engine pauses; plant reply advances it
  | 'await_vt01n';                    // sentinel — engine pauses; VT01N enqueue advances it

export interface Step {
  kind: StepKind;
  label?: string;
  awaitsCallback?: boolean;     // SAP step — pause until /step-status reports done
  awaitsBranchReply?: boolean;  // email step — pause until branch/plant replies
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
// Common step lists
// -----------------------------------------------------------------------------

// Pre-LS tail used after ZLOAD1 completes: vehicle + plant + the two
// external-driven steps (Zload3+ZSO_Auto handled by plant reply, VT01N by UI).
const PRE_LS_TAIL: Step[] = [
  { kind: 'email_to_branch_for_vehicle', awaitsBranchReply: true, label: 'Request vehicle details' },
  { kind: 'email_to_plant', label: 'Forward LS to plant' },
  { kind: 'await_plant_invoice', label: 'Wait for plant invoice (existing pipeline drives Zload3+ZSO_Auto)' },
  { kind: 'await_vt01n', label: 'Wait for VT01N enqueue (existing UI / pipeline drives it)' },
];

// Post-LS modifications skip vehicle (already known) — just re-forward LS.
const POST_LS_TAIL: Step[] = [
  { kind: 'email_to_plant', label: 'Re-forward revised LS to plant' },
  { kind: 'await_plant_invoice' },
  { kind: 'await_vt01n' },
];

// Steps that re-run visibility after a VA02 quantity change, including the two
// confirm-emails (which are the existing ls_dispatch + dispatch_confirmation).
// Note: ZSO_Visibility and Zmatana are the same step (Zmatana is part of the
// auto_gui2 ZSO-VISIBILITY pipeline, not a separate transaction).
const POST_VA02_PRE_LS: Step[] = [
  // Sheet Step 2 — Zmatana, now served by the synced inventory_snapshot DB.
  // No-op for pure-decrease/pure-delete scenarios that share this template
  // (the handler short-circuits when there are no increase operations).
  { kind: 'stock_precheck', label: 'Free-stock pre-check (replaces Zmatana)' },
  { kind: 'va02', awaitsCallback: true, label: 'Set new order qty in SAP' },
  { kind: 'email_2nd_release', awaitsBranchReply: true, label: 'Email branch to confirm revised plan' },
  { kind: 'zso_visibility', awaitsCallback: true, label: 'Re-run ZSO-VISIBILITY (+ Zmatana)' },
  { kind: 'email_confirm_product_details', awaitsBranchReply: true, label: 'ls_dispatch — confirm product details' },
  { kind: 'email_confirm_bundle_details', awaitsBranchReply: true, label: 'dispatch_confirmation — confirm bundle details' },
  { kind: 'zload1', awaitsCallback: true, label: 'Create LSs in SAP' },
  ...PRE_LS_TAIL,
];

// -----------------------------------------------------------------------------
// SCENARIOS registry
// -----------------------------------------------------------------------------

export const SCENARIOS: Record<string, Scenario> = {
  // ---------- Branch Email, Before LS — Product Clarification (rows 9–15) ----------

  // Row 9 — sheet: H=ZSO_Visibility+Zmatana, I=confirm product, J=confirm bundle,
  // K=ZLOAD1, N=vehicle email, O=plant email, P=Zload3+ZSO_Auto, Q=VT01N
  'branch|before_ls|release_all|-': {
    key: 'branch|before_ls|release_all|-',
    description: 'Row 9 — Release All, no SO qty change: re-visibility + confirm + ZLOAD1',
    steps: [
      { kind: 'zso_visibility', awaitsCallback: true, label: 'ZSO_Visibility (+ Zmatana)' },
      { kind: 'email_confirm_product_details', awaitsBranchReply: true, label: 'ls_dispatch — confirm product details' },
      { kind: 'email_confirm_bundle_details', awaitsBranchReply: true, label: 'dispatch_confirmation — confirm bundle details' },
      { kind: 'zload1', awaitsCallback: true },
      ...PRE_LS_TAIL,
    ],
  },

  // Row 10 — same shape as row 9 (Release as available/part — Decrease in SO qty)
  'branch|before_ls|release_part|-': {
    key: 'branch|before_ls|release_part|-',
    description: 'Row 10 — Release part (decrease SO qty): re-visibility + confirm + ZLOAD1',
    steps: [
      { kind: 'zso_visibility', awaitsCallback: true, label: 'ZSO_Visibility (+ Zmatana)' },
      { kind: 'email_confirm_product_details', awaitsBranchReply: true },
      { kind: 'email_confirm_bundle_details', awaitsBranchReply: true },
      { kind: 'zload1', awaitsCallback: true },
      ...PRE_LS_TAIL,
    ],
  },

  // Row 11
  'branch|before_ls|modify|increase': {
    key: 'branch|before_ls|modify|increase',
    description: 'Branch increases qty on one or more lines before LS creation',
    steps: POST_VA02_PRE_LS,
  },

  // Row 12
  'branch|before_ls|modify|inc_dec': {
    key: 'branch|before_ls|modify|inc_dec',
    description: 'Branch increases some lines and decreases others before LS creation',
    steps: POST_VA02_PRE_LS,
  },

  // Row 13
  'branch|before_ls|modify|inc_del': {
    key: 'branch|before_ls|modify|inc_del',
    description: 'Branch increases some lines and deletes others before LS creation',
    steps: POST_VA02_PRE_LS,
  },

  // Row 14 — only a delete (no quantity change to set in VA02), skip Zmatana+VA02+re-visibility
  'branch|before_ls|modify|delete': {
    key: 'branch|before_ls|modify|delete',
    description: 'Branch deletes line(s) before LS creation — straight to ZLOAD1 on the surviving lines',
    steps: [
      { kind: 'zload1', awaitsCallback: true },
      ...PRE_LS_TAIL,
    ],
  },

  // Row 15 — Hold/Wait till all material available. Sheet: D=MB51 (only step).
  // The single mb51 step parks the SO on the daily FCFS reactivator; once
  // fresh stock lands, MB51 produces a reactivation that re-enters the flow
  // through the existing handleProductionConfirmation → triggerZsoVisibility
  // pipeline.
  'branch|before_ls|wait|-': {
    key: 'branch|before_ls|wait|-',
    description: 'Row 15 — Hold/Wait: park on MB51 daily FCFS reactivator',
    steps: [
      { kind: 'mb51', label: 'Wait for daily MB51 FCFS reactivation' },
    ],
  },

  // ---------- Branch Email, Before LS — SO Modification (rows 32–37) ----------
  // Same shapes as rows 11-13 / 14, registered separately so the engine can
  // log the distinct origin. Identical step lists by user's "stage decides"
  // principle.

  'branch|before_ls|modify|decrease': {
    key: 'branch|before_ls|modify|decrease',
    description: 'Branch decreases qty on one or more lines before LS creation',
    steps: POST_VA02_PRE_LS,
  },

  'branch|before_ls|modify|dec_del': {
    key: 'branch|before_ls|modify|dec_del',
    description: 'Branch decreases some lines and deletes others before LS creation',
    steps: POST_VA02_PRE_LS,
  },

  // ---------- Branch Email, After LS — SO Modification (rows 16–21) ----------

  // Row 16
  'branch|after_ls_before_invoice|modify|increase': {
    key: 'branch|after_ls_before_invoice|modify|increase',
    description: 'Branch wants to increase qty after LS creation — VA02 + re-visibility + ZLOAD2',
    steps: [
      { kind: 'stock_precheck', label: 'Free-stock pre-check (replaces Zmatana)' },
      { kind: 'va02', awaitsCallback: true },
      { kind: 'email_2nd_release', awaitsBranchReply: true },
      { kind: 'zso_visibility', awaitsCallback: true },
      { kind: 'email_confirm_product_details', awaitsBranchReply: true },
      { kind: 'email_confirm_bundle_details', awaitsBranchReply: true },
      { kind: 'zload2', awaitsCallback: true, label: 'Revise LS qty in SAP' },
      ...POST_LS_TAIL,
    ],
  },

  // Row 17
  'branch|after_ls_before_invoice|modify|inc_dec': {
    key: 'branch|after_ls_before_invoice|modify|inc_dec',
    description: 'Branch wants to increase + decrease after LS — VA02 + ZLOAD2',
    steps: [
      { kind: 'stock_precheck', label: 'Free-stock pre-check (replaces Zmatana)' },
      { kind: 'va02', awaitsCallback: true },
      { kind: 'email_2nd_release', awaitsBranchReply: true },
      { kind: 'zso_visibility', awaitsCallback: true },
      { kind: 'email_confirm_product_details', awaitsBranchReply: true },
      { kind: 'email_confirm_bundle_details', awaitsBranchReply: true },
      { kind: 'zload2', awaitsCallback: true },
      ...POST_LS_TAIL,
    ],
  },

  // Row 18
  'branch|after_ls_before_invoice|modify|inc_del': {
    key: 'branch|after_ls_before_invoice|modify|inc_del',
    description: 'Branch wants to increase + delete after LS — VA02 + ZLOAD2 + ZLOAD_Delete',
    steps: [
      { kind: 'stock_precheck', label: 'Free-stock pre-check (replaces Zmatana)' },
      { kind: 'va02', awaitsCallback: true },
      { kind: 'email_2nd_release', awaitsBranchReply: true },
      { kind: 'zso_visibility', awaitsCallback: true },
      { kind: 'email_confirm_product_details', awaitsBranchReply: true },
      { kind: 'email_confirm_bundle_details', awaitsBranchReply: true },
      { kind: 'zload2', awaitsCallback: true },
      { kind: 'zloading_close', awaitsCallback: true, label: 'Close deleted materials on the LS' },
      ...POST_LS_TAIL,
    ],
  },

  // Row 19
  'branch|after_ls_before_invoice|modify|decrease': {
    key: 'branch|after_ls_before_invoice|modify|decrease',
    description: 'Branch decreases qty after LS — straight to ZLOAD2 (no VA02 / re-visibility)',
    steps: [
      { kind: 'zload2', awaitsCallback: true },
      ...POST_LS_TAIL,
    ],
  },

  // Row 20
  'branch|after_ls_before_invoice|modify|delete': {
    key: 'branch|after_ls_before_invoice|modify|delete',
    description: 'Branch deletes line(s) after LS — ZLOAD_Delete only',
    steps: [
      { kind: 'zloading_close', awaitsCallback: true },
      ...POST_LS_TAIL,
    ],
  },

  // Row 21
  'branch|after_ls_before_invoice|modify|dec_del': {
    key: 'branch|after_ls_before_invoice|modify|dec_del',
    description: 'Branch decreases + deletes after LS — ZLOAD2 + ZLOAD_Delete',
    steps: [
      { kind: 'zload2', awaitsCallback: true },
      { kind: 'zloading_close', awaitsCallback: true },
      ...POST_LS_TAIL,
    ],
  },

  // ---------- Plant Email, Before Plant Invoice — LS Modification (rows 25–30) ----------

  // Row 25 — plant says actual is more than ordered
  'plant|after_ls_before_invoice|modify|increase': {
    key: 'plant|after_ls_before_invoice|modify|increase',
    description: 'Plant reports increase — VA02 + re-visibility + ZLOAD2',
    steps: [
      { kind: 'stock_precheck', label: 'Free-stock pre-check (replaces Zmatana)' },
      { kind: 'va02', awaitsCallback: true },
      { kind: 'email_2nd_release', awaitsBranchReply: true },
      { kind: 'zso_visibility', awaitsCallback: true },
      { kind: 'email_confirm_product_details', awaitsBranchReply: true },
      { kind: 'email_confirm_bundle_details', awaitsBranchReply: true },
      { kind: 'zload2', awaitsCallback: true },
      ...POST_LS_TAIL,
    ],
  },

  // Row 26
  'plant|after_ls_before_invoice|modify|inc_dec': {
    key: 'plant|after_ls_before_invoice|modify|inc_dec',
    description: 'Plant reports increase + decrease — VA02 + ZLOAD2',
    steps: [
      { kind: 'stock_precheck', label: 'Free-stock pre-check (replaces Zmatana)' },
      { kind: 'va02', awaitsCallback: true },
      { kind: 'email_2nd_release', awaitsBranchReply: true },
      { kind: 'zso_visibility', awaitsCallback: true },
      { kind: 'email_confirm_product_details', awaitsBranchReply: true },
      { kind: 'email_confirm_bundle_details', awaitsBranchReply: true },
      { kind: 'zload2', awaitsCallback: true },
      ...POST_LS_TAIL,
    ],
  },

  // Row 27
  'plant|after_ls_before_invoice|modify|inc_del': {
    key: 'plant|after_ls_before_invoice|modify|inc_del',
    description: 'Plant reports increase + delete — VA02 + ZLOAD2 + ZLOAD_Delete',
    steps: [
      { kind: 'stock_precheck', label: 'Free-stock pre-check (replaces Zmatana)' },
      { kind: 'va02', awaitsCallback: true },
      { kind: 'email_2nd_release', awaitsBranchReply: true },
      { kind: 'zso_visibility', awaitsCallback: true },
      { kind: 'email_confirm_product_details', awaitsBranchReply: true },
      { kind: 'email_confirm_bundle_details', awaitsBranchReply: true },
      { kind: 'zload2', awaitsCallback: true },
      { kind: 'zloading_close', awaitsCallback: true },
      ...POST_LS_TAIL,
    ],
  },

  // Row 28
  'plant|after_ls_before_invoice|modify|decrease': {
    key: 'plant|after_ls_before_invoice|modify|decrease',
    description: 'Plant reports shortage — ZLOAD2 (no VA02 / re-visibility)',
    steps: [
      { kind: 'zload2', awaitsCallback: true },
      ...POST_LS_TAIL,
    ],
  },

  // Row 29
  'plant|after_ls_before_invoice|modify|delete': {
    key: 'plant|after_ls_before_invoice|modify|delete',
    description: 'Plant cannot ship a line at all — ZLOAD_Delete only',
    steps: [
      { kind: 'zloading_close', awaitsCallback: true },
      ...POST_LS_TAIL,
    ],
  },

  // Row 30
  'plant|after_ls_before_invoice|modify|dec_del': {
    key: 'plant|after_ls_before_invoice|modify|dec_del',
    description: 'Plant reports shortage + cannot ship others — ZLOAD2 + ZLOAD_Delete',
    steps: [
      { kind: 'zload2', awaitsCallback: true },
      { kind: 'zloading_close', awaitsCallback: true },
      ...POST_LS_TAIL,
    ],
  },
};

// -----------------------------------------------------------------------------
// resolveScenario — pure lookup, no LLM
// -----------------------------------------------------------------------------

export function resolveScenario(
  emailType: ScenarioEmailType,
  stage: Stage,
  intent: Intent,
  modification: Modification | undefined,
): Scenario | null {
  const key = scenarioKey(emailType, stage, intent, modification);
  return SCENARIOS[key] ?? null;
}

// -----------------------------------------------------------------------------
// deriveStage — pure function on DB state. The three buckets are detected from
// SalesOrder.status + presence of LoadingSlipItem.fileUrl + Shipment.status,
// matching the predicates documented in the plan.
// -----------------------------------------------------------------------------

export async function deriveStage(salesOrderId: string): Promise<Stage> {
  // Pull the minimum we need in one go. The triage logic is in-process to keep
  // it auditable; if performance ever matters this can be replaced with raw SQL.
  const so = await prisma.salesOrder.findUnique({
    where: { id: salesOrderId },
    select: {
      status: true,
      items: {
        select: { fileUrl: true },
        take: 1,
        where: { fileUrl: { not: null } },
      },
      shipments: {
        select: { status: true },
        where: { status: { in: ['shipment-triggered', 'shipped'] } },
        take: 1,
      },
    },
  });

  if (!so) {
    // Caller bug; default to the safest stage so we don't accidentally pick a
    // post-LS scenario for a non-existent SO.
    return 'before_ls';
  }

  if (so.shipments.length > 0 || so.status === 'in-progress' || so.status === 'completed') {
    return 'after_invoice';
  }

  if (so.status === 'ls_created' && so.items.length > 0) {
    return 'after_ls_before_invoice';
  }

  return 'before_ls';
}

// -----------------------------------------------------------------------------
// getValidScenarioKeys — pre-filter the registry to entries matching the
// (sender, stage) tuple. Used by the LLM-as-scenario-selector to constrain
// the LLM's output space.
// -----------------------------------------------------------------------------

export function getValidScenarioKeys(
  sender: ScenarioEmailType,
  stage: Stage,
): Array<{ key: string; description: string; stepKinds: string[] }> {
  const prefix = `${sender}|${stage}|`;
  return Object.entries(SCENARIOS)
    .filter(([k]) => k.startsWith(prefix))
    .map(([key, s]) => ({
      key,
      description: s.description,
      stepKinds: s.steps.map((st) => st.kind),
    }));
}
