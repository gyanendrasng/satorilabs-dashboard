# Chain: after_ls_modify_decrease

**Description**: Phase A NEW ORDER → release_all → ZLOAD1 → vehicle_details email. Phase B branch replies on vehicle_details with after_ls_modify_decrease → ZLOAD2 → tail
**SO Number**: 3290009
**Customer**: TEST-CUST-AFTERLSDEC
**Scenario Key**: branch|after_ls_before_invoice|modify|decrease
**Started**: 2026-05-30T09:29:15.227Z
**Finished**: 2026-05-30T09:29:27.757Z (duration: 12530ms)
**Result**: ✅ PASS

## SAP transaction summary

| # | Transaction | Step | Work ID (suffix) | Started | Completed | State | Callback effect |
|---|---|---|---|---|---|---|---|
| 1 | `ZSO-VISIBILITY` | `visibility` | …ogc0xa | [T+0:00:01] | [T+0:00:02] | done | Material rows upserted (count now 3) |
| 2 | `ZLOAD1` | `zload1` | …t1ur7l | [T+0:00:06] | [T+0:00:07] | done | LoadingSlipItem rows with fileUrl (count now 3) |
| 3 | `ZLOAD2` | `zload2` | …mc0nh2 | [T+0:00:10] | [T+0:00:10] | done | ZLOAD2 completed (LS adjustments applied in real SAP) |
| 4 | `ZLOAD3-B1` | `zload3b1` | …452f6m | [T+0:00:11] | [T+0:00:11] | done | Invoice 7682614528/85817687, Shipment status=shipped |
| 5 | `VTO1N-B` | `vto1n` | …icrovh | [T+0:00:12] | [T+0:00:12] | done | Shipment status=shipped |

## Step-by-step execution

### Step 1 — NEW ORDER inbound from branch

**Action**: `new_order_inbound`
**SO Number**: 3290009, **Customer ID**: TEST-CUST-AFTERLSDEC
**Duration**: 2338ms
**Outcome**: ✓ pass

**SAP transactions this step**:
```
  [T+0:00:01] ZSO-VISIBILITY   work=…ogc0xa state=done    → ✓ done at [T+0:00:02]
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
- Inbox pushed: MOCK-NEWORDER-1780133355245 subject="NEW ORDER 3290009"
- checkForNewEmails returned triggered=1 errors=0
- SO created: id=cmps5ft1p00gwsxzpngmurc9o poId=cmps5ft1m00gusxzpywkovanj
- ls_dispatch landed: emailId=cmps5ft8900hasxzpu9kvb60w

### Step 2 — Branch replies release_all on ls_dispatch

**Action**: `inbound_reply`
**Reply text**: "Please release everything as available. All quantities approved, go ahead and dispatch."
**Email type**: `ls_dispatch`
**Duration**: 4021ms
**Outcome**: ✓ pass

**New scenario events**:
```
  [T+0:00:02] email_received         ls_dispatch from branch
  [T+0:00:06] classifier_decision    branch|before_ls|release_all|-
  [T+0:00:06] scenario_started       branch|before_ls|release_all|-
  [T+0:00:06] step_fired             email_confirm_bundle_details
  [T+0:00:06] step_completed         email_confirm_bundle_details ✓
  [T+0:00:06] scenario_completed     branch|before_ls|release_all|-
```

**Driver notes**:
- Injecting inbound_reply to email cmps5ft8900hasxzpu9kvb60w (type=ls_dispatch)
- handleReplyV2 returned matched=true

### Step 3 — (driver fills engine gap) Synthesise dispatch_confirmation email

**Action**: `synthesise_dispatch_confirmation`
**Note**: synthesised by driver — fills a known engine gap
(engine `email_confirm_bundle_details` step is a no-op stub)
**Duration**: 270ms
**Outcome**: ✓ pass

**New emails this step**:
```
  [T+0:00:06] → OUTBOUND dispatch_confirmation  test-branch@example.com
```

**Driver notes**:
- SYNTHESISED — engine email_confirm_bundle_details handler is a no-op stub
- [DispatchConfirm] Pre-email bundling: 1 bundle(s), total 10.665 t / 45 t per truck
- [DispatchConfirm] Confirmation email sent to test-branch@example.com for PO AUTO-MOCK-NEWORDER-1780133355245 (1 SO(s), 10.66 t)
- dispatch_confirmation sent (3 item(s), 10.66t)

### Step 4 — Wait for dispatch_confirmation outbound email

**Action**: `wait_for_email`
**Email type**: `dispatch_confirmation`
**Duration**: 259ms
**Outcome**: ✓ pass

**Driver notes**:
- dispatch_confirmation email found after 1ms

### Step 5 — Branch confirms the dispatch plan → fan out ZLOAD1

**Action**: `dispatch_confirmation_reply`
**Reply text**: "Yes, please proceed with the dispatch plan as confirmed. Go ahead."
**Duration**: 274ms
**Outcome**: ✓ pass

**SAP transactions this step**:
```
  [T+0:00:06] ZLOAD1           work=…t1ur7l state=done    → ✓ done at [T+0:00:07]
              callback: LoadingSlipItem rows with fileUrl (count now 3)
```

**New emails this step**:
```
  [T+0:00:07] → OUTBOUND vehicle_details        test-branch@example.com
```

**Driver notes**:
- handleDispatchConfirmation success=true

### Step 6 — Wait for ZLOAD1 to complete → vehicle_details email lands

**Action**: `wait_for_email`
**Email type**: `vehicle_details`
**Duration**: 255ms
**Outcome**: ✓ pass

**Driver notes**:
- vehicle_details email found after 1ms

### Step 7 — Branch reply on vehicle_details — after_ls_modify_decrease (post-LS modify)

**Action**: `inbound_reply`
**Reply text**: "Please reduce YE1EDWO00001APJP from 50 to 30 on the LS. No deletions, no increases."
**Email type**: `vehicle_details`
**Duration**: 3254ms
**Outcome**: ✓ pass

**SAP transactions this step**:
```
  [T+0:00:10] ZLOAD2           work=…mc0nh2 state=done    → ✓ done at [T+0:00:10]
              callback: ZLOAD2 completed (LS adjustments applied in real SAP)
```

**New scenario events**:
```
  [T+0:00:07] email_received         vehicle_details from branch
  [T+0:00:10] classifier_decision    branch|after_ls_before_invoice|modify|decrease
  [T+0:00:10] scenario_started       branch|after_ls_before_invoice|modify|decrease
  [T+0:00:10] step_fired             zload2
  [T+0:00:10] step_completed         zload2 ✓
  [T+0:00:10] step_fired             email_to_branch_for_vehicle
  [T+0:00:10] step_completed         email_to_branch_for_vehicle ✓
  [T+0:00:10] scenario_completed     branch|after_ls_before_invoice|modify|decrease
```

**Driver notes**:
- Injecting inbound_reply to email cmps5fx7d00i4sxzpl43zghib (type=vehicle_details)
- handleReplyV2 returned matched=true

### Step 8 — Wait for new vehicle_details email after ZLOAD2 (engine re-asks branch for vehicle)

**Action**: `wait_for_email`
**Email type**: `vehicle_details`
**Duration**: 255ms
**Outcome**: ✓ pass

**Driver notes**:
- vehicle_details email found after 1ms

### Step 9 — Branch replies with vehicle / driver / LR — sends plant_ls per LSI

**Action**: `vehicle_details_reply`
**Duration**: 275ms
**Outcome**: ✓ pass

**New emails this step**:
```
  [T+0:00:10] → OUTBOUND plant_ls               test-plant@example.com
  [T+0:00:10] → OUTBOUND plant_ls               test-plant@example.com
  [T+0:00:10] → OUTBOUND plant_ls               test-plant@example.com
```

**Driver notes**:
- handleVehicleDetailsReply success=true

### Step 10 — Wait for plant_ls outbound email(s)

**Action**: `wait_for_email`
**Email type**: `plant_ls`
**Duration**: 255ms
**Outcome**: ✓ pass

**Driver notes**:
- plant_ls email found after 1ms

### Step 11 — Plant replies with invoice PDF → ZLOAD3-B1 fires

**Action**: `plant_invoice_reply`
**Duration**: 266ms
**Outcome**: ✓ pass

**SAP transactions this step**:
```
  [T+0:00:11] ZLOAD3-B1        work=…452f6m state=done    → ✓ done at [T+0:00:11]
              callback: Invoice 7682614528/85817687, Shipment status=created
```

**Driver notes**:
- Marked 3 plant_ls email(s) replied; firing checkAndSendBatchToAman
- checkAndSendBatchToAman success=true

### Step 12 — Wait for Shipment row from /processing-data callback

**Action**: `wait_for_shipment`
**Duration**: 255ms
**Outcome**: ✓ pass

**Driver notes**:
- Shipment found id=cmps5g0p600iysxzp6nfn4is9 status=created obd=85817687

### Step 13 — Operator triggers VT01N for the Shipment

**Action**: `trigger_vt01n`
**Duration**: 266ms
**Outcome**: ✓ pass

**SAP transactions this step**:
```
  [T+0:00:12] VTO1N-B          work=…icrovh state=done    → ✓ done at [T+0:00:12]
              callback: Shipment status=shipped
```

**Driver notes**:
- Firing triggerVto1n on Shipment cmps5g0p600iysxzp6nfn4is9

### Step 14 — Wait for SO status = completed

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
| Invoice.invoiceNumber | `7682614528` |
| Invoice.obdNumber | `85817687` |
| Shipment.status | `shipped` |
| ScenarioEvent count | 15 |
| SAP transactions fired | 5 |

## Complete audit trail (chronological)

```
[T+0:00:00] classifier_decision  action=new_order
[T+0:00:00] email_received       from branch — Subject "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-178013335…" — "Please release everything as available. All quantities approved, go ahead and d…"
[T+0:00:04] classifier_decision  branch|before_ls|release_all|-
[T+0:00:04] scenario_started     branch|before_ls|release_all|-
[T+0:00:04] step_fired           email_confirm_bundle_details
[T+0:00:04] step_completed       email_confirm_bundle_details ✓
[T+0:00:04] scenario_completed   branch|before_ls|release_all|-
[T+0:00:05] email_received       from branch — Subject "Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780133355…" — "Please reduce YE1EDWO00001APJP from 50 to 30 on the LS. No deletions, no increa…"
[T+0:00:08] classifier_decision  branch|after_ls_before_invoice|modify|decrease
[T+0:00:08] scenario_started     branch|after_ls_before_invoice|modify|decrease
[T+0:00:08] step_fired           zload2
[T+0:00:08] step_completed       zload2 ✓ — LS 373307:PENDING=?, 373306:PENDING=?, 373305:PENDING=?
[T+0:00:08] step_fired           email_to_branch_for_vehicle
[T+0:00:08] step_completed       email_to_branch_for_vehicle ✓
[T+0:00:08] scenario_completed   branch|after_ls_before_invoice|modify|decrease
```

## Complete email thread (chronological)

```
[2026-05-30T09:29:17.241Z] OUTBOUND to test-branch@example.com [type=ls_dispatch] — Subject: "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780133355245"
  Body: Dispatch Recommendation - AUTO-MOCK-NEWORDER-1780133355245 Dear Sales Team, Sales Order 3290009 I have reviewed the stock availability for Sales Order 3290009. Here is the dispatch recommendation: Material A — APJP [YE1EDWO00001APJP] : Stock is confirmed available. Proceed with 50 units from Batch A-26. Material B — PJP [YV6FRYENE0000PJP] : Stock is confirmed available. Proceed with 100 units from Batch 30-07-2025. Material C — 43P [YA4COWOCR000043P] : Stock is confirmed available. Proceed with 250 units from Batch 20. Best regards, Sales Order Dispatch Co-ordinator

[2026-05-30T09:29:17.592Z] INBOUND from test-branch@example.com [type=ls_dispatch] — Subject: "Re: Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780133355245"
  Body: Please release everything as available. All quantities approved, go ahead and dispatch.

[2026-05-30T09:29:21.619Z] OUTBOUND to test-branch@example.com [type=dispatch_confirmation] — Subject: "Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780133355245"
  Body: Dear Branch Team, Dispatch plan ready for Purchase Order AUTO-MOCK-NEWORDER-1780133355245 (Chain after_ls_modify_decrease). Total 10.665 t — fits in 1 vehicle (capacity 45 t). Proposed dispatch (grouped by bundle): Bundle 1 — 10.665 t (of 45 t capacity): - SO 3290009 / YA4COWOCR000043P (Batch 20): 250 units, 6.625 t - SO 3290009 / YE1EDWO00001APJP (Batch A-26): 50 units, 1.320 t - SO 3290009 / YV6FRYENE0000PJP (Batch 30-07-2025): 100 units, 2.720 t Please reply with: - "yes" / "confirm" to proceed with the above plan, or - the changes you want (e.g. "skip OOWJ on SO 1234567", "send only 15 of OP7WJ"). Once confirmed we will create the loading slips. Best regards, Sales Order Dispatch Co-ordinator

[2026-05-30T09:29:22.155Z] INBOUND from test-branch@example.com [type=dispatch_confirmation] — Subject: "Re: Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780133355245"
  Body: Yes, please proceed with the dispatch plan as confirmed. Go ahead.

[2026-05-30T09:29:22.394Z] OUTBOUND to test-branch@example.com [type=vehicle_details] — Subject: "Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780133355245 (1 bundle)"
  Body: Dear Branch Team, Loading slips for Purchase Order AUTO-MOCK-NEWORDER-1780133355245 are now ready in SAP. The PO is split into 1 bundle: Bundle 1 (~10.66 t): - SO 3290009 / LS 373305 / Material PENDING - SO 3290009 / LS 373306 / Material PENDING - SO 3290009 / LS 373307 / Material PENDING Please reply with vehicle/transport details for each bundle in the format below: Bundle 1: , , Best regards, Sales Order Dispatch Co-ordinator

[2026-05-30T09:29:26.186Z] INBOUND from test-branch@example.com [type=vehicle_details] — Subject: "Re: Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780133355245 (1 bundle)"
  Body: Vehicle GJ12-XY1234, driver mobile 9876543210, container CONT-TEST-001, LR LR-9988 dated 2026-05-30.

[2026-05-30T09:29:26.705Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373305 - SO 3290009"
  Body: Plant invoice attached. Invoice 7682614520, OBD 85817679.

[2026-05-30T09:29:26.707Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373306 - SO 3290009"
  Body: Plant invoice attached. Invoice 7682614520, OBD 85817679.

[2026-05-30T09:29:26.708Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373307 - SO 3290009"
  Body: Plant invoice attached. Invoice 7682614520, OBD 85817679.
```

## Verifications

- ✓ SO.status === `completed` (actual: `completed`)
- ✓ LSI count ≥ 3 (actual: 3)
- ✓ Invoice number present (actual: `7682614528`)
- ✓ Shipment row exists (actual status: `shipped`)
- ✓ SAP transactions ≥ 5 (actual: 5)
