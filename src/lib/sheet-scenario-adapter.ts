/**
 * Adapter: maps internal scenario keys (`branch|before_ls|modify|increase`)
 * to sheet rows in `Intent_Classification.xlsx` Sheet3, and converts a sheet
 * row into the engine's internal Scenario shape.
 *
 * Goal: the engine's step lists come from the sheet at runtime, not from a
 * hardcoded SCENARIOS registry. Edit the sheet, restart the server, see new
 * behavior — that's the user's stated requirement.
 *
 * Why this is an adapter (vs. a full rewrite): the engine's dispatch
 * machinery (`fireStep` switch over `StepKind`) is mature and tested. Rather
 * than rewriting it to consume sheet step-name strings, we translate each
 * sheet row's enabled steps into the existing internal StepKind values. The
 * resulting Scenario looks identical to what the SCENARIOS registry used to
 * return — just sourced from the sheet.
 */
import type { Scenario, Step, StepKind } from './dispatch-scenarios';
import { getScenarioRow, type EmailType } from './sheet-scenarios';
import { lookupStep } from './sheet-step-mapping';

// -----------------------------------------------------------------------------
// scenario_key → sheet row coordinates (emailType, stage, primaryIntent)
// -----------------------------------------------------------------------------
// The sheet's "Augmented Intent" column (D) is unreliable as a key — it has
// typos ("AFter") and inconsistent stage encoding (some rows drop the
// "- Before Vehicle Placement" suffix). So we key directly on the actual
// column values that getScenarioRow() compares.
// -----------------------------------------------------------------------------

interface SheetCoord {
  emailType: EmailType;
  stage: string;
  primaryIntent: string;
}

const KEY_TO_COORD: Record<string, SheetCoord> = {
  // ---------- Branch Email + Before LS Creation ----------
  'branch|before_ls|release_all|-': {
    emailType: 'Branch Email',
    stage: 'Before LS Creation',
    primaryIntent: 'Product Clarification - Release All - No Change in SO quantity',
  },
  'branch|before_ls|release_part|-': {
    emailType: 'Branch Email',
    stage: 'Before LS Creation',
    primaryIntent: 'Product Clarification - Release as available/part - Decrease in SO quantity',
  },
  'branch|before_ls|wait|-': {
    emailType: 'Branch Email',
    stage: 'Before LS Creation',
    primaryIntent: 'Product Clarification - Hold/Wait till all material available',
  },
  'branch|before_ls|modify|increase': {
    emailType: 'Branch Email',
    stage: 'Before LS Creation',
    primaryIntent: 'Product Clarification - Release with adjustment - Increase',
  },
  'branch|before_ls|modify|inc_dec': {
    emailType: 'Branch Email',
    stage: 'Before LS Creation',
    primaryIntent: 'Product Clarification - Release with adjustment - Increase + Decrease',
  },
  'branch|before_ls|modify|inc_del': {
    emailType: 'Branch Email',
    stage: 'Before LS Creation',
    primaryIntent: 'Product Clarification - Release with adjustment - Increase + Delete',
  },
  'branch|before_ls|modify|delete': {
    emailType: 'Branch Email',
    stage: 'Before LS Creation',
    primaryIntent: 'Product Clarification - Release with adjustment - Delete',
  },
  // Pure-decrease + dec_del before LS map to the same sheet row as release_part
  // (the sheet doesn't draw a distinction; both are "release as available -
  // decrease in SO quantity" patterns).
  'branch|before_ls|modify|decrease': {
    emailType: 'Branch Email',
    stage: 'Before LS Creation',
    primaryIntent: 'Product Clarification - Release as available/part - Decrease in SO quantity',
  },
  'branch|before_ls|modify|dec_del': {
    emailType: 'Branch Email',
    stage: 'Before LS Creation',
    primaryIntent: 'Product Clarification - Release as available/part - Decrease in SO quantity',
  },

  // ---------- Branch Email + After LS Creation, Before Vehicle Placement ----------
  'branch|after_ls_before_invoice|modify|increase': {
    emailType: 'Branch Email',
    stage: 'After LS Creation - Before Vehicle Placement',
    primaryIntent: 'SO Modification - Increase',
  },
  'branch|after_ls_before_invoice|modify|inc_dec': {
    emailType: 'Branch Email',
    stage: 'After LS Creation - Before Vehicle Placement',
    primaryIntent: 'SO Modification - Increase + Decrease',
  },
  'branch|after_ls_before_invoice|modify|inc_del': {
    emailType: 'Branch Email',
    stage: 'After LS Creation - Before Vehicle Placement',
    primaryIntent: 'SO Modification - Increase + Delete',
  },
  'branch|after_ls_before_invoice|modify|decrease': {
    emailType: 'Branch Email',
    stage: 'After LS Creation - Before Vehicle Placement',
    primaryIntent: 'SO Modification - Decrease',
  },
  'branch|after_ls_before_invoice|modify|delete': {
    emailType: 'Branch Email',
    stage: 'After LS Creation - Before Vehicle Placement',
    primaryIntent: 'SO Modification - Delete',
  },
  'branch|after_ls_before_invoice|modify|dec_del': {
    emailType: 'Branch Email',
    stage: 'After LS Creation - Before Vehicle Placement',
    primaryIntent: 'SO Modification - Decrease + Delete',
  },

  // ---------- Plant Email + Before Plant Invoice ----------
  'plant|after_email_to_plant|modify|increase': {
    emailType: 'Plant Email',
    stage: 'Before Plant Invoice',
    primaryIntent: 'LS Modification - Increase',
  },
  'plant|after_email_to_plant|modify|inc_dec': {
    emailType: 'Plant Email',
    stage: 'Before Plant Invoice',
    primaryIntent: 'LS Modification - Increase + Decrease',
  },
  'plant|after_email_to_plant|modify|inc_del': {
    emailType: 'Plant Email',
    stage: 'Before Plant Invoice',
    primaryIntent: 'LS Modification - Increase + Delete',
  },
  'plant|after_email_to_plant|modify|decrease': {
    emailType: 'Plant Email',
    stage: 'Before Plant Invoice',
    primaryIntent: 'LS Modification - Decrease',
  },
  'plant|after_email_to_plant|modify|delete': {
    emailType: 'Plant Email',
    stage: 'Before Plant Invoice',
    primaryIntent: 'LS Modification - Delete',
  },
  'plant|after_email_to_plant|modify|dec_del': {
    emailType: 'Plant Email',
    stage: 'Before Plant Invoice',
    primaryIntent: 'LS Modification - Decrease + Delete',
  },

  // ---------- Branch Email + Before LS — NEW SO / 2nd-release / discount / clarify ----------
  // R4 — NEW SO (inbound NEW ORDER triggers segment 1: zso_visibility + ls_dispatch)
  'branch|before_ls|new_so|-': {
    emailType: 'Branch Email',
    stage: 'Before LS Creation',
    primaryIntent: 'New SO',
  },
  // R5 — Branch confirms 2nd release before LS
  'branch|before_ls|2nd_release|-': {
    emailType: 'Branch Email',
    stage: 'Before LS Creation',
    primaryIntent: 'Second Release confirmation',
  },
  // R7 — Discount Code Confirmation (post-discount round trip; treated as resume)
  'branch|before_ls|discount_confirm|-': {
    emailType: 'Branch Email',
    stage: 'Before LS Creation',
    primaryIntent: 'Discount Code Confirmation',
  },
  // R8 — Vehicle Weight Clarification (lightweight pre-LS path)
  'branch|before_ls|clarify_weight|-': {
    emailType: 'Branch Email',
    stage: 'Before LS Creation',
    primaryIntent: 'Vehicle Weight Clarification',
  },

  // ---------- Branch Email + After LS (no suffix in sheet for R6 and R10) ----------
  // R6 — Branch confirms 2nd release AFTER LS creation
  'branch|after_ls_before_invoice|2nd_release|-': {
    emailType: 'Branch Email',
    stage: 'After LS Creation',
    primaryIntent: 'Second Release confirmation',
  },
  // R10 — Branch shares vehicle details
  'branch|after_ls_before_invoice|vehicle_details|-': {
    emailType: 'Branch Email',
    stage: 'After LS Creation',
    primaryIntent: 'Sharing Vehicle Details',
  },

  // ---------- Branch Email + Anytime intents (R9, R11) ----------
  // R9 — Seeking Order Update → auto-reply with current SO status
  'branch|anytime|status_update|-': {
    emailType: 'Branch Email',
    stage: 'Anytime',
    primaryIntent: 'Seeking Order Update',
  },
  // R11 — Others → escalate to supervisor
  'branch|anytime|other|-': {
    emailType: 'Branch Email',
    stage: 'Anytime',
    primaryIntent: 'Others',
  },

  // ---------- Branch Email + After Vehicle Placement modifications (R25-R30) ----------
  'branch|after_vehicle_placement|modify|increase': {
    emailType: 'Branch Email',
    stage: 'After LS Creation - After Vehicle Placement',
    primaryIntent: 'SO Modification - Increase',
  },
  'branch|after_vehicle_placement|modify|inc_dec': {
    emailType: 'Branch Email',
    stage: 'After LS Creation - After Vehicle Placement',
    primaryIntent: 'SO Modification - Increase + Decrease',
  },
  'branch|after_vehicle_placement|modify|inc_del': {
    emailType: 'Branch Email',
    stage: 'After LS Creation - After Vehicle Placement',
    primaryIntent: 'SO Modification - Increase + Delete',
  },
  'branch|after_vehicle_placement|modify|decrease': {
    emailType: 'Branch Email',
    stage: 'After LS Creation - After Vehicle Placement',
    primaryIntent: 'SO Modification - Decrease',
  },
  'branch|after_vehicle_placement|modify|delete': {
    emailType: 'Branch Email',
    stage: 'After LS Creation - After Vehicle Placement',
    primaryIntent: 'SO Modification - Delete',
  },
  'branch|after_vehicle_placement|modify|dec_del': {
    emailType: 'Branch Email',
    stage: 'After LS Creation - After Vehicle Placement',
    primaryIntent: 'SO Modification - Decrease + Delete',
  },

  // ---------- Branch Email + After Email to Plant modifications (R31-R36) ----------
  'branch|after_email_to_plant|modify|increase': {
    emailType: 'Branch Email',
    stage: 'After LS Creation - After Email to Plant',
    primaryIntent: 'SO Modification - Increase',
  },
  'branch|after_email_to_plant|modify|inc_dec': {
    emailType: 'Branch Email',
    stage: 'After LS Creation - After Email to Plant',
    primaryIntent: 'SO Modification - Increase + Decrease',
  },
  'branch|after_email_to_plant|modify|inc_del': {
    emailType: 'Branch Email',
    stage: 'After LS Creation - After Email to Plant',
    primaryIntent: 'SO Modification - Increase + Delete',
  },
  'branch|after_email_to_plant|modify|decrease': {
    emailType: 'Branch Email',
    stage: 'After LS Creation - After Email to Plant',
    primaryIntent: 'SO Modification - Decrease',
  },
  'branch|after_email_to_plant|modify|delete': {
    emailType: 'Branch Email',
    stage: 'After LS Creation - After Email to Plant',
    primaryIntent: 'SO Modification - Delete',
  },
  'branch|after_email_to_plant|modify|dec_del': {
    emailType: 'Branch Email',
    stage: 'After LS Creation - After Email to Plant',
    primaryIntent: 'SO Modification - Decrease + Delete',
  },

  // ---------- Branch Email + After Plant Invoice modifications (R37-R42) ----------
  'branch|after_plant_invoice|modify|increase': {
    emailType: 'Branch Email',
    stage: 'After LS Creation - After Plant Invoice',
    primaryIntent: 'SO Modification - Increase',
  },
  'branch|after_plant_invoice|modify|inc_dec': {
    emailType: 'Branch Email',
    stage: 'After LS Creation - After Plant Invoice',
    primaryIntent: 'SO Modification - Increase + Decrease',
  },
  'branch|after_plant_invoice|modify|inc_del': {
    emailType: 'Branch Email',
    stage: 'After LS Creation - After Plant Invoice',
    primaryIntent: 'SO Modification - Increase + Delete',
  },
  'branch|after_plant_invoice|modify|decrease': {
    emailType: 'Branch Email',
    stage: 'After LS Creation - After Plant Invoice',
    primaryIntent: 'SO Modification - Decrease',
  },
  'branch|after_plant_invoice|modify|delete': {
    emailType: 'Branch Email',
    stage: 'After LS Creation - After Plant Invoice',
    primaryIntent: 'SO Modification - Delete',
  },
  'branch|after_plant_invoice|modify|dec_del': {
    emailType: 'Branch Email',
    stage: 'After LS Creation - After Plant Invoice',
    primaryIntent: 'SO Modification - Decrease + Delete',
  },

  // ---------- Plant Email — invoice arrival + Anytime ----------
  // R44 — Plant invoice arrival: triggers Zload3+ZSO_Auto → VT01N pipeline
  'plant|after_plant_invoice|invoice_sent|-': {
    emailType: 'Plant Email',
    stage: 'After Plant Invoice',
    primaryIntent: 'Invoice Sent',
  },
  // R45 — Plant Other → escalate to supervisor
  'plant|anytime|other|-': {
    emailType: 'Plant Email',
    stage: 'Anytime',
    primaryIntent: 'Other',
  },
};

// -----------------------------------------------------------------------------
// Sheet handler name → internal StepKind
// -----------------------------------------------------------------------------
// `sheet-step-mapping.ts` produces a `handler` field per step name. Translate
// that handler name to the StepKind value the engine's fireStep dispatcher
// expects.
// -----------------------------------------------------------------------------

const HANDLER_TO_STEPKIND: Record<string, StepKind | null> = {
  // Internal — SAP transactions / availability checks
  triggerZsoVisibility: 'zso_visibility',
  runStockPrecheck: 'stock_precheck',
  triggerVa02: 'va02',
  fanOutZload1ForPo: 'zload1',
  triggerZload2: 'zload2',
  triggerZloadingClose: 'zloading_close',
  awaitPlantInvoicePipeline: 'await_plant_invoice',
  triggerVto1n: 'await_vt01n',
  parkOnMb51: 'mb51',

  // Outbound emails
  assembleAndSendCombinedEmail: 'email_confirm_product_details',
  sendDispatchConfirmationEmail: 'email_confirm_bundle_details',
  sendSecondReleaseEmail: 'email_2nd_release',
  sendCombinedVehicleDetailsEmailForPo: 'email_to_branch_for_vehicle',
  sendLSEmail: 'email_to_plant',

  // NEW outbound handlers — Phase 5 wiring complete.
  sendOrderStatusEmail: 'email_order_status',                                 // R9 auto-reply
  sendPlantChangeNotificationEmail: 'email_to_branch_notifying_plant_change',  // R46-R51 ack flow

  // Skipped handlers (inbound markers + user-deferred steps)
  __inbound__: null,
  __skipped__: null,
};

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * Look up the sheet row that backs a given internal scenario key, then
 * convert its enabled steps to the engine's internal Scenario shape.
 *
 * Returns null when the key isn't in the static mapping (caller falls back
 * to legacy SCENARIOS lookup as a safety net).
 */
export function getScenarioFromKey(key: string): Scenario | null {
  const coord = KEY_TO_COORD[key];
  if (!coord) return null;
  const row = getScenarioRow(coord.emailType, coord.stage, coord.primaryIntent);
  if (!row) return null;
  return scenarioFromSheetRow(key, row);
}

/**
 * Per-key description overrides for the classifier prompt. The sheet's
 * augmentedIntent column is terse (e.g. "Plant Email - After Plant Invoice -
 * Invoice Sent") and a few keys are easy for the LLM to overlook without a
 * fuller description of the trigger conditions. Add overrides sparingly —
 * each one should describe what the inbound *looks like*, not just what
 * the system does next.
 */
const DESCRIPTION_OVERRIDES: Record<string, string> = {
  'plant|after_plant_invoice|invoice_sent|-':
    'Plant notifies that the invoice has been generated / material has been dispatched. ' +
    'The reply typically contains invoice number, OBD number, and/or an invoice PDF. ' +
    'Pick this when the plant is confirming dispatch — even if the SO is still computed at ' +
    'stage "after_email_to_plant" (this inbound IS the trigger that moves the SO to ' +
    '"after_plant_invoice"). Do NOT use invoice_pdf when the body explicitly states the ' +
    'invoice number or dispatch confirmation in text form.',
};

/**
 * Convert a sheet row's enabledSteps into the engine's Scenario shape.
 * Inbound markers and skipped steps are dropped; everything else is mapped
 * to an internal StepKind via HANDLER_TO_STEPKIND.
 */
function scenarioFromSheetRow(key: string, row: { augmentedIntent: string; enabledSteps: Array<{ name: string }> }): Scenario {
  const steps: Step[] = [];
  for (const sheetStep of row.enabledSteps) {
    const mapping = lookupStep(sheetStep.name);
    if (!mapping) continue;
    if (mapping.kind === 'inbound_marker' || mapping.kind === 'skip') continue;
    const stepKind = HANDLER_TO_STEPKIND[mapping.handler];
    if (!stepKind) continue; // NEW handlers not yet wired — drop for now
    steps.push({
      kind: stepKind,
      label: sheetStep.name,
      awaitsCallback: isAwaitsCallback(stepKind),
      awaitsBranchReply: isAwaitsBranchReply(stepKind),
    });
  }
  return {
    key,
    description: DESCRIPTION_OVERRIDES[key] ?? row.augmentedIntent,
    steps,
  };
}

/**
 * Step kinds that pause for a SAP `/step-status` callback. Mirrors what the
 * old SCENARIOS registry encoded.
 */
function isAwaitsCallback(kind: StepKind): boolean {
  return (
    kind === 'va02' ||
    kind === 'zso_visibility' ||
    kind === 'zload1' ||
    kind === 'zload2' ||
    kind === 'zloading_close' ||
    kind === 'mb51'
  );
}

/**
 * Step kinds that pause waiting for a branch/plant reply on an outbound email.
 */
function isAwaitsBranchReply(kind: StepKind): boolean {
  return (
    kind === 'email_2nd_release' ||
    kind === 'email_confirm_product_details' ||
    kind === 'email_confirm_bundle_details' ||
    kind === 'email_to_branch_for_vehicle' ||
    kind === 'email_to_branch_notifying_plant_change'
  );
}

/**
 * Whether a given scenario key is backed by a sheet row.
 * Useful for test harness / diagnostics.
 */
export function isSheetBacked(key: string): boolean {
  return key in KEY_TO_COORD;
}

/**
 * All scenario keys that have a sheet mapping. Mainly for tests.
 */
export function getAllSheetBackedKeys(): string[] {
  return Object.keys(KEY_TO_COORD);
}

/**
 * Boot-time validation: confirm every KEY_TO_COORD entry resolves to a real
 * sheet row. Catches sheet drift (renamed primaryIntent, deleted row) before
 * a live classifier call lands on a phantom mapping.
 *
 * Returns the list of unresolved keys. Empty array means everything is wired.
 * Called from module-load below; also exposed for the test harness.
 */
export function validateKeyToCoord(): string[] {
  const broken: string[] = [];
  for (const [key, coord] of Object.entries(KEY_TO_COORD)) {
    const row = getScenarioRow(coord.emailType, coord.stage, coord.primaryIntent);
    if (!row) broken.push(key);
  }
  return broken;
}

// Run validation at module load. We only WARN (not throw) — a sheet edit on
// the production server shouldn't crash the engine; the operator gets a loud
// log line and the affected scenarios fall back to the SCENARIOS registry.
(() => {
  try {
    const broken = validateKeyToCoord();
    if (broken.length > 0) {
      console.warn(
        `[sheet-scenario-adapter] WARNING: ${broken.length} KEY_TO_COORD entries do not resolve to a sheet row — these scenarios will fall back to the SCENARIOS registry:`,
      );
      for (const k of broken) console.warn(`  - ${k}`);
    }
  } catch (err) {
    console.warn('[sheet-scenario-adapter] validateKeyToCoord() threw — sheet may be unreadable:', err);
  }
})();
