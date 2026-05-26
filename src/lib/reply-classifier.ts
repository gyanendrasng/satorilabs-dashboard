/**
 * Unified LLM reply classifier — the single Manager call for every inbound
 * email the dashboard processes.
 *
 * Replaces the per-type classifiers (scenario-selector, dispatch-confirmation,
 * vehicle-split, branch-reply, so-extractor, auto_gui2 /email/production-*).
 * Returns a tagged-union `ReplyClassification` whose `action` field tells the
 * dispatcher which handler to invoke and with what fields.
 *
 * Behavior:
 *   - For scenario-shaped replies (release_*, modify_*, wait): action='scenario'
 *     with scenario_key + materials + action_on_active. Same as Phase E.
 *   - For yes/no decisions (2nd_release, dispatch_confirmation):
 *     action='dispatch_confirmation_decision' or '2nd_release_decision'.
 *   - For structured extractions (vehicle details, NEW ORDER): action returns
 *     the extracted fields.
 *   - For "I see a PDF": action='invoice_pdf' (LLM still gets called so a
 *     piggybacked text modification can override).
 *   - Anything else: action='other' + a description + a question for the
 *     supervisor — the engine sends a supervisor_inquiry email.
 *
 * The existing per-handler classifiers stay alive as fallbacks (used by
 * legacy callers when UNIFIED_CLASSIFIER_ENABLED is off). See
 * scenario-selector.ts for the backward-compat shim used during rollout.
 */
import OpenAI from 'openai';
import { z } from 'zod';
import type { Stage } from './dispatch-scenarios';

// -----------------------------------------------------------------------------
// Output schema — discriminated union over all reply intents
// -----------------------------------------------------------------------------

const MaterialOpSchema = z.object({
  material_code: z.string(),
  batch: z.string().default(''),
  operation: z.enum(['keep', 'increase', 'decrease', 'delete']).optional(),
  quantity: z.number().default(0),
});

const ActionOnActiveSchema = z
  .preprocess(
    (v) => (v === 'null' || v === '' ? null : v),
    z.enum(['abort_and_replace', 'escalate']).nullable().optional(),
  )
  .optional();

const ScenarioActionSchema = z.object({
  action: z.literal('scenario'),
  scenario_key: z.string(),
  reasoning: z.string().default(''),
  escalate_reason: z.string().optional(),
  materials: z.array(MaterialOpSchema).default([]),
  action_on_active: ActionOnActiveSchema,
});

const DispatchConfirmationDecisionSchema = z.object({
  action: z.literal('dispatch_confirmation_decision'),
  decision: z.enum(['yes', 'no', 'ambiguous']),
  reasoning: z.string().default(''),
});

const SecondReleaseDecisionSchema = z.object({
  action: z.literal('2nd_release_decision'),
  decision: z.enum(['yes', 'no', 'ambiguous']),
  reasoning: z.string().default(''),
});

const VehicleSplitDecisionSchema = z.object({
  action: z.literal('vehicle_split_decision'),
  decision: z.enum(['split', 'cancel', 'amend', 'ambiguous']),
  amendments: z.array(MaterialOpSchema).optional(),
  reasoning: z.string().default(''),
});

const VehicleDetailSchema = z.object({
  bundleNumber: z.number().int().optional(),
  vehicleNumber: z.string().default(''),
  driverMobile: z.string().default(''),
  containerNumber: z.string().default(''),
});

const VehicleDetailsExtractionSchema = z.object({
  action: z.literal('vehicle_details_extraction'),
  vehicles: z.array(VehicleDetailSchema).default([]),
  reasoning: z.string().default(''),
});

const ProductionTimelineSchema = z.object({
  action: z.literal('production_timeline'),
  days: z.number().int().nonnegative(),
  reasoning: z.string().default(''),
});

const ProductionConfirmationSchema = z.object({
  action: z.literal('production_confirmation'),
  decision: z.enum(['ready', 'wait_more']),
  additionalDays: z.number().int().nonnegative().optional(),
  reasoning: z.string().default(''),
});

const NewOrderSchema = z.object({
  action: z.literal('new_order'),
  customer_id: z.string().nullable().default(null),
  so_numbers: z.array(z.string().regex(/^\d{7,}$/)).min(1).max(4),
  reasoning: z.string().default(''),
});

const InvoicePdfSchema = z.object({
  action: z.literal('invoice_pdf'),
  reasoning: z.string().default(''),
});

const OtherSchema = z.object({
  action: z.literal('other'),
  description: z.string(),
  suggested_question_for_supervisor: z.string(),
  reasoning: z.string().default(''),
});

const ReplyClassificationSchema = z.discriminatedUnion('action', [
  ScenarioActionSchema,
  DispatchConfirmationDecisionSchema,
  SecondReleaseDecisionSchema,
  VehicleSplitDecisionSchema,
  VehicleDetailsExtractionSchema,
  ProductionTimelineSchema,
  ProductionConfirmationSchema,
  NewOrderSchema,
  InvoicePdfSchema,
  OtherSchema,
]);

export type ReplyClassification = z.infer<typeof ReplyClassificationSchema>;
export type ScenarioActionClassification = z.infer<typeof ScenarioActionSchema>;

// -----------------------------------------------------------------------------
// The Manager system prompt — verbatim process knowledge + the union output
// rules + per-action examples.
// -----------------------------------------------------------------------------

const MANAGER_SYSTEM_PROMPT = `You are a Manager monitoring Product Dispatch for a Tiles & Sanitaryware company based in Morbi.

There are 3 stakeholders -
A. Order Processing Team - They are a team of employees reporting to you, actually processing the order
A. Branch - Branch places order in consultation with Customer / Client / Dealer
B. Plant - Plant is the supplier of the product. They manufacture and dispatch on behalf of Order Processing Team

The process is as below:

1. Sales Order (SO) Creation:
1A. Branch coordinates with Dealers to place orders by creating SO in SAP (SAP Transaction VA01). Each SO has multiple line items corresponding to each SKUs.
1B. The SO Creation is a two step process. First the SO is posted and communicated to Order processing Team, by email, to evaluate SKU wise material availability.
1C. Order Processing Team checks the SO (SAP Transaction ZSO_Visibility & Zmatana) replies back with material availability report
1D. Branch releases the SO, called "Second Release" (SAP Transaction VA01) for the second time to create Loading Slips

2. Loading Slip Creation:
Loading Slips are Vehicle wise SKU loading details. Each SO will have multiple line items (SKUs). Each line items will be supplied by different Plants. Each Loading Slip will be sent to a unique Plant. SO will be broken into multiple Loading Slips. A SO will have a bunch of Loading Slips. Loading Slip will have a bunch of SKUs. SAP Transaction Zload1 is used to convert an SO to Loading Slips

3. Vehicle Details:
Once the Loading Slips are created, Order Processing Team will email Branch to asking for Vehicle Details to deliver the Order

4. Intimation to Plants
Once the vehicle details are obtained then Loading Slips, along with Vehicle Details are send to Plants. The Plants reply back with Plant Invoice.

5. Client Invoice Creation
Data from Plant Invoice is updated in SAP (SAP Transaction Zload3). Using SAP Transaction ZSO_AUto, Client Invoice Is posted. This step generates Client Invoice Number, GRN Number & OBD Number

6. OBD number is used to create Dispatch Details using SAP Transaction VT01N

Apart from SAP Transactions mentioned above, the following transactions are also important:
A. ZSO_Visibility - Check the SO in details to identify the SKUs. It shows SKU wise Ordered Quantity, Available Quantity, Batches, Weights
B. Zmatana - Do s deep dive into a particular SKU and check stock availability and batch compositions
C. VA01 - Create a SO
D. VA02 - Modify SO. Once SO is updated it needs Second Release
E. Zload 1 - Create a Loading Slip
F. Zload 2 - Modify Loading slips by changing quantity of Line Items (SKUs) or adding new Line Items (SKUs)
G. Zloading_Close - Delete Line Items (SKUs) in a Loading Slip
H. Zload 3 - View Loading Slips in a particular SO. You can also download the SO details with Loading Slips in an excel and update Plant Invoice details
I. ZSO_AUto - Upload the excel updated in Zload 3 and post Client Invoice. This step generates Client Invoice Number, GRN Number & OBD Number
J. VT01N - Create dispatch details

You need to update SO in order to change/modify Loading Slips. Each modification in SO needs Branch's approval.
Any change in SO, must be accompanied by change in Loading Slips
All Loading slips change must be intimated to Plant

DO not bring in any outside information

────────────────────────────────────────────────────────────────────────
OUTPUT FORMAT (for this task):

You will be shown the email thread for the current Sales Order plus context
about which "trigger" email the latest reply is responding to. Your job is
to classify the reply into ONE action from the list below and return JSON
matching that action's schema.

Choose the action by what the SENDER IS ACTUALLY ASKING FOR. When you see
multiple intents in one email (e.g. vehicle details AND a modification
request), pick the one that REQUIRES ACTION FIRST and surface the other
in \`reasoning\`. SO modifications always take precedence — a modification
request piggybacked on a vehicle-details reply must classify as 'scenario',
not 'vehicle_details_extraction'.

Respond with strict JSON only. No prose outside the JSON. The JSON must
include an "action" field whose value is one of:
  - "scenario"
  - "dispatch_confirmation_decision"
  - "2nd_release_decision"
  - "vehicle_split_decision"
  - "vehicle_details_extraction"
  - "production_timeline"
  - "production_confirmation"
  - "new_order"
  - "invoice_pdf"
  - "other"

═══════════════════════════════════════════════════════════════════════
ACTION: "scenario" — for SO modifications, releases, and waits.

Picks ONE of the listed valid scenario keys (or "unknown"). Use this for
any branch or plant reply that asks for a quantity change, a line
deletion, a release decision, or a hold on dispatch — i.e. anything that
should drive a registered scenario in the engine.

Shape:
{
  "action": "scenario",
  "scenario_key": "<one of the listed valid keys, or 'unknown'>",
  "reasoning": "...",
  "escalate_reason": "<required only if scenario_key is 'unknown'>",
  "materials": [
    {"material_code": "...", "batch": "...", "operation": "keep|increase|decrease|delete", "quantity": <number>}
  ],
  "action_on_active": "abort_and_replace|escalate|null"
}

RULES:
- "scenario_key" MUST be exactly one of the listed valid keys, or the literal "unknown".
- For modification scenarios, include every material the sender is acting on in "materials" with the correct "operation" and the NEW target "quantity" (0 for delete).
- For release_all / release_part / wait scenarios, "materials" may list relevant lines but "operation" can be omitted.
- "action_on_active" is REQUIRED when the prompt contains an "ACTIVE SCENARIO IN PROGRESS" section, else null.
   * "abort_and_replace": the new email supersedes the in-flight scenario.
   * "escalate": the new email conflicts and you cannot decide.
- If the email mentions an SO-related action but doesn't fit any listed scenario, return scenario_key: "unknown" and explain in escalate_reason.
- IMPORTANT: the "wait" scenario applies ONLY when the sender wants to PAUSE the SO until materials become available ("hold on, please wait for stock", "we'll wait for the production run"). Outright order cancellation ("cancel this SO entirely", "we no longer need this order", "drop the whole order") is NOT 'wait' — that's an unsupported action; classify as action="other" instead.

Example — branch asks for a quantity increase:
Reply: "Please increase M-A to 150 units."
→ {"action": "scenario", "scenario_key": "branch|before_ls|modify|increase", "materials": [{"material_code": "M-A", "batch": "B1", "operation": "increase", "quantity": 150}], "action_on_active": null, "reasoning": "Branch requests a quantity increase before LS."}

═══════════════════════════════════════════════════════════════════════
ACTION: "dispatch_confirmation_decision" — for replies to a 'dispatch_confirmation' email that ask for a yes/no on the dispatch plan (bundle approval).

Shape:
{
  "action": "dispatch_confirmation_decision",
  "decision": "yes" | "no" | "ambiguous",
  "reasoning": "..."
}

Use only when the trigger email's type was 'dispatch_confirmation'. A bare
"yes" or "ok" or "go ahead" → "yes". A "hold" / "no" / "wait" → "no". Anything
unclear → "ambiguous".

═══════════════════════════════════════════════════════════════════════
ACTION: "2nd_release_decision" — for replies to a '2nd_release' email asking the branch to confirm a revised SO plan after VA02.

Shape:
{
  "action": "2nd_release_decision",
  "decision": "yes" | "no" | "ambiguous",
  "reasoning": "..."
}

Use only when the trigger email's type was '2nd_release'. A new modification
request on a '2nd_release' thread is NOT this — that's "scenario" with
action_on_active="abort_and_replace".

═══════════════════════════════════════════════════════════════════════
ACTION: "vehicle_split_decision" — for replies to a 'vehicle_split_inquiry' email about how to split an over-capacity bundle.

Shape:
{
  "action": "vehicle_split_decision",
  "decision": "split" | "cancel" | "amend" | "ambiguous",
  "amendments": [ {"material_code": "...", "operation": "decrease|delete", "quantity": <new qty>} ],   // only when decision="amend"
  "reasoning": "..."
}

"split" — load into two trucks. "cancel" — cancel the dispatch. "amend" — change quantities to fit one truck (provide amendments).

═══════════════════════════════════════════════════════════════════════
ACTION: "vehicle_details_extraction" — for replies to a 'vehicle_details' email providing vehicle / driver / container info.

Shape:
{
  "action": "vehicle_details_extraction",
  "vehicles": [
    {"bundleNumber": 1, "vehicleNumber": "GJ12-3456", "driverMobile": "9876543210", "containerNumber": "CNT-1"}
  ],
  "reasoning": "..."
}

Extract ALL vehicle sets in the reply (one per bundle/truck). bundleNumber
is optional — only set it if the sender mentions it explicitly. Missing
fields should be empty strings, not omitted.

IMPORTANT: If the reply contains both vehicle details AND a modification
request ("Vehicle is GJ12X, also please reduce M-A to 50"), classify as
'scenario' (modification takes precedence) and mention the vehicle info in
reasoning. A separate vehicle-details extraction call will happen later.

═══════════════════════════════════════════════════════════════════════
ACTION: "production_timeline" — for replies to a 'production_inquiry' email where the production team states when material will be available.

Shape:
{
  "action": "production_timeline",
  "days": <integer days from today>,
  "reasoning": "..."
}

"3 days" → 3. "next week" → 7. "tomorrow" → 1. "today" → 0.

═══════════════════════════════════════════════════════════════════════
ACTION: "production_confirmation" — for replies to a 'production_reminder' email confirming whether material is now ready.

Shape:
{
  "action": "production_confirmation",
  "decision": "ready" | "wait_more",
  "additionalDays": <integer, only when decision="wait_more">,
  "reasoning": "..."
}

═══════════════════════════════════════════════════════════════════════
ACTION: "new_order" — for fresh "NEW ORDER" emails that announce SOs to process. No SO context exists yet at this point.

Shape:
{
  "action": "new_order",
  "customer_id": "<id-or-null>",
  "so_numbers": ["1234567", ...],   // 1 to 4 SAP SO numbers, 7+ digits each
  "reasoning": "..."
}

Use only when the prompt indicates there is NO SO context yet (the email
is announcing new SOs, not a reply on an existing SO thread). "customer_id"
may be alphanumeric ("CUST-1001"), numeric ("42"), or null.

═══════════════════════════════════════════════════════════════════════
ACTION: "invoice_pdf" — for plant replies that include an invoice PDF and no actionable text.

Shape:
{
  "action": "invoice_pdf",
  "reasoning": "Plant uploaded invoice PDF — no modification requested."
}

Use this ONLY when:
1. The prompt indicates a PDF is attached.
2. The reply body is empty, a brief acknowledgement, or just "please find attached".

If the reply body contains a modification request alongside the PDF,
classify as 'scenario' instead (the PDF is still extracted as a side-effect
by a separate pipeline).

═══════════════════════════════════════════════════════════════════════
ACTION: "other" — for replies that don't fit any of the above.

Shape:
{
  "action": "other",
  "description": "<one sentence: what is the sender actually asking for>",
  "suggested_question_for_supervisor": "<short question to ask a human>",
  "reasoning": "<why this doesn't fit the listed actions>"
}

Use for things like:
- "Can you change the delivery address?"
- "Please cancel this entire SO" / "we no longer need this order"
- "What's the status of last week's order?"
- "We need to combine two orders into one."
- Ambiguous or off-topic replies the system cannot handle.

The engine will email a human supervisor with the description and
question, then re-classify the supervisor's reply when it lands.
`;

// -----------------------------------------------------------------------------
// Input types
// -----------------------------------------------------------------------------

export interface ClassifierMaterial {
  material: string;
  batch: string;
  orderQuantity: number;
  availableStock: number | null;
}

export interface ClassifierValidKey {
  key: string;
  description: string;
  stepKinds: string[];
}

export interface ClassifierActiveScenario {
  scenarioKey: string;
  description: string;
  currentStepIndex: number;
  steps: string[];
  stepsAlreadyExecuted: Array<{
    stepIndex: number;
    kind: string;
    completedAt: string;
  }>;
}

export interface ClassifyReplyArgs {
  /** null for NEW ORDER emails — no SO exists yet. */
  soNumber: string | null;
  /** null for NEW ORDER, 'branch' or 'plant' for SO-linked replies. */
  sender: 'branch' | 'plant' | null;
  /** null for NEW ORDER. */
  stage: Stage | null;
  /** Always provided — the email body / thread text. */
  emailThread: string;
  /** Empty for NEW ORDER. */
  materials: ClassifierMaterial[];
  /** Empty for NEW ORDER. Otherwise the scenario keys legal for (sender, stage). */
  validKeys: ClassifierValidKey[];
  /** The original trigger email's type (e.g. 'ls_dispatch', 'vehicle_details'). null for NEW ORDER. */
  triggerEmailType: string | null;
  /** Whether the reply has a PDF attachment. Lets the LLM pick 'invoice_pdf' or override on text intent. */
  hasPdfAttachment?: boolean;
  /** Set when a scenario is already in flight; enables action_on_active. */
  activeScenario?: ClassifierActiveScenario | null;
}

// -----------------------------------------------------------------------------
// classifyReply — the single entry point
// -----------------------------------------------------------------------------

function buildUserPrompt(args: ClassifyReplyArgs): string {
  const parts: string[] = [];

  // NEW ORDER branch — no SO context yet.
  if (args.soNumber === null) {
    parts.push('CONTEXT: This is a NEW ORDER announcement email — no Sales Order exists in the system yet.');
    parts.push('Your job is to extract customer_id and 1–4 SAP SO numbers from the body using action="new_order".');
    parts.push('');
    parts.push('EMAIL BODY:');
    parts.push(args.emailThread || '(empty)');
    parts.push('');
    parts.push('Return action="new_order" with the extracted customer_id and so_numbers. Return action="other" only if there are no SO numbers visible.');
    return parts.join('\n');
  }

  parts.push(`TARGET SALES ORDER: ${args.soNumber}`);
  parts.push(`SENDER: ${args.sender}`);
  parts.push(`CURRENT STAGE: ${args.stage}`);
  if (args.triggerEmailType) {
    parts.push(`TRIGGER EMAIL TYPE: ${args.triggerEmailType}`);
  }
  if (args.hasPdfAttachment) {
    parts.push('PDF ATTACHMENT: yes (one or more PDF files are attached to the reply)');
  }
  parts.push('');

  parts.push('MATERIALS ON THIS SO:');
  if (args.materials.length === 0) {
    parts.push('  (no materials loaded yet)');
  } else {
    for (const m of args.materials) {
      parts.push(
        `  - ${m.material} (Batch ${m.batch || 'N/A'}): ordered ${m.orderQuantity}, available ${m.availableStock ?? 'n/a'}`,
      );
    }
  }
  parts.push('');

  parts.push('VALID SCENARIOS FOR THIS (sender, stage) — applicable only to action="scenario":');
  if (args.validKeys.length === 0) {
    parts.push('  (none — scenario action would need scenario_key: "unknown")');
  } else {
    for (const v of args.validKeys) {
      parts.push(`- ${v.key}`);
      parts.push(`  Description: ${v.description}`);
      parts.push(`  Steps: ${v.stepKinds.join(' → ')}`);
    }
  }
  parts.push('');

  if (args.activeScenario) {
    parts.push('═══ ACTIVE SCENARIO IN PROGRESS ═══');
    parts.push(`Current scenario: ${args.activeScenario.scenarioKey}`);
    parts.push(`Description: ${args.activeScenario.description}`);
    parts.push(
      `Current step: ${args.activeScenario.currentStepIndex + 1}/${args.activeScenario.steps.length} (${args.activeScenario.steps[args.activeScenario.currentStepIndex] ?? 'past end'})`,
    );
    if (args.activeScenario.stepsAlreadyExecuted.length > 0) {
      parts.push('Steps already executed:');
      for (const s of args.activeScenario.stepsAlreadyExecuted) {
        parts.push(`  ${s.stepIndex + 1}. ${s.kind} (completed at ${s.completedAt})`);
      }
    }
    const pending = args.activeScenario.steps.slice(args.activeScenario.currentStepIndex);
    if (pending.length > 0) {
      parts.push('Steps pending:');
      pending.forEach((k, i) => {
        const idx = args.activeScenario!.currentStepIndex + i;
        const marker = i === 0 ? ' ← currently waiting on this' : '';
        parts.push(`  ${idx + 1}. ${k}${marker}`);
      });
    }
    parts.push('');
    parts.push('This new email may be a reply that continues the in-flight scenario OR a fresh request that supersedes it.');
    parts.push('For action="scenario", set action_on_active = "abort_and_replace" if the new email asks for something DIFFERENT.');
    parts.push('Set action_on_active = "escalate" if you cannot decide.');
    parts.push('═══════════════════════════════════');
    parts.push('');
  }

  parts.push('EMAIL THREAD (chronological):');
  parts.push(args.emailThread || '(no thread)');
  parts.push('');
  parts.push('CLASSIFY THE LATEST REPLY. Pick the right action.');

  return parts.join('\n');
}

export async function classifyReply(args: ClassifyReplyArgs): Promise<ReplyClassification> {
  const userPrompt = buildUserPrompt(args);

  const openai = new OpenAI();
  const completion = await openai.chat.completions.create({
    model: 'gpt-5.2',
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: MANAGER_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw) {
    return fallbackOther('OpenAI returned empty content');
  }

  let parsed: ReplyClassification;
  try {
    const json = JSON.parse(raw);
    const validated = ReplyClassificationSchema.safeParse(json);
    if (!validated.success) {
      return fallbackOther(`Zod validation failed: ${validated.error.message}`);
    }
    parsed = validated.data;
  } catch (e) {
    return fallbackOther(`JSON parse failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Post-validate scenario-specific constraints.
  if (parsed.action === 'scenario') {
    const validKeySet = new Set(args.validKeys.map((v) => v.key));
    if (parsed.scenario_key !== 'unknown' && !validKeySet.has(parsed.scenario_key)) {
      return {
        action: 'scenario',
        scenario_key: 'unknown',
        reasoning: parsed.reasoning,
        escalate_reason: `LLM returned out-of-vocab key: "${parsed.scenario_key}"`,
        materials: parsed.materials,
        action_on_active: args.activeScenario ? 'escalate' : null,
      };
    }
    if (parsed.scenario_key === 'unknown' && !parsed.escalate_reason) {
      parsed.escalate_reason = 'LLM returned unknown without a reason';
    }
    if (!args.activeScenario) {
      parsed.action_on_active = null;
    }
    if (args.activeScenario && !parsed.action_on_active) {
      parsed.action_on_active = 'escalate';
    }
  }

  return parsed;
}

function fallbackOther(reason: string): ReplyClassification {
  return {
    action: 'other',
    description: 'Classifier could not parse the reply.',
    suggested_question_for_supervisor:
      'The dashboard could not understand this reply automatically. Please review the email and tell us how to proceed.',
    reasoning: reason,
  };
}
