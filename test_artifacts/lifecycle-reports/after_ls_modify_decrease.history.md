# Chain: after_ls_modify_decrease

**Description**: Phase A NEW ORDER → release_all → ZLOAD1 → vehicle_details email. Phase B branch replies on vehicle_details with after_ls_modify_decrease → ZLOAD2 → tail
**SO Number**: 3290009
**Customer**: TEST-CUST-AFTERLSDEC
**Scenario Key**: branch|after_ls_before_invoice|modify|decrease
**Started**: 2026-05-30T10:18:28.580Z
**Finished**: 2026-05-30T10:18:39.564Z (duration: 10984ms)
**Result**: ✅ PASS

## SAP transaction summary

| # | Transaction | Step | Work ID (suffix) | Started | Completed | State | Callback effect |
|---|---|---|---|---|---|---|---|
| 1 | `ZSO-VISIBILITY` | `visibility` | …t6cfpk | [T+0:00:01] | [T+0:00:01] | done | Material rows upserted (count now 3) |
| 2 | `ZLOAD1` | `zload1` | …toeig8 | [T+0:00:05] | [T+0:00:06] | done | LoadingSlipItem rows with fileUrl (count now 3) |
| 3 | `ZLOAD2` | `zload2` | …sjptpp | [T+0:00:08] | [T+0:00:09] | done | ZLOAD2 completed (LS adjustments applied in real SAP) |
| 4 | `ZLOAD3-B1` | `zload3b1` | …lpzu2o | [T+0:00:09] | [T+0:00:10] | done | Invoice 7682614528/85817687, Shipment status=shipped |
| 5 | `VTO1N-B` | `vto1n` | …rwbnkf | [T+0:00:10] | [T+0:00:10] | done | Shipment status=shipped |

## Step-by-step execution

### Step 1 — NEW ORDER inbound from branch

**Action**: `new_order_inbound`
**SO Number**: 3290009, **Customer ID**: TEST-CUST-AFTERLSDEC
**Duration**: 2279ms
**Outcome**: ✓ pass

**SAP transactions this step**:
```
  [T+0:00:01] ZSO-VISIBILITY   work=…t6cfpk state=done    → ✓ done at [T+0:00:01]
              callback: Material rows upserted (count now 3)
```

**New scenario events**:
```
  [T+0:00:01] classifier_decision    action=new_order
```

**New emails this step**:
```
  [T+0:00:01] → OUTBOUND ls_dispatch_buffered   test-branch@example.com
  [T+0:00:01] → OUTBOUND ls_dispatch            test-branch@example.com
```

**Driver notes**:
- Inbox pushed: MOCK-NEWORDER-1780136308598 subject="NEW ORDER 3290009"
- checkForNewEmails returned triggered=1 errors=0
- SO created: id=cmps773tn00j0sxmrpoehmymd poId=cmps773tl00iysxmr22qm0a8w
- ls_dispatch landed: emailId=cmps7740000jesxmr2scgro1x

### Step 2 — Branch replies release_all on ls_dispatch

**Action**: `inbound_reply`
**Reply text**: "Please release everything as available. All quantities approved, go ahead and dispatch."
**Email type**: `ls_dispatch`
**Duration**: 3372ms
**Outcome**: ✓ pass

**New scenario events**:
```
  [T+0:00:02] email_received         ls_dispatch from branch
  [T+0:00:05] classifier_decision    branch|before_ls|release_all|-
  [T+0:00:05] scenario_started       branch|before_ls|release_all|-
  [T+0:00:05] step_fired             email_confirm_bundle_details
  [T+0:00:05] step_completed         email_confirm_bundle_details ✓
  [T+0:00:05] scenario_completed     branch|before_ls|release_all|-
```

**New emails this step**:
```
  [T+0:00:05] → OUTBOUND dispatch_confirmation  test-branch@example.com
```

**Driver notes**:
- Injecting inbound_reply to email cmps7740000jesxmr2scgro1x (type=ls_dispatch)
- handleReplyV2 returned matched=true

### Step 3 — Wait for dispatch_confirmation outbound email (sent by engine)

**Action**: `wait_for_email`
**Email type**: `dispatch_confirmation`
**Duration**: 259ms
**Outcome**: ✓ pass

**Driver notes**:
- dispatch_confirmation email found after 2ms

### Step 4 — Branch confirms the dispatch plan → fan out ZLOAD1

**Action**: `dispatch_confirmation_reply`
**Reply text**: "Yes, please proceed with the dispatch plan as confirmed. Go ahead."
**Duration**: 272ms
**Outcome**: ✓ pass

**SAP transactions this step**:
```
  [T+0:00:05] ZLOAD1           work=…toeig8 state=done    → ✓ done at [T+0:00:06]
              callback: LoadingSlipItem rows with fileUrl (count now 3)
```

**Driver notes**:
- handleDispatchConfirmation success=true

### Step 5 — Wait for ZLOAD1 to complete → vehicle_details email lands

**Action**: `wait_for_email`
**Email type**: `vehicle_details`
**Duration**: 261ms
**Outcome**: ✓ pass

**New emails this step**:
```
  [T+0:00:06] → OUTBOUND vehicle_details        test-branch@example.com
```

**Driver notes**:
- vehicle_details email found after 2ms

### Step 6 — Branch reply on vehicle_details — after_ls_modify_decrease (post-LS modify)

**Action**: `inbound_reply`
**Reply text**: "Please reduce YE1EDWO00001APJP from 50 to 30 on the LS. No deletions, no increases."
**Email type**: `vehicle_details`
**Duration**: 2689ms
**Outcome**: ✓ pass

**SAP transactions this step**:
```
  [T+0:00:08] ZLOAD2           work=…sjptpp state=done    → ✓ done at [T+0:00:09]
              callback: ZLOAD2 completed (LS adjustments applied in real SAP)
```

**New scenario events**:
```
  [T+0:00:06] email_received         vehicle_details from branch
  [T+0:00:08] classifier_decision    branch|after_ls_before_invoice|modify|decrease
  [T+0:00:08] scenario_started       branch|after_ls_before_invoice|modify|decrease
  [T+0:00:08] step_fired             zload2
  [T+0:00:09] step_completed         zload2 ✓
  [T+0:00:09] step_fired             email_to_branch_for_vehicle
  [T+0:00:09] step_completed         email_to_branch_for_vehicle ✓
  [T+0:00:09] scenario_completed     branch|after_ls_before_invoice|modify|decrease
```

**Driver notes**:
- Injecting inbound_reply to email cmps777a500k8sxmrm4h0l0hd (type=vehicle_details)
- handleReplyV2 returned matched=true

### Step 7 — Wait for new vehicle_details email after ZLOAD2 (engine re-asks branch for vehicle)

**Action**: `wait_for_email`
**Email type**: `vehicle_details`
**Duration**: 255ms
**Outcome**: ✓ pass

**Driver notes**:
- vehicle_details email found after 1ms

### Step 8 — Branch replies with vehicle / driver / LR — sends plant_ls per LSI

**Action**: `vehicle_details_reply`
**Duration**: 273ms
**Outcome**: ✓ pass

**New emails this step**:
```
  [T+0:00:09] → OUTBOUND plant_ls               test-plant@example.com
  [T+0:00:09] → OUTBOUND plant_ls               test-plant@example.com
  [T+0:00:09] → OUTBOUND plant_ls               test-plant@example.com
```

**Driver notes**:
- handleVehicleDetailsReply success=true

### Step 9 — Wait for plant_ls outbound email(s)

**Action**: `wait_for_email`
**Email type**: `plant_ls`
**Duration**: 254ms
**Outcome**: ✓ pass

**Driver notes**:
- plant_ls email found after 1ms

### Step 10 — Plant replies with invoice PDF → ZLOAD3-B1 fires

**Action**: `plant_invoice_reply`
**Duration**: 264ms
**Outcome**: ✓ pass

**SAP transactions this step**:
```
  [T+0:00:09] ZLOAD3-B1        work=…lpzu2o state=done    → ✓ done at [T+0:00:10]
              callback: Invoice 7682614528/85817687, Shipment status=created
```

**Driver notes**:
- Marked 3 plant_ls email(s) replied; firing checkAndSendBatchToAman
- checkAndSendBatchToAman success=true

### Step 11 — Wait for Shipment row from /processing-data callback

**Action**: `wait_for_shipment`
**Duration**: 254ms
**Outcome**: ✓ pass

**Driver notes**:
- Shipment found id=cmps77abt00l2sxmrvuqm05d9 status=created obd=85817687

### Step 12 — Operator triggers VT01N for the Shipment

**Action**: `trigger_vt01n`
**Duration**: 266ms
**Outcome**: ✓ pass

**SAP transactions this step**:
```
  [T+0:00:10] VTO1N-B          work=…rwbnkf state=done    → ✓ done at [T+0:00:10]
              callback: Shipment status=shipped
```

**Driver notes**:
- Firing triggerVto1n on Shipment cmps77abt00l2sxmrvuqm05d9

### Step 13 — Wait for SO status = completed

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
| Invoice.invoiceNumber | `7682614528` |
| Invoice.obdNumber | `85817687` |
| Shipment.status | `shipped` |
| ScenarioEvent count | 15 |
| SAP transactions fired | 5 |

## Complete audit trail (chronological)

```
[T+0:00:00] classifier_decision  action=new_order
[T+0:00:00] email_received       from branch — Subject "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-178013630…" — "Please release everything as available. All quantities approved, go ahead and d…"
[T+0:00:03] classifier_decision  branch|before_ls|release_all|-
[T+0:00:03] scenario_started     branch|before_ls|release_all|-
[T+0:00:03] step_fired           email_confirm_bundle_details
[T+0:00:03] step_completed       email_confirm_bundle_details ✓
[T+0:00:03] scenario_completed   branch|before_ls|release_all|-
[T+0:00:04] email_received       from branch — Subject "Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780136308…" — "Please reduce YE1EDWO00001APJP from 50 to 30 on the LS. No deletions, no increa…"
[T+0:00:07] classifier_decision  branch|after_ls_before_invoice|modify|decrease
[T+0:00:07] scenario_started     branch|after_ls_before_invoice|modify|decrease
[T+0:00:07] step_fired           zload2
[T+0:00:07] step_completed       zload2 ✓ — LS 373307:PENDING=?, 373306:PENDING=?, 373305:PENDING=?
[T+0:00:07] step_fired           email_to_branch_for_vehicle
[T+0:00:07] step_completed       email_to_branch_for_vehicle ✓
[T+0:00:07] scenario_completed   branch|after_ls_before_invoice|modify|decrease
```

## Complete email thread (chronological)

```
[2026-05-30T10:18:30.528Z] OUTBOUND to test-branch@example.com [type=ls_dispatch] — Subject: "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780136308598"
  Body: Dispatch Recommendation - AUTO-MOCK-NEWORDER-1780136308598 Dear Sales Team, Sales Order 3290009 I have reviewed the stock availability for Sales Order 3290009. Here is the dispatch recommendation: Material A — APJP [YE1EDWO00001APJP] : Stock is confirmed available. Proceed with 50 units from Batch A-26. Material B — PJP [YV6FRYENE0000PJP] : Stock is confirmed available. Proceed with 100 units from Batch 30-07-2025. Material C — 43P [YA4COWOCR000043P] : Stock is confirmed available. Proceed with 250 units from Batch 20. Best regards, Sales Order Dispatch Co-ordinator

[2026-05-30T10:18:30.887Z] INBOUND from test-branch@example.com [type=ls_dispatch] — Subject: "Re: Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780136308598"
  Body: Please release everything as available. All quantities approved, go ahead and dispatch.

[2026-05-30T10:18:33.991Z] OUTBOUND to test-branch@example.com [type=dispatch_confirmation] — Subject: "Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780136308598"
  Body: Dear Branch Team, Dispatch plan ready for Purchase Order AUTO-MOCK-NEWORDER-1780136308598 (Chain after_ls_modify_decrease). Total 10.665 t — fits in 1 vehicle (capacity 45 t). Proposed dispatch (grouped by bundle): Bundle 1 — 10.665 t (of 45 t capacity): - SO 3290009 / YA4COWOCR000043P (Batch 20): 250 units, 6.625 t - SO 3290009 / YE1EDWO00001APJP (Batch A-26): 50 units, 1.320 t - SO 3290009 / YV6FRYENE0000PJP (Batch 30-07-2025): 100 units, 2.720 t Please reply with: - "yes" / "confirm" to proceed with the above plan, or - the changes you want (e.g. "skip OOWJ on SO 1234567", "send only 15 of OP7WJ"). Once confirmed we will create the loading slips. Best regards, Sales Order Dispatch Co-ordinator

[2026-05-30T10:18:34.526Z] INBOUND from test-branch@example.com [type=dispatch_confirmation] — Subject: "Re: Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780136308598"
  Body: Yes, please proceed with the dispatch plan as confirmed. Go ahead.

[2026-05-30T10:18:34.781Z] OUTBOUND to test-branch@example.com [type=vehicle_details] — Subject: "Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780136308598 (1 bundle)"
  Body: Dear Branch Team, Loading slips for Purchase Order AUTO-MOCK-NEWORDER-1780136308598 are now ready in SAP. The PO is split into 1 bundle: Bundle 1 (~10.66 t): - SO 3290009 / LS 373305 / Material PENDING - SO 3290009 / LS 373306 / Material PENDING - SO 3290009 / LS 373307 / Material PENDING Please reply with vehicle/transport details for each bundle in the format below: Bundle 1: , , Best regards, Sales Order Dispatch Co-ordinator

[2026-05-30T10:18:37.997Z] INBOUND from test-branch@example.com [type=vehicle_details] — Subject: "Re: Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780136308598 (1 bundle)"
  Body: Vehicle GJ12-XY1234, driver mobile 9876543210, container CONT-TEST-001, LR LR-9988 dated 2026-05-30.

[2026-05-30T10:18:38.513Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373305 - SO 3290009"
  Body: Plant invoice attached. Invoice 7682614520, OBD 85817679.

[2026-05-30T10:18:38.515Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373306 - SO 3290009"
  Body: Plant invoice attached. Invoice 7682614520, OBD 85817679.

[2026-05-30T10:18:38.516Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373307 - SO 3290009"
  Body: Plant invoice attached. Invoice 7682614520, OBD 85817679.
```

## Verifications

- ✓ SO.status === `completed` (actual: `completed`)
- ✓ LSI count ≥ 3 (actual: 3)
- ✓ Invoice number present (actual: `7682614528`)
- ✓ Shipment row exists (actual status: `shipped`)
- ✓ SAP transactions ≥ 5 (actual: 5)
