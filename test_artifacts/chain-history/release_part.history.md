# Chain: release_part

**Description**: Partial release — branch skips zero-stock material; downstream identical to release_all but fewer LSIs
**SO Number**: 3280002
**Seed Stage**: before_ls
**Scenario Key**: branch|before_ls|release_part|-
**Started**: 2026-05-30T08:02:41.961Z
**Finished**: 2026-05-30T08:02:48.452Z (duration: 6491ms)
**Result**: ✅ PASS

## Step-by-step execution

### Step 1 — Branch replies "release_part" — skip the zero-stock material

**Action**: `inbound_reply`
**Reply text**: "Release the materials you have available, skip the ones with zero stock."
**Email type**: `ls_dispatch`
**Duration**: 3661ms
**Outcome**: ✓ pass

**New scenario events**:
```
  [T+0:00:00] email_received         from branch (ls_dispatch)
  [T+0:00:03] classifier_decision    branch|before_ls|release_part|-
  [T+0:00:03] scenario_started       branch|before_ls|release_part|-
  [T+0:00:03] step_fired             email_confirm_bundle_details
  [T+0:00:03] step_completed         email_confirm_bundle_details ✓
  [T+0:00:03] scenario_completed     branch|before_ls|release_part|-
```

**Driver notes**:
- Injecting inbound_reply to email cmps2cgjg001ysxyjjoy70nw5 (type=ls_dispatch)
- handleReplyV2 returned matched=true

### Step 2 — (driver fills engine gap) Synthesise dispatch_confirmation email

**Action**: `synthesise_dispatch_confirmation`
**Note**: synthesised by driver — fills a known engine gap
(engine `email_confirm_bundle_details` step is a no-op stub)
**Duration**: 226ms
**Outcome**: ✓ pass

**New emails this step**:
```
  [T+0:00:03] → OUTBOUND dispatch_confirmation  test-branch@example.com
```

**Driver notes**:
- SYNTHESISED — production engine gap (email_confirm_bundle_details handler is a no-op)
- [DispatchConfirm] Pre-email bundling: 1 bundle(s), total 6.140 t / 45 t per truck
- [DispatchConfirm] Confirmation email sent to test-branch@example.com for PO PO-1780128161975 (1 SO(s), 6.14 t)
- sendDispatchConfirmationEmail completed (3 item(s), 6.14t)

### Step 3 — Wait for dispatch_confirmation outbound email

**Action**: `wait_for_email`
**Email type**: `dispatch_confirmation`
**Duration**: 208ms
**Outcome**: ✓ pass

**Driver notes**:
- found dispatch_confirmation email after 2ms

### Step 4 — Branch confirms dispatch plan — should fan-out ZLOAD1

**Action**: `dispatch_confirmation_reply`
**Reply text**: "Yes, please proceed with the dispatch plan as confirmed. Go ahead."
**Duration**: 232ms
**Outcome**: ✓ pass

**Driver notes**:
- Injecting dispatch_confirmation reply on email cmps2cjds002jsxyjn14i5wyj
- handleDispatchConfirmation returned success=true

### Step 5 — Wait for ZLOAD1 to complete → vehicle_details email lands

**Action**: `wait_for_email`
**Email type**: `vehicle_details`
**Duration**: 415ms
**Outcome**: ✓ pass

**New emails this step**:
```
  [T+0:00:04] → OUTBOUND vehicle_details        test-branch@example.com
```

**Driver notes**:
- found vehicle_details email after 206ms

### Step 6 — Branch replies with vehicle/driver/LR — should send plant_ls

**Action**: `vehicle_details_reply`
**Duration**: 233ms
**Outcome**: ✓ pass

**New emails this step**:
```
  [T+0:00:04] → OUTBOUND plant_ls               test-plant@example.com
  [T+0:00:04] → OUTBOUND plant_ls               test-plant@example.com
  [T+0:00:04] → OUTBOUND plant_ls               test-plant@example.com
```

**Driver notes**:
- Injecting vehicle_details reply on email cmps2cjx0002vsxyj548qazhp
- handleVehicleDetailsReply returned success=true

### Step 7 — Wait for plant_ls outbound email(s)

**Action**: `wait_for_email`
**Email type**: `plant_ls`
**Duration**: 214ms
**Outcome**: ✓ pass

**Driver notes**:
- found plant_ls email after 2ms

### Step 8 — Plant replies with invoice PDF — triggers ZLOAD3-B1

**Action**: `plant_invoice_reply`
**Duration**: 225ms
**Outcome**: ✓ pass

**Driver notes**:
- Marking 3 plant_ls email(s) replied with synthetic PDF
- Firing checkAndSendBatchToAman with bundleId=cmps2cjpq002lsxyj78n7fjt9
- checkAndSendBatchToAman returned success=true

### Step 9 — Wait for Invoice + Shipment rows from /processing-data callback

**Action**: `wait_for_shipment`
**Duration**: 413ms
**Outcome**: ✓ pass

**Driver notes**:
- Shipment found (id=cmps2ckq40035sxyjd1t3koa9 status=created obd=85817680) after 206ms

### Step 10 — Trigger VT01N for the Shipment (operator step in production)

**Action**: `trigger_vt01n`
**Duration**: 221ms
**Outcome**: ✓ pass

**Driver notes**:
- Firing triggerVto1n on Shipment cmps2ckq40035sxyjd1t3koa9

### Step 11 — Wait for SO status = completed

**Action**: `wait_for_so_status`
**Duration**: 414ms
**Outcome**: ✓ pass

**Driver notes**:
- SO.status=completed after 205ms

## Final DB state

| Field | Value |
|---|---|
| SO.status | `completed` |
| ScenarioProgress.state | `completed` |
| LoadingSlipItem count | 3 |
| LSI with sapMaterialDoc | 3 |
| Invoice.invoiceNumber | `7682614521` |
| Invoice.obdNumber | `85817680` |
| Shipment.status | `shipped` |
| ScenarioEvent count | 6 |

## Complete audit trail (chronological)

```
[T+0:00:00] email_received       from branch — Subject "Trigger ls_dispatch" — "Release the materials you have available, skip the ones with zero stock."
[T+0:00:03] classifier_decision  branch|before_ls|release_part|-
[T+0:00:03] scenario_started     branch|before_ls|release_part|-
[T+0:00:03] step_fired           email_confirm_bundle_details
[T+0:00:03] step_completed       email_confirm_bundle_details ✓
[T+0:00:03] scenario_completed   branch|before_ls|release_part|-
```

## Complete email thread (chronological)

```
[2026-05-30T08:02:41.981Z] OUTBOUND to test-branch@example.com [type=ls_dispatch] — Subject: "Trigger ls_dispatch"
  Body: Original ls_dispatch for SO 3280002

[2026-05-30T08:02:41.988Z] INBOUND from test-branch@example.com [type=ls_dispatch] — Subject: "Re: Trigger ls_dispatch"
  Body: Release the materials you have available, skip the ones with zero stock.

[2026-05-30T08:02:45.665Z] OUTBOUND to test-branch@example.com [type=dispatch_confirmation] — Subject: "Dispatch Confirmation - PO PO-1780128161975"
  Body: Dear Branch Team, Dispatch plan ready for Purchase Order PO-1780128161975 (Test). Total 6.140 t — fits in 1 vehicle (capacity 45 t). Proposed dispatch (grouped by bundle): Bundle 1 — 6.140 t (of 45 t capacity): - SO 3280002 / YE1EDWO00001APJP (Batch A-26): 50 units, 1.320 t - SO 3280002 / YODOVMEHL0000ZZP (Batch N/A): 200 units, 2.100 t - SO 3280002 / YV6FRYENE0000PJP (Batch 30-07-2025): 100 units, 2.720 t Please reply with: - "yes" / "confirm" to proceed with the above plan, or - the changes you want (e.g. "skip OOWJ on SO 1234567", "send only 15 of OP7WJ"). Once confirmed we will create the loading slips. Best regards, Sales Order Dispatch Co-ordinator

[2026-05-30T08:02:46.104Z] INBOUND from test-branch@example.com [type=dispatch_confirmation] — Subject: "Re: Dispatch Confirmation - PO PO-1780128161975"
  Body: Yes, please proceed with the dispatch plan as confirmed. Go ahead.

[2026-05-30T08:02:46.357Z] OUTBOUND to test-branch@example.com [type=vehicle_details] — Subject: "Vehicle Details Required - PO PO-1780128161975 (1 bundle)"
  Body: Dear Branch Team, Loading slips for Purchase Order PO-1780128161975 are now ready in SAP. The PO is split into 1 bundle: Bundle 1 (~6.14 t): - SO 3280002 / LS 373285 / Material PENDING - SO 3280002 / LS 373286 / Material PENDING - SO 3280002 / LS 373287 / Material PENDING Please reply with vehicle/transport details for each bundle in the format below: Bundle 1: , , Best regards, Sales Order Dispatch Co-ordinator

[2026-05-30T08:02:46.743Z] INBOUND from test-branch@example.com [type=vehicle_details] — Subject: "Re: Vehicle Details Required - PO PO-1780128161975 (1 bundle)"
  Body: Vehicle GJ12-XY1234, driver mobile 9876543210, container CONT-TEST-001, LR LR-9988 dated 2026-05-30.

[2026-05-30T08:02:47.179Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373285 - SO 3280002"
  Body: Plant invoice attached. Invoice 7682614520, OBD 85817679.

[2026-05-30T08:02:47.183Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373286 - SO 3280002"
  Body: Plant invoice attached. Invoice 7682614520, OBD 85817679.

[2026-05-30T08:02:47.184Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373287 - SO 3280002"
  Body: Plant invoice attached. Invoice 7682614520, OBD 85817679.
```

## Verifications

- ✓ SO.status === `completed` (actual: `completed`)
- ✓ LSI count ≥ 2 (actual: 3)
- ✓ Invoice number present (actual: `7682614521`)
- ✓ Shipment row exists (actual status: `shipped`)
