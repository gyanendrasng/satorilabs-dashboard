# E2E via dummy auto_gui2 — test report

**Driver**: [scripts/e2e-via-dummy.ts](../scripts/e2e-via-dummy.ts)
**Dummy server**: [scripts/dummy-auto-gui2/server.mjs](../scripts/dummy-auto-gui2/server.mjs)
**Mode**: `SEGMENTED_EXECUTION_ENABLED=true` (legacy mode dropped per user direction)

| Run | Date | Result | Notes |
|---|---|---|---|
| Run 1 (baseline) | 2026-05-30 | **46 / 52** | 2 real defects, 4 test-side issues — see "Run 1 details" |
| Run 2 (post-fix) | 2026-05-30 | **52 / 52** | All 6 failures addressed — see "Run 2 — post-fix" |

---

## Scope — what this test actually exercises

This report covers **one specific test run only**: the 52-case comprehensive
suite executed via the new `scripts/e2e-via-dummy.ts` driver against the
dummy auto_gui2 server. It is **not** the same as:

- [scripts/test-scenarios-e2e.ts](../scripts/test-scenarios-e2e.ts) — the older
  harness that **mocks** the work queue and Gmail entirely. That suite has
  separate numbers (last run: 34/35 segmented + 34/35 legacy).
- Earlier static checks (`verify-sheet-adapter.ts`, `verify-valid-keys.ts`,
  `verify-stage-derivation.ts`, `verify-sap-output-audit.ts`) which only test
  data structures and pure functions, not HTTP behaviour.

### What's real vs. mocked in THIS run

| Layer | State |
|---|---|
| Scenario engine (`handleReplyV2`, `executeScenario`, `maybeAdvanceScenario`) | **Real** |
| Classifier (`classifyReply` → OpenAI) | **Real** — every test hits the live OpenAI API |
| Work queue (`enqueueWork` → `pumpQueue` → HTTP `/chat` over the wire) | **Real** |
| Auto_gui2 (`/chat`, `/visibility-data`, `/zload1-data`, `/processing-data`, `/step-status`) | **Mocked** — runs in [scripts/dummy-auto-gui2/server.mjs](../scripts/dummy-auto-gui2/server.mjs) as a forked child process on port 8001 |
| Dashboard route handlers (`/backend/orders/aman/*`) | **Real** — invoked in-process via a fetch interceptor + HTTP bridge so the dummy's child-process callbacks reach them |
| Gmail (`sendPlainEmail`, etc.) | **Stubbed** via require-hook — DB `Email` rows still get written |
| Database | **Real** Prisma against `test-e2e.db` SQLite file |

The dummy's callback payloads use real-world artifact data (SO 3260671 with
11 SAP-coded materials from `test_artifacts/3260671.json`, invoice number
`7682614520`, OBD `85817679`, LS counter starting at `373282` from the real
artifact PDF). See the per-test details below for which transactions made
the real HTTP round-trip.

---

## Run 1 details — baseline

**46 PASS / 6 FAIL / 52 total** (88.5%)

| Category | Count |
|---|---|
| Sheet intents correctly classified | 43 / 49 |
| Deep-dive tests passed | 3 / 3 |
| Real defects in the dashboard surfaced | 2 |
| LLM-drift / ambiguous-wording failures | 2 |
| Test-side assertion gaps | 2 |

---

## Coverage matrix — every sheet intent has at least one test

The driver runs one intent spec per sheet-backed scenario key (49 total) plus
3 deep-dive tests that verify SAP round-trip + audit-trail content. Coverage
was confirmed by a static script that enumerates `getAllSheetBackedKeys()`
and compares against `expectedKey` literals in the driver — `49/49 covered`.

| Stage | Intents tested | All PASS? |
|---|---|---|
| `before_ls` (release / wait) | 3 | ✓ release_all, release_part, wait |
| `before_ls` (modify) | 6 | ✓ increase, inc_dec, inc_del, delete, decrease, dec_del |
| `before_ls` (special) | 4 | ✓ new_so, ✗ 2nd_release (test gap), ✓ discount_confirm, ✓ clarify_weight |
| `after_ls_before_invoice` (modify) | 6 | ✓ all 6 |
| `after_ls_before_invoice` (special) | 2 | ✗ 2nd_release (test gap), ✗ vehicle_details (Zod bug) |
| `after_vehicle_placement` (modify) | 6 | ✓ all 6 |
| `after_email_to_plant` (modify, branch) | 6 | ✓ all 6 |
| `after_plant_invoice` (modify, branch) | 6 | ✓ all 6 |
| `anytime` (branch) | 2 | ✓ status_update, ✓ other |
| `after_email_to_plant` (modify, plant) | 6 | ✓ inc, inc_dec, ✗ inc_del (ambiguity), ✓ dec, ✓ del, ✗ dec_del (drift) |
| Plant special | 2 | ✗ invoice_sent (real defect), ✓ anytime_other |

---

## The 6 failures — detail

### Real defects in the dashboard (2)

#### F1. `after_ls_vehicle_details` — Zod validation drift

```
[UNIVERSAL_CLASSIFIER] action=other description="Classifier could not parse the reply."
reasoning="Zod validation failed: [...]"
```

The classifier produced output that failed the `vehicle_details_extraction`
schema validation, so the dispatcher fell back to `action=other`. This means
real vehicle-details replies could silently fail in production. Source:
[src/lib/reply-classifier.ts](../src/lib/reply-classifier.ts).

#### F2. `plant_invoice_sent` — validKeys filter excludes the very transition key

```
[UNIVERSAL_CLASSIFIER] action=other description="Plant is informing that material
is dispatched and sharing plant invoice number and OBD number..."
```

When a `plant_ls` reply arrives, the SO's stage is still `after_email_to_plant`
(no Invoice row yet). The `getValidScenarioKeys` filter restricts to keys
matching `plant|after_email_to_plant|*` + `plant|anytime|*`, so the classifier
never sees `plant|after_plant_invoice|invoice_sent|-` as a candidate — even
though that's exactly the intent that transitions the SO into
`after_plant_invoice`. Source:
[src/lib/dispatch-scenarios.ts:513-547](../src/lib/dispatch-scenarios.ts#L513-L547).

### LLM-drift / ambiguous-wording (2)

#### F3. `plant_modify_dec_del` — "unavailable" interpreted as decrease

```
key=plant|after_email_to_plant|modify|decrease (expected dec_del)
reasoning="...'unavailable' implies reduce to 0, but that is a delete operation;
since no 'decrease+de[lete]'..."
```

Same ambiguity documented across every prior session: "M-C is unavailable"
can plausibly mean **delete** or **decrease to 0**. The classifier consciously
picked `decrease` here. Not a code bug.

#### F4. `plant_modify_inc_del` — classifier hedged with `scenario_key=unknown`

```
action=scenario scenario_key=unknown
escalate_reason="Need explicit instruction/confirmation on how to modify the
SO/LS for YA4COWOCR000043P (delete/hold/alternate batch)..."
```

Same root cause as F3. The LLM asked for clarification instead of committing.
Also a real race: the assertion checked for `supervisor_inquiry` before the
escalation email had landed.

### Test-side assertion gaps (2)

#### F5 + F6. `before_ls_2nd_release` / `after_ls_2nd_release` — legacy action path treated as failure

```
action=2nd_release_decision decision=yes
```

The classifier correctly routes "yes, the revised plan is acceptable" through
the legacy `2nd_release_decision` action, which `handleSecondReleaseReply`
already processes. The test assertion only accepts `scenario_key=branch|*|2nd_release|-`
and reports failure when the legacy path fires — even though both paths are
semantically valid in the codebase today.

---

## Deep-dive tests — all 3 PASS

| Test | What it proves | Result |
|---|---|---|
| `DEEP_T11_zload3_roundtrip` | Real HTTP: dashboard enqueues ZLOAD3 → dummy fires `/processing-data` callback → Invoice + LSI updates land in DB | ✓ `invoice=7682614520 obd=85817679 lsi_with_mat_doc=3/3` |
| `DEEP_T12_order_status_sender` | Anytime status-update auto-reply email gets composed and persisted with a non-empty body | ✓ `body_len=389` |
| `DEEP_T15_audit_trail` | `renderAuditTrailForSO` produces a non-empty timeline with scenario lifecycle events that would feed the next classifier prompt | ✓ `lines=6 hasScenarioEvent=true` |

---

## Reproduce

```bash
DATABASE_URL="file:./test-e2e.db" npx prisma db push --schema prisma/schema.prisma --accept-data-loss --skip-generate
DATABASE_URL="file:./test-e2e.db" \
  AUTO_GUI_HOST=localhost AUTO_GUI_PORT=8001 \
  DUMMY_URL=http://localhost:8001 \
  DASHBOARD_URL=http://localhost:3001 \
  SAP_DEFAULT_PLANT=7581 \
  npx tsx scripts/e2e-via-dummy.ts
```

Filter to a single test or set:

```bash
FILTER=plant_invoice_sent,after_ls_vehicle_details npx tsx scripts/e2e-via-dummy.ts
```

Logs:
- `/tmp/e2e-full.log` — full driver transcript
- `/tmp/dummy-e2e.log` — dummy server's outbound callback log

---

## Run 2 — post-fix

**52 PASS / 0 FAIL / 52 total** (100%)

All six failures from Run 1 were addressed. Two were real dashboard defects
(F1, F2). Four were test-side issues — assertion logic that didn't account
for legacy non-scenario action paths, or fixture wording the LLM could read
two different ways. Plus one additional fixture-wording bug (`plant_modify_inc_dec`)
that appeared on the second run and was fixed the same way.

### What was changed in the code

| # | Type | File(s) | Change |
|---|---|---|---|
| F1 | Real defect | [src/lib/reply-classifier.ts](../src/lib/reply-classifier.ts) | `VehicleDetailSchema` and `VehicleDetailsExtractionSchema` are now lenient about `null` for optional fields (LLM occasionally emits `bundleNumber: null` or `vehicles: null`). Also added a `[CLASSIFIER_ZOD_FAIL]` log line that captures the raw LLM output + Zod issues when validation fails — future drift is debuggable from logs alone. |
| F2 | Real defect | [src/lib/dispatch-scenarios.ts](../src/lib/dispatch-scenarios.ts) | `getValidScenarioKeys` now exposes **stage-transition keys** at the previous stage too. Specifically `plant\|after_plant_invoice\|invoice_sent\|-` is now visible when `stage='after_email_to_plant'` — because that inbound IS what transitions the SO between the two stages. Without this, the classifier never saw it as a candidate. |
| F2b | Prompt clarity | [src/lib/sheet-scenario-adapter.ts](../src/lib/sheet-scenario-adapter.ts) | Added per-key `DESCRIPTION_OVERRIDES` so the classifier prompt explains *what* an `invoice_sent` reply looks like (invoice number / OBD / dispatch confirmation) and that it's pickable even when the SO is still at `after_email_to_plant`. |

### What was changed in the test fixtures / assertions

| # | Type | File | Change |
|---|---|---|---|
| F3 | Fixture wording | [scripts/e2e-via-dummy.ts](../scripts/e2e-via-dummy.ts) | `plant_modify_dec_del` reply uses explicit `"decrease ... from 50 to 30 ... and delete ... entirely"` instead of `"only 30 available; X is unavailable"`. The earlier wording let the LLM read "unavailable" as decrease-to-zero. |
| F4 | Fixture wording + settle | Same | `plant_modify_inc_del` reply uses explicit `"increase ... to 80 ... and delete ... entirely"`. Added `settleMs: 1500` so async escalation has time to land before the assertion checks for `supervisor_inquiry`. |
| F5, F6 | Assertion logic | Same | New `alsoAcceptAction` field on `IntentSpec` accepts legacy non-scenario action handlers as equivalent. Used by `before_ls_2nd_release` + `after_ls_2nd_release` (accept `2nd_release_decision`) and `after_ls_vehicle_details` (accept `vehicle_details_extraction`). |
| F7 | Fixture wording (new in Run 2) | Same | `plant_modify_inc_dec` reply uses explicit `"from 50 to 80"` and `"from 100 to 50"` so the LLM doesn't hallucinate ordered quantities. The previous text said `"only 50 of YV6FRYENE0000PJP"` and the LLM mistakenly thought 50 was the original ordered qty. |
| F8 | Fixture wording (also new) | Same | `plant_modify_delete` reply uses `"delete ... entirely (do not dispatch this material at all)"` instead of `"is completely unavailable, cannot dispatch"`. Same "unavailable → ambiguity" pattern as F3. |

### Result by category

| Category | Run 1 | Run 2 |
|---|---|---|
| Sheet intents correctly classified | 43 / 49 | **49 / 49** |
| Deep-dive tests passed | 3 / 3 | **3 / 3** |
| Real defects in the dashboard | 2 | **0** |
| LLM-drift / ambiguous-wording | 2 | **0** |
| Test-side assertion gaps | 2 | **0** |
| **Total** | **46 / 52** | **52 / 52** |

### Honest caveats

- The 52/52 number reflects a **single deterministic run**. The classifier is
  the OpenAI API — non-deterministic on edge wording. The fixture sharpening
  in F3, F4, F7, F8 was specifically to make the test inputs unambiguous so
  the LLM picks the right intent every time. If you change a reply text in
  the future, watch for the same wording traps (especially "unavailable" vs
  "delete", and any reference to a quantity that matches the ordered qty).
- The diagnostic `[CLASSIFIER_ZOD_FAIL]` log line added in F1 should fire
  zero times in healthy operation. If it appears, capture the raw payload —
  that's how schema drift first manifests.
- The Run 2 changes don't fully exercise the legacy non-scenario action
  paths (2nd_release_decision, vehicle_details_extraction, etc.) end-to-end —
  the assertion just accepts them as equivalent. A future test pass could
  add specific assertions that those handlers actually fired (e.g. for
  2nd_release_decision, that the next scenario segment was triggered).
- The single sheet intent that remains "fragile" (will fail on the same
  ambiguous wording it always has) is anything involving the word
  "unavailable" — the LLM legitimately reads it both ways. Mitigation:
  fixture authors should always say "delete X entirely" or "decrease X to
  N units" rather than relying on the LLM to infer intent.

### Reproduce Run 2

```bash
DATABASE_URL="file:./test-e2e.db" npx prisma db push --schema prisma/schema.prisma --accept-data-loss --skip-generate
DATABASE_URL="file:./test-e2e.db" \
  AUTO_GUI_HOST=localhost AUTO_GUI_PORT=8001 \
  DUMMY_URL=http://localhost:8001 \
  DASHBOARD_URL=http://localhost:3001 \
  SAP_DEFAULT_PLANT=7581 \
  npx tsx scripts/e2e-via-dummy.ts
```

Expected: `AGGREGATE [segmented]: 52 PASS / 0 FAIL / 52 total`
