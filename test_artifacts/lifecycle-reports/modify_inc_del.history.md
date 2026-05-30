# Chain: modify_inc_del

**Description**: Pre-LS modify (with VA02) — NEW ORDER → ls_dispatch → modify_inc_del reply → stock_precheck → VA02 → 2nd_release → re-visibility → release_all path → VT01N
**SO Number**: 3290007
**Customer**: TEST-CUST-MODIDL
**Scenario Key**: branch|before_ls|release_all|-
**Started**: 2026-05-30T09:28:38.516Z
**Finished**: 2026-05-30T09:28:52.981Z (duration: 14465ms)
**Result**: ✅ PASS

## SAP transaction summary

| # | Transaction | Step | Work ID (suffix) | Started | Completed | State | Callback effect |
|---|---|---|---|---|---|---|---|
| 1 | `ZSO-VISIBILITY` | `visibility` | …hhsmhv | [T+0:00:01] | [T+0:00:01] | done | Material rows upserted (count now 3) |
| 2 | `VA02` | `va02` | …oq55ij | [T+0:00:05] | [T+0:00:05] | done | VA02 completed (real SAP would have updated quantities; dummy returns success only) |
| 3 | `ZLOAD1` | `zload1` | …3k1wul | [T+0:00:12] | [T+0:00:12] | done | LoadingSlipItem rows with fileUrl (count now 3) |
| 4 | `ZLOAD3-B1` | `zload3b1` | …z6y30s | [T+0:00:13] | [T+0:00:13] | done | Invoice 7682614526/85817685, Shipment status=shipped |
| 5 | `VTO1N-B` | `vto1n` | …y3dxiw | [T+0:00:13] | [T+0:00:14] | done | Shipment status=shipped |

## Step-by-step execution

### Step 1 — NEW ORDER inbound from branch

**Action**: `new_order_inbound`
**SO Number**: 3290007, **Customer ID**: TEST-CUST-MODIDL
**Duration**: 2288ms
**Outcome**: ✓ pass

**SAP transactions this step**:
```
  [T+0:00:01] ZSO-VISIBILITY   work=…hhsmhv state=done    → ✓ done at [T+0:00:01]
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
- Inbox pushed: MOCK-NEWORDER-1780133318544 subject="NEW ORDER 3290007"
- checkForNewEmails returned triggered=1 errors=0
- SO created: id=cmps5f0ol00cesxzpw5fgb9tg poId=cmps5f0oi00ccsxzp9h7sbwn6
- ls_dispatch landed: emailId=cmps5f0v700cssxzpuqlx0lsv

### Step 2 — Branch reply on ls_dispatch — modify_inc_del

**Action**: `inbound_reply`
**Reply text**: "Increase YE1EDWO00001APJP from 50 to 80 and delete YA4COWOCR000043P entirely from the order."
**Email type**: `ls_dispatch`
**Duration**: 3085ms
**Outcome**: ✓ pass

**SAP transactions this step**:
```
  [T+0:00:05] VA02             work=…oq55ij state=done    → ✓ done at [T+0:00:05]
              callback: VA02 completed (real SAP would have updated quantities; dummy returns success only)
```

**New scenario events**:
```
  [T+0:00:02] email_received         ls_dispatch from branch
  [T+0:00:05] classifier_decision    branch|before_ls|modify|inc_del
  [T+0:00:05] scenario_started       branch|before_ls|modify|inc_del
  [T+0:00:05] step_fired             stock_precheck
  [T+0:00:05] step_completed         stock_precheck ✓
  [T+0:00:05] step_fired             va02
  [T+0:00:05] step_completed         va02 ✓
  [T+0:00:05] step_fired             email_2nd_release
  [T+0:00:05] email_sent             2nd_release to test-branch@example.com
  [T+0:00:05] step_completed         email_2nd_release ✓
  [T+0:00:05] scenario_completed     branch|before_ls|modify|inc_del
```

**New emails this step**:
```
  [T+0:00:05] → OUTBOUND 2nd_release            test-branch@example.com
```

**Driver notes**:
- Injecting inbound_reply to email cmps5f0v700cssxzpuqlx0lsv (type=ls_dispatch)
- handleReplyV2 returned matched=true

### Step 3 — Wait for 2nd_release email (engine asks branch to confirm revised plan after VA02)

**Action**: `wait_for_email`
**Email type**: `2nd_release`
**Duration**: 257ms
**Outcome**: ✓ pass

**Driver notes**:
- 2nd_release email found after 1ms

### Step 4 — Branch confirms the revised release plan

**Action**: `inbound_reply`
**Reply text**: "Yes, the revised release plan is acceptable. Please proceed with the updated quantities."
**Email type**: `2nd_release`
**Duration**: 1889ms
**Outcome**: ✓ pass

**New scenario events**:
```
  [T+0:00:05] email_received         2nd_release from branch
  [T+0:00:07] classifier_decision    action=2nd_release_decision
```

**Driver notes**:
- Injecting inbound_reply to email cmps5f3hp00desxzpufmon6vg (type=2nd_release)
- handleReplyV2 returned matched=true

### Step 5 — Wait for re-sent ls_dispatch after re-visibility (engine fires zso_visibility again)

**Action**: `wait_for_email`
**Email type**: `ls_dispatch`
**Duration**: 262ms
**Outcome**: ✓ pass

**Driver notes**:
- ls_dispatch email found after 1ms

### Step 6 — Branch confirms revised plan on re-sent ls_dispatch (release_all)

**Action**: `inbound_reply`
**Reply text**: "Please release everything as available. All quantities approved, go ahead and dispatch."
**Email type**: `ls_dispatch`
**Duration**: 4003ms
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
- Injecting inbound_reply to email cmps5f0v700cssxzpuqlx0lsv (type=ls_dispatch)
- handleReplyV2 returned matched=true

### Step 7 — (driver fills engine gap) Synthesise dispatch_confirmation email

**Action**: `synthesise_dispatch_confirmation`
**Note**: synthesised by driver — fills a known engine gap
(engine `email_confirm_bundle_details` step is a no-op stub)
**Duration**: 277ms
**Outcome**: ✓ pass

**New emails this step**:
```
  [T+0:00:11] → OUTBOUND dispatch_confirmation  test-branch@example.com
```

**Driver notes**:
- SYNTHESISED — engine email_confirm_bundle_details handler is a no-op stub
- [DispatchConfirm] Pre-email bundling: 1 bundle(s), total 10.665 t / 45 t per truck
- [DispatchConfirm] Confirmation email sent to test-branch@example.com for PO AUTO-MOCK-NEWORDER-1780133318544 (1 SO(s), 10.66 t)
- dispatch_confirmation sent (3 item(s), 10.66t)

### Step 8 — Wait for dispatch_confirmation outbound email

**Action**: `wait_for_email`
**Email type**: `dispatch_confirmation`
**Duration**: 256ms
**Outcome**: ✓ pass

**Driver notes**:
- dispatch_confirmation email found after 1ms

### Step 9 — Branch confirms the dispatch plan → fan out ZLOAD1

**Action**: `dispatch_confirmation_reply`
**Reply text**: "Yes, please proceed with the dispatch plan as confirmed. Go ahead."
**Duration**: 269ms
**Outcome**: ✓ pass

**SAP transactions this step**:
```
  [T+0:00:12] ZLOAD1           work=…3k1wul state=done    → ✓ done at [T+0:00:12]
              callback: LoadingSlipItem rows with fileUrl (count now 3)
```

**New emails this step**:
```
  [T+0:00:12] → OUTBOUND vehicle_details        test-branch@example.com
```

**Driver notes**:
- handleDispatchConfirmation success=true

### Step 10 — Wait for ZLOAD1 to complete → vehicle_details email lands

**Action**: `wait_for_email`
**Email type**: `vehicle_details`
**Duration**: 254ms
**Outcome**: ✓ pass

**Driver notes**:
- vehicle_details email found after 1ms

### Step 11 — Branch replies with vehicle / driver / LR — sends plant_ls per LSI

**Action**: `vehicle_details_reply`
**Duration**: 276ms
**Outcome**: ✓ pass

**New emails this step**:
```
  [T+0:00:12] → OUTBOUND plant_ls               test-plant@example.com
  [T+0:00:12] → OUTBOUND plant_ls               test-plant@example.com
  [T+0:00:12] → OUTBOUND plant_ls               test-plant@example.com
```

**Driver notes**:
- handleVehicleDetailsReply success=true

### Step 12 — Wait for plant_ls outbound email(s)

**Action**: `wait_for_email`
**Email type**: `plant_ls`
**Duration**: 257ms
**Outcome**: ✓ pass

**Driver notes**:
- plant_ls email found after 1ms

### Step 13 — Plant replies with invoice PDF → ZLOAD3-B1 fires

**Action**: `plant_invoice_reply`
**Duration**: 268ms
**Outcome**: ✓ pass

**SAP transactions this step**:
```
  [T+0:00:13] ZLOAD3-B1        work=…z6y30s state=done    → ✓ done at [T+0:00:13]
              callback: Invoice 7682614526/85817685, Shipment status=created
```

**Driver notes**:
- Marked 3 plant_ls email(s) replied; firing checkAndSendBatchToAman
- checkAndSendBatchToAman success=true

### Step 14 — Wait for Shipment row from /processing-data callback

**Action**: `wait_for_shipment`
**Duration**: 255ms
**Outcome**: ✓ pass

**Driver notes**:
- Shipment found id=cmps5f9v100essxzp11ozrvb9 status=created obd=85817685

### Step 15 — Operator triggers VT01N for the Shipment

**Action**: `trigger_vt01n`
**Duration**: 268ms
**Outcome**: ✓ pass

**SAP transactions this step**:
```
  [T+0:00:13] VTO1N-B          work=…y3dxiw state=done    → ✓ done at [T+0:00:14]
              callback: Shipment status=shipped
```

**Driver notes**:
- Firing triggerVto1n on Shipment cmps5f9v100essxzp11ozrvb9

### Step 16 — Wait for SO status = completed

**Action**: `wait_for_so_status`
**Duration**: 257ms
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
| Invoice.invoiceNumber | `7682614526` |
| Invoice.obdNumber | `85817685` |
| Shipment.status | `shipped` |
| ScenarioEvent count | 20 |
| SAP transactions fired | 5 |

## Complete audit trail (chronological)

```
[T+0:00:00] classifier_decision  action=new_order
[T+0:00:00] email_received       from branch — Subject "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-178013331…" — "Increase YE1EDWO00001APJP from 50 to 80 and delete YA4COWOCR000043P entirely fr…"
[T+0:00:03] classifier_decision  branch|before_ls|modify|inc_del
[T+0:00:03] scenario_started     branch|before_ls|modify|inc_del
[T+0:00:03] step_fired           stock_precheck
[T+0:00:03] step_completed       stock_precheck ✓
[T+0:00:03] step_fired           va02
[T+0:00:03] step_completed       va02 ✓ — materials YE1EDWO00001APJP=?, YV6FRYENE0000PJP=?, YA4COWOCR000043P=?
[T+0:00:03] step_fired           email_2nd_release
[T+0:00:03] email_sent           2nd_release to test-branch@example.com — "2nd Release Confirmation - SO 3290007"
[T+0:00:03] step_completed       email_2nd_release ✓
[T+0:00:03] scenario_completed   branch|before_ls|modify|inc_del
[T+0:00:03] email_received       from branch — Subject "2nd Release Confirmation - SO 3290007" — "Yes, the revised release plan is acceptable. Please proceed with the updated qu…"
[T+0:00:05] classifier_decision  action=2nd_release_decision
[T+0:00:06] email_received       from branch — Subject "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-178013331…" — "Please release everything as available. All quantities approved, go ahead and d…"
[T+0:00:09] classifier_decision  branch|before_ls|release_all|-
[T+0:00:09] scenario_started     branch|before_ls|release_all|-
[T+0:00:09] step_fired           email_confirm_bundle_details
[T+0:00:09] step_completed       email_confirm_bundle_details ✓
[T+0:00:09] scenario_completed   branch|before_ls|release_all|-
```

## Complete email thread (chronological)

```
[2026-05-30T09:28:40.483Z] OUTBOUND to test-branch@example.com [type=ls_dispatch] — Subject: "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780133318544"
  Body: Dispatch Recommendation - AUTO-MOCK-NEWORDER-1780133318544 Dear Sales Team, Sales Order 3290007 I have reviewed the stock availability for Sales Order 3290007. Here is the dispatch recommendation: Material A — APJP [YE1EDWO00001APJP] : Stock is confirmed available. Proceed with 50 units from Batch A-26. Material B — PJP [YV6FRYENE0000PJP] : Stock is confirmed available. Proceed with 100 units from Batch 30-07-2025. Material C — 43P [YA4COWOCR000043P] : Stock is confirmed available. Proceed with 250 units from Batch 20. Best regards, Sales Order Dispatch Co-ordinator

[2026-05-30T09:28:40.844Z] INBOUND from test-branch@example.com [type=ls_dispatch] — Subject: "Re: Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780133318544"
  Body: Increase YE1EDWO00001APJP from 50 to 80 and delete YA4COWOCR000043P entirely from the order.

[2026-05-30T09:28:43.886Z] OUTBOUND to test-branch@example.com [type=2nd_release] — Subject: "2nd Release Confirmation - SO 3290007"
  Body: Hi, We have updated SO 3290007 with the following changes: - Increase YE1EDWO00001APJP → 80 - Delete material YA4COWOCR000043P Please confirm we should proceed with the revised plan (reply "yes" to confirm). Thanks.

[2026-05-30T09:28:45.807Z] INBOUND from test-branch@example.com [type=2nd_release] — Subject: "Re: 2nd Release Confirmation - SO 3290007"
  Body: Yes, the revised release plan is acceptable. Please proceed with the updated quantities.

[2026-05-30T09:28:50.350Z] OUTBOUND to test-branch@example.com [type=dispatch_confirmation] — Subject: "Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780133318544"
  Body: Dear Branch Team, Dispatch plan ready for Purchase Order AUTO-MOCK-NEWORDER-1780133318544 (Chain modify_inc_del). Total 10.665 t — fits in 1 vehicle (capacity 45 t). Proposed dispatch (grouped by bundle): Bundle 1 — 10.665 t (of 45 t capacity): - SO 3290007 / YA4COWOCR000043P (Batch 20): 250 units, 6.625 t - SO 3290007 / YE1EDWO00001APJP (Batch A-26): 50 units, 1.320 t - SO 3290007 / YV6FRYENE0000PJP (Batch 30-07-2025): 100 units, 2.720 t Please reply with: - "yes" / "confirm" to proceed with the above plan, or - the changes you want (e.g. "skip OOWJ on SO 1234567", "send only 15 of OP7WJ"). Once confirmed we will create the loading slips. Best regards, Sales Order Dispatch Co-ordinator

[2026-05-30T09:28:50.878Z] INBOUND from test-branch@example.com [type=dispatch_confirmation] — Subject: "Re: Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780133318544"
  Body: Yes, please proceed with the dispatch plan as confirmed. Go ahead.

[2026-05-30T09:28:51.121Z] OUTBOUND to test-branch@example.com [type=vehicle_details] — Subject: "Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780133318544 (1 bundle)"
  Body: Dear Branch Team, Loading slips for Purchase Order AUTO-MOCK-NEWORDER-1780133318544 are now ready in SAP. The PO is split into 1 bundle: Bundle 1 (~10.66 t): - SO 3290007 / LS 373299 / Material PENDING - SO 3290007 / LS 373300 / Material PENDING - SO 3290007 / LS 373301 / Material PENDING Please reply with vehicle/transport details for each bundle in the format below: Bundle 1: , , Best regards, Sales Order Dispatch Co-ordinator

[2026-05-30T09:28:51.399Z] INBOUND from test-branch@example.com [type=vehicle_details] — Subject: "Re: Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780133318544 (1 bundle)"
  Body: Vehicle GJ12-XY1234, driver mobile 9876543210, container CONT-TEST-001, LR LR-9988 dated 2026-05-30.

[2026-05-30T09:28:51.922Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373299 - SO 3290007"
  Body: Plant invoice attached. Invoice 7682614520, OBD 85817679.

[2026-05-30T09:28:51.924Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373300 - SO 3290007"
  Body: Plant invoice attached. Invoice 7682614520, OBD 85817679.

[2026-05-30T09:28:51.925Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373301 - SO 3290007"
  Body: Plant invoice attached. Invoice 7682614520, OBD 85817679.
```

## Verifications

- ✓ SO.status === `completed` (actual: `completed`)
- ✓ LSI count ≥ 2 (actual: 3)
- ✓ Invoice number present (actual: `7682614526`)
- ✓ Shipment row exists (actual status: `shipped`)
- ✓ SAP transactions ≥ 5 (actual: 5)
