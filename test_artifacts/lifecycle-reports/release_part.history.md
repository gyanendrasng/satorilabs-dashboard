# Chain: release_part

**Description**: Partial release — NEW ORDER → ls_dispatch → release_part (skip M-C 0 stock) → VT01N
**SO Number**: 3290002
**Customer**: TEST-CUST-RELPART
**Scenario Key**: branch|before_ls|release_part|-
**Started**: 2026-05-30T10:17:17.613Z
**Finished**: 2026-05-30T10:17:26.168Z (duration: 8555ms)
**Result**: ✅ PASS

## SAP transaction summary

| # | Transaction | Step | Work ID (suffix) | Started | Completed | State | Callback effect |
|---|---|---|---|---|---|---|---|
| 1 | `ZSO-VISIBILITY` | `visibility` | …npde1x | [T+0:00:01] | [T+0:00:02] | done | Material rows upserted (count now 3) |
| 2 | `ZLOAD1` | `zload1` | …jbs8n9 | [T+0:00:06] | [T+0:00:06] | done | LoadingSlipItem rows with fileUrl (count now 2) |
| 3 | `ZLOAD3-B1` | `zload3b1` | …xkmzc8 | [T+0:00:07] | [T+0:00:07] | done | Invoice 7682614521/85817680, Shipment status=shipped |
| 4 | `VTO1N-B` | `vto1n` | …5iamwd | [T+0:00:08] | [T+0:00:08] | done | Shipment status=shipped |

## Step-by-step execution

### Step 1 — NEW ORDER inbound from branch (M-C has 0 stock)

**Action**: `new_order_inbound`
**SO Number**: 3290002, **Customer ID**: TEST-CUST-RELPART
**Duration**: 2531ms
**Outcome**: ✓ pass

**SAP transactions this step**:
```
  [T+0:00:01] ZSO-VISIBILITY   work=…npde1x state=done    → ✓ done at [T+0:00:02]
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
- Inbox pushed: MOCK-NEWORDER-1780136237631 subject="NEW ORDER 3290002"
- checkForNewEmails returned triggered=1 errors=0
- SO created: id=cmps75l9e001zsxmra6d1su5u poId=cmps75l9b001xsxmrubsf89pw
- ls_dispatch landed: emailId=cmps75lft002dsxmrct9lcqob

### Step 2 — Branch replies "release available, skip zero-stock"

**Action**: `inbound_reply`
**Reply text**: "Release the materials you have available, skip the ones with zero stock."
**Email type**: `ls_dispatch`
**Duration**: 3627ms
**Outcome**: ✓ pass

**New scenario events**:
```
  [T+0:00:02] email_received         ls_dispatch from branch
  [T+0:00:05] classifier_decision    branch|before_ls|release_part|-
  [T+0:00:05] scenario_started       branch|before_ls|release_part|-
  [T+0:00:05] step_fired             email_confirm_bundle_details
  [T+0:00:05] step_completed         email_confirm_bundle_details ✓
  [T+0:00:05] scenario_completed     branch|before_ls|release_part|-
```

**New emails this step**:
```
  [T+0:00:05] → OUTBOUND dispatch_confirmation  test-branch@example.com
```

**Driver notes**:
- Injecting inbound_reply to email cmps75lft002dsxmrct9lcqob (type=ls_dispatch)
- handleReplyV2 returned matched=true

### Step 3 — Wait for dispatch_confirmation outbound email (sent by engine)

**Action**: `wait_for_email`
**Email type**: `dispatch_confirmation`
**Duration**: 261ms
**Outcome**: ✓ pass

**Driver notes**:
- dispatch_confirmation email found after 1ms

### Step 4 — Branch confirms the dispatch plan → fan out ZLOAD1

**Action**: `dispatch_confirmation_reply`
**Reply text**: "Yes, please proceed with the dispatch plan as confirmed. Go ahead."
**Duration**: 281ms
**Outcome**: ✓ pass

**SAP transactions this step**:
```
  [T+0:00:06] ZLOAD1           work=…jbs8n9 state=done    → ✓ done at [T+0:00:06]
              callback: LoadingSlipItem rows with fileUrl (count now 2)
```

**New emails this step**:
```
  [T+0:00:06] → OUTBOUND vehicle_details        test-branch@example.com
```

**Driver notes**:
- handleDispatchConfirmation success=true

### Step 5 — Wait for ZLOAD1 to complete → vehicle_details email lands

**Action**: `wait_for_email`
**Email type**: `vehicle_details`
**Duration**: 255ms
**Outcome**: ✓ pass

**Driver notes**:
- vehicle_details email found after 1ms

### Step 6 — Branch replies with vehicle / driver / LR — sends plant_ls per LSI

**Action**: `vehicle_details_reply`
**Duration**: 264ms
**Outcome**: ✓ pass

**New emails this step**:
```
  [T+0:00:06] → OUTBOUND plant_ls               test-plant@example.com
  [T+0:00:06] → OUTBOUND plant_ls               test-plant@example.com
```

**Driver notes**:
- handleVehicleDetailsReply success=true

### Step 7 — Wait for plant_ls outbound email(s)

**Action**: `wait_for_email`
**Email type**: `plant_ls`
**Duration**: 263ms
**Outcome**: ✓ pass

**Driver notes**:
- plant_ls email found after 0ms

### Step 8 — Plant replies with invoice PDF → ZLOAD3-B1 fires

**Action**: `plant_invoice_reply`
**Duration**: 273ms
**Outcome**: ✓ pass

**SAP transactions this step**:
```
  [T+0:00:07] ZLOAD3-B1        work=…xkmzc8 state=done    → ✓ done at [T+0:00:07]
              callback: Invoice 7682614521/85817680, Shipment status=created
```

**Driver notes**:
- Marked 2 plant_ls email(s) replied; firing checkAndSendBatchToAman
- checkAndSendBatchToAman success=true

### Step 9 — Wait for Shipment row from /processing-data callback

**Action**: `wait_for_shipment`
**Duration**: 254ms
**Outcome**: ✓ pass

**Driver notes**:
- Shipment found id=cmps75ppc003dsxmr8fk6v3pa status=created obd=85817680

### Step 10 — Operator triggers VT01N for the Shipment

**Action**: `trigger_vt01n`
**Duration**: 263ms
**Outcome**: ✓ pass

**SAP transactions this step**:
```
  [T+0:00:08] VTO1N-B          work=…5iamwd state=done    → ✓ done at [T+0:00:08]
              callback: Shipment status=shipped
```

**Driver notes**:
- Firing triggerVto1n on Shipment cmps75ppc003dsxmr8fk6v3pa

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
| LoadingSlipItem count | 2 |
| LSI with sapMaterialDoc | 2 |
| Invoice.invoiceNumber | `7682614521` |
| Invoice.obdNumber | `85817680` |
| Shipment.status | `shipped` |
| ScenarioEvent count | 7 |
| SAP transactions fired | 4 |

## Complete audit trail (chronological)

```
[T+0:00:00] classifier_decision  action=new_order
[T+0:00:00] email_received       from branch — Subject "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-178013623…" — "Release the materials you have available, skip the ones with zero stock."
[T+0:00:03] classifier_decision  branch|before_ls|release_part|-
[T+0:00:03] scenario_started     branch|before_ls|release_part|-
[T+0:00:03] step_fired           email_confirm_bundle_details
[T+0:00:03] step_completed       email_confirm_bundle_details ✓
[T+0:00:03] scenario_completed   branch|before_ls|release_part|-
```

## Complete email thread (chronological)

```
[2026-05-30T10:17:19.817Z] OUTBOUND to test-branch@example.com [type=ls_dispatch] — Subject: "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780136237631"
  Body: Dispatch Recommendation - AUTO-MOCK-NEWORDER-1780136237631 Dear Sales Team, Sales Order 3290002 I have reviewed the stock availability for Sales Order 3290002. Here is the dispatch recommendation: Material A — APJP [YE1EDWO00001APJP] : Stock is confirmed available. Proceed with 50 units from Batch A-26. Material B — PJP [YV6FRYENE0000PJP] : Stock is confirmed available. Proceed with 100 units from Batch 30-07-2025. Material C — 43P [YA4COWOCR000043P] : Currently out of stock. You may choose to wait for replenishment or ignore this material to process the rest of the order. Best regards, Sales Order Dispatch Co-ordinator

[2026-05-30T10:17:20.168Z] INBOUND from test-branch@example.com [type=ls_dispatch] — Subject: "Re: Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780136237631"
  Body: Release the materials you have available, skip the ones with zero stock.

[2026-05-30T10:17:23.528Z] OUTBOUND to test-branch@example.com [type=dispatch_confirmation] — Subject: "Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780136237631"
  Body: Dear Branch Team, Dispatch plan ready for Purchase Order AUTO-MOCK-NEWORDER-1780136237631 (Chain release_part). Total 4.040 t — fits in 1 vehicle (capacity 45 t). Proposed dispatch (grouped by bundle): Bundle 1 — 4.040 t (of 45 t capacity): - SO 3290002 / YE1EDWO00001APJP (Batch A-26): 50 units, 1.320 t - SO 3290002 / YV6FRYENE0000PJP (Batch 30-07-2025): 100 units, 2.720 t Please reply with: - "yes" / "confirm" to proceed with the above plan, or - the changes you want (e.g. "skip OOWJ on SO 1234567", "send only 15 of OP7WJ"). Once confirmed we will create the loading slips. Best regards, Sales Order Dispatch Co-ordinator

[2026-05-30T10:17:24.079Z] INBOUND from test-branch@example.com [type=dispatch_confirmation] — Subject: "Re: Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780136237631"
  Body: Yes, please proceed with the dispatch plan as confirmed. Go ahead.

[2026-05-30T10:17:24.320Z] OUTBOUND to test-branch@example.com [type=vehicle_details] — Subject: "Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780136237631 (1 bundle)"
  Body: Dear Branch Team, Loading slips for Purchase Order AUTO-MOCK-NEWORDER-1780136237631 are now ready in SAP. The PO is split into 1 bundle: Bundle 1 (~4.04 t): - SO 3290002 / LS 373285 / Material PENDING - SO 3290002 / LS 373286 / Material PENDING Please reply with vehicle/transport details for each bundle in the format below: Bundle 1: , , Best regards, Sales Order Dispatch Co-ordinator

[2026-05-30T10:17:24.595Z] INBOUND from test-branch@example.com [type=vehicle_details] — Subject: "Re: Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780136237631 (1 bundle)"
  Body: Vehicle GJ12-XY1234, driver mobile 9876543210, container CONT-TEST-001, LR LR-9988 dated 2026-05-30.

[2026-05-30T10:17:25.120Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373285 - SO 3290002"
  Body: Plant invoice attached. Invoice 7682614520, OBD 85817679.

[2026-05-30T10:17:25.123Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373286 - SO 3290002"
  Body: Plant invoice attached. Invoice 7682614520, OBD 85817679.
```

## Verifications

- ✓ SO.status === `completed` (actual: `completed`)
- ✓ LSI count ≥ 2 (actual: 2)
- ✓ Invoice number present (actual: `7682614521`)
- ✓ Shipment row exists (actual status: `shipped`)
- ✓ SAP transactions ≥ 4 (actual: 4)
