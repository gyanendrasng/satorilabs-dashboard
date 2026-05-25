# Dispatch Flow Engine — Complete Pipeline Reference

A guide to how a sales order moves from a "NEW ORDER" email all the way to a shipped truck, including every email exchanged, every SAP transaction fired, every database state transition, and every branching scenario.

This document is for anyone who needs to reason about the end-to-end flow — engineers, ops, anyone debugging a stuck SO.

---

## 1. What this system does

The Satori Labs dashboard automates the dispatch lifecycle for a manufacturing business that uses SAP. Sales orders arrive over email; the system reads them, asks the right people the right questions over email, runs SAP transactions via an automation service (`auto_gui2`), and books shipments — without manual operator clicks for the happy path.

Three external parties send and receive emails:

| Party | Address (env var) | Role |
|---|---|---|
| **Branch** | `BRANCH_EMAIL` | Sales branch — places orders, approves dispatch plans, sends vehicle details, sometimes asks for quantity changes |
| **Plant** | `PLANT_EMAIL` | Manufacturing plant — receives loading slips, returns invoice PDFs, sometimes reports short shipments |
| **Production** | `PRODUCTION_EMAIL` | Production team — receives "is X material ready?" inquiries when stock is short |

Two systems sit behind the dashboard:

| System | Purpose |
|---|---|
| **`auto_gui2`** | Python service that drives SAP via UI automation. Executes transactions like ZSO-VISIBILITY, ZLOAD1, VA02, etc. |
| **Prisma DB** | SQLite (dev) / managed SQL (prod) — source of truth for SOs, POs, bundles, shipments, work queue, scenario progress |

---

## 2. High-level pipeline (the "happy path")

```
        ┌──────────────────────────────────┐
        │   BRANCH sends "NEW ORDER" email │
        └────────────────┬─────────────────┘
                         │
                         ▼
        ┌──────────────────────────────────┐
        │  Cron detects NEW ORDER          │
        │  (every minute via vercel.json)  │
        │  → creates PO + SO in DB         │
        │  → enqueues ZSO-VISIBILITY       │
        └────────────────┬─────────────────┘
                         │
                         ▼
        ┌──────────────────────────────────┐
        │  auto_gui2 runs ZSO-VISIBILITY   │
        │  Returns: per-material stock     │
        │  Sends ls_dispatch email to      │
        │  BRANCH with the dispatch plan   │
        └────────────────┬─────────────────┘
                         │
                         ▼
        ┌──────────────────────────────────┐
        │  BRANCH replies to ls_dispatch   │
        │  • "release all"                 │
        │  • "release part"                │
        │  • "wait" (stock not ready)      │
        │  • "modify" (qty changes)        │← Engine takes over here
        └────────────────┬─────────────────┘
                         │
                ┌────────┴────────┐
                ▼                 ▼
        Legacy path        Scenario engine
        (release_all,      (modify intents
         release_part,      + sender×stage
         wait)              combinations)
                ▼                 ▼
        ┌──────────────────────────────────┐
        │  dispatch_confirmation email     │
        │  → BRANCH                         │
        └────────────────┬─────────────────┘
                         │ "yes"
                         ▼
        ┌──────────────────────────────────┐
        │  fanOutZload1ForPo               │
        │  • computeBundlesForPo (pack     │
        │    materials into trucks)        │
        │  • triggerZload1 per (Bundle,SO) │
        │  → creates Loading Slips in SAP  │
        └────────────────┬─────────────────┘
                         │
                         ▼
        ┌──────────────────────────────────┐
        │  vehicle_details email           │
        │  → BRANCH                         │
        └────────────────┬─────────────────┘
                         │
                         ▼
        ┌──────────────────────────────────┐
        │  BRANCH replies with vehicle     │
        │  number + driver + container     │
        └────────────────┬─────────────────┘
                         │
                         ▼
        ┌──────────────────────────────────┐
        │  sendLSEmail (one per LSI)       │
        │  → PLANT (with LS PDF)            │
        └────────────────┬─────────────────┘
                         │
                         ▼
        ┌──────────────────────────────────┐
        │  PLANT replies with invoice PDF  │
        └────────────────┬─────────────────┘
                         │
                         ▼
        ┌──────────────────────────────────┐
        │  checkAndSendBatchToAman         │
        │  → ZLOAD3-B1 (extract invoice    │
        │    number, LS no, qty, date)     │
        └────────────────┬─────────────────┘
                         │
                         ▼
        ┌──────────────────────────────────┐
        │  Operator triggers VT01N from UI │
        │  → creates SAP shipment          │
        │  → SO completed                  │
        └──────────────────────────────────┘
```

---

## 3. The scenario engine — why it exists

The happy path above works fine for a clean "yes, ship everything" reply. But the spreadsheet `Intent Classification.xlsx` describes **22 distinct scenarios** that can arise based on who sends what, when. Examples:

- "Branch increases qty on material X before LS is created" → VA02 → re-visibility → ZLOAD1
- "Plant says we only have 98 of Y" (after LS) → ZLOAD2 (revise LS qty)
- "Branch wants to delete material Z entirely" (after LS) → ZLOADING_CLOSE (close that line in SAP)
- "Branch wants to wait until stock arrives" → park on MB51 daily reactivator

Each scenario has a different ordered sequence of SAP transactions and emails. Hard-coding 22 different code paths would be unmaintainable. Instead the engine **drives the flow from a lookup table**.

### How the engine works in one sentence

> Look up the scenario from a key built from `(sender, stage, intent, modification)`, then walk its step list one external event at a time.

---

## 4. The four dimensions of a scenario

The scenario key is `${sender}|${stage}|${intent}|${modification}`. Each dimension has a small enum.

### 4.1 Sender (from email metadata)

| Value | Meaning |
|---|---|
| `branch` | Reply came from `BRANCH_EMAIL` |
| `plant`  | Reply came from `PLANT_EMAIL` |

### 4.2 Stage (derived from DB state)

Computed by `deriveStage(salesOrderId)` from `SalesOrder.status`, `LoadingSlipItem.fileUrl`, and `Shipment.status`.

| Stage | Predicate | Meaning |
|---|---|---|
| `before_ls` | `status ∈ {pending, stock_approved}` AND no LSI has `fileUrl` | Visibility done or pending. No Loading Slips yet. |
| `after_ls_before_invoice` | `status == ls_created` AND ≥1 LSI has `fileUrl` AND no Shipment in `shipment-triggered/shipped` | LSs exist in SAP, no plant invoice received yet. |
| `after_invoice` | `status ∈ {in-progress, completed}` OR any Shipment in `shipment-triggered/shipped` | Shipment phase — invoices received, VT01N happened. |

### 4.3 Intent (from the classifier)

Returned by `classifyBranchReply` (in `src/lib/branch-reply-classifier.ts`).

| Value | Meaning |
|---|---|
| `release_all`  | Branch accepts the full plan as-is |
| `release_part` | Branch accepts a subset only |
| `wait`         | Branch wants to hold (stock not ready) |
| `modify`       | Branch wants quantity changes |

### 4.4 Modification (only when `intent === 'modify'`)

| Value | Meaning |
|---|---|
| `increase`  | One or more line quantities going UP |
| `decrease`  | One or more line quantities going DOWN |
| `delete`    | One or more lines being removed |
| `inc_dec`   | Some up, some down |
| `inc_del`   | Some up, some removed |
| `dec_del`   | Some down, some removed |

For non-`modify` intents the slot is `-` in the key.

### 4.5 Example keys

```
branch|before_ls|release_all|-
branch|before_ls|modify|inc_del
plant|after_ls_before_invoice|modify|decrease
branch|after_ls_before_invoice|modify|dec_del
```

---

## 5. Entry-point routing — how a reply finds the engine

Replies arrive via the email cron (`/backend/cron/check-emails` every minute). The cron iterates through Email rows in `status='sent'` and looks at their thread for new messages. When it finds one, it routes by `Email.emailType`:

```
                  Cron sees new reply on a tracked thread
                                │
                                ▼
                ┌───────────────────────────────────┐
                │  Switch on Email.emailType        │
                └───────────────────────────────────┘
                                │
   ┌─────────────────┬─────────┴───────┬─────────────────┬───────────────┐
   ▼                 ▼                  ▼                 ▼               ▼
'vehicle_split    'dispatch_         'production_*'    'vehicle_     '2nd_release'
 _inquiry'        confirmation'      (inquiry,         details'      (NEW —
                                      reminder)                       engine sent)
   │                 │                  │                 │               │
   ▼                 ▼                  ▼                 ▼               ▼
handleVehicle    handleDispatch     handleProduction    handleVehicle  handleSecond
SplitConfirm     Confirmation       Reply / Confirm     DetailsReply   ReleaseReply
                                                          │
                                                          │ [if flag on]
                                                          ▼
                                                  Pre-classify intent
                                                  → 'modify'? → engine
                                                  → else: extract vehicle
                                                              details

                                                                    ┌──────────────┐
                            For 'plant_ls' replies:                 │ 2nd_release  │
                            • PDF attachment? → existing            │ reply: yes → │
                              checkAndSendBatchToAman               │ advance      │
                              (ZLOAD3-B1 + advance engine)          │ no/ambig →   │
                            • No PDF + flag on? → engine            │ abort        │
                              (plant modification request)          └──────────────┘

                            For 'ls_dispatch' / null replies:
                            • handleBranchReply
                              [if flag on] → engine first
                              [if no scenario matched] → legacy
                              3-intent path (release_all/part/wait)
```

The engine entry points are:

| Entry point | Source | What it does |
|---|---|---|
| `handleReplyV2` from `handleBranchReply` | Branch reply to `ls_dispatch` | Classifies → looks up scenario → fires step 0 |
| `handleReplyV2` from `email-reply-checker` (plant fork) | Plant reply without PDF | Classifies as plant → looks up scenario → fires step 0 |
| `handleReplyV2` from `handleVehicleDetailsReply` | Branch piggybacks a modification on a vehicle-details reply | Pre-classifies; if `modify`, hands off to engine |
| `handleSecondReleaseReply` from `email-reply-checker` | Branch reply to a `2nd_release` email | "yes" → advance scenario; "no"/"ambig" → abort scenario |
| `maybeAdvanceScenario` from `/step-status` | auto_gui2 reports SAP step done | Advances scenario past the matching SAP step |
| `maybeAdvanceScenario` from `checkAndSendBatchToAman` | ZLOAD3-B1 enqueued | Advances scenario past `await_plant_invoice` |
| `maybeAdvanceScenario` from `triggerVto1n` | VT01N enqueued | Advances scenario past `await_vt01n` |

---

## 6. The scenario engine internals

### 6.1 The `Step` type

```ts
type StepKind =
  | 'zso_visibility'                  // SAP: ZSO-VISIBILITY (Zmatana is included)
  | 'va02'                            // SAP: VA02 (edit qty)
  | 'mb51'                            // SAP: MB51 daily FCFS reactivator
  | 'zload1'                          // SAP: ZLOAD1 (create LS) — via fanOutZload1ForPo
  | 'zload2'                          // SAP: ZLOAD2 (revise LS qty)
  | 'zloading_close'                  // SAP: ZLOADING_CLOSE (== ZLOAD_Delete)
  | 'email_2nd_release'               // Engine sends → BRANCH
  | 'email_confirm_product_details'   // Milestone (ls_dispatch already sent by upstream)
  | 'email_confirm_bundle_details'    // Milestone (dispatch_confirmation already sent)
  | 'email_to_branch_for_vehicle'     // Existing checkAndSendCombinedVehicleEmailForPo
  | 'email_to_plant'                  // Milestone (existing pipeline sends LSs)
  | 'await_plant_invoice'             // Sentinel: pause until plant replies
  | 'await_vt01n';                    // Sentinel: pause until UI triggers VT01N

interface Step {
  kind: StepKind;
  awaitsCallback?: boolean;      // SAP step — pause until /step-status reports done
  awaitsBranchReply?: boolean;   // Email step — pause until party replies
  label?: string;
}
```

### 6.2 The `ScenarioProgress` state machine

Every active scenario has a `ScenarioProgress` row in the DB.

```
                    ┌───────────────────────────────────┐
                    │              ready                │  ← initial state on create
                    └───────────────┬───────────────────┘
                                    │ executeScenario fires current step
                                    ▼
                ┌───────────────────────────────────────┐
                │     state depends on step.kind        │
                └───┬───────────┬───────────┬───────────┘
                    │           │           │
   ┌────────────────┴──┐  ┌─────┴─────┐ ┌───┴────────────────┐
   ▼                   ▼  ▼           ▼ ▼                    ▼
awaiting_         awaiting_       awaiting_              awaiting_
callback          reply           plant_invoice          vt01n
(SAP step)        (email step)    (await_plant_invoice)  (await_vt01n)
   │                 │                  │                    │
   │ /step-status    │ email reply      │ checkAndSendBatch  │ triggerVto1n
   │   done          │   handler        │   ToAman success   │   success
   ▼                 ▼                  ▼                    ▼
   └─────────────────┴──────────────────┴────────────────────┘
                                │
                                ▼
                advanceScenario(currentStepIndex++)
                                │
                                ▼
                ┌───────────────┴───────────────┐
                │ Past end of step list?         │
                └───┬───────────────────────┬───┘
                    │                       │
                    ▼  no                   ▼  yes
                  ready                completed
                    │
                    └──── executeScenario again

   Failure paths:
   • SAP step throws / classifier throws  → failed (terminal)
   • 2nd_release reply is "no"/"ambig"    → aborted (terminal)
```

`ScenarioProgress` row fields:

| Field | Meaning |
|---|---|
| `salesOrderId` | UNIQUE — only one active scenario per SO at a time |
| `scenarioKey` | e.g. `branch\|before_ls\|modify\|increase` |
| `currentStepIndex` | Which step in the scenario's step list we're on |
| `state` | One of the 7 states above |
| `classifierOutput` | JSON of the classifier's per-material output (used by `va02`, `zload2`, `zloading_close` steps to know which materials to act on) |
| `triggerEmailId` | The Email row that started this scenario (used for thread chaining on `email_2nd_release`) |
| `lastWorkId` / `lastEmailId` | Audit references |
| `error` | Populated on `failed` / `aborted` |
| `createdAt` / `updatedAt` | Standard |

### 6.3 The engine loop (executeScenario)

The engine **never blocks**. Each call:

1. Loads `ScenarioProgress` for the SO.
2. Bails if state is terminal (`completed`, `aborted`, `failed`).
3. Looks at the current step.
4. Fires that step's action via `fireStep` (table dispatch on `StepKind`).
5. Persists the new state (`awaiting_callback`, `awaiting_reply`, etc.).
6. Returns.

When the external event arrives (SAP callback, email reply, plant invoice, VT01N), the relevant handler calls `advanceScenario`, which increments `currentStepIndex` and calls `executeScenario` again to fire the next step.

For "no-op" steps (`email_confirm_product_details`, `email_confirm_bundle_details`, `email_to_plant`), `fireStep` returns `advance_now` and the engine immediately moves to the next step in the same tick.

---

## 7. Email types in play

Every email the system sends or receives lands as a row in the `Email` table. The `emailType` column drives routing.

| `emailType` | Direction | Who sends | Subject pattern | Reply handler |
|---|---|---|---|---|
| `ls_dispatch_buffered` | (internal, never sent) | n/a | n/a | n/a — consumed by `assembleAndSendCombinedEmail` |
| `ls_dispatch` | Outbound → BRANCH | `assembleAndSendCombinedEmail` | "Dispatch Approval Request - PO X" | `handleBranchReply` (engine first, then legacy) |
| `dispatch_confirmation` | Outbound → BRANCH | `sendDispatchConfirmationEmail` | "Dispatch Confirmation - PO X" | `handleDispatchConfirmation` (calls `fanOutZload1ForPo`) |
| `vehicle_split_inquiry` | Outbound → BRANCH | `sendVehicleSplitInquiry` (over-capacity case) | "Vehicle Split Confirmation Required - PO X" | `handleVehicleSplitConfirmation` |
| `vehicle_details` | Outbound → BRANCH | `sendCombinedVehicleDetailsEmailForPo` | "Vehicle Details Required - PO X" | `handleVehicleDetailsReply` (with engine pre-classifier) |
| `plant_ls` | Outbound → PLANT | `sendLSEmail` (per LSI) | "Loading Slip <number>" | Cron: PDF → `checkAndSendBatchToAman`. No PDF + flag → engine plant fork |
| `production_inquiry` | Outbound → PRODUCTION | (legacy "wait" path) | "Stock Availability Inquiry" | `handleProductionReply` (extract days) |
| `production_reminder` | Outbound → PRODUCTION | (after waitUntil elapses) | "Stock Availability Reminder" | `handleProductionConfirmation` (ready / wait_more) |
| `2nd_release` | Outbound → BRANCH | `sendSecondReleaseEmail` (engine only) | "2nd Release Confirmation - SO X" | `handleSecondReleaseReply` (yes → advance, else → abort) |

### Email-row `workflowState` values

| Value | Meaning |
|---|---|
| `awaiting_reply` | Generic: waiting for any reply |
| `awaiting_split_confirmation` | Waiting for the branch to confirm a 2-truck split |
| `awaiting_dispatch_confirmation` | Waiting for branch to confirm the dispatch plan |
| `awaiting_2nd_release_reply` | Engine's 2nd-release email is out, waiting for "yes" |
| `waiting_timer` | Production wait timer is running |
| `buffering` | Multi-SO `ls_dispatch` partial state |
| `completed` | Handler finished processing the reply |

---

## 8. Complete scenario registry (21 entries)

This is the literal contents of `SCENARIOS` in `src/lib/dispatch-scenarios.ts`. The first column is the lookup key. The "Steps" column is the ordered step list — read left-to-right.

**Legend for step abbreviations:**

| Abbrev | StepKind | Spreadsheet name |
|---|---|---|
| `VIS` | `zso_visibility` | ZSO_Visibility + Zmatana |
| `VA02` | `va02` | VA02 |
| `2nd` | `email_2nd_release` | Email for 2nd Release |
| `confP` | `email_confirm_product_details` | Email to Branch to confirm product details |
| `confB` | `email_confirm_bundle_details` | Email to Branch to confirm bundle details |
| `Z1` | `zload1` | ZLOAD1 |
| `Z2` | `zload2` | ZLOAD2 |
| `ZDEL` | `zloading_close` | ZLOAD_Delete |
| `MB51` | `mb51` | MB51 |
| `veh` | `email_to_branch_for_vehicle` | Email to Branch for Vehicle |
| `plant` | `email_to_plant` | Email to Plant |
| `wait_inv` | `await_plant_invoice` | (pause for Zload3+ZSO_Auto) |
| `wait_VT` | `await_vt01n` | (pause for VT01N) |

### 8.1 Branch + Before LS Creation (Product Clarification, rows 9–15)

| Sheet row | Scenario key | Steps |
|---|---|---|
| 9  | `branch\|before_ls\|release_all\|-`        | VIS → confP → confB → Z1 → veh → plant → wait_inv → wait_VT |
| 10 | `branch\|before_ls\|release_part\|-`       | VIS → confP → confB → Z1 → veh → plant → wait_inv → wait_VT |
| 11 | `branch\|before_ls\|modify\|increase`      | VA02 → 2nd → VIS → confP → confB → Z1 → veh → plant → wait_inv → wait_VT |
| 12 | `branch\|before_ls\|modify\|inc_dec`       | VA02 → 2nd → VIS → confP → confB → Z1 → veh → plant → wait_inv → wait_VT |
| 13 | `branch\|before_ls\|modify\|inc_del`       | VA02 → 2nd → VIS → confP → confB → Z1 → veh → plant → wait_inv → wait_VT |
| 14 | `branch\|before_ls\|modify\|delete`        | Z1 → veh → plant → wait_inv → wait_VT |
| 15 | `branch\|before_ls\|wait\|-`               | MB51 |

### 8.2 Branch + Before LS Creation (SO Modification, rows 32–37)

Same lookup keys as 11–14 (rows 32–37 use the same step lists — sender disambiguation isn't needed per user's decision).

| Sheet row | Scenario key | Steps |
|---|---|---|
| 32 | (shares `branch\|before_ls\|modify\|increase`) | VA02 → 2nd → VIS → confP → confB → Z1 → veh → plant → wait_inv → wait_VT |
| 33 | (shares `branch\|before_ls\|modify\|inc_dec`)  | VA02 → 2nd → VIS → confP → confB → Z1 → veh → plant → wait_inv → wait_VT |
| 34 | (shares `branch\|before_ls\|modify\|inc_del`)  | VA02 → 2nd → VIS → confP → confB → Z1 → veh → plant → wait_inv → wait_VT |
| 35 | `branch\|before_ls\|modify\|decrease`          | VA02 → 2nd → VIS → confP → confB → Z1 → veh → plant → wait_inv → wait_VT |
| 36 | (shares `branch\|before_ls\|modify\|delete`)   | Z1 → veh → plant → wait_inv → wait_VT |
| 37 | `branch\|before_ls\|modify\|dec_del`           | VA02 → 2nd → VIS → confP → confB → Z1 → veh → plant → wait_inv → wait_VT |

### 8.3 Branch + After LS Creation (SO Modification, rows 16–21)

After LS exists, vehicle email is skipped (vehicle details already known) and the load step is ZLOAD2 instead of ZLOAD1.

| Sheet row | Scenario key | Steps |
|---|---|---|
| 16 | `branch\|after_ls_before_invoice\|modify\|increase` | VA02 → 2nd → VIS → confP → confB → Z2 → plant → wait_inv → wait_VT |
| 17 | `branch\|after_ls_before_invoice\|modify\|inc_dec`  | VA02 → 2nd → VIS → confP → confB → Z2 → plant → wait_inv → wait_VT |
| 18 | `branch\|after_ls_before_invoice\|modify\|inc_del`  | VA02 → 2nd → VIS → confP → confB → Z2 → ZDEL → plant → wait_inv → wait_VT |
| 19 | `branch\|after_ls_before_invoice\|modify\|decrease` | Z2 → plant → wait_inv → wait_VT |
| 20 | `branch\|after_ls_before_invoice\|modify\|delete`   | ZDEL → plant → wait_inv → wait_VT |
| 21 | `branch\|after_ls_before_invoice\|modify\|dec_del`  | Z2 → ZDEL → plant → wait_inv → wait_VT |

### 8.4 Plant + Before Plant Invoice (LS Modification, rows 25–30)

Mirrors §8.3 but the sender is `plant` (plant reports a shortage / availability change).

| Sheet row | Scenario key | Steps |
|---|---|---|
| 25 | `plant\|after_ls_before_invoice\|modify\|increase` | VA02 → 2nd → VIS → confP → confB → Z2 → plant → wait_inv → wait_VT |
| 26 | `plant\|after_ls_before_invoice\|modify\|inc_dec`  | VA02 → 2nd → VIS → confP → confB → Z2 → plant → wait_inv → wait_VT |
| 27 | `plant\|after_ls_before_invoice\|modify\|inc_del`  | VA02 → 2nd → VIS → confP → confB → Z2 → ZDEL → plant → wait_inv → wait_VT |
| 28 | `plant\|after_ls_before_invoice\|modify\|decrease` | Z2 → plant → wait_inv → wait_VT |
| 29 | `plant\|after_ls_before_invoice\|modify\|delete`   | ZDEL → plant → wait_inv → wait_VT |
| 30 | `plant\|after_ls_before_invoice\|modify\|dec_del`  | Z2 → ZDEL → plant → wait_inv → wait_VT |

---

## 9. The classifier — what gets extracted

`classifyBranchReply` (and `classifyPlantReply`) call OpenAI `gpt-5.2` with a structured prompt and return strict JSON:

```ts
{
  sales_order: '3260614',
  intent: 'modify',
  modification: 'inc_del',                     // only when intent === 'modify'
  materials: [
    { material_code: 'YE1ALIE370000PJP', batch: 'A-3',  operation: 'increase', quantity: 200 },
    { material_code: 'YOALDELT00000ZZP', batch: 'P',    operation: 'delete',   quantity: 0   },
    { material_code: 'YV7FIRM03AN00PJP', batch: 'CP-03', operation: 'keep' }
  ],
  missing_materials: [],                       // only meaningful for intent === 'wait'
  reasoning: 'Branch asked to increase YE1ALIE to 200 and remove YOALDELT entirely.'
}
```

The engine uses this output:

- **`intent` + `modification`** → builds the scenario key for lookup.
- **`materials[]`** → drives the SAP step builders:
  - `va02` step takes materials with `operation ∈ {increase, decrease}` and calls `triggerVa02(soNumber, [{material, orderQuantity: quantity}])`
  - `zload2` step does the same but with `lsNumber` resolved from `LoadingSlipItem`
  - `zloading_close` step takes materials with `operation === 'delete'` and calls `triggerZloadingClose(soNumber, [material_codes])`

---

## 10. SAP transactions — who fires what

Every SAP transaction is a row in the global `WorkQueue` table (`src/lib/work-queue.ts`). The queue is serialized — one transaction `firing` at a time system-wide. auto_gui2 acknowledges completion by POSTing to `/backend/orders/aman/step-status` with the work row's id.

| Transaction | `WorkStep` value | Trigger function | Used in scenarios |
|---|---|---|---|
| ZSO-VISIBILITY (includes Zmatana) | `visibility` | `triggerZsoVisibility` | New SO + every modify scenario re-visibility step |
| VA02 (edit qty) | `va02` | `triggerVa02` | All inc/dec/inc_dec/inc_del/dec_del modify scenarios |
| ZLOAD1 (create LS) | `zload1` | `triggerZload1` via `fanOutZload1ForPo` | All before-LS scenarios |
| ZLOAD2 (revise LS qty) | `zload2` | `triggerZload2` | All after-LS modify scenarios |
| ZLOADING_CLOSE (= ZLOAD_Delete) | `zloading_close` | `triggerZloadingClose` | All delete / inc_del / dec_del modify scenarios |
| ZLOAD3-B1 (extract invoice) | `zload3b1` | `checkAndSendBatchToAman` | When plant invoice PDFs arrive |
| VT01N-B (create shipment) | `vto1n` | `triggerVto1n` | UI-triggered when LR + vehicle details ready |
| MB51 (daily FCFS) | `mb51` | Daily cron | Reactivates SOs in `wait` state |

Retry policy: 1 initial + 3 retries = 4 attempts total, 30s backoff. Defined in `MAX_ATTEMPTS` / `RETRY_BACKOFF_MS`.

---

## 11. SalesOrder lifecycle states

`SalesOrder.status` transitions roughly mirror the stage progression.

| Status | Set by | Meaning |
|---|---|---|
| `pending` | Default on creation (from NEW ORDER ingest) | Just-created SO |
| `pending-input` | (UI display state, not actually written) | Awaiting user input |
| `in-progress` | `/initial-data` callback after ZLOAD3-A | Plant has LS files; awaiting invoice |
| `stock_approved` | `handleDispatchConfirmation` / `fanOutZload1ForPo` | Branch approved dispatch; about to fire ZLOAD1 |
| `ls_created` | `/zload1-data` callback | LS files created in SAP; vehicle email sent |
| `completed` | `/step-status` VT01N gate | All shipments shipped; SO finished |

Other key SalesOrder fields:

| Field | Use |
|---|---|
| `visibilityState` | `null \| queued \| firing \| received \| failed` — ZSO-VISIBILITY pipeline state (multi-SO serial processing) |
| `releasePlan` | JSON release plan after `release_all/release_part` intent — held until weight gate clears |
| `waitUntil` | When to re-fire ZSO-VISIBILITY (set by `wait` intent or `production_reply`) |
| `waitRechecks` | Count of times we've re-checked |
| `intentLabel` | Denormalised latest `scenarioKey` from ScenarioProgress (for dashboard reads) |
| `originalThreadId` / `originalMessageId` | Gmail thread anchor for replying-in-thread |

---

## 12. Two worked end-to-end examples

### Example A: Happy path (release_all, no modifications)

```
Time   Actor / Event                                       SO.status / state
────   ──────────────────────────────────────────────      ──────────────────
T+0    BRANCH sends "NEW ORDER 3260614"
T+1m   cron checkForNewEmails detects it                   SO created
                                                            status='pending'
                                                            visibilityState='queued'
T+1m   triggerZsoVisibility('3260614')                     WorkQueue: visibility firing
T+2m   auto_gui2 runs ZSO-VISIBILITY                       Material rows populated
       POSTs /visibility-data with materials
T+2m   assembleAndSendCombinedEmail(poId)                  Email: ls_dispatch sent
                                                            workflowState='awaiting_reply'
T+10m  BRANCH replies "yes release all"
T+11m  cron checkForReplies → handleBranchReply
       [flag on] → handleReplyV2('branch')
       classifier returns intent='release_all'
       deriveStage → 'before_ls'
       lookup → branch|before_ls|release_all|-
       ScenarioProgress created at step 0 (VIS)            ScenarioProgress: ready
       executeScenario fires VIS                            ScenarioProgress: awaiting_callback
       (this re-runs visibility; assembleAndSendCombinedEmail
        is idempotent so no duplicate ls_dispatch)
T+12m  /step-status visibility done                         maybeAdvanceScenario advances step
       executeScenario → confP (milestone)                 ScenarioProgress: advances immediately
       → confB (milestone)                                 ScenarioProgress: advances immediately
       → Z1 (fanOutZload1ForPo)                            ScenarioProgress: awaiting_callback
                                                            status='stock_approved'
                                                            WorkQueue: zload1 firing
T+15m  /step-status zload1 done for each bundle            
       /zload1-data callbacks populate LSIs                 status='ls_created'
                                                            ScenarioProgress advances
       executeScenario → veh                                ScenarioProgress: awaiting_reply
       checkAndSendCombinedVehicleEmailForPo sends         Email: vehicle_details sent
T+30m  BRANCH replies "vehicle GJ12X, driver 9876..., container C-123"
T+31m  handleVehicleDetailsReply (no modify intent)        
       saves vehicle on Bundle rows
       For each LSI: sendLSEmail(plant)                    Email: plant_ls sent (per LSI)
       advanceScenario → plant (milestone, advance now)
       → wait_inv                                          ScenarioProgress: awaiting_plant_invoice
T+60m  PLANT replies with invoice PDF
T+61m  cron sees PDF → checkAndSendBatchToAman             WorkQueue: zload3b1 firing
       maybeAdvanceScenario('zload3b1')                    ScenarioProgress advances
       executeScenario → wait_VT                           ScenarioProgress: awaiting_vt01n
T+65m  auto_gui2 returns invoice/OBD data
       Shipment row created with obdNumber                  Shipment: status='created'
T+90m  Operator clicks "Trigger VT01N" on UI               
       triggerVto1n(shipmentId)                            WorkQueue: vto1n firing
                                                            Shipment: 'shipment-triggered'
       maybeAdvanceScenario('vto1n')                       ScenarioProgress advances
       executeScenario sees past end → completed           ScenarioProgress: completed
T+95m  /step-status vto1n done                             Shipment: 'shipped'
                                                            status='completed' (SO)
```

### Example B: After-LS modification — branch says "reduce material Y to 50 and delete material Z"

```
Time   Actor / Event                                       SO.status / state
────   ──────────────────────────────────────────────      ──────────────────
T+0    SO is in stage after_ls_before_invoice              status='ls_created'
       (LSs created, plant has LS PDFs)                    LSI: fileUrl populated
       Engine has no active ScenarioProgress for this SO
T+0    BRANCH sends a fresh email: "please reduce Y to     
       50 and remove Z entirely on SO 3260614"
       Email arrives on the vehicle_details thread
T+1m   cron handleVehicleDetailsReply
       [flag on] pre-classifier handleReplyV2('branch')
       classifier returns intent='modify',
         modification='dec_del',
         materials=[{Y, decrease, 50}, {Z, delete, 0}]
       deriveStage → 'after_ls_before_invoice'
       lookup → branch|after_ls_before_invoice|modify|dec_del
       Step list: Z2 → ZDEL → plant → wait_inv → wait_VT
       ScenarioProgress created at step 0                  ScenarioProgress: ready
       executeScenario fires Z2 (ZLOAD2)                    ScenarioProgress: awaiting_callback
                                                            WorkQueue: zload2 firing
T+3m   /step-status zload2 done                            
       maybeAdvanceScenario('zload2')                      ScenarioProgress advances
       executeScenario fires ZDEL (ZLOADING_CLOSE)          ScenarioProgress: awaiting_callback
                                                            WorkQueue: zloading_close firing
T+5m   /step-status zloading_close done                    
       maybeAdvanceScenario('zloading_close')              ScenarioProgress advances
       executeScenario → plant (milestone)
       → wait_inv                                          ScenarioProgress: awaiting_plant_invoice
       (plant has LSs already; engine pauses)
T+30m  PLANT replies with invoice PDF for the revised LS
       checkAndSendBatchToAman → ZLOAD3-B1                 WorkQueue: zload3b1 firing
       maybeAdvanceScenario('zload3b1')                    ScenarioProgress advances
       → wait_VT                                           ScenarioProgress: awaiting_vt01n
T+60m  Operator triggers VT01N                              WorkQueue: vto1n firing
       maybeAdvanceScenario('vto1n')                       ScenarioProgress: completed
                                                            status='completed' (SO)
```

---

## 13. The feature flag

The whole engine is gated by `SCENARIO_ENGINE_ENABLED`. When set to anything other than `'true'` (case-insensitive), the engine is dormant — no behavioral change to the existing system.

```bash
# Off (default) — only legacy 3-intent classifier path runs
SCENARIO_ENGINE_ENABLED=false

# On — engine takes over for modify intents + plant modifications + vehicle reply piggybacks
SCENARIO_ENGINE_ENABLED=true
```

Where it gates:

1. **Top of `handleBranchReply`** — when on, calls engine first; falls back to legacy if no scenario matches.
2. **Plant-mod fork in `email-reply-checker.ts`** — when on AND plant_ls reply has no PDF, routes to engine.
3. **Top of `handleVehicleDetailsReply`** — when on, pre-classifies for modification intent.
4. **Inside `maybeAdvanceScenario`** — short-circuits when off so external triggers don't accidentally advance anything.

---

## 14. What is NOT in the engine (intentional)

Per the spreadsheet scoping:

| Out of scope | Why |
|---|---|
| Row 3 "New SO" | Existing new-order path stays untouched |
| Row 5 "Vehicle Weight Clarification" | Triggered by a special case, not yet specified |
| Rows 4, 6, 7, 8 (Anytime / Order Update / Sharing Vehicle Details / Others) | Covered by existing handlers (vehicle_details, conversational) |
| Sheet 2 entirely | Antique, AB Logistics, PAF, partial invoicing — all P2 |

Pipeline tail is **observed not driven** by the engine:

- `email_to_plant` step is a milestone — engine doesn't re-send LS to plant. The existing `handleVehicleDetailsReply` → `sendLSEmail` path does that. (Vehicle details are always present by the time this step is reached, per design.)
- `await_plant_invoice` step is a pause — `checkAndSendBatchToAman` is what ultimately advances the engine past it when the plant reply lands.
- `await_vt01n` step is a pause — `triggerVto1n` advances the engine.

---

## 15. Files in this implementation

| File | Role |
|---|---|
| `src/lib/dispatch-scenarios.ts` | Types + `SCENARIOS` registry + `deriveStage` + `resolveScenario` |
| `src/lib/scenario-engine.ts` | Orchestrator: `handleReplyV2`, `executeScenario`, `advanceScenario`, `maybeAdvanceScenario`, `sendSecondReleaseEmail`, `handleSecondReleaseReply`, `classifyPlantReply`, `fireStep` |
| `src/lib/branch-reply-classifier.ts` | Extended classifier — adds `intent: 'modify'` + `modification` + per-material `operation` |
| `src/lib/auto-gui-trigger.ts` | Pre-existing trigger functions + new exported `fanOutZload1ForPo` helper; gated feature-flag delegation at top of `handleBranchReply`; engine-advance hooks in `checkAndSendBatchToAman` + `triggerVto1n` + `handleVehicleDetailsReply` pre-classifier |
| `src/lib/email-reply-checker.ts` | Reply routing — adds `2nd_release` branch + plant-mod fork |
| `src/app/backend/orders/aman/step-status/route.ts` | Adds `maybeAdvanceScenario` call after legacy gates |
| `prisma/schema.prisma` | `ScenarioProgress` model + `intentLabel` on `SalesOrder` |
| `prisma/migrations/20260521000000_add_scenario_progress/migration.sql` | DDL for new table + column |
| `scripts/test-scenario-classifier.ts` | Offline fixture harness for the classifier |

---

## 16. Quick reference card

**To enable the engine in an environment:**
```
SCENARIO_ENGINE_ENABLED=true
```

**To inspect a stuck scenario:**
```sql
SELECT s.soNumber, sp.scenarioKey, sp.currentStepIndex, sp.state, sp.error
FROM scenario_progress sp
JOIN sales_order s ON s.id = sp.salesOrderId
WHERE sp.state NOT IN ('completed', 'aborted', 'failed');
```

**To run classifier fixtures:**
```
OPENAI_API_KEY=sk-... npx tsx scripts/test-scenario-classifier.ts
```

**To wipe an aborted scenario and let a fresh reply re-enter the engine:**
```sql
DELETE FROM scenario_progress WHERE salesOrderId = 'so-id-here';
```

**Cron entry point:** `vercel.json` → `/backend/cron/check-emails` (every minute).
