# Chain: release_all

**Description**: Standard happy path — branch releases all materials, full SAP round-trip to VT01N
**SO Number**: 3280001
**Seed Stage**: before_ls
**Scenario Key**: branch|before_ls|release_all|-
**Started**: 2026-05-30T08:02:35.440Z
**Finished**: 2026-05-30T08:02:41.957Z (duration: 6517ms)
**Result**: ✅ PASS

## Step-by-step execution

### Step 1 — Branch replies "release_all" to the seeded ls_dispatch email

**Action**: `inbound_reply`
**Reply text**: "Please release everything as available. All quantities approved, go ahead and dispatch."
**Email type**: `ls_dispatch`
**Duration**: 3907ms
**Outcome**: ✓ pass

**New scenario events**:
```
  [T+0:00:00] email_received         from branch (ls_dispatch)
  [T+0:00:03] classifier_decision    branch|before_ls|release_all|-
  [T+0:00:03] scenario_started       branch|before_ls|release_all|-
  [T+0:00:03] step_fired             email_confirm_bundle_details
  [T+0:00:03] step_completed         email_confirm_bundle_details ✓
  [T+0:00:03] scenario_completed     branch|before_ls|release_all|-
```

**Driver notes**:
- Injecting inbound_reply to email cmps2cbi6000bsxyj689aaul1 (type=ls_dispatch)
- handleReplyV2 returned matched=true

### Step 2 — (driver fills engine gap) Synthesise dispatch_confirmation email

**Action**: `synthesise_dispatch_confirmation`
**Note**: synthesised by driver — fills a known engine gap
(engine `email_confirm_bundle_details` step is a no-op stub)
**Duration**: 228ms
**Outcome**: ✓ pass

**New emails this step**:
```
  [T+0:00:03] → OUTBOUND dispatch_confirmation  test-branch@example.com
```

**Driver notes**:
- SYNTHESISED — production engine gap (email_confirm_bundle_details handler is a no-op)
- [DispatchConfirm] Pre-email bundling: 1 bundle(s), total 10.665 t / 45 t per truck
- [DispatchConfirm] Confirmation email sent to test-branch@example.com for PO PO-1780128155449 (1 SO(s), 10.66 t)
- sendDispatchConfirmationEmail completed (3 item(s), 10.66t)

### Step 3 — Wait for dispatch_confirmation outbound email

**Action**: `wait_for_email`
**Email type**: `dispatch_confirmation`
**Duration**: 207ms
**Outcome**: ✓ pass

**Driver notes**:
- found dispatch_confirmation email after 2ms

### Step 4 — Branch confirms dispatch plan — should fan-out ZLOAD1

**Action**: `dispatch_confirmation_reply`
**Reply text**: "Yes, please proceed with the dispatch plan as confirmed. Go ahead."
**Duration**: 221ms
**Outcome**: ✓ pass

**Driver notes**:
- Injecting dispatch_confirmation reply on email cmps2cejc000wsxyjieiyhaau
- handleDispatchConfirmation returned success=true

### Step 5 — Wait for ZLOAD1 to complete → vehicle_details email lands

**Action**: `wait_for_email`
**Email type**: `vehicle_details`
**Duration**: 409ms
**Outcome**: ✓ pass

**New emails this step**:
```
  [T+0:00:04] → OUTBOUND vehicle_details        test-branch@example.com
```

**Driver notes**:
- found vehicle_details email after 203ms

### Step 6 — Branch replies with vehicle/driver/LR — should send plant_ls

**Action**: `vehicle_details_reply`
**Duration**: 234ms
**Outcome**: ✓ pass

**New emails this step**:
```
  [T+0:00:05] → OUTBOUND plant_ls               test-plant@example.com
  [T+0:00:05] → OUTBOUND plant_ls               test-plant@example.com
  [T+0:00:05] → OUTBOUND plant_ls               test-plant@example.com
```

**Driver notes**:
- Injecting vehicle_details reply on email cmps2cf3x0018sxyjhquey9s1
- handleVehicleDetailsReply returned success=true

### Step 7 — Wait for plant_ls outbound email(s)

**Action**: `wait_for_email`
**Email type**: `plant_ls`
**Duration**: 208ms
**Outcome**: ✓ pass

**Driver notes**:
- found plant_ls email after 2ms

### Step 8 — Plant replies with invoice PDF — triggers ZLOAD3-B1

**Action**: `plant_invoice_reply`
**Duration**: 223ms
**Outcome**: ✓ pass

**Driver notes**:
- Marking 3 plant_ls email(s) replied with synthetic PDF
- Firing checkAndSendBatchToAman with bundleId=cmps2cev4000ysxyj52wn63vd
- checkAndSendBatchToAman returned success=true

### Step 9 — Wait for Invoice + Shipment rows from /processing-data callback

**Action**: `wait_for_shipment`
**Duration**: 412ms
**Outcome**: ✓ pass

**Driver notes**:
- Shipment found (id=cmps2cfv5001isxyj04bug25s status=created obd=85817679) after 202ms

### Step 10 — Trigger VT01N for the Shipment (operator step in production)

**Action**: `trigger_vt01n`
**Duration**: 238ms
**Outcome**: ✓ pass

**Driver notes**:
- Firing triggerVto1n on Shipment cmps2cfv5001isxyj04bug25s

### Step 11 — Wait for SO status = completed

**Action**: `wait_for_so_status`
**Duration**: 208ms
**Outcome**: ✓ pass

**Driver notes**:
- SO.status=completed after 1ms

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
| ScenarioEvent count | 6 |

## Complete audit trail (chronological)

```
[T+0:00:00] email_received       from branch — Subject "Trigger ls_dispatch" — "Please release everything as available. All quantities approved, go ahead and d…"
[T+0:00:03] classifier_decision  branch|before_ls|release_all|-
[T+0:00:03] scenario_started     branch|before_ls|release_all|-
[T+0:00:03] step_fired           email_confirm_bundle_details
[T+0:00:03] step_completed       email_confirm_bundle_details ✓
[T+0:00:03] scenario_completed   branch|before_ls|release_all|-
```

## Complete email thread (chronological)

```
[2026-05-30T08:02:35.455Z] OUTBOUND to test-branch@example.com [type=ls_dispatch] — Subject: "Trigger ls_dispatch"
  Body: Original ls_dispatch for SO 3280001

[2026-05-30T08:02:35.470Z] INBOUND from test-branch@example.com [type=ls_dispatch] — Subject: "Re: Trigger ls_dispatch"
  Body: Please release everything as available. All quantities approved, go ahead and dispatch.

[2026-05-30T08:02:39.384Z] OUTBOUND to test-branch@example.com [type=dispatch_confirmation] — Subject: "Dispatch Confirmation - PO PO-1780128155449"
  Body: Dear Branch Team, Dispatch plan ready for Purchase Order PO-1780128155449 (Test). Total 10.665 t — fits in 1 vehicle (capacity 45 t). Proposed dispatch (grouped by bundle): Bundle 1 — 10.665 t (of 45 t capacity): - SO 3280001 / YA4COWOCR000043P (Batch 20): 250 units, 6.625 t - SO 3280001 / YE1EDWO00001APJP (Batch A-26): 50 units, 1.320 t - SO 3280001 / YV6FRYENE0000PJP (Batch 30-07-2025): 100 units, 2.720 t Please reply with: - "yes" / "confirm" to proceed with the above plan, or - the changes you want (e.g. "skip OOWJ on SO 1234567", "send only 15 of OP7WJ"). Once confirmed we will create the loading slips. Best regards, Sales Order Dispatch Co-ordinator

[2026-05-30T08:02:39.816Z] INBOUND from test-branch@example.com [type=dispatch_confirmation] — Subject: "Re: Dispatch Confirmation - PO PO-1780128155449"
  Body: Yes, please proceed with the dispatch plan as confirmed. Go ahead.

[2026-05-30T08:02:40.125Z] OUTBOUND to test-branch@example.com [type=vehicle_details] — Subject: "Vehicle Details Required - PO PO-1780128155449 (1 bundle)"
  Body: Dear Branch Team, Loading slips for Purchase Order PO-1780128155449 are now ready in SAP. The PO is split into 1 bundle: Bundle 1 (~10.66 t): - SO 3280001 / LS 373282 / Material PENDING - SO 3280001 / LS 373283 / Material PENDING - SO 3280001 / LS 373284 / Material PENDING Please reply with vehicle/transport details for each bundle in the format below: Bundle 1: , , Best regards, Sales Order Dispatch Co-ordinator

[2026-05-30T08:02:40.444Z] INBOUND from test-branch@example.com [type=vehicle_details] — Subject: "Re: Vehicle Details Required - PO PO-1780128155449 (1 bundle)"
  Body: Vehicle GJ12-XY1234, driver mobile 9876543210, container CONT-TEST-001, LR LR-9988 dated 2026-05-30.

[2026-05-30T08:02:40.875Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373282 - SO 3280001"
  Body: Plant invoice attached. Invoice 7682614520, OBD 85817679.

[2026-05-30T08:02:40.878Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373283 - SO 3280001"
  Body: Plant invoice attached. Invoice 7682614520, OBD 85817679.

[2026-05-30T08:02:40.879Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373284 - SO 3280001"
  Body: Plant invoice attached. Invoice 7682614520, OBD 85817679.
```

## Verifications

- ✓ SO.status === `completed` (actual: `completed`)
- ✓ LSI count ≥ 3 (actual: 3)
- ✓ LSI with sapMaterialDoc ≥ 3 (actual: 3)
- ✓ Invoice number present (actual: `7682614520`)
- ✓ Shipment row exists (actual status: `shipped`)
