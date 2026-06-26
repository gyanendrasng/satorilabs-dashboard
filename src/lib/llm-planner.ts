/**
 * LLM planner — the single decision-maker for every inbound email.
 *
 * On every inbound email, planNextSteps() reads:
 *   - the manager prompt (ManagerV3.0.txt at repo root)
 *   - the SO's audit trail (renderAuditTrailForSO)
 *   - the SO's email thread (renderEmailThreadForSO)
 *   - the SO's current DB state (status, materials, plant_ls sent?, invoice?)
 *
 * …and asks an LLM to emit an ordered list of steps (each {kind, args}) up
 * to and including the next outbound email. The scenario engine then walks
 * those steps via its fireStep handlers; when the stop step completes, the
 * scenario parks awaiting reply. Next inbound triggers a fresh plan call.
 *
 * The LLM picks steps from a fixed vocabulary and fills in args directly
 * from the email thread — no downstream LLM extractor re-reads the body.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { prisma } from './prisma';
import { renderEmailThreadForSO } from './email-thread';
import { renderAuditTrailForSO } from './audit-trail';
import { deriveStage, type StepKind } from './dispatch-scenarios';
import { getLlmService } from './llm-service';

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

/**
 * Per-step args emitted by the planner. The planner reads the email thread +
 * audit trail and fills these in directly — no second LLM extractor runs.
 * Executor coerces JS types into the typed Prisma columns at the boundary
 * (e.g. qty: number → Material.orderQuantity: Int via Math.round).
 *
 * Args are OPTIONAL at the schema level: if the planner omits args on a step
 * that needs them, the coercion helper at the handler boundary throws and the
 * scenario fails — the planner re-plans on next tick. Permissive at the
 * schema layer keeps rollout incremental.
 */
export type MaterialOp = 'inc' | 'dec' | 'del';

export interface MaterialModification {
  code: string;
  op: MaterialOp;
  /** Required for inc / dec. Absent for del. */
  qty?: number;
}

export interface LsRevision {
  /** When the planner can identify the LS from the thread; otherwise executor resolves via (soNumber, material, batch). */
  lsNumber?: string;
  material: string;
  /** Optional. Executor falls back to existing LSI.batch if omitted. */
  batch?: string;
  qty: number;
}

export interface LsDeletion {
  lsNumber?: string;
  material: string;
  batch?: string;
}

export interface VehicleSet {
  /** When the branch reply specifies a bundle/truck index; executor resolves the Bundle row. */
  bundleNumber?: number;
  vehicleNumber: string;
  driverMobile: string;
  containerNumber: string;
}

export interface TonnageReading {
  value: number;
  unit: 't' | 'kg';
}

export type PlannedStepArgs =
  | { materials: MaterialModification[] }
  | { revisions: LsRevision[] }
  | { deletes: LsDeletion[] }
  | { vehicles: VehicleSet[] }
  | { tonnage: TonnageReading }
  | Record<string, never>;

export interface PlannedStep {
  kind: StepKind;
  /** Optional free-text reasoning from the LLM (kept for audit). */
  rationale?: string;
  /**
   * Planner-authored question text — used ONLY by the three question-asking
   * step kinds (`email_clarify_branch`, `email_clarify_plant`,
   * `email_supervisor_question`). The executor sends this verbatim as the
   * body of the outbound email. Ignored by every other step kind.
   */
  question?: string;
  /**
   * Candidate answers/options the planner is weighing. Used by
   * `email_supervisor_question` to surface the alternatives the planner is
   * stuck between. Rendered as a bulleted list in the supervisor email.
   */
  options?: string[];
  /**
   * Per-kind data the executor needs (materials, vehicles, tonnage, …).
   * The planner reads the email thread + audit and fills this in; no
   * downstream LLM extracts data again. Shape varies by `kind` — see
   * `PlannedStepArgs`. Loose `Record<string, unknown>` at this layer
   * because zod validates shape; coercion happens in the handler.
   */
  args?: Record<string, unknown>;
}

export interface PlanResult {
  /** The ordered list of steps to fire. */
  steps: PlannedStep[];
  /**
   * Index in `steps` after which the walker pauses. Typically the last
   * outbound email step. If steps is empty, this is -1 (nothing to do).
   */
  stopAfterIndex: number;
  /** The LLM's overall reasoning, surfaced in audit + ScenarioProgress.plannerRationale. */
  rationale: string;
  /** When true, the engine sends a supervisor inquiry instead of firing steps. */
  escalate: boolean;
  /** The exact question/concern for the supervisor when escalate=true. */
  escalationQuestion?: string;
}

// -----------------------------------------------------------------------------
// Manager prompt loader (cached at module load)
//
// ManagerV3.0.txt holds the whole planner prompt — process guide, OUTPUT FORMAT,
// and the change-order rules — with {{TOKEN}} placeholders that buildPlannerPrompt()
// fills in: {{AVAILABLE_STEP_KINDS}} (built on the fly from the STEP_KINDS array,
// the same source that drives Zod validation) and the per-call DB sections
// (sender, SO state, audit, thread). The rendered result is sent as ONE system
// message (see planNextSteps).
// -----------------------------------------------------------------------------

const MANAGER_PROMPT_PATH = path.join(process.cwd(), 'ManagerV3.0.txt');
let cachedPromptTemplate: string | null = null;

/**
 * Read ManagerV3.0.txt and return the LLM-facing template (still holding the
 * {{TOKEN}} placeholders). The file's leading `#` change-log header and the
 * `=== SYSTEM ===` / `=== USER ===` dividers are organisational only and are
 * stripped here so they never reach the model. Cached at module load.
 */
function loadPromptTemplate(): string {
  if (cachedPromptTemplate !== null) return cachedPromptTemplate;
  let raw: string;
  try {
    raw = fs.readFileSync(MANAGER_PROMPT_PATH, 'utf8');
  } catch (err) {
    throw new Error(
      `[llm-planner] Could not read ManagerV3.0.txt at ${MANAGER_PROMPT_PATH}: ${err instanceof Error ? err.message : String(err)}. ` +
        `This file is required for the planner to run.`,
    );
  }
  // Everything up to and including `=== SYSTEM ===` is the change-log comment
  // header — drop it. Then remove the lone `=== USER ===` divider line. What
  // remains is the full prompt with {{TOKEN}} placeholders.
  const sysMarker = '=== SYSTEM ===';
  const sysIdx = raw.indexOf(sysMarker);
  const body = sysIdx >= 0 ? raw.slice(sysIdx + sysMarker.length) : raw;
  cachedPromptTemplate = body.replace(/^[ \t]*=== USER ===[ \t]*\r?\n/m, '').trimStart();
  return cachedPromptTemplate;
}

// -----------------------------------------------------------------------------
// Step-kind vocabulary block (rendered into every user prompt)
// -----------------------------------------------------------------------------

/**
 * Each step kind's `args` shape. The planner reads the email thread and fills
 * args in directly — the executor does NOT call a second LLM to extract them.
 *
 * `argsSchema` is rendered into the prompt verbatim so the planner sees the
 * shape it must emit. `null` = step needs no args.
 */
const STEP_KINDS: Array<{ kind: StepKind; description: string; argsSchema: string | null }> = [
  {
    kind: 'stock_precheck',
    description: 'Free-stock pre-check (replaces Zmatana). Use BEFORE va02 on any increase. ' +
      'CRITICAL — the qty you check depends on whether loading slips already exist ' +
      '(read `loading slips exist (bundles frozen)` from CURRENT SO STATE):\n' +
      '  • NO loading slips yet → check the FULL new target quantity. The original ' +
      'amount has not been reserved against stock anywhere, so the whole order must ' +
      'be available. (e.g. 200 → 220 ⇒ qty: 220.)\n' +
      '  • Loading slips EXIST (frozen, or about to be wiped+recreated) → check only ' +
      'the DELTA being added. The original quantity is already accounted for by the ' +
      'existing loading slips (and in the recreate path the precheck runs BEFORE the ' +
      'wipe, so those items are still reserved). (e.g. 200 → 220 ⇒ qty: 20.)\n' +
      'This differs from va02, which ALWAYS takes the absolute new total. So when ' +
      'loading slips exist, stock_precheck.qty (delta) and va02.qty (new total) are ' +
      'DIFFERENT numbers for the same material.',
    argsSchema: '{ materials: [{ code: "<material code>", op: "inc"|"dec"|"del", qty?: <number — FULL new total when no LS exist; DELTA being added when LS exist; omit for del> }, ...] }',
  },
  {
    kind: 'bundle_capacity_assessment',
    description: 'Post-plant-intimation capacity check. Use AS THE FIRST STEP whenever plant_ls has been sent AND the branch is asking to INCREASE or ADD a material — this fires AFTER the upstream modify cycle (stock_precheck → va02 → email_2nd_release → branch ack → zso_visibility) has already raised the SO line ceiling. The engine greedily splits each material\'s deltaKg across bundles: first pack the bundle that already carries the material, then spill onto sibling bundles best-fit, then anything that doesn\'t fit becomes overflow. The verdict appears in the audit trail as step_completed bundle_capacity_assessment with payload.verdicts = [{material, verdict, allocations: [{kind: "same_bundle"|"other_bundle", bundleId, kg}, ...], overflowKg}]. Read those verdicts on your NEXT plan call (this step terminates the current plan) and emit the per-allocation step path per Rule 6e Phase 2. No SAP transaction; one engine-side step only. If the SAME request ALSO decreases/deletes other materials, pass them in args.decreases ([{material, toQty}], toQty=0=delete): the assessment credits the space they free (so the increase fits more easily) and the dispatch approval + confirmation emails show the decreased quantities. Those decreases are DISPLAY-ONLY here — the real SAP zload2 / zloading_close for them still runs later in Phase 3.',
    argsSchema: '{ items: [{ material: "<code>", deltaKg: <number, positive — the additional weight in kg this material is gaining> }, ...], decreases?: [{ material: "<code>", toQty: <integer — the material\'s NEW total quantity in units after the decrease; 0 = delete> }, ...] }',
  },
  {
    kind: 'va02',
    description:
      'Modify SO line items in SAP.\n' +
      '  • INCREASES — always list every increased material as { op: "inc", qty: <new total quantity, integer> }.\n' +
      '  • DECREASES / DELETES — list these ({ op: "dec", qty: <new total quantity, integer> } / { op: "del" }, omit qty for del) ONLY when NO loading slips exist at the moment this VA02 runs. That is: the plain pre-LS modify (WINDOW 1), and the RECREATE path where a zloading_close (args.all=true) EARLIER IN THIS SAME PLAN has already wiped the slips. In that no-slips window VA02 is the only thing that writes the dec/del to the SO line, so it MUST be listed here.\n' +
      '  • When loading slips EXIST and remain (the preserve / surgical path, and post-plant_ls) — do NOT list dec/del on VA02. They are applied to the slips via zload2 / zloading_close, and the engine flushes the pending SO-line change automatically on the NEXT VA02. In that window list ONLY increases here (the engine still auto-flushes any already-recorded pending dec/del onto the SO line on this same run).\n' +
      '  • EVERY va02 — increase, decrease, or delete — is followed by an email_2nd_release (the SO must be re-released for the change to take effect). A va02 carrying ONLY dec/del still takes a 2nd release. It skips only the increase-only steps: NO stock_precheck. (zso_visibility is still re-run on resume, since stock may have moved.)',
    argsSchema: '{ materials: [{ code: "<material code>", op: "inc"|"dec"|"del", qty?: <integer — new total for inc/dec; omit for del> }, ...] }',
  },
  {
    kind: 'zso_visibility',
    description: 'Re-run ZSO_Visibility + Zmatana. Always run after va02 to refresh material availability.',
    argsSchema: null,
  },
  {
    kind: 'lone_zmatana',
    description: 'Run ZMatana standalone for one or more material codes — fetches per-material availability + batch from SAP WITHOUT re-running ZSO_Visibility. Two uses: (1) when stock_precheck substituted a short material with a cross-plant equivalent (you will see step_completed stock_precheck with a substitutions payload) — sequence va02 → lone_zmatana → email_2nd_release; (2) the surgical/preserve delta path (Rule 6e Phase 2.5) where a new loading slip is being created for an increased material. ' +
      'DELTA: when loading slips already exist and you are fetching stock for the ADDED quantity only, pass `delta` (units) per material — the SO line already shows the new total after VA02, but the original qty is reserved by existing slips, so ZMatana should look for stock against the delta. OMIT `delta` for the substitution use-case (no delta concept; the SAP agent falls back to the SO line). The Material rows need batch + availableStock populated before any downstream step can ship them.',
    argsSchema: '{ materials: [{ code: "<material code>", delta?: <units added, positive integer — include when LS exist and only the delta needs stock; omit for substitution> }, ...] }',
  },
  {
    kind: 'mb51',
    description: 'Park on daily FCFS reactivator. Use only when waiting for new stock to arrive.',
    argsSchema: null,
  },
  {
    kind: 'zload1',
    description: 'Create loading slips (LSs). Two modes: (1) initial — no args; fans out per-bundle from the SO\'s computed bundles. (2) APPEND mode — pass args.appendToBundleId + args.materials to issue a SINGLE new LS attached to an existing bundle. Use mode (2) per Rule 6e Phase 2 for every `other_bundle` allocation returned by bundle_capacity_assessment; the materials list is the new material code + units corresponding to that allocation\'s kg leg.',
    argsSchema: '(optional, append mode only): { appendToBundleId: "<bundle cuid from audit>", materials: [{ code: "<material code>", batch: "<batch if known>", qty: <int> }, ...] }',
  },
  {
    kind: 'zload2',
    description: 'Revise existing loading slip quantities. Use when LSs already exist and qty needs updating.',
    argsSchema: '{ revisions: [{ lsNumber?: "<LS no if known from thread>", material: "<code>", batch?: "<batch if stated>", qty: <new qty, integer> }, ...] }',
  },
  {
    kind: 'zloading_close',
    description: 'Delete line items from existing LSs (ZLOAD_Delete). Two modes: (1) SURGICAL — args.deletes lists per-material rows to remove from named LSs. Use ONLY for post-plant_ls deletes per Rule 11 (bundles are frozen; we are only revising specific lines). (2) WIPE-ALL — args.all=true wipes EVERY line of EVERY LS on this SO (in SAP, deleting all lines of an LS deletes the LS itself). Use this whenever a pre-plant_ls modification cycle needs to fire (Rule 9c, Rule 10b path b) — it must be the FIRST step in that chain, before va02/zso_visibility/zload1 fresh. args.all=true is ONLY valid when no `email_sent plant_ls` exists in the audit trail. Once plant_ls has been sent, the bundle composition is FROZEN — emit per-material surgical zloading_close (Rule 11) or bundle_capacity_assessment (Rule 6e) instead. The engine will refuse args.all=true post-plant_ls and fail the scenario.',
    argsSchema: '{ all: true } | { deletes: [{ lsNumber?: "<LS no if known>", material: "<code>", batch?: "<batch>" }, ...] }',
  },
  {
    kind: 'email_2nd_release',
    description: 'Ask the BRANCH (not plant) to perform the second release after a va02 modification. The branch runs the actual release in SAP. Send AFTER va02, BEFORE re-running zso_visibility. The branch\'s reply lands as sender=branch and triggers rule 8 → zso_visibility.',
    argsSchema: '{ materials: [{ code, op: "inc"|"dec"|"del", qty?: <integer> }, ...] }  // for the email body summary',
  },
  {
    kind: 'email_confirm_product_details',
    description: 'The ls_dispatch email — confirm product/batch details with branch. Sent automatically by the zso_visibility callback; do not emit explicitly unless you specifically want to re-send.',
    argsSchema: null,
  },
  {
    kind: 'email_confirm_bundle_details',
    description: 'The dispatch_confirmation email — confirm bundle/truck plan with branch. Send after ls_dispatch was replied to with a confirmation.',
    argsSchema: null,
  },
  {
    kind: 'email_to_branch_for_vehicle',
    description: 'Ask branch for vehicle details (truck no, driver, LR). Send after ZLOAD1 creates loading slips.',
    argsSchema: null,
  },
  {
    kind: 'email_to_plant',
    description: 'Forward the LS PDF to the plant (plant_ls email). Use ONLY after branch provides vehicle details (truck/driver/LR). Sends EVERY LS for the affected bundles. Do NOT use after zload2/zloading_close — use email_modified_ls_to_plant for that.',
    argsSchema: '{ vehicles: [{ bundleNumber?: <int, omit for single-truck>, vehicleNumber: "<reg no>", driverMobile: "<10-digit>", containerNumber: "<container or empty>" }, ...] }',
  },
  {
    kind: 'email_modified_ls_to_plant',
    description: 'Forward the regenerated LS PDFs to the plant after a zload2 / zloading_close modification. Sends ONLY the LSs that were just touched by the preceding zload2/zloading_close steps in THIS plan — never every LS. Use this whenever the plan contains zload2 or zloading_close AND we need to notify the plant of the change.',
    argsSchema: null,
  },
  {
    kind: 'email_to_branch_notifying_plant_change',
    description: 'Notify branch that the plant has proposed a modification. Send when a plant reply asks for a quantity change.',
    argsSchema: '{ materials: [{ code, op: "inc"|"dec"|"del", qty?: <integer> }, ...] }  // for the email body summary',
  },
  {
    kind: 'email_order_status',
    description: 'Auto-reply with the current SO status. Use when branch asks "where is my order?" (Seeking Order Update).',
    argsSchema: null,
  },
  {
    kind: 'process_plant_invoice',
    description: 'Plant has sent an invoice PDF on a plant_ls reply. Run ZLOAD3+ZSO_Auto via the batch sender. Use WHENEVER the latest plant reply on a plant_ls thread shows "[PDF ATTACHMENT RECEIVED]" in the email thread (or the audit trail shows "[HAS PDF ATTACHMENT]" on its email_received) — that attached PDF IS the plant invoice, regardless of what the reply text says (plants often also ask for the client invoice in the same email; ignore that, the PDF is what matters). Emit this, NOT await_plant_invoice and NOT email_clarify_plant. The batch sender is scoped per (bundle, SO) and only fires ZLOAD3 once every loading slip in that bundle has replied with its PDF, so it is safe to emit on each plant reply.',
    argsSchema: null,
  },
  {
    kind: 'process_tonnage_reply',
    description: 'Branch replied to a tonnage_inquiry email with the vehicle/truck tonnage. Use ONLY when the latest inbound is a reply on a tonnage_inquiry thread and contains a number that looks like a truck capacity (e.g. "35 t", "35000 kg"). The executor writes po.weightage (PO-level — affects every SO under the PO), and the next inbound resumes normal dispatch. Note: tonnage_inquiry is a PO-scoped email anchored on the lead SO of the PO (project convention); the same PO.weightage benefits every SO.',
    argsSchema: '{ tonnage: { value: <number as stated>, unit: "t"|"kg" } }  // executor converts kg→t before writing',
  },
  {
    kind: 'email_clarify_branch',
    description: 'Reply in-thread to BRANCH asking a focused clarifying question. Use when the branch reply is ambiguous, incomplete, or only partially answers what we asked. Provide the exact question text on this step as `question`. The executor sends the email verbatim and pauses; the branch reply will trigger a fresh plan.',
    argsSchema: null,
  },
  {
    kind: 'email_clarify_plant',
    description: 'Reply in-thread to PLANT asking a focused clarifying question. Use when the plant reply is ambiguous, incomplete, or only partially answers what we asked. Provide the exact question text on this step as `question`. The executor sends the email verbatim and pauses.',
    argsSchema: null,
  },
  {
    kind: 'email_supervisor_question',
    description: 'Email the SUPERVISOR for guidance when you do not know which step to take. Use ONLY when the audit trail / email thread leave you genuinely unable to choose between options. Provide the exact question text as `question` and the alternatives you are weighing as `options` (each a short phrase). The executor sends the email and pauses; the supervisor reply will be classified by the next plan.',
    argsSchema: null,
  },
  {
    kind: 'email_branch_overflow_request',
    description: 'Send the branch a "partial dispatch, please confirm" email when a bundle_capacity_assessment returned `partial_overflow` (some kg placed, some overflow) or `needs_new_so` (nothing placed) AND we want the branch to acknowledge the partial plan + raise a fresh SO for the overflow BEFORE we touch SAP. Use as the FIRST step after bundle_capacity_assessment whenever overflowKgTotal > 0 (Rule 6e Phase 1.5). The args carry the placed vs overflow split per material so the email body can show both. After the branch replies confirming, Rule 6e Phase 2 fires (stock_precheck → va02 → email_2nd_release for the placed portion).',
    argsSchema: '{ items: [{ material: "<code>", placedKg: <number>, overflowKg: <number> }, ...] }',
  },
  {
    kind: 'email_branch_request_new_so',
    description: 'Send the branch a final-step email telling them their requested increase cannot be accommodated within the existing dispatch plan (every bundle on the PO is full and already intimated to the plant) and asking them to raise a fresh SO for the additional units. Use ONLY when a prior bundle_capacity_assessment returned `needs_new_so` for at least one item AND the partial path is not being run. Terminal — the new SO arrives as a normal NEW ORDER email and re-enters the pipeline.',
    argsSchema: '{ items: [{ material: "<code>", deltaKg: <number, the overflow weight that cannot be accommodated> }, ...] }',
  },
  {
    kind: 'await_plant_invoice',
    description: 'Sentinel — pause until the plant emails an invoice. Use ONLY when the plant has acknowledged the loading slip but its reply has NO PDF attachment (no "[PDF ATTACHMENT RECEIVED]" in the thread / "[HAS PDF ATTACHMENT]" in the audit trail). If a PDF WAS received, the invoice has ALREADY arrived → emit process_plant_invoice instead. NEVER emit email_clarify_plant asking the plant to send an invoice they already attached.',
    argsSchema: null,
  },
  {
    kind: 'await_vt01n',
    description: 'Sentinel — pause until the operator (or pipeline) fires VT01N for the shipment.',
    argsSchema: null,
  },
];

function renderStepVocabulary(): string {
  const lines = ['AVAILABLE STEP KINDS (you MUST pick `kind` values from this list):'];
  for (const s of STEP_KINDS) {
    if (s.argsSchema) {
      lines.push(`- ${s.kind}: ${s.description}`);
      lines.push(`    args: ${s.argsSchema}`);
    } else {
      lines.push(`- ${s.kind}: ${s.description}  (no args)`);
    }
  }
  return lines.join('\n');
}

// -----------------------------------------------------------------------------
// Current SO state block (rendered into every user prompt)
// -----------------------------------------------------------------------------

interface SoStateSnapshot {
  soNumber: string;
  customer: string | null;
  status: string;
  stage: string;
  materialCount: number;
  /** Number of LoadingSlip rows on this SO (ZLOAD1 has created them). */
  lsCount: number;
  /** True once ANY LoadingSlip row exists — bundle composition is FROZEN from
   *  this point (the preserve/recreate fork keys on this). */
  loadingSlipsExist: boolean;
  plantLsSent: boolean;
  /** True once the branch has shared vehicle details (any Bundle on the PO has a
   *  vehicleNumber) OR plant_ls has been sent. Drives the VEHICLE GATE (Rule V):
   *  reuse on-file details instead of re-asking. */
  vehicleDetailsReceived: boolean;
  invoiceReceived: boolean;
  shipmentCreated: boolean;
  materialLines: string[];
  /** Per-PO truck capacity (tonnes). Null until branch shares — bundling is blocked. */
  poWeightageTonnes: number | null;
  /** A tonnage_inquiry email is sent and awaiting branch reply on this PO. */
  tonnageInquiryPending: boolean;
  /** Total SOs that share this PO (and therefore share this tonnage). */
  poSoCount: number;
}

async function buildSoStateSnapshot(salesOrderId: string): Promise<SoStateSnapshot | null> {
  const so = await prisma.salesOrder.findUnique({
    where: { id: salesOrderId },
    include: {
      materials: { orderBy: { createdAt: 'asc' } },
      items: { select: { id: true } },
      loadingSlips: { select: { id: true } },
      purchaseOrder: {
        include: {
          customer: true,
          salesOrders: { select: { id: true } },
        },
      },
      invoice: { select: { id: true } },
      shipments: { select: { id: true, status: true } },
    },
  });
  if (!so) return null;

  const plantLs = await prisma.email.findFirst({
    where: { salesOrderId, emailType: 'plant_ls', status: { in: ['sent', 'replied'] } },
    select: { id: true },
  });

  // Vehicle details are captured per-Bundle on the parent PO (Bundle.vehicleNumber).
  // Any populated bundle — or a sent plant_ls — means the branch has shared
  // transport, so the VEHICLE GATE reuses it instead of re-asking. Mirrors the
  // `after_vehicle_placement` check in deriveStage.
  const vehiclePlaced = so.purchaseOrder
    ? await prisma.bundle.findFirst({
        where: { purchaseOrderId: so.purchaseOrder.id, vehicleNumber: { not: null } },
        select: { id: true },
      })
    : null;

  const stage = await deriveStage(salesOrderId);

  const materialLines = so.materials.map((m) => {
    const ord = m.orderQuantity ?? 0;
    const avail = m.availableStock ?? '?';
    const batch = m.batch || 'N/A';
    return `  - ${m.material} (Batch ${batch}): ordered ${ord}, available ${avail}`;
  });

  // PO-level tonnage state. Tonnage is per-PO (one truck → one capacity →
  // applies to every SO of the PO). Bundling is blocked until this lands.
  const poWeightage = so.purchaseOrder?.weightage ? Number(so.purchaseOrder.weightage) : null;
  let tonnageInquiryPending = false;
  if (so.purchaseOrder && (poWeightage === null || poWeightage <= 0)) {
    const pendingInquiry = await prisma.email.findFirst({
      where: {
        purchaseOrderId: so.purchaseOrder.id,
        emailType: 'tonnage_inquiry',
        status: 'sent',
        repliedAt: null,
      },
      select: { id: true },
    });
    tonnageInquiryPending = !!pendingInquiry;
  }

  return {
    soNumber: so.soNumber,
    customer: so.purchaseOrder?.customer?.name ?? so.purchaseOrder?.customerName ?? null,
    status: so.status,
    stage,
    materialCount: so.materials.length,
    lsCount: so.loadingSlips.length,
    loadingSlipsExist: so.loadingSlips.length > 0,
    plantLsSent: !!plantLs,
    vehicleDetailsReceived: !!plantLs || !!vehiclePlaced,
    invoiceReceived: !!so.invoice,
    shipmentCreated: so.shipments.length > 0,
    materialLines,
    poWeightageTonnes: poWeightage,
    tonnageInquiryPending,
    poSoCount: so.purchaseOrder?.salesOrders.length ?? 1,
  };
}

function renderSoState(s: SoStateSnapshot): string {
  const tonnageLine =
    s.poWeightageTonnes !== null && s.poWeightageTonnes > 0
      ? `- PO vehicle tonnage: ${s.poWeightageTonnes} t (per-PO; shared by ${s.poSoCount} SO${s.poSoCount === 1 ? '' : 's'})`
      : s.tonnageInquiryPending
        ? `- PO vehicle tonnage: (NOT SHARED YET — tonnage_inquiry sent, awaiting branch reply; affects ${s.poSoCount} SO${s.poSoCount === 1 ? '' : 's'})`
        : `- PO vehicle tonnage: (NOT SHARED YET — no tonnage_inquiry on file; affects ${s.poSoCount} SO${s.poSoCount === 1 ? '' : 's'})`;
  return [
    'CURRENT SO STATE:',
    `- soNumber: ${s.soNumber}`,
    `- customer: ${s.customer ?? '(unknown)'}`,
    `- status: ${s.status}`,
    `- stage (derived): ${s.stage}`,
    `- material lines: ${s.materialCount}`,
    `- loading slips created: ${s.lsCount}`,
    `- loading slips exist (bundles frozen): ${s.loadingSlipsExist ? 'yes' : 'no'}`,
    tonnageLine,
    `- plant_ls email sent: ${s.plantLsSent ? 'yes' : 'no'}`,
    `- vehicle details received: ${s.vehicleDetailsReceived ? 'yes' : 'no'}`,
    `- plant invoice received: ${s.invoiceReceived ? 'yes' : 'no'}`,
    `- shipment created: ${s.shipmentCreated ? 'yes' : 'no'}`,
    '',
    'MATERIALS:',
    ...(s.materialLines.length > 0 ? s.materialLines : ['  (none loaded yet)']),
  ].join('\n');
}

// -----------------------------------------------------------------------------
// Output JSON schema (Zod)
// -----------------------------------------------------------------------------

// Single source of truth for the kind vocabulary: STEP_KINDS drives BOTH the
// AVAILABLE STEP KINDS block injected into the prompt (renderStepVocabulary) AND
// this Zod validation tuple — so the prompt and the validator can never drift.
const VALID_STEP_KINDS = STEP_KINDS.map((s) => s.kind) as [StepKind, ...StepKind[]];

// Args schema is shape-only — we trust the planner to emit the right fields
// per the step kind. Executor coerces and routes coercion failures through
// the `scenario_failed` path, which re-triggers the planner on next tick.
const PlannedStepSchema = z.object({
  kind: z.enum(VALID_STEP_KINDS),
  rationale: z.string().optional(),
  question: z.string().optional(),
  options: z.array(z.string()).optional(),
  args: z.record(z.string(), z.unknown()).optional(),
});

const PlanResultSchema = z.object({
  rationale: z.string(),
  steps: z.array(PlannedStepSchema),
  stop_after_index: z.number().int(),
  escalate: z.boolean(),
  escalation_question: z.string().nullable().optional(),
});

// -----------------------------------------------------------------------------
// Prompt construction
// -----------------------------------------------------------------------------

/**
 * Render the full V3.0 planner prompt: load the ManagerV3.0.txt template and
 * substitute its {{TOKEN}} placeholders — {{AVAILABLE_STEP_KINDS}} (built from
 * STEP_KINDS) plus the four per-call DB sections. The returned string is sent
 * verbatim as a single system message.
 */
export async function buildPlannerPrompt(args: {
  salesOrderId: string;
  triggerEmailId: string;
  sender: 'branch' | 'plant' | 'production';
}): Promise<string> {
  const [auditTrail, emailThread, soSnapshot] = await Promise.all([
    renderAuditTrailForSO({ salesOrderId: args.salesOrderId }),
    renderEmailThreadForSO({ salesOrderId: args.salesOrderId }),
    buildSoStateSnapshot(args.salesOrderId),
  ]);

  const soState = soSnapshot ? renderSoState(soSnapshot) : '(SO snapshot unavailable)';

  // Use FUNCTION replacers (not string replacers) so a literal `$` in the
  // rendered content can't trigger `$&` / `$1` special-pattern substitution.
  // {{AVAILABLE_STEP_KINDS}} is built on the fly from the STEP_KINDS array (the
  // single source that also drives Zod validation); the per-call DB sections
  // fill the rest.
  return loadPromptTemplate()
    .replace('{{AVAILABLE_STEP_KINDS}}', () => renderStepVocabulary())
    .replace('{{SENDER}}', () => args.sender)
    .replace('{{SO_STATE}}', () => soState)
    .replace('{{AUDIT_TRAIL}}', () => auditTrail)
    .replace('{{EMAIL_THREAD}}', () => emailThread);
}

// -----------------------------------------------------------------------------
// Public entry point
// -----------------------------------------------------------------------------

/**
 * Write the literal (system, user) prompt pair for this plan call to a file
 * under `test_artifacts/planner-prompts/` for offline inspection. Gated on
 * the PLANNER_DUMP_PROMPTS env flag so prod stays clean.
 *
 * Filename: `<UTC-timestamp>__<soNumber>__<triggerEmailId>.txt`
 *   - Timestamp first → lexicographic sort == chronological sort.
 *   - soNumber second → easy human-scan inside the folder.
 *   - triggerEmailId last → guarantees uniqueness; a single trigger that
 *     gets retried (e.g. zod-parse failure → re-plan on next tick) writes
 *     a second file with a different timestamp prefix.
 *
 * Any failure here is swallowed — the dump must never break a real plan call.
 */
async function dumpPromptToFile(
  salesOrderId: string,
  triggerEmailId: string,
  prompt: string,
): Promise<void> {
  if ((process.env.PLANNER_DUMP_PROMPTS ?? 'false').toLowerCase() !== 'true') return;
  try {
    const so = await prisma.salesOrder.findUnique({
      where: { id: salesOrderId },
      select: { soNumber: true },
    });
    const soNumber = so?.soNumber ?? 'unknown';
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = path.join(process.cwd(), 'test_artifacts', 'planner-prompts');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${ts}__${soNumber}__${triggerEmailId}.txt`);
    fs.writeFileSync(filePath, `${prompt}\n`, 'utf8');
  } catch (err) {
    console.warn(
      `[llm-planner] PLANNER_DUMP_PROMPTS write failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function planNextSteps(args: {
  salesOrderId: string;
  triggerEmailId: string;
  sender: 'branch' | 'plant' | 'production';
}): Promise<PlanResult> {
  const prompt = await buildPlannerPrompt(args);

  await dumpPromptToFile(args.salesOrderId, args.triggerEmailId, prompt);

  // All LLM calls in the dashboard go through getLlmService(), which selects
  // the provider/model from env vars (LLM_PROVIDER / LLM_MODEL / *_API_KEY).
  // See src/lib/llm-service.ts for the full env contract.
  const llm = getLlmService();

  // Retry the LLM call + parse + Zod-validate up to PLANNER_LLM_ATTEMPTS times.
  // Transient failure modes that warrant a retry:
  //   - llm.chat() throws (network blip, provider 5xx, JSON parse failure
  //     inside parseJsonStrict because the model emitted truncated /
  //     malformed output)
  //   - empty text (provider returned a 200 with no body — has happened with
  //     Gemini under load)
  //   - Zod validation fails (the model produced syntactically valid JSON
  //     that doesn't match PlanResultSchema — usually a missing required
  //     field on a step the model improvised)
  // We do NOT retry on planFailure(...) for application-logic reasons: only
  // on actual parse/validation/network failures.
  const PLANNER_LLM_ATTEMPTS = 3;
  let result: Awaited<ReturnType<typeof llm.chat>> | null = null;
  let validated: ReturnType<typeof PlanResultSchema.safeParse> | null = null;
  let lastErr: unknown = null;

  for (let attempt = 1; attempt <= PLANNER_LLM_ATTEMPTS; attempt++) {
    try {
      result = await llm.chat({
        // V3.0 sends the ENTIRE rendered prompt as one system message. The user
        // turn is a content-free trigger only — required because the Gemini
        // provider maps `system` to systemInstruction and would otherwise be
        // left with empty `contents` (see llm-service.ts). All prompt content
        // lives in `system`.
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: 'Produce the JSON plan for the latest inbound email now.' },
        ],
        requireJson: true,
        // Planner output is a structured JSON plan (rationale + steps[] with
        // nested args, plus per-step rationale strings) and can run long on
        // multi-step modify cycles. Lock the cap here so a low LLM_MAX_TOKENS
        // env value can't truncate the JSON mid-stream and fail the Zod parse.
        maxTokens: 50000,
      });

      if (!result.text) {
        lastErr = new Error(
          `LLM returned empty content (provider=${result.provider} model=${result.model})`,
        );
        result = null;
        console.warn(
          `[PLANNER_RETRY] soId=${args.salesOrderId} attempt=${attempt}/${PLANNER_LLM_ATTEMPTS} reason=empty-content`,
        );
        continue;
      }

      // llm.chat() with requireJson=true already parsed JSON; if the model
      // emitted something unparseable, chat() would have thrown above and
      // we'd already be in the catch block.
      validated = PlanResultSchema.safeParse(result.json);
      if (validated.success) {
        break;
      }

      // Zod failed — log and retry. Keep the raw response in the warn line
      // for offline debugging.
      const raw = result.text;
      const preview = raw.length > 600 ? raw.slice(0, 600) + '…' : raw;
      console.warn(
        `[PLANNER_RETRY] soId=${args.salesOrderId} attempt=${attempt}/${PLANNER_LLM_ATTEMPTS} reason=zod-fail ` +
          `errors=${JSON.stringify(validated.error.issues)} raw=${preview}`,
      );
      lastErr = new Error(`Zod validation failed: ${validated.error.message}`);
      result = null;
      validated = null;
    } catch (e) {
      lastErr = e;
      console.warn(
        `[PLANNER_RETRY] soId=${args.salesOrderId} attempt=${attempt}/${PLANNER_LLM_ATTEMPTS} reason=throw ` +
          `error=${e instanceof Error ? e.message : String(e)}\n` +
          `stack=${e instanceof Error && e.stack ? e.stack : '(no stack)'}`,
      );
      result = null;
      validated = null;
    }

    // Backoff before the next attempt (skip after the last attempt).
    if (attempt < PLANNER_LLM_ATTEMPTS) {
      const backoffMs = 300 * attempt;
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }

  if (!result || !validated || !validated.success) {
    const msg = lastErr instanceof Error ? lastErr.message : String(lastErr ?? 'unknown');
    return planFailure(
      `Planner LLM call failed after ${PLANNER_LLM_ATTEMPTS} attempts: ${msg}`,
    );
  }

  const v = validated.data;

  // Normalise stop_after_index: it must be either -1 (nothing to do) or a
  // valid index into steps. Clamp generously rather than fail closed.
  let stopAfterIndex = v.stop_after_index;
  if (v.steps.length === 0) {
    stopAfterIndex = -1;
  } else if (stopAfterIndex < 0 || stopAfterIndex >= v.steps.length) {
    // LLM picked a nonsensical index. Default to the last step.
    stopAfterIndex = v.steps.length - 1;
  }

  console.log(
    `[PLANNER] soId=${args.salesOrderId} emailId=${args.triggerEmailId} sender=${args.sender} ` +
      `steps=${v.steps.map((s) => s.kind).join(',') || '∅'} stopAfter=${stopAfterIndex} escalate=${v.escalate}`,
  );

  return {
    steps: v.steps,
    stopAfterIndex,
    rationale: v.rationale,
    escalate: v.escalate,
    escalationQuestion: v.escalation_question ?? undefined,
  };
}

function planFailure(reason: string): PlanResult {
  console.warn(`[PLANNER_FAIL] ${reason} — escalating`);
  return {
    steps: [],
    stopAfterIndex: -1,
    rationale: '(planner failed)',
    escalate: true,
    escalationQuestion: `Planner failure: ${reason}`,
  };
}
