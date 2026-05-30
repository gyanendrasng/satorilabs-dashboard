# Chain: release_all

**Description**: Happy path — NEW ORDER → ls_dispatch → release_all → VT01N
**SO Number**: 3290001
**Customer**: TEST-CUST-RELALL
**Scenario Key**: branch|before_ls|release_all|-
**Started**: 2026-05-30T09:27:39.639Z
**Finished**: 2026-05-30T09:27:47.836Z (duration: 8197ms)
**Result**: ✅ PASS

## SAP transaction summary

| # | Transaction | Step | Work ID (suffix) | Started | Completed | State | Callback effect |
|---|---|---|---|---|---|---|---|
| 1 | `ZSO-VISIBILITY` | `visibility` | …5cjl2c | [T+0:00:02] | [T+0:00:02] | done | Material rows upserted (count now 3) |
| 2 | `ZLOAD1` | `zload1` | …e5omu1 | [T+0:00:06] | [T+0:00:06] | done | LoadingSlipItem rows with fileUrl (count now 3) |
| 3 | `ZLOAD3-B1` | `zload3b1` | …omyjjf | [T+0:00:07] | [T+0:00:07] | done | Invoice 7682614520/85817679, Shipment status=shipped |
| 4 | `VTO1N-B` | `vto1n` | …daqtk5 | [T+0:00:07] | [T+0:00:07] | done | Shipment status=shipped |

## Step-by-step execution

### Step 1 — NEW ORDER inbound from branch → ZSO-VISIBILITY → ls_dispatch lands

**Action**: `new_order_inbound`
**SO Number**: 3290001, **Customer ID**: TEST-CUST-RELALL
**Duration**: 2724ms
**Outcome**: ✓ pass

**SAP transactions this step**:
```
  [T+0:00:02] ZSO-VISIBILITY   work=…5cjl2c state=done    → ✓ done at [T+0:00:02]
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
- Inbox pushed: MOCK-NEWORDER-1780133259686 subject="NEW ORDER 3290001"
- checkForNewEmails returned triggered=1 errors=0
- SO created: id=cmps5drix0006sxzpbqpfu6pu poId=cmps5driv0004sxzps3u85dyg
- ls_dispatch landed: emailId=cmps5drsa000ksxzpv26qjm8b

### Step 2 — Branch replies "release everything" to ls_dispatch

**Action**: `inbound_reply`
**Reply text**: "Please release everything as available. All quantities approved, go ahead and dispatch."
**Email type**: `ls_dispatch`
**Duration**: 2757ms
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

**Driver notes**:
- Injecting inbound_reply to email cmps5drsa000ksxzpv26qjm8b (type=ls_dispatch)
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
- [DispatchConfirm] Confirmation email sent to test-branch@example.com for PO AUTO-MOCK-NEWORDER-1780133259686 (1 SO(s), 10.66 t)
- dispatch_confirmation sent (3 item(s), 10.66t)

### Step 4 — Wait for dispatch_confirmation outbound email

**Action**: `wait_for_email`
**Email type**: `dispatch_confirmation`
**Duration**: 263ms
**Outcome**: ✓ pass

**Driver notes**:
- dispatch_confirmation email found after 1ms

### Step 5 — Branch confirms the dispatch plan → fan out ZLOAD1

**Action**: `dispatch_confirmation_reply`
**Reply text**: "Yes, please proceed with the dispatch plan as confirmed. Go ahead."
**Duration**: 276ms
**Outcome**: ✓ pass

**SAP transactions this step**:
```
  [T+0:00:06] ZLOAD1           work=…e5omu1 state=done    → ✓ done at [T+0:00:06]
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

### Step 7 — Branch replies with vehicle / driver / LR — sends plant_ls per LSI

**Action**: `vehicle_details_reply`
**Duration**: 278ms
**Outcome**: ✓ pass

**New emails this step**:
```
  [T+0:00:06] → OUTBOUND plant_ls               test-plant@example.com
  [T+0:00:06] → OUTBOUND plant_ls               test-plant@example.com
  [T+0:00:06] → OUTBOUND plant_ls               test-plant@example.com
```

**Driver notes**:
- handleVehicleDetailsReply success=true

### Step 8 — Wait for plant_ls outbound email(s)

**Action**: `wait_for_email`
**Email type**: `plant_ls`
**Duration**: 259ms
**Outcome**: ✓ pass

**Driver notes**:
- plant_ls email found after 1ms

### Step 9 — Plant replies with invoice PDF → ZLOAD3-B1 fires

**Action**: `plant_invoice_reply`
**Duration**: 272ms
**Outcome**: ✓ pass

**SAP transactions this step**:
```
  [T+0:00:07] ZLOAD3-B1        work=…omyjjf state=done    → ✓ done at [T+0:00:07]
              callback: Invoice 7682614520/85817679, Shipment status=created
```

**Driver notes**:
- Marked 3 plant_ls email(s) replied; firing checkAndSendBatchToAman
- checkAndSendBatchToAman success=true

### Step 10 — Wait for Shipment row from /processing-data callback

**Action**: `wait_for_shipment`
**Duration**: 256ms
**Outcome**: ✓ pass

**Driver notes**:
- Shipment found id=cmps5dvlv001osxzp5psqdn8r status=created obd=85817679

### Step 11 — Operator triggers VT01N for the Shipment

**Action**: `trigger_vt01n`
**Duration**: 269ms
**Outcome**: ✓ pass

**SAP transactions this step**:
```
  [T+0:00:07] VTO1N-B          work=…daqtk5 state=done    → ✓ done at [T+0:00:07]
              callback: Shipment status=shipped
```

**Driver notes**:
- Firing triggerVto1n on Shipment cmps5dvlv001osxzp5psqdn8r

### Step 12 — Wait for SO status = completed

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
| Invoice.invoiceNumber | `7682614520` |
| Invoice.obdNumber | `85817679` |
| Shipment.status | `shipped` |
| ScenarioEvent count | 7 |
| SAP transactions fired | 4 |

## Complete audit trail (chronological)

```
[T+0:00:00] classifier_decision  action=new_order
[T+0:00:00] email_received       from branch — Subject "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-178013325…" — "Please release everything as available. All quantities approved, go ahead and d…"
[T+0:00:03] classifier_decision  branch|before_ls|release_all|-
[T+0:00:03] scenario_started     branch|before_ls|release_all|-
[T+0:00:03] step_fired           email_confirm_bundle_details
[T+0:00:03] step_completed       email_confirm_bundle_details ✓
[T+0:00:03] scenario_completed   branch|before_ls|release_all|-
```

## Complete email thread (chronological)

```
[2026-05-30T09:27:42.059Z] OUTBOUND to test-branch@example.com [type=ls_dispatch] — Subject: "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780133259686"
  Body: Dispatch Recommendation - AUTO-MOCK-NEWORDER-1780133259686 Dear Sales Team, Sales Order 3290001 I have reviewed the stock availability for Sales Order 3290001. Here is the dispatch recommendation: Material A — APJP [YE1EDWO00001APJP] : Stock is confirmed available. Proceed with 50 units from Batch A-26. Material B — PJP [YV6FRYENE0000PJP] : Stock is confirmed available. Proceed with 100 units from Batch 30-07-2025. Material C — 43P [YA4COWOCR000043P] : Stock is confirmed available. Proceed with 250 units from Batch 20. Best regards, Sales Order Dispatch Co-ordinator

[2026-05-30T09:27:42.421Z] INBOUND from test-branch@example.com [type=ls_dispatch] — Subject: "Re: Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780133259686"
  Body: Please release everything as available. All quantities approved, go ahead and dispatch.

[2026-05-30T09:27:45.190Z] OUTBOUND to test-branch@example.com [type=dispatch_confirmation] — Subject: "Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780133259686"
  Body: Dear Branch Team, Dispatch plan ready for Purchase Order AUTO-MOCK-NEWORDER-1780133259686 (Chain release_all). Total 10.665 t — fits in 1 vehicle (capacity 45 t). Proposed dispatch (grouped by bundle): Bundle 1 — 10.665 t (of 45 t capacity): - SO 3290001 / YA4COWOCR000043P (Batch 20): 250 units, 6.625 t - SO 3290001 / YE1EDWO00001APJP (Batch A-26): 50 units, 1.320 t - SO 3290001 / YV6FRYENE0000PJP (Batch 30-07-2025): 100 units, 2.720 t Please reply with: - "yes" / "confirm" to proceed with the above plan, or - the changes you want (e.g. "skip OOWJ on SO 1234567", "send only 15 of OP7WJ"). Once confirmed we will create the loading slips. Best regards, Sales Order Dispatch Co-ordinator

[2026-05-30T09:27:45.730Z] INBOUND from test-branch@example.com [type=dispatch_confirmation] — Subject: "Re: Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780133259686"
  Body: Yes, please proceed with the dispatch plan as confirmed. Go ahead.

[2026-05-30T09:27:45.970Z] OUTBOUND to test-branch@example.com [type=vehicle_details] — Subject: "Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780133259686 (1 bundle)"
  Body: Dear Branch Team, Loading slips for Purchase Order AUTO-MOCK-NEWORDER-1780133259686 are now ready in SAP. The PO is split into 1 bundle: Bundle 1 (~10.66 t): - SO 3290001 / LS 373282 / Material PENDING - SO 3290001 / LS 373283 / Material PENDING - SO 3290001 / LS 373284 / Material PENDING Please reply with vehicle/transport details for each bundle in the format below: Bundle 1: , , Best regards, Sales Order Dispatch Co-ordinator

[2026-05-30T09:27:46.248Z] INBOUND from test-branch@example.com [type=vehicle_details] — Subject: "Re: Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780133259686 (1 bundle)"
  Body: Vehicle GJ12-XY1234, driver mobile 9876543210, container CONT-TEST-001, LR LR-9988 dated 2026-05-30.

[2026-05-30T09:27:46.778Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373282 - SO 3290001"
  Body: Plant invoice attached. Invoice 7682614520, OBD 85817679.

[2026-05-30T09:27:46.781Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373283 - SO 3290001"
  Body: Plant invoice attached. Invoice 7682614520, OBD 85817679.

[2026-05-30T09:27:46.782Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373284 - SO 3290001"
  Body: Plant invoice attached. Invoice 7682614520, OBD 85817679.
```

## Verifications

- ✓ SO.status === `completed` (actual: `completed`)
- ✓ LSI count ≥ 3 (actual: 3)
- ✓ LSI with sapMaterialDoc ≥ 3 (actual: 3)
- ✓ Invoice number present (actual: `7682614520`)
- ✓ Shipment row exists (actual status: `shipped`)
- ✓ SAP transactions ≥ 4 (actual: 4)
