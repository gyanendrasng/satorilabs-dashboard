# Chain: modify_before_ls_increase

**Description**: Pre-LS modify path — branch increases qty, confirms revised plan, then standard tail
**SO Number**: 3280003
**Seed Stage**: before_ls
**Scenario Key**: branch|before_ls|modify|increase
**Started**: 2026-05-30T08:02:48.455Z
**Finished**: 2026-05-30T08:02:57.024Z (duration: 8569ms)
**Result**: ✅ PASS

## Step-by-step execution

### Step 1 — Branch asks to increase M-A from 50 → 80 (pre-LS modify scenario)

**Action**: `inbound_reply`
**Reply text**: "Please increase material YE1EDWO00001APJP from 50 to 80 units."
**Email type**: `ls_dispatch`
**Duration**: 3424ms
**Outcome**: ✓ pass

**New scenario events**:
```
  [T+0:00:00] email_received         from branch (ls_dispatch)
  [T+0:00:03] classifier_decision    branch|before_ls|modify|increase
  [T+0:00:03] scenario_started       branch|before_ls|modify|increase
  [T+0:00:03] step_fired             stock_precheck
  [T+0:00:03] step_completed         stock_precheck ✓
  [T+0:00:03] step_fired             va02
```

**Driver notes**:
- Injecting inbound_reply to email cmps2cljs003lsxyjdg26i9qj (type=ls_dispatch)
- handleReplyV2 returned matched=true

### Step 2 — Wait for 2nd_release email (engine asks branch to confirm new plan)

**Action**: `wait_for_email`
**Email type**: `2nd_release`
**Duration**: 413ms
**Outcome**: ✓ pass

**New scenario events**:
```
  [T+0:00:03] step_completed         va02 ✓
  [T+0:00:03] step_fired             email_2nd_release
  [T+0:00:03] email_sent             2nd_release to test-branch@example.com
  [T+0:00:03] step_completed         email_2nd_release ✓
  [T+0:00:03] scenario_completed     branch|before_ls|modify|increase
```

**New emails this step**:
```
  [T+0:00:03] → OUTBOUND 2nd_release            test-branch@example.com
```

**Driver notes**:
- found 2nd_release email after 205ms

### Step 3 — Branch confirms the revised release plan → triggers dispatch path

**Action**: `inbound_reply`
**Reply text**: "Yes, the revised release plan is acceptable. Please proceed with the updated quantities."
**Email type**: `2nd_release`
**Duration**: 1932ms
**Outcome**: ✓ pass

**New scenario events**:
```
  [T+0:00:03] email_received         from branch (2nd_release)
  [T+0:00:05] classifier_decision    action=2nd_release_decision
```

**Driver notes**:
- Injecting inbound_reply to email cmps2co7g004asxyj72hxepav (type=2nd_release)
- handleReplyV2 returned matched=true

### Step 4 — (driver fills engine gap) Synthesise dispatch_confirmation email after modify→confirm path

**Action**: `synthesise_dispatch_confirmation`
**Note**: synthesised by driver — fills a known engine gap
(engine `email_confirm_bundle_details` step is a no-op stub)
**Duration**: 237ms
**Outcome**: ✓ pass

**New emails this step**:
```
  [T+0:00:05] → OUTBOUND dispatch_confirmation  test-branch@example.com
```

**Driver notes**:
- SYNTHESISED — production engine gap (email_confirm_bundle_details handler is a no-op)
- [DispatchConfirm] Pre-email bundling: 1 bundle(s), total 10.665 t / 45 t per truck
- [DispatchConfirm] Confirmation email sent to test-branch@example.com for PO PO-1780128168468 (1 SO(s), 10.66 t)
- sendDispatchConfirmationEmail completed (3 item(s), 10.66t)

### Step 5 — Wait for dispatch_confirmation outbound email

**Action**: `wait_for_email`
**Email type**: `dispatch_confirmation`
**Duration**: 209ms
**Outcome**: ✓ pass

**Driver notes**:
- found dispatch_confirmation email after 1ms

### Step 6 — Branch confirms dispatch plan — should fan-out ZLOAD1

**Action**: `dispatch_confirmation_reply`
**Reply text**: "Yes, please proceed with the dispatch plan as confirmed. Go ahead."
**Duration**: 230ms
**Outcome**: ✓ pass

**Driver notes**:
- Injecting dispatch_confirmation reply on email cmps2cq0m004osxyjbdw0mhh8
- handleDispatchConfirmation returned success=true

### Step 7 — Wait for ZLOAD1 to complete → vehicle_details email lands

**Action**: `wait_for_email`
**Email type**: `vehicle_details`
**Duration**: 410ms
**Outcome**: ✓ pass

**New emails this step**:
```
  [T+0:00:06] → OUTBOUND vehicle_details        test-branch@example.com
```

**Driver notes**:
- found vehicle_details email after 205ms

### Step 8 — Branch replies with vehicle/driver/LR — should send plant_ls

**Action**: `vehicle_details_reply`
**Duration**: 225ms
**Outcome**: ✓ pass

**New emails this step**:
```
  [T+0:00:06] → OUTBOUND plant_ls               test-plant@example.com
  [T+0:00:06] → OUTBOUND plant_ls               test-plant@example.com
  [T+0:00:06] → OUTBOUND plant_ls               test-plant@example.com
```

**Driver notes**:
- Injecting vehicle_details reply on email cmps2cqjo0050sxyjwg8rk6i1
- handleVehicleDetailsReply returned success=true

### Step 9 — Wait for plant_ls outbound email(s)

**Action**: `wait_for_email`
**Email type**: `plant_ls`
**Duration**: 210ms
**Outcome**: ✓ pass

**Driver notes**:
- found plant_ls email after 1ms

### Step 10 — Plant replies with invoice PDF — triggers ZLOAD3-B1

**Action**: `plant_invoice_reply`
**Duration**: 218ms
**Outcome**: ✓ pass

**Driver notes**:
- Marking 3 plant_ls email(s) replied with synthetic PDF
- Firing checkAndSendBatchToAman with bundleId=cmps2cqcw004qsxyjmvtf65us
- checkAndSendBatchToAman returned success=true

### Step 11 — Wait for Invoice + Shipment rows from /processing-data callback

**Action**: `wait_for_shipment`
**Duration**: 413ms
**Outcome**: ✓ pass

**Driver notes**:
- Shipment found (id=cmps2crch005asxyjz14dqior status=created obd=85817681) after 204ms

### Step 12 — Trigger VT01N for the Shipment (operator step in production)

**Action**: `trigger_vt01n`
**Duration**: 217ms
**Outcome**: ✓ pass

**Driver notes**:
- Firing triggerVto1n on Shipment cmps2crch005asxyjz14dqior

### Step 13 — Wait for SO status = completed

**Action**: `wait_for_so_status`
**Duration**: 409ms
**Outcome**: ✓ pass

**Driver notes**:
- SO.status=completed after 203ms

## Final DB state

| Field | Value |
|---|---|
| SO.status | `completed` |
| ScenarioProgress.state | `completed` |
| LoadingSlipItem count | 3 |
| LSI with sapMaterialDoc | 3 |
| Invoice.invoiceNumber | `7682614522` |
| Invoice.obdNumber | `85817681` |
| Shipment.status | `shipped` |
| ScenarioEvent count | 13 |

## Complete audit trail (chronological)

```
[T+0:00:00] email_received       from branch — Subject "Trigger ls_dispatch" — "Please increase material YE1EDWO00001APJP from 50 to 80 units."
[T+0:00:03] classifier_decision  branch|before_ls|modify|increase
[T+0:00:03] scenario_started     branch|before_ls|modify|increase
[T+0:00:03] step_fired           stock_precheck
[T+0:00:03] step_completed       stock_precheck ✓
[T+0:00:03] step_fired           va02
[T+0:00:03] step_completed       va02 ✓ — materials YE1EDWO00001APJP=50, YV6FRYENE0000PJP=100, YA4COWOCR000043P=250
[T+0:00:03] step_fired           email_2nd_release
[T+0:00:03] email_sent           2nd_release to test-branch@example.com — "2nd Release Confirmation - SO 3280003"
[T+0:00:03] step_completed       email_2nd_release ✓
[T+0:00:03] scenario_completed   branch|before_ls|modify|increase
[T+0:00:03] email_received       from branch — Subject "2nd Release Confirmation - SO 3280003" — "Yes, the revised release plan is acceptable. Please proceed with the updated qu…"
[T+0:00:05] classifier_decision  action=2nd_release_decision
```

## Complete email thread (chronological)

```
[2026-05-30T08:02:48.473Z] OUTBOUND to test-branch@example.com [type=ls_dispatch] — Subject: "Trigger ls_dispatch"
  Body: Original ls_dispatch for SO 3280003

[2026-05-30T08:02:48.479Z] INBOUND from test-branch@example.com [type=ls_dispatch] — Subject: "Re: Trigger ls_dispatch"
  Body: Please increase material YE1EDWO00001APJP from 50 to 80 units.

[2026-05-30T08:02:51.916Z] OUTBOUND to test-branch@example.com [type=2nd_release] — Subject: "2nd Release Confirmation - SO 3280003"
  Body: Hi, We have updated SO 3280003 with the following changes: - Increase YE1EDWO00001APJP → 80 Please confirm we should proceed with the revised plan (reply "yes" to confirm). Thanks.

[2026-05-30T08:02:54.036Z] INBOUND from test-branch@example.com [type=2nd_release] — Subject: "Re: 2nd Release Confirmation - SO 3280003"
  Body: Yes, the revised release plan is acceptable. Please proceed with the updated quantities.

[2026-05-30T08:02:54.262Z] OUTBOUND to test-branch@example.com [type=dispatch_confirmation] — Subject: "Dispatch Confirmation - PO PO-1780128168468"
  Body: Dear Branch Team, Dispatch plan ready for Purchase Order PO-1780128168468 (Test). Total 10.665 t — fits in 1 vehicle (capacity 45 t). Proposed dispatch (grouped by bundle): Bundle 1 — 10.665 t (of 45 t capacity): - SO 3280003 / YA4COWOCR000043P (Batch 20): 250 units, 6.625 t - SO 3280003 / YE1EDWO00001APJP (Batch A-26): 50 units, 1.320 t - SO 3280003 / YV6FRYENE0000PJP (Batch 30-07-2025): 100 units, 2.720 t Please reply with: - "yes" / "confirm" to proceed with the above plan, or - the changes you want (e.g. "skip OOWJ on SO 1234567", "send only 15 of OP7WJ"). Once confirmed we will create the loading slips. Best regards, Sales Order Dispatch Co-ordinator

[2026-05-30T08:02:54.715Z] INBOUND from test-branch@example.com [type=dispatch_confirmation] — Subject: "Re: Dispatch Confirmation - PO PO-1780128168468"
  Body: Yes, please proceed with the dispatch plan as confirmed. Go ahead.

[2026-05-30T08:02:54.949Z] OUTBOUND to test-branch@example.com [type=vehicle_details] — Subject: "Vehicle Details Required - PO PO-1780128168468 (1 bundle)"
  Body: Dear Branch Team, Loading slips for Purchase Order PO-1780128168468 are now ready in SAP. The PO is split into 1 bundle: Bundle 1 (~10.66 t): - SO 3280003 / LS 373288 / Material PENDING - SO 3280003 / LS 373289 / Material PENDING - SO 3280003 / LS 373290 / Material PENDING Please reply with vehicle/transport details for each bundle in the format below: Bundle 1: , , Best regards, Sales Order Dispatch Co-ordinator

[2026-05-30T08:02:55.343Z] INBOUND from test-branch@example.com [type=vehicle_details] — Subject: "Re: Vehicle Details Required - PO PO-1780128168468 (1 bundle)"
  Body: Vehicle GJ12-XY1234, driver mobile 9876543210, container CONT-TEST-001, LR LR-9988 dated 2026-05-30.

[2026-05-30T08:02:55.768Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373288 - SO 3280003"
  Body: Plant invoice attached. Invoice 7682614520, OBD 85817679.

[2026-05-30T08:02:55.769Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373289 - SO 3280003"
  Body: Plant invoice attached. Invoice 7682614520, OBD 85817679.

[2026-05-30T08:02:55.770Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373290 - SO 3280003"
  Body: Plant invoice attached. Invoice 7682614520, OBD 85817679.
```

## Verifications

- ✓ SO.status === `completed` (actual: `completed`)
- ✓ LSI count ≥ 3 (actual: 3)
- ✓ LSI with sapMaterialDoc ≥ 3 (actual: 3)
- ✓ Invoice number present (actual: `7682614522`)
- ✓ Shipment row exists (actual status: `shipped`)
