# Chain: release_all

**Description**: Happy path — NEW ORDER → ls_dispatch → release_all → VT01N
**SO Number**: 3290001
**Customer**: TEST-CUST-RELALL
**Scenario Key**: llm-planned
**Started**: 2026-06-03T13:59:04.651Z
**Finished**: 2026-06-03T13:59:17.413Z (duration: 12762ms)
**Result**: ✅ PASS

## SAP transaction summary

| # | Transaction | Step | Work ID (suffix) | Started | Completed | State | Callback effect |
|---|---|---|---|---|---|---|---|
| 1 | `ZSO-VISIBILITY` | `visibility` | …bsqg6p | [T+0:00:01] | [T+0:00:02] | done | Material rows upserted (count now 3) |
| 2 | `ZLOAD1` | `zload1` | …jf9fh8 | [T+0:00:09] | [T+0:00:10] | done |  |
| 3 | `ZLOAD3-B1` | `zload3b1` | …ul2it8 | [T+0:00:11] | [T+0:00:11] | done | Invoice 7682614520/85817679, Shipment status=shipped |
| 4 | `VTO1N-B` | `vto1n` | …hj9ryh | [T+0:00:12] | [T+0:00:12] | done | Shipment status=shipped |

## Step-by-step execution

### Step 1 — NEW ORDER inbound from branch → ZSO-VISIBILITY → ls_dispatch lands

**Action**: `new_order_inbound`
**SO Number**: 3290001, **Customer ID**: TEST-CUST-RELALL
**Duration**: 2519ms
**Outcome**: ✓ pass

**SAP transactions this step**:
```
  [T+0:00:01] ZSO-VISIBILITY   work=…bsqg6p state=done    → ✓ done at [T+0:00:02]
              callback: Material rows upserted (count now 3)
```

**New scenario events**:
```
  [T+0:00:01] email_received         new_order from branch
  [T+0:00:01] classifier_decision    action=new_order
  [T+0:00:02] step_completed         zso_visibility ✓
  [T+0:00:02] email_sent             ls_dispatch to test-branch@example.com
  [T+0:00:02] step_completed         zso_visibility ✓
```

**New emails this step**:
```
  [T+0:00:02] → OUTBOUND ls_dispatch_buffered   test-branch@example.com
  [T+0:00:02] → OUTBOUND ls_dispatch            test-branch@example.com
```

**Driver notes**:
- Inbox pushed: MOCK-NEWORDER-1780495144684 subject="NEW ORDER 3290001"
- checkForNewEmails returned triggered=1 errors=0
- SO created: id=cmpy4u7pd0006sxd5jp38rrwj poId=cmpy4u7pb0004sxd5qkacgohp
- ls_dispatch landed: emailId=cmpy4u7y7000osxd5kzcsk8ed

### Step 2 — Branch replies "release everything" to ls_dispatch

**Action**: `inbound_reply`
**Reply text**: "Please release everything as available. All quantities approved, go ahead and dispatch."
**Email type**: `ls_dispatch`
**Duration**: 3147ms
**Outcome**: ✓ pass

**New scenario events**:
```
  [T+0:00:02] email_received         ls_dispatch from branch
  [T+0:00:05] classifier_decision    llm-planned
  [T+0:00:05] scenario_started       llm-planned
  [T+0:00:05] step_fired             email_confirm_bundle_details
  [T+0:00:05] email_sent             dispatch_confirmation to test-branch@example.com
  [T+0:00:05] step_completed         email_confirm_bundle_details ✓
  [T+0:00:05] scenario_completed     llm-planned
```

**New emails this step**:
```
  [T+0:00:05] → OUTBOUND dispatch_confirmation  test-branch@example.com
```

**Driver notes**:
- Injecting inbound_reply to email cmpy4u7y7000osxd5kzcsk8ed (type=ls_dispatch)
- handleReplyV2 returned matched=true

### Step 3 — Wait for dispatch_confirmation outbound email (sent by engine)

**Action**: `wait_for_email`
**Email type**: `dispatch_confirmation`
**Duration**: 260ms
**Outcome**: ✓ pass

**Driver notes**:
- dispatch_confirmation email found after 0ms

### Step 4 — Branch confirms the dispatch plan → fan out ZLOAD1

**Action**: `dispatch_confirmation_reply`
**Reply text**: "Yes, please proceed with the dispatch plan as confirmed. Go ahead."
**Duration**: 4555ms
**Outcome**: ✓ pass

**SAP transactions this step**:
```
  [T+0:00:09] ZLOAD1           work=…jf9fh8 state=firing  → (firing)
```

**New scenario events**:
```
  [T+0:00:05] email_received         dispatch_confirmation from branch
  [T+0:00:09] classifier_decision    llm-planned
  [T+0:00:09] scenario_started       llm-planned
  [T+0:00:09] step_fired             zload1
```

**Driver notes**:
- handleDispatchConfirmation success=true

### Step 5 — Wait for ZLOAD1 to complete → vehicle_details email lands

**Action**: `wait_for_email`
**Email type**: `vehicle_details`
**Duration**: 664ms
**Outcome**: ✓ pass

**New scenario events**:
```
  [T+0:00:10] email_sent             vehicle_details to test-branch@example.com
  [T+0:00:10] step_completed         zload1 ✓
  [T+0:00:10] step_fired             email_to_branch_for_vehicle
  [T+0:00:10] step_completed         email_to_branch_for_vehicle ✓
  [T+0:00:10] scenario_completed     llm-planned
```

**New emails this step**:
```
  [T+0:00:10] → OUTBOUND vehicle_details        test-branch@example.com
```

**Driver notes**:
- vehicle_details email found after 404ms

### Step 6 — Branch replies with vehicle / driver / LR — sends plant_ls per LSI

**Action**: `vehicle_details_reply`
**Duration**: 271ms
**Outcome**: ✓ pass

**New scenario events**:
```
  [T+0:00:11] email_sent             plant_ls to test-plant@example.com
  [T+0:00:11] email_sent             plant_ls to test-plant@example.com
  [T+0:00:11] email_sent             plant_ls to test-plant@example.com
```

**New emails this step**:
```
  [T+0:00:11] → OUTBOUND plant_ls               test-plant@example.com
  [T+0:00:11] → OUTBOUND plant_ls               test-plant@example.com
  [T+0:00:11] → OUTBOUND plant_ls               test-plant@example.com
```

**Driver notes**:
- handleVehicleDetailsReply success=true

### Step 7 — Wait for plant_ls outbound email(s)

**Action**: `wait_for_email`
**Email type**: `plant_ls`
**Duration**: 254ms
**Outcome**: ✓ pass

**Driver notes**:
- plant_ls email found after 1ms

### Step 8 — Plant replies with invoice PDF → ZLOAD3-B1 fires

**Action**: `plant_invoice_reply`
**Duration**: 263ms
**Outcome**: ✓ pass

**SAP transactions this step**:
```
  [T+0:00:11] ZLOAD3-B1        work=…ul2it8 state=done    → ✓ done at [T+0:00:11]
              callback: Invoice 7682614520/85817679, Shipment status=created
```

**New scenario events**:
```
  [T+0:00:11] step_completed         zload3b1 ✓
```

**Driver notes**:
- Marked 3 plant_ls email(s) replied; firing checkAndSendBatchToAman
- checkAndSendBatchToAman success=true

### Step 9 — Wait for Shipment row from /processing-data callback

**Action**: `wait_for_shipment`
**Duration**: 260ms
**Outcome**: ✓ pass

**Driver notes**:
- Shipment found id=cmpy4ufdv002usxd5f0q5wnma status=created obd=85817679

### Step 10 — Operator triggers VT01N for the Shipment

**Action**: `trigger_vt01n`
**Duration**: 271ms
**Outcome**: ✓ pass

**SAP transactions this step**:
```
  [T+0:00:12] VTO1N-B          work=…hj9ryh state=done    → ✓ done at [T+0:00:12]
              callback: Shipment status=shipped
```

**New scenario events**:
```
  [T+0:00:12] step_completed         vto1n ✓
```

**Driver notes**:
- Firing triggerVto1n on Shipment cmpy4ufdv002usxd5f0q5wnma

### Step 11 — Wait for SO status = completed

**Action**: `wait_for_so_status`
**Duration**: 257ms
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
| Invoice.invoiceNumber | `7682614520` |
| Invoice.obdNumber | `85817679` |
| Shipment.status | `shipped` |
| ScenarioEvent count | 26 |
| SAP transactions fired | 4 |

## Complete audit trail (chronological)

```
[T+0:00:00] email_received       from branch — Subject "NEW ORDER 3290001" — "Hi team, Please create the following sales order: Customer ID: TEST-CUST-RELALL…"
[T+0:00:00] classifier_decision  action=new_order
[T+0:00:00] step_completed       zso_visibility ✓ — materials YE1EDWO00001APJP=50, YV6FRYENE0000PJP=100, YA4COWOCR000043P=250
[T+0:00:00] email_sent           ls_dispatch to test-branch@example.com — "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-178049514…"
[T+0:00:00] step_completed       zso_visibility ✓
[T+0:00:00] email_received       from branch — Subject "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-178049514…" — "Please release everything as available. All quantities approved, go ahead and d…"
[T+0:00:03] classifier_decision  llm-planned
[T+0:00:03] scenario_started     llm-planned
[T+0:00:03] step_fired           email_confirm_bundle_details
[T+0:00:03] email_sent           dispatch_confirmation to test-branch@example.com — "Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780495144684"
[T+0:00:03] step_completed       email_confirm_bundle_details ✓
[T+0:00:03] scenario_completed   llm-planned
[T+0:00:03] email_received       from branch — Subject "Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780495144684" — "Yes, please proceed with the dispatch plan as confirmed. Go ahead."
[T+0:00:07] classifier_decision  llm-planned
[T+0:00:07] scenario_started     llm-planned
[T+0:00:07] step_fired           zload1
[T+0:00:08] email_sent           vehicle_details to test-branch@example.com — "Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780495144…"
[T+0:00:08] step_completed       zload1 ✓ — LS 373284:PENDING=?, 373283:PENDING=?, 373282:PENDING=?
[T+0:00:08] step_fired           email_to_branch_for_vehicle
[T+0:00:08] step_completed       email_to_branch_for_vehicle ✓
[T+0:00:08] scenario_completed   llm-planned
[T+0:00:09] email_sent           plant_ls to test-plant@example.com — "Loading Slip 373282 - SO 3290001"
[T+0:00:09] email_sent           plant_ls to test-plant@example.com — "Loading Slip 373283 - SO 3290001"
[T+0:00:09] email_sent           plant_ls to test-plant@example.com — "Loading Slip 373284 - SO 3290001"
[T+0:00:09] step_completed       zload3b1 ✓
[T+0:00:10] step_completed       vto1n ✓
```

## Complete email thread (chronological)

```
--- Turn 1 [2026-06-03T13:59:06.944Z] US → test-branch@example.com [type=ls_dispatch] ---
Subject: Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780495144684
Dispatch Recommendation - AUTO-MOCK-NEWORDER-1780495144684 Dear Sales Team, Sales Order 3290001 I have reviewed the stock availability for Sales Order 3290001. Here is the dispatch recommendation: Material A — APJP [YE1EDWO00001APJP] : Stock is confirmed available. Proceed with 50 units from Batch A-26. Material C — 43P [YA4COWOCR000043P] : Stock is confirmed available. Proceed with 250 units from Batch 20. Material B — PJP [YV6FRYENE0000PJP] : Stock is confirmed available. Proceed with 100 units from Batch 30-07-2025. Best regards, Sales Order Dispatch Co-ordinator

--- Turn 2 [2026-06-03T13:59:07.217Z] test-branch@example.com → US [type=ls_dispatch] ---
Subject: Re: Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780495144684
Please release everything as available. All quantities approved, go ahead and dispatch.

--- Turn 3 [2026-06-03T13:59:10.094Z] US → test-branch@example.com [type=dispatch_confirmation] ---
Subject: Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780495144684
Dear Branch Team, Dispatch plan ready for Purchase Order AUTO-MOCK-NEWORDER-1780495144684 (Chain release_all). Total 10.665 t — fits in 1 vehicle (capacity 35 t). Proposed dispatch (grouped by bundle): Bundle 1 — 10.665 t (of 35 t capacity): - SO 3290001 / YA4COWOCR000043P (Batch 20): 250 units, 6.625 t - SO 3290001 / YE1EDWO00001APJP (Batch A-26): 50 units, 1.320 t - SO 3290001 / YV6FRYENE0000PJP (Batch 30-07-2025): 100 units, 2.720 t Please reply with: - "yes" / "confirm" to proceed with the above plan, or - the changes you want (e.g. "skip OOWJ on SO 1234567", "send only 15 of OP7WJ"). Once confirmed we will create the loading slips. Best regards, Sales Order Dispatch Co-ordinator

--- Turn 4 [2026-06-03T13:59:10.614Z] test-branch@example.com → US [type=dispatch_confirmation] ---
Subject: Re: Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780495144684
Yes, please proceed with the dispatch plan as confirmed. Go ahead.

--- Turn 5 [2026-06-03T13:59:15.541Z] US → test-branch@example.com [type=vehicle_details] ---
Subject: Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780495144684 (1 bundle)
Dear Branch Team, Loading slips for Purchase Order AUTO-MOCK-NEWORDER-1780495144684 are now ready in SAP. The PO is split into 1 bundle: Bundle 1 (~10.66 t): - SO 3290001 / LS 373282 / Material PENDING - SO 3290001 / LS 373283 / Material PENDING - SO 3290001 / LS 373284 / Material PENDING Please reply with vehicle/transport details for each bundle in the format below: Bundle 1: , , Best regards, Sales Order Dispatch Co-ordinator

--- Turn 6 [2026-06-03T13:59:15.838Z] test-branch@example.com → US [type=vehicle_details] ---
Subject: Re: Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780495144684 (1 bundle)
Vehicle GJ12-XY1234, driver mobile 9876543210, container CONT-TEST-001, LR LR-9988 dated 2026-05-30.

--- Turn 7 [2026-06-03T13:59:16.356Z] test-plant@example.com → US [type=plant_ls] ---
Subject: Re: Loading Slip 373282 - SO 3290001
Plant invoice attached. Invoice 7682614520, OBD 85817679.

--- Turn 8 [2026-06-03T13:59:16.357Z] test-plant@example.com → US [type=plant_ls] ---
Subject: Re: Loading Slip 373283 - SO 3290001
Plant invoice attached. Invoice 7682614520, OBD 85817679.

--- Turn 9 [2026-06-03T13:59:16.358Z] test-plant@example.com → US [type=plant_ls]   ← LATEST INBOUND (plan for THIS) ---
Subject: Re: Loading Slip 373284 - SO 3290001
Plant invoice attached. Invoice 7682614520, OBD 85817679.
```

## Verifications

- ✓ SO.status === `completed` (actual: `completed`)
- ✓ LSI count ≥ 3 (actual: 3)
- ✓ LSI with sapMaterialDoc ≥ 3 (actual: 3)
- ✓ Invoice number present (actual: `7682614520`)
- ✓ Shipment row exists (actual status: `shipped`)
- ✓ SAP transactions ≥ 4 (actual: 4)
