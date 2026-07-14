# LLM Planner — Output Reference

This document is the canonical reference for everything the planner
(`src/lib/llm-planner.ts`) can emit on each call. It is the contract
between the planner and the scenario engine: the engine only does what
the planner tells it to do, and the planner can only choose from the
vocabulary listed here.

> **Where the planner runs**
> Every inbound email tied to a SalesOrder enters
> [`handleReplyV2`](../src/lib/scenario-engine.ts) → calls
> [`planNextSteps`](../src/lib/llm-planner.ts). The planner reads the
> manager prompt (`ManagerV2.1.txt`), the SO's audit trail, the email
> thread, and a live SO-state snapshot, then returns a `PlanResult`
> described below. The engine walks the steps via `fireStep` until
> `stopAfterIndex` is reached, at which point it parks the scenario.
> The next inbound starts the cycle over.

---

## 1. The `PlanResult` envelope

Every successful `planNextSteps()` call returns a single `PlanResult`
object. The fields are defined in
[`src/lib/llm-planner.ts`](../src/lib/llm-planner.ts):

```ts
export interface PlanResult {
  steps: PlannedStep[];
  stopAfterIndex: number;
  rationale: string;
  escalate: boolean;
  escalationQuestion?: string;
}
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `steps` | `PlannedStep[]` | yes | Ordered list of milestones the engine will fire. May be empty. |
| `stopAfterIndex` | `number` | yes | Index of the **last** step that runs before the scenario pauses. `-1` means "no steps to run". `steps.length - 1` means "run every step then pause". The engine clamps malformed values to a valid bound. |
| `rationale` | `string` | yes | One- or two-sentence explanation of what the latest email asks for and why these steps follow. Persisted on `ScenarioProgress.plannerRationale` and surfaced in the audit log. |
| `escalate` | `boolean` | yes | System-level failure flag. **Not** the same as the supervisor step — see [§5](#5-the-three-escape-hatches). When `true` the engine writes an aborted `ScenarioProgress` row and never fires any step. |
| `escalationQuestion` | `string \| undefined` | only when `escalate=true` | Human-readable reason for the failure (e.g. `"Zod validation failed: ..."`). Visible to the operator on the dashboard. |

### Raw JSON shape the LLM emits

The LLM emits this exact JSON (validated by Zod before becoming a
`PlanResult`):

```json
{
  "rationale": "<string>",
  "steps": [ /* PlannedStep, see §2 */ ],
  "stop_after_index": 0,
  "escalate": false,
  "escalation_question": null
}
```

The snake-case keys (`stop_after_index`, `escalation_question`) are an
implementation detail of the prompt; downstream code reads the
camelCase fields off `PlanResult`.

---

## 2. The `PlannedStep` shape

Each entry inside `steps` is a `PlannedStep`:

```ts
export interface PlannedStep {
  kind: StepKind;
  rationale?: string;
  question?: string;
  options?: string[];
}
```

| Field | Type | Required | Used by |
|---|---|---|---|
| `kind` | `StepKind` (closed set — see [§3](#3-the-stepkind-vocabulary)) | yes | All steps. Out-of-vocab values are rejected by Zod. |
| `rationale` | `string` | optional | Audit only. Shown in the `step_fired` event payload and rendered as the step label in dashboard timelines. |
| `question` | `string` | required for the 3 question-asking kinds; ignored otherwise | The **verbatim** email body. The executor never paraphrases this — what the planner writes is what gets sent. |
| `options` | `string[]` | used by `email_supervisor_question`; ignored otherwise | Short candidate next-actions the planner is weighing. Rendered as a numbered list in the supervisor email. |

> **Important: the planner emits step kinds only**
> For every step kind **except** the three question-askers, the planner
> does **not** emit any data values. It does not pick quantities,
> material codes, vehicle numbers, or tonnage values. Each step's
> executor reads what it needs from the email thread / DB on its own.
> The planner's job is to choose the right sequence of milestones,
> nothing more.

---

## 3. The `StepKind` vocabulary

18 step kinds, grouped by what they do. The full source-of-truth list
lives in [`src/lib/dispatch-scenarios.ts`](../src/lib/dispatch-scenarios.ts);
the one-line descriptions surfaced to the LLM live in
[`src/lib/llm-planner.ts`](../src/lib/llm-planner.ts) (`STEP_KINDS`).

### 3a. SAP transactions

| Kind | What it does | When to emit |
|---|---|---|
| `stock_precheck` | Free-stock pre-check against the synced `inventory_snapshot` DB. Replaces the spreadsheet's "Zmatana" Step 2 for increase-shaped modifications. | **Always** before `va02` on any increase. If insufficient, the executor emails the branch a shortage note and aborts the scenario; sufficient → advance. |
| `va02` | Modify SO line items in SAP. | Only when **increasing** a material quantity. Decreases and deletes never need `va02`. |
| `zso_visibility` | Re-run `ZSO_Visibility` + `Zmatana`. The `/visibility-data` callback auto-sends the next `ls_dispatch` email. | Always after `va02` to refresh material availability and trigger the round-2 product confirmation. |
| `mb51` | Park on the daily FCFS reactivator (wait for new stock to arrive). | Only when the branch explicitly says "wait" or the precheck flags a shortage and the branch wants to wait. |
| `zload1` | Create loading slips (LSs) for the SO. Fans out per bundle. | Only when **no LSs exist yet** for the SO (i.e. `SO.status != 'ls_created'`). Re-emitting after LSs exist is a hard error. |
| `zload2` | Revise existing LS quantities. | When LSs already exist and the qty on a line needs updating (decrease or post-LS increase). |
| `zloading_close` | Delete line items from an existing LS (SAP `ZLOAD_Delete`). | For material deletions after LS creation. |

### 3b. Outbound emails — executor authors the text

For every kind in this group, the executor builds the email body
deterministically from the SO state, materials list, audit trail, or
trigger reply. The planner only decides **whether** to emit the kind,
not what to say.

| Kind | Email type sent | When to emit |
|---|---|---|
| `email_2nd_release` | `2nd_release` | After `va02` to ask the branch to confirm the revised plan. Always emitted **between** `va02` and the re-run of `zso_visibility`. Bumps `PurchaseOrder.dispatchRound`. |
| `email_confirm_product_details` | `ls_dispatch` | This is normally auto-sent by the `/visibility-data` callback. Only emit explicitly to re-send. |
| `email_confirm_bundle_details` | `dispatch_confirmation` | After the branch confirms the `ls_dispatch`. Hard rule of the process: branch must confirm the bundle plan before `zload1` fires (see ManagerV2.1 §1E). |
| `email_to_branch_for_vehicle` | `vehicle_details` | After `zload1` creates the loading slips, to ask the branch for truck no / driver / LR. |
| `email_to_plant` | `plant_ls` | After the branch provides vehicle details. Forwards the LS PDF to the plant. |
| `email_to_branch_notifying_plant_change` | `plant_change_notification` | When the **plant** is proposing modifications. Branch must approve before SAP is touched. Never used for branch-driven changes. |
| `email_order_status` | `order_status` | Single-step Anytime intent — when the branch asks "where is my order?" the executor builds a status reply from the audit trail. |

### 3c. Outbound emails — planner authors the text

Three kinds where the planner writes the question itself. The executor
sends it verbatim. **`question` is required** on the step; sending a
step in this group with an empty `question` causes the scenario to
fail.

| Kind | Recipient | Threading | Extra fields |
|---|---|---|---|
| `email_clarify_branch` | `BRANCH_EMAIL` | In-thread (reply on the inbound that triggered the plan) | `question` only |
| `email_clarify_plant` | `PLANT_EMAIL` | In-thread | `question` only |
| `email_supervisor_question` | `SUPERVISOR_EMAIL` (`amanrai369@gmail.com` if unset) | Fresh thread | `question` + `options[]` |

The clarification kinds are for ambiguous, contradictory, or partial
replies. The supervisor kind is for in-band confusion — the planner has
read the audit trail and the email thread but genuinely can't pick
between options. See [§5](#5-the-three-escape-hatches) for when to use
each.

### 3d. Data-extraction steps

These steps read the inbound reply, parse a value out of it, and write
it to the DB. They do not call SAP and do not send email.

| Kind | What it parses | Where it writes |
|---|---|---|
| `process_plant_invoice` | Invoice PDF attached to a `plant_ls` reply. The PDF was already uploaded to R2 by the email-reply-checker pre-pass — this step fires `ZLOAD3-B1` (the batch sender) to ingest it. | `Invoice` row + LS metadata |
| `process_tonnage_reply` | Vehicle tonnage from a reply on a `tonnage_inquiry` thread. Multi-strategy regex (kg → tonnes/t/mt → contextual fallback). | `PurchaseOrder.weightage` |

### 3e. Sentinels

| Kind | What it does |
|---|---|
| `await_plant_invoice` | Marks the scenario `awaiting_plant_invoice`. `checkAndSendBatchToAman` advances it when the plant invoice arrives. |
| `await_vt01n` | Marks the scenario `awaiting_vt01n`. `triggerVto1n` advances it when the operator (or pipeline) fires `VT01N` for the shipment. |

Sentinels are rarely needed because the engine's other paths (cron,
callbacks) drive these transitions automatically. They exist for plans
that want to *mark* the wait explicitly so the audit timeline shows
"paused on X".

---

## 4. `stopAfterIndex` semantics

| Plan | `stopAfterIndex` | Behavior |
|---|---|---|
| 0 steps | `-1` | Engine writes a `scenario_completed` event immediately. Nothing fires. |
| 1 step | `0` | The single step fires, then the scenario completes. |
| 3 steps, pause after step 2 | `2` | All three fire, then the scenario marks itself `completed` (segmented mode) or `awaiting_reply` (legacy mode, if the last step was an email). |
| 3 steps, pause after step 1 | `1` | Only steps 0 and 1 fire. Step 2 is **dropped** — the engine doesn't return to it on the next inbound. (In practice this is rare; the planner usually pauses at the last step.) |

The engine clamps a malformed `stopAfterIndex` (negative when `steps`
isn't empty, or `>= steps.length`) to `steps.length - 1` rather than
fail closed. The planner is expected to set it correctly anyway.

The planner is told to plan **up to and including the next outbound
email**. So in practice `stopAfterIndex` points at the last
`email_*` / `email_clarify_*` / `email_supervisor_question` step. SAP
steps after the last email never appear in a single plan — they get
emitted on a later cycle, after the inbound reply is in.

---

## 5. The three escape hatches

The planner has three different mechanisms for "I can't proceed
normally". They are **not interchangeable**.

### 5a. Clarification (`email_clarify_branch` / `email_clarify_plant`)

Use when the latest inbound is ambiguous, contradictory, or only
partially answers what we asked. The planner emits a single
clarification step with a focused question; the executor sends it
in-thread; the scenario parks; the recipient's reply re-enters the
planner with full thread context.

```json
{
  "rationale": "Branch shared the truck number but not the tonnage. Need both before we can bundle.",
  "steps": [
    {
      "kind": "email_clarify_branch",
      "question": "Thanks for sharing the truck number. Could you also confirm the vehicle tonnage (in tonnes)?"
    }
  ],
  "stop_after_index": 0,
  "escalate": false
}
```

**Rules of thumb the planner is taught:**
- Quote back the part of the message you understood.
- One question per email (unless the questions are tightly linked).
- Keep it 1–3 sentences. Don't paste the original thread.
- Don't use clarification as a stalling move. If the reply is
  actionable, act.

### 5b. Supervisor (`email_supervisor_question`)

Use when the planner has read the audit trail and the email thread but
genuinely cannot decide between options. The planner provides the
question **and** a short list of alternatives it's weighing. The
supervisor replies with which option to take (or with custom
instructions); the reply is picked up by the next plan.

```json
{
  "rationale": "Branch is asking to ship an extra 50 units after dispatch_confirmation was already approved. Unclear whether to treat as a new round or a post-LS modify.",
  "steps": [
    {
      "kind": "email_supervisor_question",
      "question": "SO 3260671 — branch asked to add +50 units on M-A after dispatch_confirmation was approved. Should we treat as a new dispatch round (va02 + 2nd_release) or as a post-LS modify (zload2)?",
      "options": [
        "Treat as new round — fire va02 then 2nd_release",
        "Treat as post-LS modify — fire zload2",
        "Reject and ask branch to clarify"
      ]
    }
  ],
  "stop_after_index": 0,
  "escalate": false
}
```

**Rules of thumb the planner is taught:**
- Apply rules 1–15 of the prompt first. Supervisor is the last resort.
- Be specific: a vague "please advise" wastes a round-trip.
- Provide 2–4 short options as short phrases.
- Don't paste the email — the supervisor sees the rendered thread
  already.

### 5c. System failure (`escalate=true`)

This is **not** a step kind. It's a top-level field on the
`PlanResult`. Set by the planner module itself when:
- the LLM returns empty content,
- the JSON fails to parse,
- the Zod schema rejects the response.

In any of these cases the planner returns:

```json
{
  "steps": [],
  "stopAfterIndex": -1,
  "rationale": "(planner failed)",
  "escalate": true,
  "escalationQuestion": "Zod validation failed: …"
}
```

The engine writes an aborted `ScenarioProgress` row and emits
`scenario_aborted`. No steps fire. Operator intervention is required.

> **Why two separate mechanisms?**
> `email_supervisor_question` is for *in-band* confusion — the system is
> working but the planner can't pick a path. `escalate=true` is for
> *out-of-band* failures — the system itself broke. They route to
> different code paths and surface differently on the dashboard.

---

## 6. Examples

### 6a. Pleasantry — no action

Branch replies "Thanks, all good".

```json
{
  "rationale": "Pleasantry, no action required.",
  "steps": [],
  "stop_after_index": -1,
  "escalate": false
}
```

### 6b. Standard release_all flow — Stage A → B

Branch replies "Release everything" on a round-1 `ls_dispatch`.

```json
{
  "rationale": "Branch confirmed product details. Move to bundle confirmation.",
  "steps": [
    { "kind": "email_confirm_bundle_details", "rationale": "Stage A → Stage B" }
  ],
  "stop_after_index": 0,
  "escalate": false
}
```

### 6c. Standard release_all flow — Stage B → C

Branch replies "Confirmed" on `dispatch_confirmation`.

```json
{
  "rationale": "Branch approved the bundle plan. Create LSs and ask for vehicle details.",
  "steps": [
    { "kind": "zload1" },
    { "kind": "email_to_branch_for_vehicle" }
  ],
  "stop_after_index": 1,
  "escalate": false
}
```

### 6d. Modify-increase pre-LS

Branch replies "+50 on M-A" on a round-1 `ls_dispatch`.

```json
{
  "rationale": "Branch wants to increase M-A by 50. Check stock, modify SO, ask branch to confirm revised plan.",
  "steps": [
    { "kind": "stock_precheck" },
    { "kind": "va02" },
    { "kind": "email_2nd_release" }
  ],
  "stop_after_index": 2,
  "escalate": false
}
```

### 6e. Modify-decrease post-LS

Branch replies "Remove M-B" on a `plant_ls` email (branch-sender, post-LS).

```json
{
  "rationale": "Branch (the customer authority) wants M-B removed after LSs exist. Decrement via ZLOAD_Delete and forward updated LS to plant.",
  "steps": [
    { "kind": "zloading_close" },
    { "kind": "email_to_plant" }
  ],
  "stop_after_index": 1,
  "escalate": false
}
```

### 6f. Plant invoice arrival

Plant replies with an invoice PDF.

```json
{
  "rationale": "Plant sent the invoice PDF. Run ZLOAD3+ZSO_Auto via the batch sender.",
  "steps": [
    { "kind": "process_plant_invoice" }
  ],
  "stop_after_index": 0,
  "escalate": false
}
```

### 6g. Tonnage reply

Branch replies "Vehicle is 35 tonnes" on a `tonnage_inquiry` email.

```json
{
  "rationale": "Branch shared the truck tonnage. Persist on po.weightage so bundling can resume.",
  "steps": [
    { "kind": "process_tonnage_reply" }
  ],
  "stop_after_index": 0,
  "escalate": false
}
```

### 6h. Clarification — partial reply

Branch replies "modify the order" with no material code or quantity.

```json
{
  "rationale": "Branch asked to modify but didn't specify material or quantity. Ask for the missing details.",
  "steps": [
    {
      "kind": "email_clarify_branch",
      "question": "Could you confirm which material you'd like to modify and what the new quantity should be?"
    }
  ],
  "stop_after_index": 0,
  "escalate": false
}
```

### 6i. Supervisor — stuck

Branch's reply lands on a thread where the audit trail is internally
inconsistent.

```json
{
  "rationale": "Audit trail shows two ls_dispatch emails but no dispatch_confirmation between them — can't tell which round we're in.",
  "steps": [
    {
      "kind": "email_supervisor_question",
      "question": "SO 3260680 — audit trail shows two ls_dispatch emails but no dispatch_confirmation between them. Unclear which round the branch's reply applies to.",
      "options": [
        "Treat as round-2 reply — emit email_confirm_bundle_details",
        "Treat as round-1 reply — re-send dispatch_confirmation",
        "Send clarification email to branch asking which release they are confirming"
      ]
    }
  ],
  "stop_after_index": 0,
  "escalate": false
}
```

### 6j. System failure — Zod rejected the LLM output

(Produced by the planner module, not by the LLM.)

```json
{
  "steps": [],
  "stopAfterIndex": -1,
  "rationale": "(planner failed)",
  "escalate": true,
  "escalationQuestion": "Zod validation failed: steps[0].kind: invalid_enum_value"
}
```

---

## 7. What the planner does **not** emit

For clarity, these are things the planner is explicitly **not**
responsible for:

- **Data values** — quantities, material codes, vehicle numbers,
  tonnage values. Each step's executor reads what it needs from the
  email thread / DB.
- **Multiple steps after the next outbound email.** The planner stops
  planning at the next email; the inbound reply triggers a fresh plan.
- **Re-emitting already-completed steps.** The audit trail is shown to
  the planner; if `step_completed zload1` is in it, the planner must
  use `zload2` instead.
- **NEW ORDER intake.** That's a separate non-planner extraction path
  (`extractOrderInfoWithAI`) that creates the SO and PO. The planner
  only runs once the SO exists.
- **PDF parsing.** Reply PDFs are uploaded to R2 by the
  email-reply-checker pre-pass before the planner ever sees the email.

---

## 8. Where each field ends up

| `PlanResult` field | Persisted on | Surfaced where |
|---|---|---|
| `steps` | `ScenarioProgress.generatedSteps` (JSON) | `scenario_started` event payload, dashboard timeline |
| `stopAfterIndex` | `ScenarioProgress.stopAfterIndex` | Walker pause logic |
| `rationale` | `ScenarioProgress.plannerRationale` + `classifier_decision` event | Dashboard, audit log |
| `escalate=true` | `ScenarioProgress.state='aborted'` + `error` set to `escalationQuestion` | Dashboard alerts |
| Per-step `rationale` | `step_fired` event payload | Dashboard timeline (rendered as the step label) |
| Per-step `question` | `Email.sentBody` (verbatim) + `Email.relatedMaterials.question` | Outbound email; supervisor inbox |
| Per-step `options` | `Email.relatedMaterials.options` + rendered as numbered list in `Email.sentBody` | Supervisor inbox |
