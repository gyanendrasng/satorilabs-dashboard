# Chain: modify_delete

**Description**: Pre-LS modify (no VA02) — NEW ORDER → ls_dispatch → modify_delete reply → dispatch_confirmation → ZLOAD1 → tail
**SO Number**: 3290005
**Customer**: TEST-CUST-MODDEL
**Scenario Key**: branch|before_ls|modify|delete
**Started**: 2026-05-30T10:17:46.368Z
**Finished**: 2026-05-30T10:17:53.479Z (duration: 7111ms)
**Result**: ✅ PASS

## SAP transaction summary

| # | Transaction | Step | Work ID (suffix) | Started | Completed | State | Callback effect |
|---|---|---|---|---|---|---|---|
| 1 | `ZSO-VISIBILITY` | `visibility` | …kze3lg | [T+0:00:01] | [T+0:00:02] | done | Material rows upserted (count now 3) |
| 2 | `ZLOAD1` | `zload1` | …ja07x7 | [T+0:00:05] | [T+0:00:05] | done | LoadingSlipItem rows with fileUrl (count now 3) |
| 3 | `ZLOAD3-B1` | `zload3b1` | …err8zy | [T+0:00:06] | [T+0:00:06] | done | Invoice 7682614524/85817683, Shipment status=shipped |
| 4 | `VTO1N-B` | `vto1n` | …w8z0tn | [T+0:00:06] | [T+0:00:06] | done | Shipment status=shipped |

## Step-by-step execution

### Step 1 — NEW ORDER inbound from branch

**Action**: `new_order_inbound`
**SO Number**: 3290005, **Customer ID**: TEST-CUST-MODDEL
**Duration**: 2495ms
**Outcome**: ✓ pass

**SAP transactions this step**:
```
  [T+0:00:01] ZSO-VISIBILITY   work=…kze3lg state=done    → ✓ done at [T+0:00:02]
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
- Inbox pushed: MOCK-NEWORDER-1780136266383 subject="NEW ORDER 3290005"
- checkForNewEmails returned triggered=1 errors=0
- SO created: id=cmps767ew008ksxmrgc9z3qlr poId=cmps767et008isxmre10bnabt
- ls_dispatch landed: emailId=cmps767ld008ysxmr28etwfq7

### Step 2 — Branch reply on ls_dispatch — modify_delete

**Action**: `inbound_reply`
**Reply text**: "Please delete material YA4COWOCR000043P from the order. No quantity changes elsewhere."
**Email type**: `ls_dispatch`
**Duration**: 2246ms
**Outcome**: ✓ pass

**New scenario events**:
```
  [T+0:00:02] email_received         ls_dispatch from branch
  [T+0:00:04] classifier_decision    branch|before_ls|modify|delete
  [T+0:00:04] scenario_started       branch|before_ls|modify|delete
  [T+0:00:04] step_fired             email_confirm_product_details
  [T+0:00:04] step_completed         email_confirm_product_details ✓
  [T+0:00:04] step_fired             email_confirm_bundle_details
  [T+0:00:04] step_completed         email_confirm_bundle_details ✓
  [T+0:00:04] scenario_completed     branch|before_ls|modify|delete
```

**New emails this step**:
```
  [T+0:00:04] → OUTBOUND dispatch_confirmation  test-branch@example.com
```

**Driver notes**:
- Injecting inbound_reply to email cmps767ld008ysxmr28etwfq7 (type=ls_dispatch)
- handleReplyV2 returned matched=true

### Step 3 — Wait for dispatch_confirmation outbound email (sent by engine)

**Action**: `wait_for_email`
**Email type**: `dispatch_confirmation`
**Duration**: 254ms
**Outcome**: ✓ pass

**Driver notes**:
- dispatch_confirmation email found after 1ms

### Step 4 — Branch confirms the dispatch plan → fan out ZLOAD1

**Action**: `dispatch_confirmation_reply`
**Reply text**: "Yes, please proceed with the dispatch plan as confirmed. Go ahead."
**Duration**: 268ms
**Outcome**: ✓ pass

**SAP transactions this step**:
```
  [T+0:00:05] ZLOAD1           work=…ja07x7 state=done    → ✓ done at [T+0:00:05]
              callback: LoadingSlipItem rows with fileUrl (count now 3)
```

**New emails this step**:
```
  [T+0:00:05] → OUTBOUND vehicle_details        test-branch@example.com
```

**Driver notes**:
- handleDispatchConfirmation success=true

### Step 5 — Wait for ZLOAD1 to complete → vehicle_details email lands

**Action**: `wait_for_email`
**Email type**: `vehicle_details`
**Duration**: 253ms
**Outcome**: ✓ pass

**Driver notes**:
- vehicle_details email found after 0ms

### Step 6 — Branch replies with vehicle / driver / LR — sends plant_ls per LSI

**Action**: `vehicle_details_reply`
**Duration**: 270ms
**Outcome**: ✓ pass

**New emails this step**:
```
  [T+0:00:05] → OUTBOUND plant_ls               test-plant@example.com
  [T+0:00:05] → OUTBOUND plant_ls               test-plant@example.com
  [T+0:00:05] → OUTBOUND plant_ls               test-plant@example.com
```

**Driver notes**:
- handleVehicleDetailsReply success=true

### Step 7 — Wait for plant_ls outbound email(s)

**Action**: `wait_for_email`
**Email type**: `plant_ls`
**Duration**: 258ms
**Outcome**: ✓ pass

**Driver notes**:
- plant_ls email found after 1ms

### Step 8 — Plant replies with invoice PDF → ZLOAD3-B1 fires

**Action**: `plant_invoice_reply`
**Duration**: 272ms
**Outcome**: ✓ pass

**SAP transactions this step**:
```
  [T+0:00:06] ZLOAD3-B1        work=…err8zy state=done    → ✓ done at [T+0:00:06]
              callback: Invoice 7682614524/85817683, Shipment status=created
```

**Driver notes**:
- Marked 3 plant_ls email(s) replied; firing checkAndSendBatchToAman
- checkAndSendBatchToAman success=true

### Step 9 — Wait for Shipment row from /processing-data callback

**Action**: `wait_for_shipment`
**Duration**: 254ms
**Outcome**: ✓ pass

**Driver notes**:
- Shipment found id=cmps76arx00a6sxmrticcv5va status=created obd=85817683

### Step 10 — Operator triggers VT01N for the Shipment

**Action**: `trigger_vt01n`
**Duration**: 262ms
**Outcome**: ✓ pass

**SAP transactions this step**:
```
  [T+0:00:06] VTO1N-B          work=…w8z0tn state=done    → ✓ done at [T+0:00:06]
              callback: Shipment status=shipped
```

**Driver notes**:
- Firing triggerVto1n on Shipment cmps76arx00a6sxmrticcv5va

### Step 11 — Wait for SO status = completed

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
| Invoice.invoiceNumber | `7682614524` |
| Invoice.obdNumber | `85817683` |
| Shipment.status | `shipped` |
| ScenarioEvent count | 9 |
| SAP transactions fired | 4 |

## Complete audit trail (chronological)

```
[T+0:00:00] classifier_decision  action=new_order
[T+0:00:00] email_received       from branch — Subject "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-178013626…" — "Please delete material YA4COWOCR000043P from the order. No quantity changes els…"
[T+0:00:02] classifier_decision  branch|before_ls|modify|delete
[T+0:00:02] scenario_started     branch|before_ls|modify|delete
[T+0:00:02] step_fired           email_confirm_product_details
[T+0:00:02] step_completed       email_confirm_product_details ✓
[T+0:00:02] step_fired           email_confirm_bundle_details
[T+0:00:02] step_completed       email_confirm_bundle_details ✓
[T+0:00:02] scenario_completed   branch|before_ls|modify|delete
```

## Complete email thread (chronological)

```
[2026-05-30T10:17:48.529Z] OUTBOUND to test-branch@example.com [type=ls_dispatch] — Subject: "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780136266383"
  Body: Dispatch Recommendation - AUTO-MOCK-NEWORDER-1780136266383 Dear Sales Team, Sales Order 3290005 I have reviewed the stock availability for Sales Order 3290005. Here is the dispatch recommendation: Material A — APJP [YE1EDWO00001APJP] : Stock is confirmed available. Proceed with 50 units from Batch A-26. Material B — PJP [YV6FRYENE0000PJP] : Stock is confirmed available. Proceed with 100 units from Batch 30-07-2025. Material C — 43P [YA4COWOCR000043P] : Stock is confirmed available. Proceed with 250 units from Batch 20. Best regards, Sales Order Dispatch Co-ordinator

[2026-05-30T10:17:48.884Z] INBOUND from test-branch@example.com [type=ls_dispatch] — Subject: "Re: Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780136266383"
  Body: Please delete material YA4COWOCR000043P from the order. No quantity changes elsewhere.

[2026-05-30T10:17:50.868Z] OUTBOUND to test-branch@example.com [type=dispatch_confirmation] — Subject: "Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780136266383"
  Body: Dear Branch Team, Dispatch plan ready for Purchase Order AUTO-MOCK-NEWORDER-1780136266383 (Chain modify_delete). Total 10.665 t — fits in 1 vehicle (capacity 45 t). Proposed dispatch (grouped by bundle): Bundle 1 — 10.665 t (of 45 t capacity): - SO 3290005 / YA4COWOCR000043P (Batch 20): 250 units, 6.625 t - SO 3290005 / YE1EDWO00001APJP (Batch A-26): 50 units, 1.320 t - SO 3290005 / YV6FRYENE0000PJP (Batch 30-07-2025): 100 units, 2.720 t Please reply with: - "yes" / "confirm" to proceed with the above plan, or - the changes you want (e.g. "skip OOWJ on SO 1234567", "send only 15 of OP7WJ"). Once confirmed we will create the loading slips. Best regards, Sales Order Dispatch Co-ordinator

[2026-05-30T10:17:51.393Z] INBOUND from test-branch@example.com [type=dispatch_confirmation] — Subject: "Re: Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780136266383"
  Body: Yes, please proceed with the dispatch plan as confirmed. Go ahead.

[2026-05-30T10:17:51.632Z] OUTBOUND to test-branch@example.com [type=vehicle_details] — Subject: "Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780136266383 (1 bundle)"
  Body: Dear Branch Team, Loading slips for Purchase Order AUTO-MOCK-NEWORDER-1780136266383 are now ready in SAP. The PO is split into 1 bundle: Bundle 1 (~10.66 t): - SO 3290005 / LS 373293 / Material PENDING - SO 3290005 / LS 373294 / Material PENDING - SO 3290005 / LS 373295 / Material PENDING Please reply with vehicle/transport details for each bundle in the format below: Bundle 1: , , Best regards, Sales Order Dispatch Co-ordinator

[2026-05-30T10:17:51.909Z] INBOUND from test-branch@example.com [type=vehicle_details] — Subject: "Re: Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780136266383 (1 bundle)"
  Body: Vehicle GJ12-XY1234, driver mobile 9876543210, container CONT-TEST-001, LR LR-9988 dated 2026-05-30.

[2026-05-30T10:17:52.432Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373293 - SO 3290005"
  Body: Plant invoice attached. Invoice 7682614520, OBD 85817679.

[2026-05-30T10:17:52.435Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373294 - SO 3290005"
  Body: Plant invoice attached. Invoice 7682614520, OBD 85817679.

[2026-05-30T10:17:52.437Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373295 - SO 3290005"
  Body: Plant invoice attached. Invoice 7682614520, OBD 85817679.
```

## Verifications

- ✓ SO.status === `completed` (actual: `completed`)
- ✓ LSI count ≥ 2 (actual: 3)
- ✓ Invoice number present (actual: `7682614524`)
- ✓ Shipment row exists (actual status: `shipped`)
- ✓ SAP transactions ≥ 4 (actual: 4)
