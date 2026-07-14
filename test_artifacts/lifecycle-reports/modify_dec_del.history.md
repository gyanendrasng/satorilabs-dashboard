# Chain: modify_dec_del

**Description**: Pre-LS modify (no VA02) — NEW ORDER → ls_dispatch → modify_dec_del reply → dispatch_confirmation → ZLOAD1 → tail
**SO Number**: 3290008
**Customer**: TEST-CUST-MODDD
**Scenario Key**: branch|before_ls|modify|dec_del
**Started**: 2026-05-30T10:18:20.748Z
**Finished**: 2026-05-30T10:18:28.577Z (duration: 7829ms)
**Result**: ✅ PASS

## SAP transaction summary

| # | Transaction | Step | Work ID (suffix) | Started | Completed | State | Callback effect |
|---|---|---|---|---|---|---|---|
| 1 | `ZSO-VISIBILITY` | `visibility` | …cy3g8g | [T+0:00:01] | [T+0:00:01] | done | Material rows upserted (count now 3) |
| 2 | `ZLOAD1` | `zload1` | …gk4vux | [T+0:00:05] | [T+0:00:05] | done | LoadingSlipItem rows with fileUrl (count now 3) |
| 3 | `ZLOAD3-B1` | `zload3b1` | …im7ey5 | [T+0:00:06] | [T+0:00:07] | done | Invoice 7682614527/85817686, Shipment status=shipped |
| 4 | `VTO1N-B` | `vto1n` | …ej6haa | [T+0:00:07] | [T+0:00:07] | done | Shipment status=shipped |

## Step-by-step execution

### Step 1 — NEW ORDER inbound from branch

**Action**: `new_order_inbound`
**SO Number**: 3290008, **Customer ID**: TEST-CUST-MODDD
**Duration**: 2053ms
**Outcome**: ✓ pass

**SAP transactions this step**:
```
  [T+0:00:01] ZSO-VISIBILITY   work=…cy3g8g state=done    → ✓ done at [T+0:00:01]
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
- Inbox pushed: MOCK-NEWORDER-1780136300764 subject="NEW ORDER 3290008"
- checkForNewEmails returned triggered=1 errors=0
- SO created: id=cmps76xlv00h7sxmre63m6bpi poId=cmps76xls00h5sxmr2y7fd4yb
- ls_dispatch landed: emailId=cmps76xsk00hlsxmrjc7iz0ld

### Step 2 — Branch reply on ls_dispatch — modify_dec_del

**Action**: `inbound_reply`
**Reply text**: "Reduce YE1EDWO00001APJP from 50 to 30 and delete YA4COWOCR000043P entirely from the order."
**Email type**: `ls_dispatch`
**Duration**: 3376ms
**Outcome**: ✓ pass

**New scenario events**:
```
  [T+0:00:02] email_received         ls_dispatch from branch
  [T+0:00:05] classifier_decision    branch|before_ls|modify|dec_del
  [T+0:00:05] scenario_started       branch|before_ls|modify|dec_del
  [T+0:00:05] step_fired             email_confirm_bundle_details
  [T+0:00:05] step_completed         email_confirm_bundle_details ✓
  [T+0:00:05] scenario_completed     branch|before_ls|modify|dec_del
```

**New emails this step**:
```
  [T+0:00:05] → OUTBOUND dispatch_confirmation  test-branch@example.com
```

**Driver notes**:
- Injecting inbound_reply to email cmps76xsk00hlsxmrjc7iz0ld (type=ls_dispatch)
- handleReplyV2 returned matched=true

### Step 3 — Wait for dispatch_confirmation outbound email (sent by engine)

**Action**: `wait_for_email`
**Email type**: `dispatch_confirmation`
**Duration**: 257ms
**Outcome**: ✓ pass

**Driver notes**:
- dispatch_confirmation email found after 1ms

### Step 4 — Branch confirms the dispatch plan → fan out ZLOAD1

**Action**: `dispatch_confirmation_reply`
**Reply text**: "Yes, please proceed with the dispatch plan as confirmed. Go ahead."
**Duration**: 280ms
**Outcome**: ✓ pass

**SAP transactions this step**:
```
  [T+0:00:05] ZLOAD1           work=…gk4vux state=done    → ✓ done at [T+0:00:05]
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
**Duration**: 256ms
**Outcome**: ✓ pass

**Driver notes**:
- vehicle_details email found after 1ms

### Step 6 — Branch replies with vehicle / driver / LR — sends plant_ls per LSI

**Action**: `vehicle_details_reply`
**Duration**: 274ms
**Outcome**: ✓ pass

**New emails this step**:
```
  [T+0:00:06] → OUTBOUND plant_ls               test-plant@example.com
  [T+0:00:06] → OUTBOUND plant_ls               test-plant@example.com
  [T+0:00:06] → OUTBOUND plant_ls               test-plant@example.com
```

**Driver notes**:
- handleVehicleDetailsReply success=true

### Step 7 — Wait for plant_ls outbound email(s)

**Action**: `wait_for_email`
**Email type**: `plant_ls`
**Duration**: 262ms
**Outcome**: ✓ pass

**Driver notes**:
- plant_ls email found after 1ms

### Step 8 — Plant replies with invoice PDF → ZLOAD3-B1 fires

**Action**: `plant_invoice_reply`
**Duration**: 277ms
**Outcome**: ✓ pass

**SAP transactions this step**:
```
  [T+0:00:06] ZLOAD3-B1        work=…im7ey5 state=done    → ✓ done at [T+0:00:07]
              callback: Invoice 7682614527/85817686, Shipment status=created
```

**Driver notes**:
- Marked 3 plant_ls email(s) replied; firing checkAndSendBatchToAman
- checkAndSendBatchToAman success=true

### Step 9 — Wait for Shipment row from /processing-data callback

**Action**: `wait_for_shipment`
**Duration**: 254ms
**Outcome**: ✓ pass

**Driver notes**:
- Shipment found id=cmps771ut00ipsxmrfpp9hsgx status=created obd=85817686

### Step 10 — Operator triggers VT01N for the Shipment

**Action**: `trigger_vt01n`
**Duration**: 262ms
**Outcome**: ✓ pass

**SAP transactions this step**:
```
  [T+0:00:07] VTO1N-B          work=…ej6haa state=done    → ✓ done at [T+0:00:07]
              callback: Shipment status=shipped
```

**Driver notes**:
- Firing triggerVto1n on Shipment cmps771ut00ipsxmrfpp9hsgx

### Step 11 — Wait for SO status = completed

**Action**: `wait_for_so_status`
**Duration**: 256ms
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
| Invoice.invoiceNumber | `7682614527` |
| Invoice.obdNumber | `85817686` |
| Shipment.status | `shipped` |
| ScenarioEvent count | 7 |
| SAP transactions fired | 4 |

## Complete audit trail (chronological)

```
[T+0:00:00] classifier_decision  action=new_order
[T+0:00:00] email_received       from branch — Subject "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-178013630…" — "Reduce YE1EDWO00001APJP from 50 to 30 and delete YA4COWOCR000043P entirely from…"
[T+0:00:03] classifier_decision  branch|before_ls|modify|dec_del
[T+0:00:03] scenario_started     branch|before_ls|modify|dec_del
[T+0:00:03] step_fired           email_confirm_bundle_details
[T+0:00:03] step_completed       email_confirm_bundle_details ✓
[T+0:00:03] scenario_completed   branch|before_ls|modify|dec_del
```

## Complete email thread (chronological)

```
[2026-05-30T10:18:22.484Z] OUTBOUND to test-branch@example.com [type=ls_dispatch] — Subject: "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780136300764"
  Body: Dispatch Recommendation - AUTO-MOCK-NEWORDER-1780136300764 Dear Sales Team, Sales Order 3290008 I have reviewed the stock availability for Sales Order 3290008. Here is the dispatch recommendation: Material A — APJP [YE1EDWO00001APJP] : Stock is confirmed available. Proceed with 50 units from Batch A-26. Material B — PJP [YV6FRYENE0000PJP] : Stock is confirmed available. Proceed with 100 units from Batch 30-07-2025. Material C — 43P [YA4COWOCR000043P] : Stock is confirmed available. Proceed with 250 units from Batch 20. Best regards, Sales Order Dispatch Co-ordinator

[2026-05-30T10:18:22.822Z] INBOUND from test-branch@example.com [type=ls_dispatch] — Subject: "Re: Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780136300764"
  Body: Reduce YE1EDWO00001APJP from 50 to 30 and delete YA4COWOCR000043P entirely from the order.

[2026-05-30T10:18:25.935Z] OUTBOUND to test-branch@example.com [type=dispatch_confirmation] — Subject: "Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780136300764"
  Body: Dear Branch Team, Dispatch plan ready for Purchase Order AUTO-MOCK-NEWORDER-1780136300764 (Chain modify_dec_del). Total 10.665 t — fits in 1 vehicle (capacity 45 t). Proposed dispatch (grouped by bundle): Bundle 1 — 10.665 t (of 45 t capacity): - SO 3290008 / YA4COWOCR000043P (Batch 20): 250 units, 6.625 t - SO 3290008 / YE1EDWO00001APJP (Batch A-26): 50 units, 1.320 t - SO 3290008 / YV6FRYENE0000PJP (Batch 30-07-2025): 100 units, 2.720 t Please reply with: - "yes" / "confirm" to proceed with the above plan, or - the changes you want (e.g. "skip OOWJ on SO 1234567", "send only 15 of OP7WJ"). Once confirmed we will create the loading slips. Best regards, Sales Order Dispatch Co-ordinator

[2026-05-30T10:18:26.475Z] INBOUND from test-branch@example.com [type=dispatch_confirmation] — Subject: "Re: Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780136300764"
  Body: Yes, please proceed with the dispatch plan as confirmed. Go ahead.

[2026-05-30T10:18:26.711Z] OUTBOUND to test-branch@example.com [type=vehicle_details] — Subject: "Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780136300764 (1 bundle)"
  Body: Dear Branch Team, Loading slips for Purchase Order AUTO-MOCK-NEWORDER-1780136300764 are now ready in SAP. The PO is split into 1 bundle: Bundle 1 (~10.66 t): - SO 3290008 / LS 373302 / Material PENDING - SO 3290008 / LS 373303 / Material PENDING - SO 3290008 / LS 373304 / Material PENDING Please reply with vehicle/transport details for each bundle in the format below: Bundle 1: , , Best regards, Sales Order Dispatch Co-ordinator

[2026-05-30T10:18:26.996Z] INBOUND from test-branch@example.com [type=vehicle_details] — Subject: "Re: Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780136300764 (1 bundle)"
  Body: Vehicle GJ12-XY1234, driver mobile 9876543210, container CONT-TEST-001, LR LR-9988 dated 2026-05-30.

[2026-05-30T10:18:27.527Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373302 - SO 3290008"
  Body: Plant invoice attached. Invoice 7682614520, OBD 85817679.

[2026-05-30T10:18:27.530Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373303 - SO 3290008"
  Body: Plant invoice attached. Invoice 7682614520, OBD 85817679.

[2026-05-30T10:18:27.531Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373304 - SO 3290008"
  Body: Plant invoice attached. Invoice 7682614520, OBD 85817679.
```

## Verifications

- ✓ SO.status === `completed` (actual: `completed`)
- ✓ LSI count ≥ 2 (actual: 3)
- ✓ Invoice number present (actual: `7682614527`)
- ✓ Shipment row exists (actual status: `shipped`)
- ✓ SAP transactions ≥ 4 (actual: 4)
