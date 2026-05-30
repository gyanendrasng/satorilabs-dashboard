# Chain: plant_invoice_arrival

**Description**: Phase A NEW ORDER → release_all → ZLOAD1 → vehicle_details → plant_ls. Phase B plant replies with invoice → ZLOAD3-B1 → VT01N
**SO Number**: 3290011
**Customer**: TEST-CUST-PLANTINV
**Scenario Key**: branch|before_ls|release_all|-
**Started**: 2026-05-30T09:29:39.026Z
**Finished**: 2026-05-30T09:29:47.805Z (duration: 8779ms)
**Result**: ✅ PASS

## SAP transaction summary

| # | Transaction | Step | Work ID (suffix) | Started | Completed | State | Callback effect |
|---|---|---|---|---|---|---|---|
| 1 | `ZSO-VISIBILITY` | `visibility` | …wqva4c | [T+0:00:01] | [T+0:00:02] | done | Material rows upserted (count now 3) |
| 2 | `ZLOAD1` | `zload1` | …drosew | [T+0:00:06] | [T+0:00:06] | done | LoadingSlipItem rows with fileUrl (count now 3) |
| 3 | `ZLOAD3-B1` | `zload3b1` | …0yx08r | [T+0:00:07] | [T+0:00:07] | done | Invoice 7682614530/85817689, Shipment status=shipped |
| 4 | `VTO1N-B` | `vto1n` | …o2h32v | [T+0:00:08] | [T+0:00:08] | done | Shipment status=shipped |

## Step-by-step execution

### Step 1 — NEW ORDER inbound from branch

**Action**: `new_order_inbound`
**SO Number**: 3290011, **Customer ID**: TEST-CUST-PLANTINV
**Duration**: 2352ms
**Outcome**: ✓ pass

**SAP transactions this step**:
```
  [T+0:00:01] ZSO-VISIBILITY   work=…wqva4c state=done    → ✓ done at [T+0:00:02]
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
- Inbox pushed: MOCK-NEWORDER-1780133379043 subject="NEW ORDER 3290011"
- checkForNewEmails returned triggered=1 errors=0
- SO created: id=cmps5gbf200lmsxzp0pjk98hz poId=cmps5gbez00lksxzp45x3gutu
- ls_dispatch landed: emailId=cmps5gblj00m0sxzpa75bg9z9

### Step 2 — Branch replies release_all on ls_dispatch

**Action**: `inbound_reply`
**Reply text**: "Please release everything as available. All quantities approved, go ahead and dispatch."
**Email type**: `ls_dispatch`
**Duration**: 3733ms
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
- Injecting inbound_reply to email cmps5gblj00m0sxzpa75bg9z9 (type=ls_dispatch)
- handleReplyV2 returned matched=true

### Step 3 — (driver fills engine gap) Synthesise dispatch_confirmation email

**Action**: `synthesise_dispatch_confirmation`
**Note**: synthesised by driver — fills a known engine gap
(engine `email_confirm_bundle_details` step is a no-op stub)
**Duration**: 278ms
**Outcome**: ✓ pass

**New emails this step**:
```
  [T+0:00:06] → OUTBOUND dispatch_confirmation  test-branch@example.com
```

**Driver notes**:
- SYNTHESISED — engine email_confirm_bundle_details handler is a no-op stub
- [DispatchConfirm] Pre-email bundling: 1 bundle(s), total 10.665 t / 45 t per truck
- [DispatchConfirm] Confirmation email sent to test-branch@example.com for PO AUTO-MOCK-NEWORDER-1780133379043 (1 SO(s), 10.66 t)
- dispatch_confirmation sent (3 item(s), 10.66t)

### Step 4 — Wait for dispatch_confirmation outbound email

**Action**: `wait_for_email`
**Email type**: `dispatch_confirmation`
**Duration**: 257ms
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
  [T+0:00:06] ZLOAD1           work=…drosew state=done    → ✓ done at [T+0:00:06]
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
**Duration**: 255ms
**Outcome**: ✓ pass

**Driver notes**:
- vehicle_details email found after 0ms

### Step 7 — Branch replies with vehicle/driver/LR → sends plant_ls per LSI

**Action**: `vehicle_details_reply`
**Duration**: 277ms
**Outcome**: ✓ pass

**New emails this step**:
```
  [T+0:00:07] → OUTBOUND plant_ls               test-plant@example.com
  [T+0:00:07] → OUTBOUND plant_ls               test-plant@example.com
  [T+0:00:07] → OUTBOUND plant_ls               test-plant@example.com
```

**Driver notes**:
- handleVehicleDetailsReply success=true

### Step 8 — Wait for plant_ls outbound email(s)

**Action**: `wait_for_email`
**Email type**: `plant_ls`
**Duration**: 260ms
**Outcome**: ✓ pass

**Driver notes**:
- plant_ls email found after 1ms

### Step 9 — Plant replies with invoice PDF on plant_ls thread → ZLOAD3-B1

**Action**: `plant_invoice_reply`
**Duration**: 277ms
**Outcome**: ✓ pass

**SAP transactions this step**:
```
  [T+0:00:07] ZLOAD3-B1        work=…0yx08r state=done    → ✓ done at [T+0:00:07]
              callback: Invoice 7682614530/85817689, Shipment status=created
```

**Driver notes**:
- Marked 3 plant_ls email(s) replied; firing checkAndSendBatchToAman
- checkAndSendBatchToAman success=true

### Step 10 — Wait for Shipment row from /processing-data callback

**Action**: `wait_for_shipment`
**Duration**: 254ms
**Outcome**: ✓ pass

**Driver notes**:
- Shipment found id=cmps5gg5r00n4sxzpe7qhfk96 status=created obd=85817689

### Step 11 — Operator triggers VT01N for the Shipment

**Action**: `trigger_vt01n`
**Duration**: 277ms
**Outcome**: ✓ pass

**SAP transactions this step**:
```
  [T+0:00:08] VTO1N-B          work=…o2h32v state=done    → ✓ done at [T+0:00:08]
              callback: Shipment status=shipped
```

**Driver notes**:
- Firing triggerVto1n on Shipment cmps5gg5r00n4sxzpe7qhfk96

### Step 12 — Wait for SO status = completed

**Action**: `wait_for_so_status`
**Duration**: 260ms
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
| Invoice.invoiceNumber | `7682614530` |
| Invoice.obdNumber | `85817689` |
| Shipment.status | `shipped` |
| ScenarioEvent count | 7 |
| SAP transactions fired | 4 |

## Complete audit trail (chronological)

```
[T+0:00:00] classifier_decision  action=new_order
[T+0:00:00] email_received       from branch — Subject "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-178013337…" — "Please release everything as available. All quantities approved, go ahead and d…"
[T+0:00:04] classifier_decision  branch|before_ls|release_all|-
[T+0:00:04] scenario_started     branch|before_ls|release_all|-
[T+0:00:04] step_fired           email_confirm_bundle_details
[T+0:00:04] step_completed       email_confirm_bundle_details ✓
[T+0:00:04] scenario_completed   branch|before_ls|release_all|-
```

## Complete email thread (chronological)

```
[2026-05-30T09:29:41.048Z] OUTBOUND to test-branch@example.com [type=ls_dispatch] — Subject: "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780133379043"
  Body: Dispatch Recommendation - AUTO-MOCK-NEWORDER-1780133379043 Dear Sales Team, Sales Order 3290011 I have reviewed the stock availability for Sales Order 3290011. Here is the dispatch recommendation: Material A — APJP [YE1EDWO00001APJP] : Stock is confirmed available. Proceed with 50 units from Batch A-26. Material B — PJP [YV6FRYENE0000PJP] : Stock is confirmed available. Proceed with 100 units from Batch 30-07-2025. Material C — 43P [YA4COWOCR000043P] : Stock is confirmed available. Proceed with 250 units from Batch 20. Best regards, Sales Order Dispatch Co-ordinator

[2026-05-30T09:29:41.403Z] INBOUND from test-branch@example.com [type=ls_dispatch] — Subject: "Re: Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780133379043"
  Body: Please release everything as available. All quantities approved, go ahead and dispatch.

[2026-05-30T09:29:45.150Z] OUTBOUND to test-branch@example.com [type=dispatch_confirmation] — Subject: "Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780133379043"
  Body: Dear Branch Team, Dispatch plan ready for Purchase Order AUTO-MOCK-NEWORDER-1780133379043 (Chain plant_invoice_arrival). Total 10.665 t — fits in 1 vehicle (capacity 45 t). Proposed dispatch (grouped by bundle): Bundle 1 — 10.665 t (of 45 t capacity): - SO 3290011 / YA4COWOCR000043P (Batch 20): 250 units, 6.625 t - SO 3290011 / YE1EDWO00001APJP (Batch A-26): 50 units, 1.320 t - SO 3290011 / YV6FRYENE0000PJP (Batch 30-07-2025): 100 units, 2.720 t Please reply with: - "yes" / "confirm" to proceed with the above plan, or - the changes you want (e.g. "skip OOWJ on SO 1234567", "send only 15 of OP7WJ"). Once confirmed we will create the loading slips. Best regards, Sales Order Dispatch Co-ordinator

[2026-05-30T09:29:45.686Z] INBOUND from test-branch@example.com [type=dispatch_confirmation] — Subject: "Re: Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780133379043"
  Body: Yes, please proceed with the dispatch plan as confirmed. Go ahead.

[2026-05-30T09:29:45.936Z] OUTBOUND to test-branch@example.com [type=vehicle_details] — Subject: "Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780133379043 (1 bundle)"
  Body: Dear Branch Team, Loading slips for Purchase Order AUTO-MOCK-NEWORDER-1780133379043 are now ready in SAP. The PO is split into 1 bundle: Bundle 1 (~10.66 t): - SO 3290011 / LS 373311 / Material PENDING - SO 3290011 / LS 373312 / Material PENDING - SO 3290011 / LS 373313 / Material PENDING Please reply with vehicle/transport details for each bundle in the format below: Bundle 1: , , Best regards, Sales Order Dispatch Co-ordinator

[2026-05-30T09:29:46.209Z] INBOUND from test-branch@example.com [type=vehicle_details] — Subject: "Re: Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780133379043 (1 bundle)"
  Body: Vehicle GJ12-XY1234, driver mobile 9876543210, container CONT-TEST-001, LR LR-9988 dated 2026-05-30.

[2026-05-30T09:29:46.735Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373311 - SO 3290011"
  Body: Plant invoice attached. Invoice 7682614520, OBD 85817679.

[2026-05-30T09:29:46.738Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373312 - SO 3290011"
  Body: Plant invoice attached. Invoice 7682614520, OBD 85817679.

[2026-05-30T09:29:46.740Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373313 - SO 3290011"
  Body: Plant invoice attached. Invoice 7682614520, OBD 85817679.
```

## Verifications

- ✓ SO.status === `completed` (actual: `completed`)
- ✓ LSI count ≥ 3 (actual: 3)
- ✓ LSI with sapMaterialDoc ≥ 3 (actual: 3)
- ✓ Invoice number present (actual: `7682614530`)
- ✓ Shipment row exists (actual status: `shipped`)
- ✓ SAP transactions ≥ 4 (actual: 4)
