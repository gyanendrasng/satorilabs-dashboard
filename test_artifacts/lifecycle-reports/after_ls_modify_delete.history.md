# Chain: after_ls_modify_delete

**Description**: Phase A NEW ORDER → release_all → ZLOAD1 → vehicle_details email. Phase B branch replies on vehicle_details with after_ls_modify_delete → ZLOAD2 → tail
**SO Number**: 3290010
**Customer**: TEST-CUST-AFTERLSDEL
**Scenario Key**: branch|after_ls_before_invoice|modify|delete
**Started**: 2026-05-30T09:29:27.760Z
**Finished**: 2026-05-30T09:29:39.022Z (duration: 11262ms)
**Result**: ✅ PASS

## SAP transaction summary

| # | Transaction | Step | Work ID (suffix) | Started | Completed | State | Callback effect |
|---|---|---|---|---|---|---|---|
| 1 | `ZSO-VISIBILITY` | `visibility` | …6ktdo9 | [T+0:00:02] | [T+0:00:02] | done | Material rows upserted (count now 3) |
| 2 | `ZLOAD1` | `zload1` | …c6cong | [T+0:00:05] | [T+0:00:06] | done | LoadingSlipItem rows with fileUrl (count now 3) |
| 3 | `ZLOADING_CLOSE` | `zloading_close` | …iurze6 | [T+0:00:09] | [T+0:00:09] | done | callback applied |
| 4 | `ZLOAD3-B1` | `zload3b1` | …lox6cx | [T+0:00:10] | [T+0:00:10] | done | Invoice 7682614529/85817688, Shipment status=shipped |
| 5 | `VTO1N-B` | `vto1n` | …x809bt | [T+0:00:10] | [T+0:00:10] | done | Shipment status=shipped |

## Step-by-step execution

### Step 1 — NEW ORDER inbound from branch

**Action**: `new_order_inbound`
**SO Number**: 3290010, **Customer ID**: TEST-CUST-AFTERLSDEL
**Duration**: 3187ms
**Outcome**: ✓ pass

**SAP transactions this step**:
```
  [T+0:00:02] ZSO-VISIBILITY   work=…6ktdo9 state=done    → ✓ done at [T+0:00:02]
              callback: Material rows upserted (count now 3)
```

**New scenario events**:
```
  [T+0:00:02] classifier_decision    action=new_order
```

**New emails this step**:
```
  [T+0:00:02] → OUTBOUND ls_dispatch_buffered   test-branch@example.com
  [T+0:00:02] → OUTBOUND ls_dispatch            test-branch@example.com
```

**Driver notes**:
- Inbox pushed: MOCK-NEWORDER-1780133367777 subject="NEW ORDER 3290010"
- checkForNewEmails returned triggered=1 errors=0
- SO created: id=cmps5g3dm00j9sxzpjs3w7c2n poId=cmps5g3dk00j7sxzpbubkedj8
- ls_dispatch landed: emailId=cmps5g3k000jnsxzp0vklhia1

### Step 2 — Branch replies release_all on ls_dispatch

**Action**: `inbound_reply`
**Reply text**: "Please release everything as available. All quantities approved, go ahead and dispatch."
**Email type**: `ls_dispatch`
**Duration**: 2163ms
**Outcome**: ✓ pass

**New scenario events**:
```
  [T+0:00:03] email_received         ls_dispatch from branch
  [T+0:00:05] classifier_decision    branch|before_ls|release_all|-
  [T+0:00:05] scenario_started       branch|before_ls|release_all|-
  [T+0:00:05] step_fired             email_confirm_bundle_details
  [T+0:00:05] step_completed         email_confirm_bundle_details ✓
  [T+0:00:05] scenario_completed     branch|before_ls|release_all|-
```

**Driver notes**:
- Injecting inbound_reply to email cmps5g3k000jnsxzp0vklhia1 (type=ls_dispatch)
- handleReplyV2 returned matched=true

### Step 3 — (driver fills engine gap) Synthesise dispatch_confirmation email

**Action**: `synthesise_dispatch_confirmation`
**Note**: synthesised by driver — fills a known engine gap
(engine `email_confirm_bundle_details` step is a no-op stub)
**Duration**: 278ms
**Outcome**: ✓ pass

**New emails this step**:
```
  [T+0:00:05] → OUTBOUND dispatch_confirmation  test-branch@example.com
```

**Driver notes**:
- SYNTHESISED — engine email_confirm_bundle_details handler is a no-op stub
- [DispatchConfirm] Pre-email bundling: 1 bundle(s), total 10.665 t / 45 t per truck
- [DispatchConfirm] Confirmation email sent to test-branch@example.com for PO AUTO-MOCK-NEWORDER-1780133367777 (1 SO(s), 10.66 t)
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
**Duration**: 275ms
**Outcome**: ✓ pass

**SAP transactions this step**:
```
  [T+0:00:05] ZLOAD1           work=…c6cong state=done    → ✓ done at [T+0:00:06]
              callback: LoadingSlipItem rows with fileUrl (count now 3)
```

**New emails this step**:
```
  [T+0:00:06] → OUTBOUND vehicle_details        test-branch@example.com
```

**Driver notes**:
- handleDispatchConfirmation success=true

### Step 6 — Wait for ZLOAD1 to complete → vehicle_details email lands

**Action**: `wait_for_email`
**Email type**: `vehicle_details`
**Duration**: 254ms
**Outcome**: ✓ pass

**Driver notes**:
- vehicle_details email found after 0ms

### Step 7 — Branch reply on vehicle_details — after_ls_modify_delete (post-LS modify)

**Action**: `inbound_reply`
**Reply text**: "Please remove YA4COWOCR000043P from the LS entirely. No quantity changes elsewhere."
**Email type**: `vehicle_details`
**Duration**: 2988ms
**Outcome**: ✓ pass

**SAP transactions this step**:
```
  [T+0:00:09] ZLOADING_CLOSE   work=…iurze6 state=done    → ✓ done at [T+0:00:09]
              callback: callback applied
```

**New scenario events**:
```
  [T+0:00:06] email_received         vehicle_details from branch
  [T+0:00:09] classifier_decision    branch|after_ls_before_invoice|modify|delete
  [T+0:00:09] scenario_started       branch|after_ls_before_invoice|modify|delete
  [T+0:00:09] step_fired             zloading_close
  [T+0:00:09] step_completed         zloading_close ✓
  [T+0:00:09] step_fired             email_to_branch_for_vehicle
  [T+0:00:09] step_completed         email_to_branch_for_vehicle ✓
  [T+0:00:09] scenario_completed     branch|after_ls_before_invoice|modify|delete
```

**Driver notes**:
- Injecting inbound_reply to email cmps5g64000khsxzp7n28olm1 (type=vehicle_details)
- handleReplyV2 returned matched=true

### Step 8 — Wait for new vehicle_details email after ZLOAD2 (engine re-asks branch for vehicle)

**Action**: `wait_for_email`
**Email type**: `vehicle_details`
**Duration**: 255ms
**Outcome**: ✓ pass

**Driver notes**:
- vehicle_details email found after 0ms

### Step 9 — Branch replies with vehicle / driver / LR — sends plant_ls per LSI

**Action**: `vehicle_details_reply`
**Duration**: 272ms
**Outcome**: ✓ pass

**New emails this step**:
```
  [T+0:00:09] → OUTBOUND plant_ls               test-plant@example.com
  [T+0:00:09] → OUTBOUND plant_ls               test-plant@example.com
  [T+0:00:09] → OUTBOUND plant_ls               test-plant@example.com
```

**Driver notes**:
- handleVehicleDetailsReply success=true

### Step 10 — Wait for plant_ls outbound email(s)

**Action**: `wait_for_email`
**Email type**: `plant_ls`
**Duration**: 258ms
**Outcome**: ✓ pass

**Driver notes**:
- plant_ls email found after 1ms

### Step 11 — Plant replies with invoice PDF → ZLOAD3-B1 fires

**Action**: `plant_invoice_reply`
**Duration**: 275ms
**Outcome**: ✓ pass

**SAP transactions this step**:
```
  [T+0:00:10] ZLOAD3-B1        work=…lox6cx state=done    → ✓ done at [T+0:00:10]
              callback: Invoice 7682614529/85817688, Shipment status=created
```

**Driver notes**:
- Marked 3 plant_ls email(s) replied; firing checkAndSendBatchToAman
- checkAndSendBatchToAman success=true

### Step 12 — Wait for Shipment row from /processing-data callback

**Action**: `wait_for_shipment`
**Duration**: 253ms
**Outcome**: ✓ pass

**Driver notes**:
- Shipment found id=cmps5g9eb00lbsxzplzv0h7li status=created obd=85817688

### Step 13 — Operator triggers VT01N for the Shipment

**Action**: `trigger_vt01n`
**Duration**: 266ms
**Outcome**: ✓ pass

**SAP transactions this step**:
```
  [T+0:00:10] VTO1N-B          work=…x809bt state=done    → ✓ done at [T+0:00:10]
              callback: Shipment status=shipped
```

**Driver notes**:
- Firing triggerVto1n on Shipment cmps5g9eb00lbsxzplzv0h7li

### Step 14 — Wait for SO status = completed

**Action**: `wait_for_so_status`
**Duration**: 255ms
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
| Invoice.invoiceNumber | `7682614529` |
| Invoice.obdNumber | `85817688` |
| Shipment.status | `shipped` |
| ScenarioEvent count | 15 |
| SAP transactions fired | 5 |

## Complete audit trail (chronological)

```
[T+0:00:00] classifier_decision  action=new_order
[T+0:00:00] email_received       from branch — Subject "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-178013336…" — "Please release everything as available. All quantities approved, go ahead and d…"
[T+0:00:02] classifier_decision  branch|before_ls|release_all|-
[T+0:00:02] scenario_started     branch|before_ls|release_all|-
[T+0:00:02] step_fired           email_confirm_bundle_details
[T+0:00:02] step_completed       email_confirm_bundle_details ✓
[T+0:00:02] scenario_completed   branch|before_ls|release_all|-
[T+0:00:03] email_received       from branch — Subject "Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780133367…" — "Please remove YA4COWOCR000043P from the LS entirely. No quantity changes elsewh…"
[T+0:00:06] classifier_decision  branch|after_ls_before_invoice|modify|delete
[T+0:00:06] scenario_started     branch|after_ls_before_invoice|modify|delete
[T+0:00:06] step_fired           zloading_close
[T+0:00:06] step_completed       zloading_close ✓ — LS 373310:PENDING=?, 373309:PENDING=?, 373308:PENDING=?
[T+0:00:06] step_fired           email_to_branch_for_vehicle
[T+0:00:06] step_completed       email_to_branch_for_vehicle ✓
[T+0:00:06] scenario_completed   branch|after_ls_before_invoice|modify|delete
```

## Complete email thread (chronological)

```
[2026-05-30T09:29:30.625Z] OUTBOUND to test-branch@example.com [type=ls_dispatch] — Subject: "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780133367777"
  Body: Dispatch Recommendation - AUTO-MOCK-NEWORDER-1780133367777 Dear Sales Team, Sales Order 3290010 I have reviewed the stock availability for Sales Order 3290010. Here is the dispatch recommendation: Material A — APJP [YE1EDWO00001APJP] : Stock is confirmed available. Proceed with 50 units from Batch A-26. Material B — PJP [YV6FRYENE0000PJP] : Stock is confirmed available. Proceed with 100 units from Batch 30-07-2025. Material C — 43P [YA4COWOCR000043P] : Stock is confirmed available. Proceed with 250 units from Batch 20. Best regards, Sales Order Dispatch Co-ordinator

[2026-05-30T09:29:30.972Z] INBOUND from test-branch@example.com [type=ls_dispatch] — Subject: "Re: Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780133367777"
  Body: Please release everything as available. All quantities approved, go ahead and dispatch.

[2026-05-30T09:29:33.148Z] OUTBOUND to test-branch@example.com [type=dispatch_confirmation] — Subject: "Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780133367777"
  Body: Dear Branch Team, Dispatch plan ready for Purchase Order AUTO-MOCK-NEWORDER-1780133367777 (Chain after_ls_modify_delete). Total 10.665 t — fits in 1 vehicle (capacity 45 t). Proposed dispatch (grouped by bundle): Bundle 1 — 10.665 t (of 45 t capacity): - SO 3290010 / YA4COWOCR000043P (Batch 20): 250 units, 6.625 t - SO 3290010 / YE1EDWO00001APJP (Batch A-26): 50 units, 1.320 t - SO 3290010 / YV6FRYENE0000PJP (Batch 30-07-2025): 100 units, 2.720 t Please reply with: - "yes" / "confirm" to proceed with the above plan, or - the changes you want (e.g. "skip OOWJ on SO 1234567", "send only 15 of OP7WJ"). Once confirmed we will create the loading slips. Best regards, Sales Order Dispatch Co-ordinator

[2026-05-30T09:29:33.686Z] INBOUND from test-branch@example.com [type=dispatch_confirmation] — Subject: "Re: Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780133367777"
  Body: Yes, please proceed with the dispatch plan as confirmed. Go ahead.

[2026-05-30T09:29:33.936Z] OUTBOUND to test-branch@example.com [type=vehicle_details] — Subject: "Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780133367777 (1 bundle)"
  Body: Dear Branch Team, Loading slips for Purchase Order AUTO-MOCK-NEWORDER-1780133367777 are now ready in SAP. The PO is split into 1 bundle: Bundle 1 (~10.66 t): - SO 3290010 / LS 373308 / Material PENDING - SO 3290010 / LS 373309 / Material PENDING - SO 3290010 / LS 373310 / Material PENDING Please reply with vehicle/transport details for each bundle in the format below: Bundle 1: , , Best regards, Sales Order Dispatch Co-ordinator

[2026-05-30T09:29:37.449Z] INBOUND from test-branch@example.com [type=vehicle_details] — Subject: "Re: Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780133367777 (1 bundle)"
  Body: Vehicle GJ12-XY1234, driver mobile 9876543210, container CONT-TEST-001, LR LR-9988 dated 2026-05-30.

[2026-05-30T09:29:37.973Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373308 - SO 3290010"
  Body: Plant invoice attached. Invoice 7682614520, OBD 85817679.

[2026-05-30T09:29:37.976Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373309 - SO 3290010"
  Body: Plant invoice attached. Invoice 7682614520, OBD 85817679.

[2026-05-30T09:29:37.978Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373310 - SO 3290010"
  Body: Plant invoice attached. Invoice 7682614520, OBD 85817679.
```

## Verifications

- ✓ SO.status === `completed` (actual: `completed`)
- ✓ LSI count ≥ 2 (actual: 3)
- ✓ Invoice number present (actual: `7682614529`)
- ✓ Shipment row exists (actual status: `shipped`)
- ✓ SAP transactions ≥ 5 (actual: 5)
