# Chain: modify_after_ls_decrease

**Description**: Post-LS modify path — branch reduces qty after LS exists; ZLOAD2 → vehicle → plant → SAP tail
**SO Number**: 3280004
**Seed Stage**: after_ls_before_invoice
**Scenario Key**: branch|after_ls_before_invoice|modify|decrease
**Started**: 2026-05-30T08:02:57.027Z
**Finished**: 2026-05-30T08:03:01.721Z (duration: 4694ms)
**Result**: ✅ PASS

## Step-by-step execution

### Step 1 — Branch asks to reduce M-A from 50 → 30 on the existing LS

**Action**: `inbound_reply`
**Reply text**: "Please reduce YE1EDWO00001APJP from 50 to 30 on the LS. No deletions, no increases."
**Email type**: `vehicle_details`
**Duration**: 2955ms
**Outcome**: ✓ pass

**New scenario events**:
```
  [T+0:00:00] email_received         from branch (vehicle_details)
  [T+0:00:02] classifier_decision    branch|after_ls_before_invoice|modify|decrease
  [T+0:00:02] scenario_started       branch|after_ls_before_invoice|modify|decrease
  [T+0:00:02] step_fired             zload2
```

**Driver notes**:
- Injecting inbound_reply to email cmps2cs60005ysxyjnlggs4ck (type=vehicle_details)
- handleReplyV2 returned matched=true

### Step 2 — Wait for new vehicle_details email (engine asks branch for vehicle after ZLOAD2)

**Action**: `wait_for_email`
**Email type**: `vehicle_details`
**Duration**: 207ms
**Outcome**: ✓ pass

**New scenario events**:
```
  [T+0:00:02] step_completed         zload2 ✓
  [T+0:00:02] step_fired             email_to_branch_for_vehicle
  [T+0:00:02] step_completed         email_to_branch_for_vehicle ✓
  [T+0:00:02] scenario_completed     branch|after_ls_before_invoice|modify|decrease
```

**Driver notes**:
- found vehicle_details email after 2ms

### Step 3 — Branch replies with vehicle/driver/LR — should send plant_ls

**Action**: `vehicle_details_reply`
**Duration**: 219ms
**Outcome**: ✓ pass

**New emails this step**:
```
  [T+0:00:03] → OUTBOUND plant_ls               test-plant@example.com
  [T+0:00:03] → OUTBOUND plant_ls               test-plant@example.com
  [T+0:00:03] → OUTBOUND plant_ls               test-plant@example.com
```

**Driver notes**:
- Injecting vehicle_details reply on email cmps2cs60005ysxyjnlggs4ck
- handleVehicleDetailsReply returned success=true

### Step 4 — Wait for plant_ls outbound email

**Action**: `wait_for_email`
**Email type**: `plant_ls`
**Duration**: 212ms
**Outcome**: ✓ pass

**Driver notes**:
- found plant_ls email after 1ms

### Step 5 — Plant replies with invoice → ZLOAD3-B1

**Action**: `plant_invoice_reply`
**Duration**: 234ms
**Outcome**: ✓ pass

**Driver notes**:
- Marking 3 plant_ls email(s) replied with synthetic PDF
- Firing checkAndSendBatchToAman with bundleId=cmps2cs5v005qsxyj4365hqlc
- checkAndSendBatchToAman returned success=true

### Step 6 — Wait for Shipment row from /processing-data callback

**Action**: `wait_for_shipment`
**Duration**: 410ms
**Outcome**: ✓ pass

**Driver notes**:
- Shipment found (id=cmps2cv4i006vsxyjj97i3rsg status=created obd=85817682) after 203ms

### Step 7 — Trigger VT01N for the Shipment

**Action**: `trigger_vt01n`
**Duration**: 218ms
**Outcome**: ✓ pass

**Driver notes**:
- Firing triggerVto1n on Shipment cmps2cv4i006vsxyjj97i3rsg

### Step 8 — Wait for SO status = completed

**Action**: `wait_for_so_status`
**Duration**: 209ms
**Outcome**: ✓ pass

**Driver notes**:
- SO.status=completed after 0ms

## Final DB state

| Field | Value |
|---|---|
| SO.status | `completed` |
| ScenarioProgress.state | `completed` |
| LoadingSlipItem count | 3 |
| LSI with sapMaterialDoc | 3 |
| Invoice.invoiceNumber | `7682614523` |
| Invoice.obdNumber | `85817682` |
| Shipment.status | `shipped` |
| ScenarioEvent count | 8 |

## Complete audit trail (chronological)

```
[T+0:00:00] email_received       from branch — Subject "Trigger vehicle_details" — "Please reduce YE1EDWO00001APJP from 50 to 30 on the LS. No deletions, no increa…"
[T+0:00:02] classifier_decision  branch|after_ls_before_invoice|modify|decrease
[T+0:00:02] scenario_started     branch|after_ls_before_invoice|modify|decrease
[T+0:00:02] step_fired           zload2
[T+0:00:02] step_completed       zload2 ✓ — LS PRE-YA4COWOCR000043P:YA4COWOCR000043P=250, PRE-YV6FRYENE0000PJP:YV6FRYENE0000PJP=100, PRE-YE1EDWO00001APJP:YE1EDWO00001APJP=50
[T+0:00:02] step_fired           email_to_branch_for_vehicle
[T+0:00:02] step_completed       email_to_branch_for_vehicle ✓
[T+0:00:02] scenario_completed   branch|after_ls_before_invoice|modify|decrease
```

## Complete email thread (chronological)

```
[2026-05-30T08:02:57.049Z] OUTBOUND to test-branch@example.com [type=vehicle_details] — Subject: "Trigger vehicle_details"
  Body: Original vehicle_details for SO 3280004

[2026-05-30T08:03:00.223Z] INBOUND from test-branch@example.com [type=vehicle_details] — Subject: "Re: Trigger vehicle_details"
  Body: Vehicle GJ12-XY1234, driver mobile 9876543210, container CONT-TEST-001, LR LR-9988 dated 2026-05-30.

[2026-05-30T08:03:00.649Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip PRE-YE1EDWO00001APJP - SO 3280004"
  Body: Plant invoice attached. Invoice 7682614520, OBD 85817679.

[2026-05-30T08:03:00.657Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip PRE-YV6FRYENE0000PJP - SO 3280004"
  Body: Plant invoice attached. Invoice 7682614520, OBD 85817679.

[2026-05-30T08:03:00.658Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip PRE-YA4COWOCR000043P - SO 3280004"
  Body: Plant invoice attached. Invoice 7682614520, OBD 85817679.
```

## Verifications

- ✓ SO.status === `completed` (actual: `completed`)
- ✓ LSI count ≥ 3 (actual: 3)
- ✓ Invoice number present (actual: `7682614523`)
- ✓ Shipment row exists (actual status: `shipped`)
