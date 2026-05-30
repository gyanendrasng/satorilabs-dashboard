# Chain: modify_inc_dec

**Description**: Pre-LS modify (with VA02) — NEW ORDER → ls_dispatch → modify_inc_dec reply → stock_precheck → VA02 → 2nd_release → re-visibility → release_all path → VT01N
**SO Number**: 3290006
**Customer**: TEST-CUST-MODID
**Scenario Key**: branch|before_ls|release_all|-
**Started**: 2026-05-30T10:17:53.482Z
**Finished**: 2026-05-30T10:18:07.834Z (duration: 14352ms)
**Result**: ✅ PASS

## SAP transaction summary

| # | Transaction | Step | Work ID (suffix) | Started | Completed | State | Callback effect |
|---|---|---|---|---|---|---|---|
| 1 | `ZSO-VISIBILITY` | `visibility` | …a358r9 | [T+0:00:02] | [T+0:00:02] | done | Material rows upserted (count now 3) |
| 2 | `VA02` | `va02` | …hr63oz | [T+0:00:05] | [T+0:00:05] | done | VA02 completed (real SAP would have updated quantities; dummy returns success only) |
| 3 | `ZSO-VISIBILITY` | `visibility` | …zjsy29 | [T+0:00:07] | [T+0:00:07] | done | Material rows upserted (count now 3) |
| 4 | `ZLOAD1` | `zload1` | …zzudg1 | [T+0:00:12] | [T+0:00:12] | done | LoadingSlipItem rows with fileUrl (count now 3) |
| 5 | `ZLOAD3-B1` | `zload3b1` | …lqydl4 | [T+0:00:13] | [T+0:00:13] | done | Invoice 7682614525/85817684, Shipment status=shipped |
| 6 | `VTO1N-B` | `vto1n` | …xxpr2r | [T+0:00:13] | [T+0:00:14] | done | Shipment status=shipped |

## Step-by-step execution

### Step 1 — NEW ORDER inbound from branch

**Action**: `new_order_inbound`
**SO Number**: 3290006, **Customer ID**: TEST-CUST-MODID
**Duration**: 2781ms
**Outcome**: ✓ pass

**SAP transactions this step**:
```
  [T+0:00:02] ZSO-VISIBILITY   work=…a358r9 state=done    → ✓ done at [T+0:00:02]
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
- Inbox pushed: MOCK-NEWORDER-1780136273499 subject="NEW ORDER 3290006"
- checkForNewEmails returned triggered=1 errors=0
- SO created: id=cmps76d4u00ahsxmrs38clkpw poId=cmps76d4r00afsxmry8w80zod
- ls_dispatch landed: emailId=cmps76db300avsxmrm0i8vj4n

### Step 2 — Branch reply on ls_dispatch — modify_inc_dec

**Action**: `inbound_reply`
**Reply text**: "Increase YE1EDWO00001APJP from 50 to 80 and decrease YV6FRYENE0000PJP from 100 to 50."
**Email type**: `ls_dispatch`
**Duration**: 2840ms
**Outcome**: ✓ pass

**SAP transactions this step**:
```
  [T+0:00:05] VA02             work=…hr63oz state=done    → ✓ done at [T+0:00:05]
              callback: VA02 completed (real SAP would have updated quantities; dummy returns success only)
```

**New scenario events**:
```
  [T+0:00:02] email_received         ls_dispatch from branch
  [T+0:00:05] classifier_decision    branch|before_ls|modify|inc_dec
  [T+0:00:05] scenario_started       branch|before_ls|modify|inc_dec
  [T+0:00:05] step_fired             stock_precheck
  [T+0:00:05] step_completed         stock_precheck ✓
  [T+0:00:05] step_fired             va02
  [T+0:00:05] step_completed         va02 ✓
  [T+0:00:05] step_fired             email_2nd_release
  [T+0:00:05] email_sent             2nd_release to test-branch@example.com
  [T+0:00:05] step_completed         email_2nd_release ✓
  [T+0:00:05] scenario_completed     branch|before_ls|modify|inc_dec
```

**New emails this step**:
```
  [T+0:00:05] → OUTBOUND 2nd_release            test-branch@example.com
```

**Driver notes**:
- Injecting inbound_reply to email cmps76db300avsxmrm0i8vj4n (type=ls_dispatch)
- handleReplyV2 returned matched=true

### Step 3 — Wait for 2nd_release email (engine asks branch to confirm revised plan after VA02)

**Action**: `wait_for_email`
**Email type**: `2nd_release`
**Duration**: 258ms
**Outcome**: ✓ pass

**Driver notes**:
- 2nd_release email found after 3ms

### Step 4 — Branch confirms the revised release plan

**Action**: `inbound_reply`
**Reply text**: "Yes, the revised release plan is acceptable. Please proceed with the updated quantities."
**Email type**: `2nd_release`
**Duration**: 1689ms
**Outcome**: ✓ pass

**SAP transactions this step**:
```
  [T+0:00:07] ZSO-VISIBILITY   work=…zjsy29 state=done    → ✓ done at [T+0:00:07]
              callback: Material rows upserted (count now 3)
```

**New scenario events**:
```
  [T+0:00:05] email_received         2nd_release from branch
  [T+0:00:07] classifier_decision    action=2nd_release_decision
  [T+0:00:07] step_fired             zso_visibility
  [T+0:00:07] step_completed         zso_visibility ✓
  [T+0:00:07] step_fired             email_confirm_product_details
  [T+0:00:07] step_completed         email_confirm_product_details ✓
  [T+0:00:07] step_fired             email_confirm_bundle_details
  [T+0:00:07] step_completed         email_confirm_bundle_details ✓
  [T+0:00:07] scenario_completed     branch|before_ls|modify|inc_dec
```

**New emails this step**:
```
  [T+0:00:07] → OUTBOUND ls_dispatch_buffered   test-branch@example.com
  [T+0:00:07] → OUTBOUND dispatch_confirmation  test-branch@example.com
```

**Driver notes**:
- Injecting inbound_reply to email cmps76fqq00bhsxmrz7epmnmp (type=2nd_release)
- handleReplyV2 returned matched=true

### Step 5 — Wait for re-sent ls_dispatch after re-visibility (engine fires zso_visibility again)

**Action**: `wait_for_email`
**Email type**: `ls_dispatch`
**Duration**: 253ms
**Outcome**: ✓ pass

**Driver notes**:
- ls_dispatch email found after 0ms

### Step 6 — Branch confirms revised plan on re-sent ls_dispatch (release_all)

**Action**: `inbound_reply`
**Reply text**: "Please release everything as available. All quantities approved, go ahead and dispatch."
**Email type**: `ls_dispatch`
**Duration**: 4067ms
**Outcome**: ✓ pass

**New scenario events**:
```
  [T+0:00:07] email_received         ls_dispatch from branch
  [T+0:00:11] classifier_decision    branch|before_ls|release_all|-
  [T+0:00:11] scenario_started       branch|before_ls|release_all|-
  [T+0:00:11] step_fired             email_confirm_bundle_details
  [T+0:00:11] step_completed         email_confirm_bundle_details ✓
  [T+0:00:11] scenario_completed     branch|before_ls|release_all|-
```

**Driver notes**:
- Injecting inbound_reply to email cmps76db300avsxmrm0i8vj4n (type=ls_dispatch)
- handleReplyV2 returned matched=true

### Step 7 — Wait for dispatch_confirmation outbound email (sent by engine)

**Action**: `wait_for_email`
**Email type**: `dispatch_confirmation`
**Duration**: 264ms
**Outcome**: ✓ pass

**Driver notes**:
- dispatch_confirmation email found after 1ms

### Step 8 — Branch confirms the dispatch plan → fan out ZLOAD1

**Action**: `dispatch_confirmation_reply`
**Reply text**: "Yes, please proceed with the dispatch plan as confirmed. Go ahead."
**Duration**: 282ms
**Outcome**: ✓ pass

**SAP transactions this step**:
```
  [T+0:00:12] ZLOAD1           work=…zzudg1 state=firing  → (firing)
              callback: LoadingSlipItem rows with fileUrl (count now 3)
```

**Driver notes**:
- handleDispatchConfirmation success=true

### Step 9 — Wait for ZLOAD1 to complete → vehicle_details email lands

**Action**: `wait_for_email`
**Email type**: `vehicle_details`
**Duration**: 257ms
**Outcome**: ✓ pass

**New emails this step**:
```
  [T+0:00:12] → OUTBOUND vehicle_details        test-branch@example.com
```

**Driver notes**:
- vehicle_details email found after 1ms

### Step 10 — Branch replies with vehicle / driver / LR — sends plant_ls per LSI

**Action**: `vehicle_details_reply`
**Duration**: 278ms
**Outcome**: ✓ pass

**New emails this step**:
```
  [T+0:00:12] → OUTBOUND plant_ls               test-plant@example.com
  [T+0:00:12] → OUTBOUND plant_ls               test-plant@example.com
  [T+0:00:12] → OUTBOUND plant_ls               test-plant@example.com
```

**Driver notes**:
- handleVehicleDetailsReply success=true

### Step 11 — Wait for plant_ls outbound email(s)

**Action**: `wait_for_email`
**Email type**: `plant_ls`
**Duration**: 263ms
**Outcome**: ✓ pass

**Driver notes**:
- plant_ls email found after 1ms

### Step 12 — Plant replies with invoice PDF → ZLOAD3-B1 fires

**Action**: `plant_invoice_reply`
**Duration**: 274ms
**Outcome**: ✓ pass

**SAP transactions this step**:
```
  [T+0:00:13] ZLOAD3-B1        work=…lqydl4 state=done    → ✓ done at [T+0:00:13]
              callback: Invoice 7682614525/85817684, Shipment status=created
```

**Driver notes**:
- Marked 3 plant_ls email(s) replied; firing checkAndSendBatchToAman
- checkAndSendBatchToAman success=true

### Step 13 — Wait for Shipment row from /processing-data callback

**Action**: `wait_for_shipment`
**Duration**: 253ms
**Outcome**: ✓ pass

**Driver notes**:
- Shipment found id=cmps76ltj00djsxmrlsxolxju status=created obd=85817684

### Step 14 — Operator triggers VT01N for the Shipment

**Action**: `trigger_vt01n`
**Duration**: 305ms
**Outcome**: ✓ pass

**SAP transactions this step**:
```
  [T+0:00:13] VTO1N-B          work=…xxpr2r state=done    → ✓ done at [T+0:00:14]
              callback: Shipment status=shipped
```

**Driver notes**:
- Firing triggerVto1n on Shipment cmps76ltj00djsxmrlsxolxju

### Step 15 — Wait for SO status = completed

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
| Invoice.invoiceNumber | `7682614525` |
| Invoice.obdNumber | `85817684` |
| Shipment.status | `shipped` |
| ScenarioEvent count | 27 |
| SAP transactions fired | 6 |

## Complete audit trail (chronological)

```
[T+0:00:00] classifier_decision  action=new_order
[T+0:00:00] email_received       from branch — Subject "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-178013627…" — "Increase YE1EDWO00001APJP from 50 to 80 and decrease YV6FRYENE0000PJP from 100 …"
[T+0:00:03] classifier_decision  branch|before_ls|modify|inc_dec
[T+0:00:03] scenario_started     branch|before_ls|modify|inc_dec
[T+0:00:03] step_fired           stock_precheck
[T+0:00:03] step_completed       stock_precheck ✓
[T+0:00:03] step_fired           va02
[T+0:00:03] step_completed       va02 ✓ — materials YE1EDWO00001APJP=?, YV6FRYENE0000PJP=?, YA4COWOCR000043P=?
[T+0:00:03] step_fired           email_2nd_release
[T+0:00:03] email_sent           2nd_release to test-branch@example.com — "2nd Release Confirmation - SO 3290006"
[T+0:00:03] step_completed       email_2nd_release ✓
[T+0:00:03] scenario_completed   branch|before_ls|modify|inc_dec
[T+0:00:03] email_received       from branch — Subject "2nd Release Confirmation - SO 3290006" — "Yes, the revised release plan is acceptable. Please proceed with the updated qu…"
[T+0:00:05] classifier_decision  action=2nd_release_decision
[T+0:00:05] step_fired           zso_visibility
[T+0:00:05] step_completed       zso_visibility ✓ — materials YE1EDWO00001APJP=50, YV6FRYENE0000PJP=100, YA4COWOCR000043P=250
[T+0:00:05] step_fired           email_confirm_product_details
[T+0:00:05] step_completed       email_confirm_product_details ✓
[T+0:00:05] step_fired           email_confirm_bundle_details
[T+0:00:05] step_completed       email_confirm_bundle_details ✓
[T+0:00:05] scenario_completed   branch|before_ls|modify|inc_dec
[T+0:00:05] email_received       from branch — Subject "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-178013627…" — "Please release everything as available. All quantities approved, go ahead and d…"
[T+0:00:09] classifier_decision  branch|before_ls|release_all|-
[T+0:00:09] scenario_started     branch|before_ls|release_all|-
[T+0:00:09] step_fired           email_confirm_bundle_details
[T+0:00:09] step_completed       email_confirm_bundle_details ✓
[T+0:00:09] scenario_completed   branch|before_ls|release_all|-
```

## Complete email thread (chronological)

```
[2026-05-30T10:17:55.936Z] OUTBOUND to test-branch@example.com [type=ls_dispatch] — Subject: "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780136273499"
  Body: Dispatch Recommendation - AUTO-MOCK-NEWORDER-1780136273499 Dear Sales Team, Sales Order 3290006 I have reviewed the stock availability for Sales Order 3290006. Here is the dispatch recommendation: Material A — APJP [YE1EDWO00001APJP] : Stock is confirmed available. Proceed with 50 units from Batch A-26. Material B — PJP [YV6FRYENE0000PJP] : Stock is confirmed available. Proceed with 100 units from Batch 30-07-2025. Material C — 43P [YA4COWOCR000043P] : Stock is confirmed available. Proceed with 250 units from Batch 20. Best regards, Sales Order Dispatch Co-ordinator

[2026-05-30T10:17:56.285Z] INBOUND from test-branch@example.com [type=ls_dispatch] — Subject: "Re: Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780136273499"
  Body: Increase YE1EDWO00001APJP from 50 to 80 and decrease YV6FRYENE0000PJP from 100 to 50.

[2026-05-30T10:17:59.090Z] OUTBOUND to test-branch@example.com [type=2nd_release] — Subject: "2nd Release Confirmation - SO 3290006"
  Body: Hi, We have updated SO 3290006 with the following changes: - Increase YE1EDWO00001APJP → 80 - Decrease YV6FRYENE0000PJP → 50 Please confirm we should proceed with the revised plan (reply "yes" to confirm). Thanks.

[2026-05-30T10:18:00.796Z] INBOUND from test-branch@example.com [type=2nd_release] — Subject: "Re: 2nd Release Confirmation - SO 3290006"
  Body: Yes, the revised release plan is acceptable. Please proceed with the updated quantities.

[2026-05-30T10:18:01.055Z] OUTBOUND to test-branch@example.com [type=dispatch_confirmation] — Subject: "Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780136273499"
  Body: Dear Branch Team, Dispatch plan ready for Purchase Order AUTO-MOCK-NEWORDER-1780136273499 (Chain modify_inc_dec). Total 10.665 t — fits in 1 vehicle (capacity 45 t). Proposed dispatch (grouped by bundle): Bundle 1 — 10.665 t (of 45 t capacity): - SO 3290006 / YA4COWOCR000043P (Batch 20): 250 units, 6.625 t - SO 3290006 / YE1EDWO00001APJP (Batch A-26): 50 units, 1.320 t - SO 3290006 / YV6FRYENE0000PJP (Batch 30-07-2025): 100 units, 2.720 t Please reply with: - "yes" / "confirm" to proceed with the above plan, or - the changes you want (e.g. "skip OOWJ on SO 1234567", "send only 15 of OP7WJ"). Once confirmed we will create the loading slips. Best regards, Sales Order Dispatch Co-ordinator

[2026-05-30T10:18:05.677Z] INBOUND from test-branch@example.com [type=dispatch_confirmation] — Subject: "Re: Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780136273499"
  Body: Yes, please proceed with the dispatch plan as confirmed. Go ahead.

[2026-05-30T10:18:05.936Z] OUTBOUND to test-branch@example.com [type=vehicle_details] — Subject: "Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780136273499 (1 bundle)"
  Body: Dear Branch Team, Loading slips for Purchase Order AUTO-MOCK-NEWORDER-1780136273499 are now ready in SAP. The PO is split into 1 bundle: Bundle 1 (~10.66 t): - SO 3290006 / LS 373296 / Material PENDING - SO 3290006 / LS 373297 / Material PENDING - SO 3290006 / LS 373298 / Material PENDING Please reply with vehicle/transport details for each bundle in the format below: Bundle 1: , , Best regards, Sales Order Dispatch Co-ordinator

[2026-05-30T10:18:06.203Z] INBOUND from test-branch@example.com [type=vehicle_details] — Subject: "Re: Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780136273499 (1 bundle)"
  Body: Vehicle GJ12-XY1234, driver mobile 9876543210, container CONT-TEST-001, LR LR-9988 dated 2026-05-30.

[2026-05-30T10:18:06.737Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373296 - SO 3290006"
  Body: Plant invoice attached. Invoice 7682614520, OBD 85817679.

[2026-05-30T10:18:06.740Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373297 - SO 3290006"
  Body: Plant invoice attached. Invoice 7682614520, OBD 85817679.

[2026-05-30T10:18:06.742Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373298 - SO 3290006"
  Body: Plant invoice attached. Invoice 7682614520, OBD 85817679.
```

## Verifications

- ✓ SO.status === `completed` (actual: `completed`)
- ✓ LSI count ≥ 3 (actual: 3)
- ✓ Invoice number present (actual: `7682614525`)
- ✓ Shipment row exists (actual status: `shipped`)
- ✓ SAP transactions ≥ 5 (actual: 6)
