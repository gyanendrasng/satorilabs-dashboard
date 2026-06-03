/**
 * LLM planner — replaces the sheet-driven scenario classifier.
 *
 * On every inbound email, planNextSteps() reads:
 *   - the manager prompt (ManagerV2.1.txt at repo root)
 *   - the SO's audit trail (renderAuditTrailForSO)
 *   - the SO's email thread (renderEmailThreadForSO)
 *   - the SO's current DB state (status, materials, plant_ls sent?, invoice?)
 *
 * …and asks an LLM to emit an ordered list of step kinds (drawn from the
 * existing StepKind vocabulary) up to and including the next outbound
 * email. The scenario engine then walks those steps via its existing
 * fireStep handlers; when the stop step completes, the scenario parks
 * awaiting reply. Next inbound triggers a fresh plan call.
 *
 * No sheet. No hardcoded scenario keys. The LLM picks steps from a fixed
 * vocabulary and the engine fires the corresponding handlers.
 */
import fs from 'node:fs';
import path from 'node:path';
import OpenAI from 'openai';
import { z } from 'zod';
import { prisma } from './prisma';
import { renderEmailThreadForSO } from './email-thread';
import { renderAuditTrailForSO } from './audit-trail';
import { deriveStage, type StepKind } from './dispatch-scenarios';

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

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

const STEP_KINDS: Array<{ kind: StepKind; description: string }> = [
  { kind: 'stock_precheck', description: 'Free-stock pre-check (replaces Zmatana). Use BEFORE va02 on any increase.' },
  { kind: 'va02', description: 'Modify SO line items in SAP. Use ONLY when increasing a material quantity. Decreases and deletes do not need va02.' },
  { kind: 'zso_visibility', description: 'Re-run ZSO_Visibility + Zmatana. Always run after va02 to refresh material availability.' },
  { kind: 'mb51', description: 'Park on daily FCFS reactivator. Use only when waiting for new stock to arrive.' },
  { kind: 'zload1', description: 'Create loading slips (LSs). Use ONLY when no LSs exist yet for this SO (i.e. SO.status != ls_created).' },
  { kind: 'zload2', description: 'Revise existing loading slip quantities. Use when LSs already exist and qty needs updating.' },
  { kind: 'zloading_close', description: 'Delete line items from an existing LS (ZLOAD_Delete). Use for material deletions after LS creation.' },
  { kind: 'email_2nd_release', description: 'Ask branch to confirm the revised plan after a va02 modification. Send AFTER va02, BEFORE re-running zso_visibility.' },
  { kind: 'email_confirm_product_details', description: 'The ls_dispatch email — confirm product/batch details with branch. Sent automatically by the zso_visibility callback; do not emit explicitly unless you specifically want to re-send.' },
  { kind: 'email_confirm_bundle_details', description: 'The dispatch_confirmation email — confirm bundle/truck plan with branch. Send after ls_dispatch was replied to with a confirmation.' },
  { kind: 'email_to_branch_for_vehicle', description: 'Ask branch for vehicle details (truck no, driver, LR). Send after ZLOAD1 creates loading slips.' },
  { kind: 'email_to_plant', description: 'Forward the LS PDF to the plant (plant_ls email). Send after branch provides vehicle details.' },
  { kind: 'email_to_branch_notifying_plant_change', description: 'Notify branch that the plant has proposed a modification. Send when a plant reply asks for a quantity change.' },
  { kind: 'email_order_status', description: 'Auto-reply with the current SO status. Use when branch asks "where is my order?" (Seeking Order Update).' },
  { kind: 'process_plant_invoice', description: 'Plant has sent an invoice PDF on a plant_ls reply. Run ZLOAD3+ZSO_Auto via the batch sender. Use when the latest plant reply has a PDF attachment.' },
  { kind: 'process_tonnage_reply', description: 'Branch replied to a tonnage_inquiry email with the vehicle/truck tonnage. Use ONLY when the latest inbound is a reply on a tonnage_inquiry thread and contains a number that looks like a truck capacity (e.g. "35 t", "35000 kg"). The executor parses the reply, writes po.weightage, and the next inbound resumes normal dispatch.' },
  { kind: 'email_clarify_branch', description: 'Reply in-thread to BRANCH asking a focused clarifying question. Use when the branch reply is ambiguous, incomplete, or only partially answers what we asked. Provide the exact question text on this step as `question`. The executor sends the email verbatim and pauses; the branch reply will trigger a fresh plan.' },
  { kind: 'email_clarify_plant', description: 'Reply in-thread to PLANT asking a focused clarifying question. Use when the plant reply is ambiguous, incomplete, or only partially answers what we asked. Provide the exact question text on this step as `question`. The executor sends the email verbatim and pauses.' },
  { kind: 'email_supervisor_question', description: 'Email the SUPERVISOR for guidance when you do not know which step to take. Use ONLY when the audit trail / email thread leave you genuinely unable to choose between options. Provide the exact question text as `question` and the alternatives you are weighing as `options` (each a short phrase). The executor sends the email and pauses; the supervisor reply will be classified by the next plan.' },
  { kind: 'await_plant_invoice', description: 'Sentinel — pause execution until the plant emails an invoice. The next plant reply will resume.' },
  { kind: 'await_vt01n', description: 'Sentinel — pause until the operator (or pipeline) fires VT01N for the shipment.' },
];

function renderStepVocabulary(): string {
  const lines = ['AVAILABLE STEP KINDS (you MUST pick `kind` values from this list):'];
  for (const s of STEP_KINDS) {
    lines.push(`- ${s.kind}: ${s.description}`);
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
}

async function buildSoStateSnapshot(salesOrderId: string): Promise<SoStateSnapshot | null> {
  const so = await prisma.salesOrder.findUnique({
    where: { id: salesOrderId },
    include: {
      materials: { orderBy: { createdAt: 'asc' } },
      items: { select: { id: true } },
      purchaseOrder: { include: { customer: true } },
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
  };
}

function renderSoState(s: SoStateSnapshot): string {
  return [
    'CURRENT SO STATE:',
    `- soNumber: ${s.soNumber}`,
    `- customer: ${s.customer ?? '(unknown)'}`,
    `- status: ${s.status}`,
    `- stage (derived): ${s.stage}`,
    `- material lines: ${s.materialCount}`,
    `- loading slips created: ${s.lsCount}`,
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

const PlannedStepSchema = z.object({
  kind: z.enum(VALID_STEP_KINDS),
  rationale: z.string().optional(),
  question: z.string().optional(),
  options: z.array(z.string()).optional(),
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
    { "kind": "<step_kind from vocab above>", "rationale": "why this step" }
  ],
  "stop_after_index": <integer — the LAST index in steps that fires before we pause; usually points at the last outbound email step>,
  "escalate": false,
  "escalation_question": null
}

For the three question-asking step kinds — email_clarify_branch, email_clarify_plant, email_supervisor_question — the step object MUST also include:
{ "kind": "email_clarify_branch", "rationale": "...", "question": "<exact text to send>" }
{ "kind": "email_supervisor_question", "rationale": "...", "question": "<situation>", "options": ["option A", "option B", ...] }
Omit "question" / "options" for any other step kind.

RULES:
1. Plan up to and including the NEXT outbound email. STOP at that email. The next inbound email will trigger a fresh plan call.
2. Pick step kinds ONLY from the AVAILABLE STEP KINDS list. Out-of-vocab values are rejected.
3. You emit step KINDS ONLY. Do NOT emit data values (quantities, materials, vehicle numbers, etc.). Each step's executor reads what it needs from the email thread / DB on its own. Your job is to choose the right sequence of milestones, nothing more.
4. If you are unsure what the email means, or the right action requires authority you don't have, set escalate=true and put the question in escalation_question. Leave steps as [].
5. Re-read the audit trail. If a step has ALREADY been completed, do not repeat it. Example: if ZLOAD1 already fired, modifying qty must use zload2, never zload1.

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

  6. INBOUND: branch MODIFY-INCREASE on ls_dispatch (pre-LS, no LSs yet).
     EMIT: stock_precheck → va02 → email_2nd_release. STOP.

  6b. INBOUND: branch MODIFY-INCREASE on plant_ls (post-LS, LSs already exist).
      EMIT: stock_precheck → va02 → email_2nd_release. STOP.

  7. INBOUND: branch MODIFY-DECREASE or MODIFY-DELETE on ls_dispatch (pre-LS).
     EMIT: email_confirm_bundle_details. STOP.

  8. INBOUND: branch "yes do 2nd release" on a 2nd_release email.
     (Audit trail shows va02 ✓ + email_2nd_release already sent.)
     EMIT: zso_visibility. STOP.
     The /visibility-data callback auto-sends round-2 ls_dispatch.
     Do NOT chain to email_confirm_bundle_details here.

  9. INBOUND: branch confirmation on a round-2 ls_dispatch.
     (Audit trail shows TWO ls_dispatch emails AND one 2nd_release ✓.)
     EMIT: email_confirm_bundle_details. STOP.

 10. INBOUND: branch confirmation on a round-2 dispatch_confirmation.
     (Audit trail shows va02 ✓ + zso_visibility ✓ × 2 + ls_dispatch ✓ × 2 + dispatch_confirmation ✓ × 2.)
     CHOOSE based on whether LoadingSlipItem rows already exist:
       (a) NO LSIs yet → EMIT zload1 → email_to_branch_for_vehicle. STOP.
       (b) LSIs already exist (audit trail has a prior step_completed zload1 ✓ from BEFORE the modification) → EMIT zload2 → email_to_plant. STOP.
     A prior "step_completed zload1" event in the audit trail = path (b). No prior zload1 = path (a).

 11. INBOUND: branch MODIFY-DECREASE / MODIFY-DELETE / MODIFY-DEC-DEL reply on a plant_ls email.
     (Audit trail: zload1 ✓ and plant_ls ✓ already happened. SENDER=branch.)
     The BRANCH is requesting the change — they are the customer authority.
     EMIT: zload2 (decrease/inc-dec) AND/OR zloading_close (delete) → email_to_plant. STOP.
     Do NOT emit email_to_branch_notifying_plant_change — that's for PLANT-proposed changes.
     No va02, no 2nd release. Decreases / deletes don't change the SO; they only revise the LS.

ANYTIME / OTHER:
 12. For a "Seeking Order Update" inquiry: emit a single email_order_status step. STOP.
 13. When the plant has sent an invoice PDF on a plant_ls reply, emit process_plant_invoice. STOP.
 14. When the branch replies on a tonnage_inquiry thread with the vehicle tonnage (e.g. "35 t", "35000 kg", "vehicle is 40 tonnes"), emit a single process_tonnage_reply step. STOP. The executor writes po.weightage and the next inbound (or the cron's natural retry) resumes the normal dispatch flow.

WHEN A REPLY IS UNCLEAR / INCOMPLETE — ASK A CLARIFYING QUESTION:
 15. If the latest inbound is ambiguous, contradictory, or only partially answers what we asked, emit a single email_clarify_branch (or email_clarify_plant if the sender was the plant) step. STOP. Provide the exact question on the step as the "question" field. The reply will trigger a fresh plan.
     - Example: we asked for vehicle tonnage AND truck number; the branch replied only with the truck number → emit email_clarify_branch with question="You shared the truck number. Could you also confirm the vehicle tonnage (in tonnes)?".
     - Example: branch replied "modify the order" with no material code or quantity → emit email_clarify_branch asking for the specific material + new quantity.
     - Keep the question SHORT (1–3 sentences). Quote back the part of their message you understood so they know you read it. Do not invent details. Do not ask more than one question per email unless they are tightly linked.
     - Do NOT use clarification as a stalling move. If the reply is clearly actionable, ACT. Use a clarification only when proceeding without the missing fact would be wrong or destructive.

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

export async function planNextSteps(args: {
  salesOrderId: string;
  triggerEmailId: string;
  sender: 'branch' | 'plant' | 'production';
}): Promise<PlanResult> {
  const systemPrompt = loadManagerPrompt();
  const userPrompt = await buildUserPrompt(args);

  const openai = new OpenAI();
  const completion = await openai.chat.completions.create({
    model: 'gpt-5.2',
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw) {
    return planFailure('OpenAI returned empty content');
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    return planFailure(`JSON parse failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const validated = PlanResultSchema.safeParse(json);
  if (!validated.success) {
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
