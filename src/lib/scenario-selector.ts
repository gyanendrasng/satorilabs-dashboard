/**
 * LLM-as-scenario-selector (Phase E).
 *
 * Replaces the narrow Phase A–D classifier (intent + modification) with a
 * full "Manager" LLM that reads:
 *   - the entire email thread for the SO
 *   - the current stage of the SO (derived from DB state)
 *   - the materials on the SO
 *   - the valid scenario keys (pre-filtered by sender + stage)
 *   - if mid-flow: the active scenario's progress
 *
 * and picks ONE of the registered scenario keys, OR `'unknown'`.
 *
 * Out-of-vocab outputs are coerced to `'unknown'`. The engine escalates those
 * to operator review — no retries, no hallucinated SAP transactions.
 */
import OpenAI from 'openai';
import { z } from 'zod';
import type { Stage } from './dispatch-scenarios';

// -----------------------------------------------------------------------------
// Output schema
// -----------------------------------------------------------------------------

const MaterialOpSchema = z.object({
  material_code: z.string(),
  batch: z.string().default(''),
  operation: z.enum(['keep', 'increase', 'decrease', 'delete']).optional(),
  quantity: z.number().default(0),
});

const ScenarioSelectionSchema = z.object({
  scenario_key: z.string(),
  reasoning: z.string().default(''),
  escalate_reason: z.string().optional(),
  materials: z.array(MaterialOpSchema).default([]),
  // Required only when an active scenario was provided in the prompt.
  // Accept the enum values, JSON null, or the literal string "null" (LLMs
  // sometimes return string-null in JSON output). Anything else is coerced
  // to null by the preprocess.
  action_on_active: z
    .preprocess(
      (v) => (v === 'null' || v === '' ? null : v),
      z.enum(['abort_and_replace', 'escalate']).nullable().optional(),
    )
    .optional(),
});

export type ScenarioSelection = z.infer<typeof ScenarioSelectionSchema>;

// -----------------------------------------------------------------------------
// The "Manager" system prompt — verbatim from the user, plus a structured-
// output addendum that constrains the LLM to pick from a known scenario list.
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

You are NOT being asked to write step-by-step instructions. Instead, your job
is to read the email thread provided below and pick ONE scenario key from the
list of valid scenarios. Each scenario key already has a pre-defined step
sequence — your job is matching, not authoring.

Respond with strict JSON only. No prose outside the JSON.

{
  "scenario_key": "<one of the listed valid keys, or 'unknown'>",
  "reasoning": "<one to two sentences on why you chose this key>",
  "escalate_reason": "<required only if scenario_key is 'unknown' — describe what the sender is asking for and why it doesn't fit any listed scenario>",
  "materials": [
    {"material_code": "...", "batch": "...", "operation": "keep|increase|decrease|delete", "quantity": <number>}
  ],
  "action_on_active": "abort_and_replace|escalate|null"
}

RULES:
- "scenario_key" MUST be exactly one of the listed valid keys, or the literal string "unknown". Do not invent keys.
- For modification scenarios, include every material the sender is acting on in "materials" with the correct "operation" and the NEW target "quantity" (0 for delete).
- For release_all / release_part / wait scenarios, "materials" may list the relevant lines but "operation" can be omitted.
- "action_on_active" is REQUIRED if the prompt contains an "ACTIVE SCENARIO IN PROGRESS" section. Otherwise set it to null. Values:
    * "abort_and_replace": the new email supersedes the in-flight scenario; switch to the new scenario_key.
    * "escalate": the new email conflicts with the in-flight scenario and you cannot decide.
- If you cannot map the email to one of the listed scenarios with high confidence, return scenario_key: "unknown" and explain in escalate_reason.
`;

// -----------------------------------------------------------------------------
// The main function
// -----------------------------------------------------------------------------

export interface SelectorMaterial {
  material: string;
  batch: string;
  orderQuantity: number;
  availableStock: number | null;
}

export interface SelectorValidKey {
  key: string;
  description: string;
  stepKinds: string[];
}

export interface SelectorActiveScenario {
  scenarioKey: string;
  description: string;
  currentStepIndex: number;
  steps: string[];               // ordered step kinds for the active scenario
  stepsAlreadyExecuted: Array<{
    stepIndex: number;
    kind: string;
    completedAt: string;        // ISO timestamp from events
  }>;
}

export async function selectScenarioForReply(args: {
  soNumber: string;
  sender: 'branch' | 'plant';
  stage: Stage;
  emailThread: string;
  materials: SelectorMaterial[];
  validKeys: SelectorValidKey[];
  activeScenario?: SelectorActiveScenario | null;
}): Promise<ScenarioSelection> {
  const userPromptParts: string[] = [];

  userPromptParts.push(`TARGET SALES ORDER: ${args.soNumber}`);
  userPromptParts.push(`SENDER: ${args.sender}`);
  userPromptParts.push(`CURRENT STAGE: ${args.stage}`);
  userPromptParts.push('');

  userPromptParts.push('MATERIALS ON THIS SO:');
  if (args.materials.length === 0) {
    userPromptParts.push('  (no materials loaded yet)');
  } else {
    for (const m of args.materials) {
      userPromptParts.push(
        `  - ${m.material} (Batch ${m.batch || 'N/A'}): ordered ${m.orderQuantity}, available ${m.availableStock ?? 'n/a'}`,
      );
    }
  }
  userPromptParts.push('');

  userPromptParts.push('VALID SCENARIOS FOR THIS (sender, stage):');
  if (args.validKeys.length === 0) {
    userPromptParts.push('  (none — return scenario_key: "unknown")');
  } else {
    for (const v of args.validKeys) {
      userPromptParts.push(`- ${v.key}`);
      userPromptParts.push(`  Description: ${v.description}`);
      userPromptParts.push(`  Steps: ${v.stepKinds.join(' → ')}`);
    }
  }
  userPromptParts.push('');

  if (args.activeScenario) {
    userPromptParts.push('═══ ACTIVE SCENARIO IN PROGRESS ═══');
    userPromptParts.push(`Current scenario: ${args.activeScenario.scenarioKey}`);
    userPromptParts.push(`Description: ${args.activeScenario.description}`);
    userPromptParts.push(
      `Current step: ${args.activeScenario.currentStepIndex + 1}/${args.activeScenario.steps.length} (${args.activeScenario.steps[args.activeScenario.currentStepIndex] ?? 'past end'})`,
    );
    if (args.activeScenario.stepsAlreadyExecuted.length > 0) {
      userPromptParts.push('Steps already executed:');
      for (const s of args.activeScenario.stepsAlreadyExecuted) {
        userPromptParts.push(`  ${s.stepIndex + 1}. ${s.kind} (completed at ${s.completedAt})`);
      }
    }
    const pending = args.activeScenario.steps.slice(args.activeScenario.currentStepIndex);
    if (pending.length > 0) {
      userPromptParts.push('Steps pending:');
      pending.forEach((k, i) => {
        const idx = args.activeScenario!.currentStepIndex + i;
        const marker = i === 0 ? ' ← currently waiting on this' : '';
        userPromptParts.push(`  ${idx + 1}. ${k}${marker}`);
      });
    }
    userPromptParts.push('');
    userPromptParts.push('This new email may be a reply that continues the in-flight scenario OR a fresh request that supersedes it.');
    userPromptParts.push('Set action_on_active = "abort_and_replace" if the new email asks for something DIFFERENT from the in-flight scenario.');
    userPromptParts.push('Set action_on_active = "escalate" if you cannot decide.');
    userPromptParts.push('═══════════════════════════════════');
    userPromptParts.push('');
  }

  userPromptParts.push('EMAIL THREAD (chronological):');
  userPromptParts.push(args.emailThread || '(no thread)');
  userPromptParts.push('');
  userPromptParts.push('PICK ONE SCENARIO KEY.');

  const userPrompt = userPromptParts.join('\n');

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
    return {
      scenario_key: 'unknown',
      reasoning: '',
      escalate_reason: 'OpenAI returned empty content',
      materials: [],
      action_on_active: args.activeScenario ? 'escalate' : null,
    };
  }

  let parsed: ScenarioSelection;
  try {
    const json = JSON.parse(raw);
    const validated = ScenarioSelectionSchema.safeParse(json);
    if (!validated.success) {
      return {
        scenario_key: 'unknown',
        reasoning: '',
        escalate_reason: `Zod validation failed: ${validated.error.message}`,
        materials: [],
        action_on_active: args.activeScenario ? 'escalate' : null,
      };
    }
    parsed = validated.data;
  } catch (e) {
    return {
      scenario_key: 'unknown',
      reasoning: '',
      escalate_reason: `JSON parse failed: ${e instanceof Error ? e.message : String(e)}`,
      materials: [],
      action_on_active: args.activeScenario ? 'escalate' : null,
    };
  }

  // Coerce out-of-vocab keys to 'unknown' — no hallucinated SAP transactions.
  const validKeySet = new Set(args.validKeys.map((v) => v.key));
  if (parsed.scenario_key !== 'unknown' && !validKeySet.has(parsed.scenario_key)) {
    return {
      scenario_key: 'unknown',
      reasoning: parsed.reasoning,
      escalate_reason: `LLM returned out-of-vocab key: "${parsed.scenario_key}"`,
      materials: parsed.materials,
      action_on_active: args.activeScenario ? 'escalate' : null,
    };
  }

  // Require escalate_reason if scenario_key is 'unknown'.
  if (parsed.scenario_key === 'unknown' && !parsed.escalate_reason) {
    parsed.escalate_reason = 'LLM returned unknown without a reason';
  }

  // When no active scenario, force action_on_active to null.
  if (!args.activeScenario) {
    parsed.action_on_active = null;
  }
  // When active scenario exists but LLM didn't set action_on_active, default to escalate.
  if (args.activeScenario && !parsed.action_on_active) {
    parsed.action_on_active = 'escalate';
  }

  return parsed;
}
