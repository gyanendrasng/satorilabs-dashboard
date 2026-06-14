/**
 * LLM planner — the single decision-maker for every inbound email.
 *
 * On every inbound email, planNextSteps() reads:
 *   - the manager prompt (ManagerV2.1.txt at repo root)
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
// -----------------------------------------------------------------------------

const MANAGER_PROMPT_PATH = path.join(process.cwd(), 'ManagerV2.1.txt');
let cachedManagerPrompt: string | null = null;

function loadManagerPrompt(): string {
  if (cachedManagerPrompt !== null) return cachedManagerPrompt;
  try {
    cachedManagerPrompt = fs.readFileSync(MANAGER_PROMPT_PATH, 'utf8');
  } catch (err) {
    throw new Error(
      `[llm-planner] Could not read ManagerV2.1.txt at ${MANAGER_PROMPT_PATH}: ${err instanceof Error ? err.message : String(err)}. ` +
        `This file is required for the planner to run.`,
    );
  }
  return cachedManagerPrompt;
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
    description: 'Free-stock pre-check (replaces Zmatana). Use BEFORE va02 on any increase.',
    argsSchema: '{ materials: [{ code: "<material code>", op: "inc"|"dec"|"del", qty?: <number, omit for del> }, ...] }',
  },
  {
    kind: 'bundle_capacity_assessment',
    description: 'Post-plant-intimation capacity check. Use AS THE VERY FIRST STEP (before stock_precheck) whenever plant_ls has been sent AND the branch is asking to INCREASE or ADD a material. The engine computes, per material delta in kg, whether the increase fits in the bundle that already carries the material, a different bundle on the same PO, or no bundle at all. The verdict appears in the audit trail as step_completed bundle_capacity_assessment with payload.verdicts = [{material, verdict, bundleId, remainingKg}]. Read those verdicts on your NEXT plan call (this step terminates the current plan) and emit the per-item path per Rule 11. No SAP transaction; one engine-side step only.',
    argsSchema: '{ items: [{ material: "<code>", deltaKg: <number, positive — the additional weight in kg this material is gaining> }, ...] }',
  },
  {
    kind: 'va02',
    description: 'Modify SO line items in SAP. Use ONLY when increasing a material quantity. Decreases and deletes do not need va02.',
    argsSchema: '{ materials: [{ code: "<material code>", op: "inc", qty: <new total quantity, integer> }, ...] }',
  },
  {
    kind: 'zso_visibility',
    description: 'Re-run ZSO_Visibility + Zmatana. Always run after va02 to refresh material availability.',
    argsSchema: null,
  },
  {
    kind: 'lone_zmatana',
    description: 'Run ZMatana standalone for one or more material codes — fetches per-material availability + batch from SAP WITHOUT re-running ZSO_Visibility. Use ONLY when stock_precheck substituted a short material with a cross-plant equivalent (you will see step_completed stock_precheck with a substitutions payload in the audit trail). Sequence: va02 (with the substitute material codes) → lone_zmatana (with the same substitute codes) → email_2nd_release. The substitute Material rows need batch + availableStock populated before any downstream step can ship them.',
    argsSchema: '{ materials: [{ code: "<substitute material code>" }, ...] }',
  },
  {
    kind: 'mb51',
    description: 'Park on daily FCFS reactivator. Use only when waiting for new stock to arrive.',
    argsSchema: null,
  },
  {
    kind: 'zload1',
    description: 'Create loading slips (LSs). Two modes: (1) initial — no args; fans out per-bundle from the SO\'s computed bundles. (2) APPEND mode — pass args.appendToBundleId + args.materials to issue a SINGLE new LS attached to an existing bundle. Use mode (2) ONLY after a bundle_capacity_assessment verdict of `fits_other_bundle` post-plant-intimation; the materials list is the just-VA02\'d new SO line(s) going onto the target bundle.',
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
    description: 'Ask the PLANT (not branch) to perform the second release after a va02 modification. The plant runs the actual release in SAP. Send AFTER va02, BEFORE re-running zso_visibility. The plant\'s reply lands as sender=plant and triggers rule 8 → zso_visibility.',
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
    description: 'Plant has sent an invoice PDF on a plant_ls reply. Run ZLOAD3+ZSO_Auto via the batch sender. Use when the latest plant reply has a PDF attachment.',
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
    kind: 'email_branch_request_new_so',
    description: 'Send the branch a final-step email telling them their requested increase cannot be accommodated within the existing dispatch plan (every bundle on the PO is full and already intimated to the plant) and asking them to raise a fresh SO for the additional units. Use ONLY when a prior bundle_capacity_assessment returned `needs_new_so` for at least one item. Terminal — the new SO arrives as a normal NEW ORDER email and re-enters the pipeline.',
    argsSchema: '{ items: [{ material: "<code>", deltaKg: <number, the overflow weight that cannot be accommodated> }, ...] }',
  },
  {
    kind: 'await_plant_invoice',
    description: 'Sentinel — pause execution until the plant emails an invoice. The next plant reply will resume.',
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
  lsCount: number;
  plantLsSent: boolean;
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
    lsCount: so.items.length,
    plantLsSent: !!plantLs,
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
    tonnageLine,
    `- plant_ls email sent: ${s.plantLsSent ? 'yes' : 'no'}`,
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

const OUTPUT_FORMAT_BLOCK = `
OUTPUT FORMAT — RETURN STRICT JSON. NO MARKDOWN. NO PROSE OUTSIDE THE JSON.

{
  "rationale": "Short explanation of what the latest email is asking for and why these steps follow.",
  "steps": [
    { "kind": "<step_kind from vocab above>", "rationale": "why this step", "args": { /* per the step's argsSchema, omit if the step has no args */ } }
  ],
  "stop_after_index": <integer — the LAST index in steps that fires before we pause; usually points at the last outbound email step>,
  "escalate": false,
  "escalation_question": null
}

Examples of step objects with args (shape per AVAILABLE STEP KINDS argsSchema):
  { "kind": "va02", "rationale": "branch asked to bump M-A to 257", "args": { "materials": [{ "code": "M-A", "op": "inc", "qty": 257 }] } }
  { "kind": "zload2", "rationale": "decrease M-B to 80 on LS 12345", "args": { "revisions": [{ "lsNumber": "12345", "material": "M-B", "qty": 80 }] } }
  { "kind": "email_to_plant", "rationale": "branch shared truck details", "args": { "vehicles": [{ "vehicleNumber": "MH12AB1234", "driverMobile": "9999999999", "containerNumber": "" }] } }
  { "kind": "process_tonnage_reply", "rationale": "branch shared 35 t", "args": { "tonnage": { "value": 35, "unit": "t" } } }
  { "kind": "zso_visibility", "rationale": "plant confirmed 2nd release" }  // no args

For the three question-asking step kinds — email_clarify_branch, email_clarify_plant, email_supervisor_question — the step object MUST also include:
{ "kind": "email_clarify_branch", "rationale": "...", "question": "<exact text to send>" }
{ "kind": "email_supervisor_question", "rationale": "...", "question": "<situation>", "options": ["option A", "option B", ...] }
Omit "question" / "options" for any other step kind.

RULES:
0. **PO TONNAGE GATE (check this FIRST, before any other rule).**
   Vehicle tonnage is a per-PO fact that controls bundle/truck packing for every SO of the PO. The CURRENT SO STATE block above tells you whether it's known. While "PO vehicle tonnage" is NOT SHARED YET:
     - DO NOT emit any of: email_confirm_bundle_details, zload1, email_to_branch_for_vehicle, email_to_plant. Bundling is impossible without a truck capacity.
     - If the state line says "tonnage_inquiry sent, awaiting branch reply" → return steps=[] with rationale "waiting on tonnage_inquiry reply before bundling; resume on next inbound". The branch will reply on the tonnage_inquiry thread; that reply will trigger process_tonnage_reply and unblock the flow automatically.
     - If the state line says "no tonnage_inquiry on file" → emit a single email_clarify_branch step asking for the vehicle tonnage. STOP. Example question: "Could you share the vehicle/truck tonnage (capacity) for this dispatch? We need it to plan the bundle/truck split."
     - If the latest inbound IS itself a reply on a tonnage_inquiry thread and contains tonnage, emit process_tonnage_reply (per rule 14) — that's the unblock.
     - You MAY still emit non-bundle, non-truck steps that don't depend on tonnage (e.g. process_plant_invoice on a separate flow, email_order_status for a status question).
1. Plan up to and including the NEXT outbound email. STOP at that email. The next inbound email will trigger a fresh plan call.
2. Pick step kinds ONLY from the AVAILABLE STEP KINDS list. Out-of-vocab values are rejected.
3. EVERY step that has an argsSchema in AVAILABLE STEP KINDS MUST include an \`args\` object matching that schema. The args you emit are passed VERBATIM to the executor — no downstream LLM re-extracts them from the email body. You have the full email thread above; read it and fill the args in. Use the SAME material codes / LS numbers / vehicle numbers the email thread uses (do not invent or normalise). If a step's argsSchema is null/none, omit \`args\` entirely.
   For SAP-mutating steps (va02, zload2, zloading_close, stock_precheck) the args drive REAL transactions. If you would have to guess to fill them in, do NOT emit the step — emit email_clarify_branch / email_clarify_plant instead (see rule 15).
4. If you are unsure what the email means, or the right action requires authority you don't have, set escalate=true and put the question in escalation_question. Leave steps as [].
5. Re-read the audit trail. The trail lists every step that has already completed on this SO (step_completed events). DO NOT re-emit a step the trail shows as completed unless the latest inbound is explicitly asking for a re-do. The engine no longer suppresses duplicates for you — YOU are the suppression. If the latest inbound looks like one you have already handled (e.g. a dispatch_confirmation was already sent this round and the branch's reply is "ok, confirmed"), either (i) continue forward to the next stage, (ii) emit nothing and STOP (steps=[], stop_after_index=-1), or (iii) emit email_clarify_* if you can't tell why we're being re-triggered.
   Example: if ZLOAD1 already fired (step_completed zload1 in audit) AND plant_ls has been sent, modifying qty post-plant_ls uses zload2 (per Rule 6e/Rule 11). If ZLOAD1 has fired but plant_ls has NOT been sent, modifying qty wipes the LSs first via zloading_close (args.all=true) and re-fires zload1 fresh — NEVER zload2 (per Rule 6b / Rule 9c / Rule 10b path b).

THE STANDARD DISPATCH SEQUENCE (memorise this — every order goes through it):

  STAGE A — Product confirmation
    inbound: NEW ORDER  → (cron-driven) zso_visibility → email_confirm_product_details auto-sent
    inbound: branch replies on ls_dispatch → emit email_confirm_bundle_details. STOP.
  STAGE B — Bundle confirmation
    inbound: branch confirms dispatch_confirmation → emit zload1, then email_to_branch_for_vehicle. STOP at vehicle email.
  STAGE C — Vehicle + plant
    inbound: branch sends vehicle details → emit email_to_plant. STOP.
  STAGE D — Plant invoice
    inbound: plant replies with invoice PDF → emit process_plant_invoice. STOP.
    The downstream VT01N is operator-driven; await_vt01n is only emitted if you want to mark the wait explicitly.

CRITICAL: The branch MUST confirm the bundle plan before ZLOAD1 fires. Even when the branch's ls_dispatch reply says "release everything, proceed" — that confirms PRODUCT details. We still need to send email_confirm_bundle_details (dispatch_confirmation) so the branch can confirm the BUNDLE / truck split. Do NOT skip directly from ls_dispatch reply to zload1. The two-confirmation pattern (product, then bundle) is a hard rule of the process — see ManagerV2.1, section 1E.

MODIFICATIONS (deviations from the standard sequence):

A modification flow happens across MANY plans, one per inbound email. Each
of the segments below is a SEPARATE plan triggered by a SEPARATE inbound.

CRITICAL — WHO IS ASKING FOR THE CHANGE:
The "SENDER OF LATEST EMAIL" field at the top of this prompt tells you who
sent the reply (branch / plant / production). The TRIGGER email type tells
you which thread the reply landed on, not who sent it. A reply on a
plant_ls email may come FROM the branch (asking to modify the LS) OR
FROM the plant (responding with invoice / shortage). Read SENDER, not
trigger email type, to decide whose intent this is.

  - SENDER=branch + reply asks to modify quantities/lines → BRANCH-side
    modification. Branch IS the customer authorizing changes. Fire SAP
    transactions directly (zload2 / zloading_close / va02). Do NOT emit
    email_to_branch_notifying_plant_change — that's only when the PLANT
    is proposing changes that the branch needs to approve.
  - SENDER=plant + reply asks to modify quantities/lines → PLANT-side
    proposal. Emit email_to_branch_notifying_plant_change first (branch
    must approve before we touch SAP).
  - SENDER=plant + reply is a confirmation/acknowledgment on a 2nd_release
    email ("yes", "done", "released", "ok"). This is NOT a modification —
    it's the plant confirming they performed the requested second release
    in SAP. Apply rule 8 (emit zso_visibility), NOT zload2 /
    email_modified_ls_to_plant. The presence of an existing LSI does not
    change this: rule 8 wins because the trigger email is 2nd_release.

  6. INBOUND: branch MODIFY-INCREASE on ls_dispatch (pre-LS, no LSs yet).
     EMIT: stock_precheck → va02 → email_2nd_release. STOP.

  6b. INBOUND: branch MODIFY-INCREASE — LSs exist but plant_ls NOT yet sent
      (audit trail has step_completed zload1 ✓ but NO email_sent plant_ls).
      Bundles can still be re-composed safely, but ONLY by wiping every
      existing LS first so the bundler can re-pack optimally for the new
      quantities. EMIT: zloading_close (args.all=true) → stock_precheck →
      va02 → email_2nd_release. STOP.
      Do NOT emit zload2 in this case — pre-plant_ls modifications NEVER
      use zload2. The wipe-and-re-bundle path produces optimal truck
      packing; zload2 leaves the existing bundle composition frozen.
      Downstream: after the plant acks 2nd_release, Rule 8 fires zso_visibility,
      the visibility callback auto-sends a round-2 ls_dispatch, the branch
      accepts the new material list (Rule 9 case a → email_confirm_bundle_details
      which calls the bundler to wipe + recreate Bundle rows), the branch
      accepts the new bundle plan (Rule 10b path a → zload1 fresh →
      email_to_branch_for_vehicle). No ZLOAD2 anywhere in this chain.

  6e. INBOUND: branch MODIFY-INCREASE / MODIFY-ADD-MATERIAL on a plant_ls
      email — i.e. plant_ls has already been sent (CURRENT SO STATE shows
      \`plant_ls email sent: yes\` AND audit trail has \`email_sent plant_ls\`).
      Bundles are FROZEN: loading slips cannot migrate between bundles.

      **CRITICAL — TWO-PHASE RULE. Check the audit trail before emitting:**
      - PHASE 1 (no prior bundle_capacity_assessment for this modification
        yet — the audit trail does NOT contain a recent
        \`step_completed bundle_capacity_assessment\` with verdicts AFTER
        the latest plant_ls / email_received for this modify request):
        Your ONLY step is bundle_capacity_assessment with one items[]
        entry per material being increased / added. deltaKg = additional
        kilograms this material is gaining (read it from the email —
        branch usually states units; convert via the material's
        Material.orderWeightKg if shown, otherwise read the email's
        weight figure directly). STOP after bundle_capacity_assessment;
        the engine emits step_completed with verdicts and re-enters this
        planner.
      - PHASE 2 (the audit trail DOES contain
        \`step_completed bundle_capacity_assessment\` with a \`verdicts:\`
        summary AFTER the latest inbound modification email): the verdicts
        are already known. DO NOT re-emit bundle_capacity_assessment —
        doing so triggers an infinite loop. Read the verdicts directly
        from the audit line (format: \`material=verdict(bundleId=...,
        remainingKg=...)\`) and emit the per-item path below.

      On the NEXT plan call (Phase 2):
        - For each item with verdict='fits_same_bundle':
          EMIT (per item) stock_precheck → va02 → email_2nd_release →
          zso_visibility → zload2 → email_modified_ls_to_plant.
        - For each item with verdict='fits_other_bundle':
          EMIT (per item) stock_precheck → va02 → email_2nd_release →
          zso_visibility → zload1 (APPEND mode — pass args.appendToBundleId
          and args.materials carrying the new material code + qty) →
          email_to_plant. The zload1 step here MUST include args; without
          them the engine treats it as initial-mode which would re-bundle
          and fail with BundlesFrozenError.
        - If ANY item has verdict='needs_new_so':
          EMIT email_branch_request_new_so with args.items =
          [{material, deltaKg}] for the overflow items. STOP. Do NOT
          emit va02 for those items. Items that DID fit (same or other
          bundle) can be progressed on the same plan call; only the
          overflow items are deferred to the new-SO request.
      Multiple items in one reply MAY mix verdicts; emit per-item paths
      in order (fits-bundle items first, overflow last).
      Do NOT skip bundle_capacity_assessment when plant_ls has been sent —
      Rule 6 / 6b apply only BEFORE plant_ls.

  6c. RE-PLAN AFTER CROSS-PLANT SUBSTITUTION. If the audit trail shows a
      step_completed for stock_precheck with a \`substitutions\` payload like
      \`substitutions: [{ originalMaterial, substituteMaterial, substitutePlant, requested, ... }, ...]\`,
      the stock_precheck engine swapped one or more short materials with
      cross-plant equivalents. This means VA02 has NOT yet fired — the
      previous plan was terminated after stock_precheck so a fresh plan
      could emit VA02 with the correct substitute material codes. You must:
        - EMIT va02 with materials = the SUBSTITUTE codes (NOT the originals).
          For each substitutions row, the va02 step's \`args.materials\` entry
          uses \`code: substituteMaterial\` and the same \`qty\` as \`requested\`
          (the substitute fully replaces the original line).
        - EMIT lone_zmatana with materials = the SAME substitute codes (one
          entry per substitution). This fetches batch + availableStock for
          the substitute Material rows so downstream steps can ship them.
        - EMIT email_2nd_release to the plant (existing semantics — plant
          confirms the swap). Its materials args carry the substitute codes
          and qty (op="inc"), so the plant sees what they're confirming.
      EMIT order: va02 → lone_zmatana → email_2nd_release. STOP.
      Do NOT re-emit stock_precheck — it has already run and the
      substitutions are recorded in the audit trail; re-emitting it would
      re-do the lookup needlessly.

  7. INBOUND: branch MODIFY-DECREASE or MODIFY-DELETE on ls_dispatch (pre-LS).
     EMIT: email_confirm_bundle_details. STOP.

  8. INBOUND: PLANT confirms the 2nd release ("yes", "done", "released", etc.)
     on a 2nd_release email. (SENDER=plant. Audit trail shows va02 ✓ +
     email_2nd_release already sent.) NOTE: the 2nd_release email is sent
     to the PLANT — they perform the second release — so the reply comes
     from sender=plant, NOT branch. Do not skip this rule because the
     sender is plant; it is the only correct path for a 2nd_release reply.
     EMIT: zso_visibility. STOP.
     The /visibility-data callback auto-sends round-2 ls_dispatch.
     Do NOT chain to email_confirm_bundle_details here.
     Do NOT emit zload2 / email_modified_ls_to_plant — the plant
     confirmation is a green-light for re-visibility, not a request to
     modify loading slips (rule 11 covers branch-requested LS modifications
     on a plant_ls thread, which is a different scenario).

  9. INBOUND: branch reply on a round-2-or-later ls_dispatch (modification
     cycle in progress — material list re-confirmation stage).
     TRIGGER: the planner is invoked because the branch replied on an
     ls_dispatch email AND the audit trail shows AT LEAST one prior va02 ✓
     AND AT LEAST one prior 2nd_release email_sent AND at least two
     email_sent ls_dispatch events.

     **The order of approval is STRICT: materials first (this rule),
     bundles second (Rule 10), ZLOAD1 fresh third (Rule 10b path b). The
     branch must accept the material list before they see the bundle plan;
     they must accept the bundle plan before any loading slips are touched.
     Pre-plant_ls modifications NEVER use zload2 — they use a full
     wipe-and-recreate cycle so the bundler can re-pack optimally.**

     Decide by reading the branch's reply body:

     (a) PLAIN CONFIRMATION ("ok", "yes", "confirmed", "proceed",
         "release as available", "looks good") → the branch has accepted
         the updated material list. EMIT email_confirm_bundle_details to
         move on to bundle re-approval. STOP.

     (b) REPLY CARRIES VEHICLE DETAILS (truck no, driver, container) but
         is NOT a further modification → treat as PLAIN CONFIRMATION on
         the material list. IGNORE the vehicle details (they reference
         the PRE-modification bundle plan, which the branch has not yet
         re-approved). EMIT email_confirm_bundle_details. The planner
         will re-ask for vehicle details later (Rule 10c) against the
         finalised post-modification plan.

     (c) FURTHER MODIFICATION REQUEST (another qty change, add or
         remove a material) → DO NOT advance to bundle confirmation.
         The material list itself is not yet accepted. RESTART the
         modify cycle by re-applying Rule 6 / 6b. EMIT:
           - For an INCREASE: zloading_close (args.all=true) →
             stock_precheck → va02 → email_2nd_release.
           - For a DECREASE / DELETE: zloading_close (args.all=true) →
             email_2nd_release (the materials args summarise the
             decrease/delete so the plant can still do 2nd release on
             the unchanged lines; no va02 because decreases don't
             change the SO).
         The cycle will eventually return to this Rule 9 on the next
         round-N ls_dispatch, and the branch can keep iterating on the
         material list until they accept it.
         Do NOT emit zload2 here — pre-plant_ls modifications NEVER
         use zload2. The wipe-all path lets the bundler re-pack
         optimally for the new quantities.

     (d) GENUINELY UNCLEAR / AMBIGUOUS reply → emit
         email_clarify_branch with a short, specific question.

     Tie-break heuristics for case (a) vs (c) vs (d):
       - If the reply names a material code + a number (and that
         number differs from the current SO qty) → case (c).
       - If the reply names ONLY a truck / driver / container / LR
         number → case (b).
       - If the reply is a short affirmative phrase OR an affirmative
         phrase plus vehicle details → case (a) or (b).
       - When in genuine doubt between (a) and (c), prefer (d) —
         clarify rather than guess. Wrong VA02 args are destructive.
     Do NOT emit email_to_plant or email_modified_ls_to_plant here —
     LSs in DB still reflect pre-modification quantities and would
     ship stale to the plant. The pre-plant_ls re-bundle cycle
     (zloading_close all → … → zload1 fresh) is what eventually
     syncs them; the plant receives the final LSs via email_to_plant
     only after Rule 10b path (a) fires zload1 fresh.

 10. INBOUND: branch reply on a round-2-or-later dispatch_confirmation
     (modification cycle in progress — bundle plan re-confirmation stage).
     (Audit trail shows va02 ✓ + zso_visibility ✓ ≥ 2 + ls_dispatch ✓ ≥ 2 + dispatch_confirmation ✓ ≥ 2.)

     **The branch has already accepted the new material list (Rule 9 case
     a/b fired). Now they're reacting to the bundle / truck plan.**

     Decide by reading the branch's reply body:

     **PLAIN CONFIRMATION** on the bundle plan ("yes", "confirm",
     "proceed", "go ahead") → EMIT zload1 → email_to_branch_for_vehicle.
     STOP.
       NOTE: pre-plant_ls modifications MUST have wiped the prior LSs
       upstream (Rule 6b / Rule 9c emit zloading_close args.all=true at
       the top of the modify cycle). By the time this rule runs there
       are no LSIs on the SO, so zload1 fires in initial mode (no args)
       and the engine fans out across the freshly re-bundled Bundles.
       The bundler call inside the email_confirm_bundle_details step
       (the one that just generated the bundle plan the branch confirmed)
       has already wiped+recreated the DB Bundle rows.
       If you find audit trail evidence that suggests LSIs still exist
       at this point (a prior step_completed zload1 with no subsequent
       zloading_close args.all=true between it and the current point),
       this is a bug in an earlier plan — emit email_supervisor_question
       describing the inconsistency rather than emitting zload2 (which
       is forbidden pre-plant_ls).

     **FURTHER MODIFICATION REQUEST** on the bundle plan (another qty
     change or a request to redistribute) → DO NOT fire zload1. The
     bundle plan is not yet accepted. RESTART the modify cycle from
     Rule 6/6b (for an increase) or apply the decrease/delete branch
     of Rule 9c. The cycle will return through Rule 9 (material list
     re-confirm) then Rule 10 (bundle re-confirm) again. The branch
     can keep iterating on either approval until they're satisfied.

     **UNCLEAR / AMBIGUOUS** → email_clarify_branch.

     **VEHICLE DETAILS in the reply** → treat as PLAIN CONFIRMATION on
     the bundle plan: EMIT zload1 → email_to_branch_for_vehicle.
     IGNORE the vehicle details supplied in this reply — they
     reference the PRE-modification plan, which is no longer current.
     Rule 10c below will collect fresh vehicle details after zload1
     finishes against the new bundles.

 10c. STALE-VEHICLE-DETAILS DETECTION (runs after Rule 10b).
      After Rule 10b emits zload1 fresh, the email_to_branch_for_vehicle
      step naturally collects fresh vehicle details — no separate
      stale-detection is needed in the pre-plant_ls path. (This rule
      remains relevant only for the post-plant_ls Rule 11 path, where
      zload2 / zloading_close can leave stale vehicle_details on file.)
      For post-plant_ls modifications:
        - If the audit trail's MOST RECENT "email_sent vehicle_details"
          event is OLDER than the most recent "step_completed va02"
          (or step_completed zload2 / zloading_close), EMIT
          email_to_branch_for_vehicle to collect fresh vehicle details
          against the now-stable plan.
        - If vehicle_details is NEWER, the details on file are valid —
          do not re-ask.

 11. INBOUND: branch MODIFY-DECREASE / MODIFY-DELETE / MODIFY-DEC-DEL reply on a plant_ls email.
     (Audit trail: zload1 ✓ and plant_ls ✓ already happened. SENDER=branch.)
     The BRANCH is requesting the change — they are the customer authority.
     EMIT: zload2 (decrease/inc-dec) AND/OR zloading_close (delete) AND email_modified_ls_to_plant — ALL IN THE SAME PLAN (steps array MUST end with email_modified_ls_to_plant). Do NOT emit just zload2/zloading_close alone; the plant must always be notified of the change. STOP after the email step.
     Do NOT emit email_to_branch_notifying_plant_change — that's for PLANT-proposed changes.
     Do NOT emit plain email_to_plant here — it would send EVERY LS to the plant, including unmodified ones. Use email_modified_ls_to_plant which sends only the touched LSs.
     No va02, no 2nd release. Decreases / deletes don't change the SO; they only revise the LS.

ANYTIME / OTHER:
 12. For a "Seeking Order Update" inquiry: emit a single email_order_status step. STOP.
 13. When the plant has sent an invoice PDF on a plant_ls reply, emit process_plant_invoice. STOP.
 14. When the branch replies on a tonnage_inquiry thread with the vehicle tonnage (e.g. "35 t", "35000 kg", "vehicle is 40 tonnes"), emit a single process_tonnage_reply step. STOP. The executor writes po.weightage and the next inbound (or the cron's natural retry) resumes the normal dispatch flow.

WHEN A REPLY IS UNCLEAR / INCOMPLETE — ASK A CLARIFYING QUESTION:
 15. If the latest inbound is ambiguous, contradictory, or only partially answers what we asked, emit a single email_clarify_branch (or email_clarify_plant if the sender was the plant) step. STOP. Provide the exact question on the step as the "question" field. The reply will trigger a fresh plan.
     - **Clarify-on-guess (hard rule).** If filling in the \`args\` for a SAP-mutating step (va02, zload2, zloading_close, stock_precheck) would require you to GUESS — material code not clearly stated, quantity ambiguous or missing, batch unclear, vehicle number partial, bundle assignment unclear — you MUST emit email_clarify_* instead. Confidence threshold is HIGH: only proceed if the reply explicitly names the material AND the new quantity (or material AND delete). Wrong args land in SAP unchecked, so when in doubt, ask.
     - Example: we asked for vehicle tonnage AND truck number; the branch replied only with the truck number → emit email_clarify_branch with question="You shared the truck number. Could you also confirm the vehicle tonnage (in tonnes)?".
     - Example: branch replied "modify the order" with no material code or quantity → emit email_clarify_branch asking for the specific material + new quantity.
     - Example: branch replied "increase M-A" with no number → emit email_clarify_branch asking for the new total quantity.
     - Keep the question SHORT (1–3 sentences). Quote back the part of their message you understood so they know you read it. Do not invent details. Do not ask more than one question per email unless they are tightly linked.
     - Do NOT use clarification as a stalling move. If the reply is clearly actionable AND the args can be filled in unambiguously from the thread, ACT. Use clarification only when proceeding without the missing fact would be wrong or destructive.

WHEN YOU ARE STUCK — ASK THE SUPERVISOR:
 16. If you genuinely cannot decide what step to take next — for example the audit trail looks inconsistent, two rules above seem to conflict, or the email asks for something outside the standard process — emit a single email_supervisor_question step. STOP. On the step provide:
     - "question": one or two sentences stating the situation in your own words. Include the SO number and what the inbound is asking for. Do NOT paste the full email — the supervisor sees the rendered thread already.
     - "options": 2–4 short candidate next-actions you are weighing (each a short phrase like "Fire zload2 for material X" or "Send 2nd_release email to confirm with branch"). The supervisor will reply with which one to take, or with custom instructions.
     - Do not use this as an escape hatch. Try to apply rules 1–15 first. The supervisor's reply will be picked up as a normal inbound and re-planned, so a vague "please advise" wastes time. Be specific.
     - This step is for in-band confusion only. For PARSER / SYSTEM failures (planner errors, malformed inputs) leave steps=[] and set escalate=true with escalation_question instead.

FORMATTING:
 17. stop_after_index is 0-based. If steps has 3 entries and you want to pause after firing all 3, set stop_after_index=2.
 18. If you have nothing to do (e.g. the email is "thanks"): set steps=[] and stop_after_index=-1.
`;

async function buildUserPrompt(args: {
  salesOrderId: string;
  triggerEmailId: string;
  sender: 'branch' | 'plant' | 'production';
}): Promise<string> {
  const [auditTrail, emailThread, soSnapshot] = await Promise.all([
    renderAuditTrailForSO({ salesOrderId: args.salesOrderId }),
    renderEmailThreadForSO({ salesOrderId: args.salesOrderId }),
    buildSoStateSnapshot(args.salesOrderId),
  ]);

  const sections = [
    `SENDER OF LATEST EMAIL: ${args.sender}`,
    '',
    soSnapshot ? renderSoState(soSnapshot) : '(SO snapshot unavailable)',
    '',
    'PRIOR ACTIONS ON THIS SO (chronological, oldest first):',
    auditTrail,
    '',
    'EMAIL THREAD (chronological, oldest first):',
    emailThread,
    '',
    renderStepVocabulary(),
    '',
    OUTPUT_FORMAT_BLOCK,
    '',
    'Now produce the JSON plan for the latest inbound email.',
  ];

  return sections.join('\n');
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
  systemPrompt: string,
  userPrompt: string,
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
    const content =
      `=== SYSTEM ===\n${systemPrompt}\n\n=== USER ===\n${userPrompt}\n`;
    fs.writeFileSync(filePath, content, 'utf8');
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
  const systemPrompt = loadManagerPrompt();
  const userPrompt = await buildUserPrompt(args);

  await dumpPromptToFile(args.salesOrderId, args.triggerEmailId, systemPrompt, userPrompt);

  // All LLM calls in the dashboard go through getLlmService(), which selects
  // the provider/model from env vars (LLM_PROVIDER / LLM_MODEL / *_API_KEY).
  // See src/lib/llm-service.ts for the full env contract.
  const llm = getLlmService();
  let result;
  try {
    result = await llm.chat({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      requireJson: true,
      // Planner output is a structured JSON plan (rationale + steps[] with
      // nested args, plus per-step rationale strings) and can run long on
      // multi-step modify cycles. Lock the cap here so a low LLM_MAX_TOKENS
      // env value can't truncate the JSON mid-stream and fail the Zod parse.
      maxTokens: 12000,
    });
  } catch (e) {
    return planFailure(`LLM call failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (!result.text) {
    return planFailure(`LLM returned empty content (provider=${result.provider} model=${result.model})`);
  }

  // llm.chat() with requireJson=true already parsed JSON; if the model emitted
  // something unparseable, chat() would have thrown above.
  const validated = PlanResultSchema.safeParse(result.json);
  if (!validated.success) {
    const raw = result.text;
    const preview = raw.length > 600 ? raw.slice(0, 600) + '…' : raw;
    console.warn(
      `[PLANNER_ZOD_FAIL] soId=${args.salesOrderId} emailId=${args.triggerEmailId} raw=${preview} errors=${JSON.stringify(validated.error.issues)}`,
    );
    return planFailure(`Zod validation failed: ${validated.error.message}`);
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
