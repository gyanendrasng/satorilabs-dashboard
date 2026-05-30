/**
 * Mapping between sheet step names (Row 3 of Sheet3) and the engine's
 * action handlers. The engine's `executeStepByName` looks each step up
 * here and dispatches to the right kind of action.
 *
 * Three kinds of mappings:
 *   - 'inbound_marker' — sheet column labels something the system WILL
 *     RECEIVE (e.g. "Email from Branch confirming product details").
 *     The engine skips these during execution; they're just context for
 *     the LLM. The next inbound email that matches this marker triggers
 *     a fresh classifier run.
 *   - 'internal' — SAP transaction / availability check. The engine
 *     dispatches to the named handler and either advances synchronously
 *     ('advance_now') or pauses for an external callback ('pause').
 *   - 'outbound' — the engine sends the named email and TERMINATES the
 *     scenario (per the user's "stop after first outbound" rule).
 *   - 'skip' — explicitly skipped per user direction (Discount Check,
 *     MB51 Check, Reply to/from Branch). Engine no-ops the cell.
 *
 * This file is the ONLY place that translates between sheet labels and
 * code. To wire a new step kind: add a row here + write the handler.
 */

export type StepKind =
  | 'inbound_marker'
  | 'internal'
  | 'outbound'
  | 'skip';

export interface StepMapping {
  kind: StepKind;
  /**
   * For 'internal' / 'outbound' steps: a stable identifier the engine uses
   * to pick the handler. For 'inbound_marker' / 'skip' this is informational.
   */
  handler: string;
  /** Short human-readable description for logs. */
  description?: string;
}

/**
 * Normalize a sheet step name for lookup. The sheet has some duplicated
 * whitespace and casing oddities (e.g. "Email From Branch  confirming product
 * details" with two spaces) — we collapse whitespace + lowercase before
 * matching so small sheet typos don't break the engine.
 */
export function normalizeStepName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Mapping table keyed by the NORMALIZED step name. Use `lookupStep(name)` to
 * resolve; it applies the normalization for you.
 */
const STEP_TABLE: Record<string, StepMapping> = {
  // ─── Inbound markers (no-op during execution) ────────────────────────
  // These appear in sheet rows to indicate what email is expected next.
  // The engine skips them; the next matching inbound email triggers a new
  // classifier run.
  'branch email': {
    kind: 'inbound_marker',
    handler: '__inbound__',
    description: 'NEW ORDER inbound from branch (trigger marker)',
  },
  'reply from branch': {
    kind: 'inbound_marker',
    handler: '__inbound__',
    description: 'Branch reply to discount-check round-trip (skipped here)',
  },
  'email from branch confirming product details': {
    kind: 'inbound_marker',
    handler: '__inbound__',
  },
  'email from branch confirming bundle details': {
    kind: 'inbound_marker',
    handler: '__inbound__',
  },
  'email from branch': {
    kind: 'inbound_marker',
    handler: '__inbound__',
    description: 'Branch reply on vehicle-details thread',
  },
  'email from branch confirming 2nd release': {
    kind: 'inbound_marker',
    handler: '__inbound__',
  },
  'email from branch changing product': {
    kind: 'inbound_marker',
    handler: '__inbound__',
    description: 'Branch-initiated modification request',
  },
  'email from plant changing product': {
    kind: 'inbound_marker',
    handler: '__inbound__',
    description: 'Plant-initiated modification request',
  },
  'email from plant with invoice': {
    kind: 'inbound_marker',
    handler: '__inbound__',
  },
  'email from branch acknowledging plant change': {
    kind: 'inbound_marker',
    handler: '__inbound__',
  },
  // Alias for the misspelling that exists in the current sheet
  // ("acknowledging plant chage" — missing 'n'). Keep both so the engine
  // is robust regardless of whether the sheet typo is fixed.
  'email from branch acknowledging plant chage': {
    kind: 'inbound_marker',
    handler: '__inbound__',
  },

  // ─── Internal actions (SAP transactions + checks) ────────────────────
  'zso visibility + zmatana': {
    kind: 'internal',
    handler: 'triggerZsoVisibility',
    description: 'Run ZSO-VISIBILITY in SAP; refresh material+stock data',
  },
  'product availability check': {
    kind: 'internal',
    handler: 'runStockPrecheck',
    description: 'Free-stock gate for increase-shaped modifications',
  },
  'va02': {
    kind: 'internal',
    handler: 'triggerVa02',
    description: 'Set new order quantity in SAP',
  },
  'zload1': {
    kind: 'internal',
    handler: 'fanOutZload1ForPo',
    description: 'Create Loading Slips in SAP',
  },
  'zload2': {
    kind: 'internal',
    handler: 'triggerZload2',
    description: 'Revise LS quantity in SAP',
  },
  'zload delete': {
    kind: 'internal',
    handler: 'triggerZloadingClose',
    description: 'Close/delete materials on an existing LS',
  },
  'zload3 + zso_auto': {
    kind: 'internal',
    handler: 'awaitPlantInvoicePipeline',
    description: 'ZLOAD3 + ZSO_Auto — driven by plant-invoice callback path',
  },
  'vt01n': {
    kind: 'internal',
    handler: 'triggerVto1n',
    description: 'Create shipment in SAP',
  },

  // ─── Outbound actions (engine sends an email; scenario terminates) ──
  'email to branch to confirm product details': {
    kind: 'outbound',
    handler: 'assembleAndSendCombinedEmail',
    description: 'ls_dispatch email — confirm product details with branch',
  },
  'email to branch to confirm bundle details': {
    kind: 'outbound',
    handler: 'sendDispatchConfirmationEmail',
    description: 'dispatch_confirmation email — confirm bundle plan',
  },
  'email to branch for second release': {
    kind: 'outbound',
    handler: 'sendSecondReleaseEmail',
    description: '2nd_release email after VA02 changes quantities',
  },
  'email to branch for vehicle': {
    kind: 'outbound',
    handler: 'sendCombinedVehicleDetailsEmailForPo',
    description: 'vehicle_details email — request vehicle/driver info',
  },
  'email to plant': {
    kind: 'outbound',
    handler: 'sendLSEmail',
    description: 'plant_ls email — forward LS to plant',
  },
  'email to plant with ls': {
    kind: 'outbound',
    handler: 'sendLSEmail',
    description: 'plant_ls email (post-plant-modification re-send)',
  },
  'email to branch notifying plant change': {
    kind: 'outbound',
    handler: 'sendPlantChangeNotificationEmail',
    description: 'NEW — notify branch of plant-proposed modifications',
  },

  // ─── Explicit skips (user-deferred) ──────────────────────────────────
  'discount check': {
    kind: 'skip',
    handler: '__skipped__',
    description: 'Discount Check — deferred per user',
  },
  'mb51 check': {
    kind: 'internal',
    handler: 'parkOnMb51',
    description: 'Park on MB51 daily FCFS reactivator — wait for stock to land',
  },
  'reply to branch': {
    kind: 'skip',
    handler: '__skipped__',
    description: 'Reply to Branch (discount round-trip) — skipped per user',
  },
};

/**
 * Resolve a sheet step name to its handler mapping. Returns null when
 * the step name isn't in the table (the engine logs + skips unknown
 * steps so a sheet typo doesn't crash the run).
 */
export function lookupStep(stepName: string): StepMapping | null {
  return STEP_TABLE[normalizeStepName(stepName)] ?? null;
}

/**
 * Useful for tests / boot-time validation: every step name the sheet uses
 * should be present in this table.
 */
export function getMappedStepCount(): number {
  return Object.keys(STEP_TABLE).length;
}

export function getAllStepMappings(): Array<{ name: string; mapping: StepMapping }> {
  return Object.entries(STEP_TABLE).map(([name, mapping]) => ({ name, mapping }));
}
