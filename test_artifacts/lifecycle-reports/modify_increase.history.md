# Chain: modify_increase

**Description**: Pre-LS modify (with VA02) — NEW ORDER → ls_dispatch → modify_increase reply → stock_precheck → VA02 → 2nd_release → re-visibility → release_all path → VT01N
**SO Number**: 3290003
**Customer**: TEST-CUST-MODINC
**Scenario Key**: branch|before_ls|modify|increase
**Started**: 2026-05-30T09:27:56.503Z
**Finished**: 2026-05-30T09:28:09.305Z (duration: 12802ms)
**Result**: ✅ PASS

## SAP transaction summary

| # | Transaction | Step | Work ID (suffix) | Started | Completed | State | Callback effect |
|---|---|---|---|---|---|---|---|
| 1 | `ZSO-VISIBILITY` | `visibility` | …8wl5hj | [T+0:00:01] | [T+0:00:02] | done | Material rows upserted (count now 3) |
| 2 | `VA02` | `va02` | …i8mvqr | [T+0:00:04] | [T+0:00:05] | done | VA02 completed (real SAP would have updated quantities; dummy returns success only) |
| 3 | `ZLOAD1` | `zload1` | …o6f4cq | [T+0:00:10] | [T+0:00:10] | done | LoadingSlipItem rows with fileUrl (count now 3) |
| 4 | `ZLOAD3-B1` | `zload3b1` | …d67niw | [T+0:00:11] | [T+0:00:11] | done | Invoice 7682614522/85817681, Shipment status=shipped |
| 5 | `VTO1N-B` | `vto1n` | …0k4a73 | [T+0:00:12] | [T+0:00:12] | done | Shipment status=shipped |

## Step-by-step execution

### Step 1 — NEW ORDER inbound from branch

**Action**: `new_order_inbound`
**SO Number**: 3290003, **Customer ID**: TEST-CUST-MODINC
**Duration**: 2399ms
**Outcome**: ✓ pass

**SAP transactions this step**:
```
  [T+0:00:01] ZSO-VISIBILITY   work=…8wl5hj state=done    → ✓ done at [T+0:00:02]
              callback: Material rows upserted (count now 3)
```

**New scenario events**:
```
  [T+0:00:01] classifier_decision    action=new_order
```

**New emails this step**:
```
  [T+0:00:02] → OUTBOUND ls_dispatch_buffered   test-branch@example.com
  [T+0:00:02] → OUTBOUND ls_dispatch            test-branch@example.com
```

**Driver notes**:
- Inbox pushed: MOCK-NEWORDER-1780133276521 subject="NEW ORDER 3290003"
- checkForNewEmails returned triggered=1 errors=0
- SO created: id=cmps5e4cq003osxzpxnkaqh5h poId=cmps5e4cn003msxzpb6tjrlly
- ls_dispatch landed: emailId=cmps5e4j30042sxzp8sn8uhfi

### Step 2 — Branch reply on ls_dispatch — modify_increase

**Action**: `inbound_reply`
**Reply text**: "Please increase material YE1EDWO00001APJP from 50 to 80 units."
**Email type**: `ls_dispatch`
**Duration**: 2802ms
**Outcome**: ✓ pass

**SAP transactions this step**:
```
  [T+0:00:04] VA02             work=…i8mvqr state=done    → ✓ done at [T+0:00:05]
              callback: VA02 completed (real SAP would have updated quantities; dummy returns success only)
```

**New scenario events**:
```
  [T+0:00:02] email_received         ls_dispatch from branch
  [T+0:00:04] classifier_decision    branch|before_ls|modify|increase
  [T+0:00:04] scenario_started       branch|before_ls|modify|increase
  [T+0:00:04] step_fired             stock_precheck
  [T+0:00:04] step_completed         stock_precheck ✓
  [T+0:00:04] step_fired             va02
  [T+0:00:05] step_completed         va02 ✓
  [T+0:00:05] step_fired             email_2nd_release
  [T+0:00:05] email_sent             2nd_release to test-branch@example.com
  [T+0:00:05] step_completed         email_2nd_release ✓
  [T+0:00:05] scenario_completed     branch|before_ls|modify|increase
```

**New emails this step**:
```
  [T+0:00:05] → OUTBOUND 2nd_release            test-branch@example.com
```

**Driver notes**:
- Injecting inbound_reply to email cmps5e4j30042sxzp8sn8uhfi (type=ls_dispatch)
- handleReplyV2 returned matched=true

### Step 3 — Wait for 2nd_release email (engine asks branch to confirm revised plan after VA02)

**Action**: `wait_for_email`
**Email type**: `2nd_release`
**Duration**: 261ms
**Outcome**: ✓ pass

**Driver notes**:
- 2nd_release email found after 1ms

### Step 4 — Branch confirms the revised release plan

**Action**: `inbound_reply`
**Reply text**: "Yes, the revised release plan is acceptable. Please proceed with the updated quantities."
**Email type**: `2nd_release`
**Duration**: 2197ms
**Outcome**: ✓ pass

**New scenario events**:
```
  [T+0:00:05] email_received         2nd_release from branch
  [T+0:00:07] classifier_decision    action=2nd_release_decision
```

**Driver notes**:
- Injecting inbound_reply to email cmps5e6xe004osxzpz5j14rjl (type=2nd_release)
- handleReplyV2 returned matched=true

### Step 5 — Wait for re-sent ls_dispatch after re-visibility (engine fires zso_visibility again)

**Action**: `wait_for_email`
**Email type**: `ls_dispatch`
**Duration**: 260ms
**Outcome**: ✓ pass

**Driver notes**:
- ls_dispatch email found after 1ms

### Step 6 — Branch confirms revised plan on re-sent ls_dispatch (release_all)

**Action**: `inbound_reply`
**Reply text**: "Please release everything as available. All quantities approved, go ahead and dispatch."
**Email type**: `ls_dispatch`
**Duration**: 1983ms
**Outcome**: ✓ pass

**New scenario events**:
```
  [T+0:00:07] email_received         ls_dispatch from branch
  [T+0:00:09] classifier_decision    action=2nd_release_decision
```

**Driver notes**:
- Injecting inbound_reply to email cmps5e4j30042sxzp8sn8uhfi (type=ls_dispatch)
- handleReplyV2 returned matched=true

### Step 7 — (driver fills engine gap) Synthesise dispatch_confirmation email

**Action**: `synthesise_dispatch_confirmation`
**Note**: synthesised by driver — fills a known engine gap
(engine `email_confirm_bundle_details` step is a no-op stub)
**Duration**: 279ms
**Outcome**: ✓ pass

**New emails this step**:
```
  [T+0:00:09] → OUTBOUND dispatch_confirmation  test-branch@example.com
```

**Driver notes**:
- SYNTHESISED — engine email_confirm_bundle_details handler is a no-op stub
- [DispatchConfirm] Pre-email bundling: 1 bundle(s), total 10.665 t / 45 t per truck
- [DispatchConfirm] Confirmation email sent to test-branch@example.com for PO AUTO-MOCK-NEWORDER-1780133276521 (1 SO(s), 10.66 t)
- dispatch_confirmation sent (3 item(s), 10.66t)

### Step 8 — Wait for dispatch_confirmation outbound email

**Action**: `wait_for_email`
**Email type**: `dispatch_confirmation`
**Duration**: 256ms
**Outcome**: ✓ pass

**Driver notes**:
- dispatch_confirmation email found after 1ms

### Step 9 — Branch confirms the dispatch plan → fan out ZLOAD1

**Action**: `dispatch_confirmation_reply`
**Reply text**: "Yes, please proceed with the dispatch plan as confirmed. Go ahead."
**Duration**: 291ms
**Outcome**: ✓ pass

**SAP transactions this step**:
```
  [T+0:00:10] ZLOAD1           work=…o6f4cq state=firing  → (firing)
              callback: LoadingSlipItem rows with fileUrl (count now 1)
```

**Driver notes**:
- handleDispatchConfirmation success=true

### Step 10 — Wait for ZLOAD1 to complete → vehicle_details email lands

**Action**: `wait_for_email`
**Email type**: `vehicle_details`
**Duration**: 460ms
**Outcome**: ✓ pass

**New emails this step**:
```
  [T+0:00:10] → OUTBOUND vehicle_details        test-branch@example.com
```

**Driver notes**:
- vehicle_details email found after 202ms

### Step 11 — Branch replies with vehicle / driver / LR — sends plant_ls per LSI

**Action**: `vehicle_details_reply`
**Duration**: 276ms
**Outcome**: ✓ pass

**New emails this step**:
```
  [T+0:00:11] → OUTBOUND plant_ls               test-plant@example.com
  [T+0:00:11] → OUTBOUND plant_ls               test-plant@example.com
  [T+0:00:11] → OUTBOUND plant_ls               test-plant@example.com
```

**Driver notes**:
- handleVehicleDetailsReply success=true

### Step 12 — Wait for plant_ls outbound email(s)

**Action**: `wait_for_email`
**Email type**: `plant_ls`
**Duration**: 257ms
**Outcome**: ✓ pass

**Driver notes**:
- plant_ls email found after 1ms

### Step 13 — Plant replies with invoice PDF → ZLOAD3-B1 fires

**Action**: `plant_invoice_reply`
**Duration**: 270ms
**Outcome**: ✓ pass

**SAP transactions this step**:
```
  [T+0:00:11] ZLOAD3-B1        work=…d67niw state=done    → ✓ done at [T+0:00:11]
              callback: Invoice 7682614522/85817681, Shipment status=created
```

**Driver notes**:
- Marked 3 plant_ls email(s) replied; firing checkAndSendBatchToAman
- checkAndSendBatchToAman success=true

### Step 14 — Wait for Shipment row from /processing-data callback

**Action**: `wait_for_shipment`
**Duration**: 255ms
**Outcome**: ✓ pass

**Driver notes**:
- Shipment found id=cmps5ec61005ssxzpr7s6pqob status=created obd=85817681

### Step 15 — Operator triggers VT01N for the Shipment

**Action**: `trigger_vt01n`
**Duration**: 268ms
**Outcome**: ✓ pass

**SAP transactions this step**:
```
  [T+0:00:12] VTO1N-B          work=…0k4a73 state=done    → ✓ done at [T+0:00:12]
              callback: Shipment status=shipped
```

**Driver notes**:
- Firing triggerVto1n on Shipment cmps5ec61005ssxzpr7s6pqob

### Step 16 — Wait for SO status = completed

**Action**: `wait_for_so_status`
**Duration**: 259ms
**Outcome**: ✓ pass

**Driver notes**:
- SO.status=completed

## Final DB state

| Field | Value |
|---|---|
| SO.status | `completed` |
| ScenarioProgress.state | `completed` |
| LoadingSlipItem count | 3 |
| LSI with sapMaterialDoc | 3 |
| Invoice.invoiceNumber | `7682614522` |
| Invoice.obdNumber | `85817681` |
| Shipment.status | `shipped` |
| ScenarioEvent count | 16 |
| SAP transactions fired | 5 |

## Complete audit trail (chronological)

```
[T+0:00:00] classifier_decision  action=new_order
[T+0:00:00] email_received       from branch — Subject "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-178013327…" — "Please increase material YE1EDWO00001APJP from 50 to 80 units."
[T+0:00:03] classifier_decision  branch|before_ls|modify|increase
[T+0:00:03] scenario_started     branch|before_ls|modify|increase
[T+0:00:03] step_fired           stock_precheck
[T+0:00:03] step_completed       stock_precheck ✓
[T+0:00:03] step_fired           va02
[T+0:00:03] step_completed       va02 ✓ — materials YE1EDWO00001APJP=?, YV6FRYENE0000PJP=?, YA4COWOCR000043P=?
[T+0:00:03] step_fired           email_2nd_release
[T+0:00:03] email_sent           2nd_release to test-branch@example.com — "2nd Release Confirmation - SO 3290003"
[T+0:00:03] step_completed       email_2nd_release ✓
[T+0:00:03] scenario_completed   branch|before_ls|modify|increase
[T+0:00:03] email_received       from branch — Subject "2nd Release Confirmation - SO 3290003" — "Yes, the revised release plan is acceptable. Please proceed with the updated qu…"
[T+0:00:05] classifier_decision  action=2nd_release_decision
[T+0:00:06] email_received       from branch — Subject "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-178013327…" — "Please release everything as available. All quantities approved, go ahead and d…"
[T+0:00:07] classifier_decision  action=2nd_release_decision
```

## Complete email thread (chronological)

```
[2026-05-30T09:27:58.575Z] OUTBOUND to test-branch@example.com [type=ls_dispatch] — Subject: "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780133276521"
  Body: Dispatch Recommendation - AUTO-MOCK-NEWORDER-1780133276521 Dear Sales Team, Sales Order 3290003 I have reviewed the stock availability for Sales Order 3290003. Here is the dispatch recommendation: Material A — APJP [YE1EDWO00001APJP] : Stock is confirmed available. Proceed with 50 units from Batch A-26. Material B — PJP [YV6FRYENE0000PJP] : Stock is confirmed available. Proceed with 100 units from Batch 30-07-2025. Material C — 43P [YA4COWOCR000043P] : Stock is confirmed available. Proceed with 250 units from Batch 20. Best regards, Sales Order Dispatch Co-ordinator

[2026-05-30T09:28:01.682Z] OUTBOUND to test-branch@example.com [type=2nd_release] — Subject: "2nd Release Confirmation - SO 3290003"
  Body: Hi, We have updated SO 3290003 with the following changes: - Increase YE1EDWO00001APJP → 80 Please confirm we should proceed with the revised plan (reply "yes" to confirm). Thanks.

[2026-05-30T09:28:03.922Z] INBOUND from test-branch@example.com [type=2nd_release] — Subject: "Re: 2nd Release Confirmation - SO 3290003"
  Body: Yes, the revised release plan is acceptable. Please proceed with the updated quantities.

[2026-05-30T09:28:06.167Z] INBOUND from test-branch@example.com [type=ls_dispatch] — Subject: "Re: Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780133276521"
  Body: Please release everything as available. All quantities approved, go ahead and dispatch.

[2026-05-30T09:28:06.448Z] OUTBOUND to test-branch@example.com [type=dispatch_confirmation] — Subject: "Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780133276521"
  Body: Dear Branch Team, Dispatch plan ready for Purchase Order AUTO-MOCK-NEWORDER-1780133276521 (Chain modify_increase). Total 10.665 t — fits in 1 vehicle (capacity 45 t). Proposed dispatch (grouped by bundle): Bundle 1 — 10.665 t (of 45 t capacity): - SO 3290003 / YA4COWOCR000043P (Batch 20): 250 units, 6.625 t - SO 3290003 / YE1EDWO00001APJP (Batch A-26): 50 units, 1.320 t - SO 3290003 / YV6FRYENE0000PJP (Batch 30-07-2025): 100 units, 2.720 t Please reply with: - "yes" / "confirm" to proceed with the above plan, or - the changes you want (e.g. "skip OOWJ on SO 1234567", "send only 15 of OP7WJ"). Once confirmed we will create the loading slips. Best regards, Sales Order Dispatch Co-ordinator

[2026-05-30T09:28:06.982Z] INBOUND from test-branch@example.com [type=dispatch_confirmation] — Subject: "Re: Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780133276521"
  Body: Yes, please proceed with the dispatch plan as confirmed. Go ahead.

[2026-05-30T09:28:07.277Z] OUTBOUND to test-branch@example.com [type=vehicle_details] — Subject: "Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780133276521 (1 bundle)"
  Body: Dear Branch Team, Loading slips for Purchase Order AUTO-MOCK-NEWORDER-1780133276521 are now ready in SAP. The PO is split into 1 bundle: Bundle 1 (~10.66 t): - SO 3290003 / LS 373287 / Material PENDING - SO 3290003 / LS 373288 / Material PENDING - SO 3290003 / LS 373289 / Material PENDING Please reply with vehicle/transport details for each bundle in the format below: Bundle 1: , , Best regards, Sales Order Dispatch Co-ordinator

[2026-05-30T09:28:07.723Z] INBOUND from test-branch@example.com [type=vehicle_details] — Subject: "Re: Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780133276521 (1 bundle)"
  Body: Vehicle GJ12-XY1234, driver mobile 9876543210, container CONT-TEST-001, LR LR-9988 dated 2026-05-30.

[2026-05-30T09:28:08.249Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373287 - SO 3290003"
  Body: Plant invoice attached. Invoice 7682614520, OBD 85817679.

[2026-05-30T09:28:08.252Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373288 - SO 3290003"
  Body: Plant invoice attached. Invoice 7682614520, OBD 85817679.

[2026-05-30T09:28:08.253Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373289 - SO 3290003"
  Body: Plant invoice attached. Invoice 7682614520, OBD 85817679.
```

## Verifications

- ✓ SO.status === `completed` (actual: `completed`)
- ✓ LSI count ≥ 3 (actual: 3)
- ✓ Invoice number present (actual: `7682614522`)
- ✓ Shipment row exists (actual status: `shipped`)
- ✓ SAP transactions ≥ 5 (actual: 5)
