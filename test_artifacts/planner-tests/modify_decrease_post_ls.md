# Test case: modify_decrease_post_ls

**Description**: Branch asks to decrease M-A 50→30 AFTER plant_ls has been sent. Expect ZLOAD2 (no VA02, no 2nd_release).
**SO Number**: 3290108
**Customer**: TEST-CUST-POST-DEC
**Started**: 2026-05-31T07:41:07.768Z
**Finished**: 2026-05-31T07:41:48.869Z (duration 41.1s)
**Result**: ❌ FAIL

## Failures
- Expected SO.status="completed", got "ls_created"
- SAP transaction sequence missing: ZLOAD3-B1, VTO1N-B. Actual order: ZSO-VISIBILITY → ZLOAD1 → ZLOAD2

## SAP transactions (instruction payloads)

| # | Transaction | State | Work ID | Enqueued | Finished |
|---|---|---|---|---|---|
| 1 | ZSO-VISIBILITY | done | `r69wbt9v` | 2026-05-31T07:41:08.631Z | 2026-05-31T07:41:08.862Z |
| 2 | ZLOAD1 | done | `xy63lt04` | 2026-05-31T07:41:14.741Z | 2026-05-31T07:41:15.014Z |
| 3 | ZLOAD2 | done | `niyl3g58` | 2026-05-31T07:41:25.597Z | 2026-05-31T07:41:25.812Z |

### Transaction 1 — ZSO-VISIBILITY

- **Work ID**: `cmpth0l9200vtsx3pr69wbt9v`
- **State**: done
- **Instruction sent to SAP**:
  ```
  VPN is connected and SAP is logged in. Just go ahead and run the SAP Transaction ZSO-VISIBILITY for Sales order number 3290108.
  ```
- **Structured args**:
  ```json
  {
    "transaction_code": "ZSO-VISIBILITY",
    "meta": {
      "so_number": "3290108"
    }
  }
  ```

### Transaction 2 — ZLOAD1

- **Work ID**: `cmpth0pyt00x7sx3pxy63lt04`
- **State**: done
- **Instruction sent to SAP**:
  ```
  VPN is connected, SAP is logged in. Execute ZLOAD1 for sales order 3290108 (Bundle 1). Materials to dispatch:
  - Material: YE1EDWO00001APJP, Batch: A-26, Quantity: 50
  - Material: YV6FRYENE0000PJP, Batch: 30-07-2025, Quantity: 100
  - Material: YA4COWOCR000043P, Batch: 20, Quantity: 250
  ```
- **Structured args**:
  ```json
  {
    "transaction_code": "ZLOAD1",
    "so_number": "3290108",
    "meta": {
      "so_number": "3290108",
      "bundle_id": "cmpth0pyp00x5sx3phyml7ah9",
      "bundle_number": 1
    }
  }
  ```

### Transaction 3 — ZLOAD2

- **Work ID**: `cmpth0ycc00yrsx3pniyl3g58`
- **State**: done
- **Instruction sent to SAP**:
  ```
  VPN is connected and SAP is logged in. Just go ahead and run the SAP Transaction ZLOAD2 for Loading Slip number 373303. For material YE1EDWO00001APJP batch A-26 order quantity is 30
  ```
- **Structured args**:
  ```json
  {
    "transaction_code": "ZLOAD2",
    "meta": {
      "ls_number": "373303",
      "materials": [
        {
          "material": "YE1EDWO00001APJP",
          "batch": "A-26",
          "orderQuantity": 30
        }
      ],
      "payload_key": "{\"lsNumber\":\"373303\",\"materials\":[{\"material\":\"YE1EDWO00001APJP\",\"batch\":\"A-26\",\"orderQuantity\":30}]}"
    }
  }
  ```

## Event chain (audit trail)

```
[T+0:00:00] email_received       from branch — Subject "NEW ORDER 3290108" — "Dear Sales Team, Please create SO 3290108 for customer TEST-CUST-POST-DEC. Mate…"
[T+0:00:00] classifier_decision  action=new_order
[T+0:00:00] step_completed       zso_visibility ✓ — materials YE1EDWO00001APJP=50, YV6FRYENE0000PJP=100, YA4COWOCR000043P=250
[T+0:00:00] email_sent           ls_dispatch to test-branch@example.com — "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-178021326…"
[T+0:00:00] step_completed       zso_visibility ✓
[T+0:00:00] email_received       from branch — Subject "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-178021326…" — "Confirmed. Release everything."
[T+0:00:02] classifier_decision  llm-planned
[T+0:00:02] scenario_started     llm-planned
[T+0:00:02] step_fired           email_confirm_bundle_details
[T+0:00:02] email_sent           dispatch_confirmation to test-branch@example.com — "Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780213267786"
[T+0:00:02] step_completed       email_confirm_bundle_details ✓
[T+0:00:02] scenario_completed   llm-planned
[T+0:00:03] email_received       from branch — Subject "Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780213267786" — "Confirmed. Proceed."
[T+0:00:06] classifier_decision  llm-planned
[T+0:00:06] scenario_started     llm-planned
[T+0:00:06] step_fired           zload1
[T+0:00:06] email_sent           vehicle_details to test-branch@example.com — "Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780213267…"
[T+0:00:06] step_completed       zload1 ✓ — LS 373305:PENDING=?, 373304:PENDING=?, 373303:PENDING=?
[T+0:00:06] step_fired           email_to_branch_for_vehicle
[T+0:00:06] step_completed       email_to_branch_for_vehicle ✓
[T+0:00:06] scenario_completed   llm-planned
[T+0:00:07] email_received       from branch — Subject "Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780213267…" — "Vehicle: MH12OP9012, Driver: 9333333333, LR: LR-008 dated 2026-05-31"
[T+0:00:09] classifier_decision  llm-planned
[T+0:00:09] scenario_started     llm-planned
[T+0:00:09] step_fired           email_to_plant
[T+0:00:10] email_sent           plant_ls to test-plant@example.com — "Loading Slip 373303 - SO 3290108"
[T+0:00:10] email_sent           plant_ls to test-plant@example.com — "Loading Slip 373304 - SO 3290108"
[T+0:00:10] email_sent           plant_ls to test-plant@example.com — "Loading Slip 373305 - SO 3290108"
[T+0:00:10] step_completed       email_to_plant ✓
[T+0:00:10] scenario_completed   llm-planned
[T+0:00:11] email_received       from branch — Subject "Loading Slip 373305 - SO 3290108" — "Update: please reduce YE1EDWO00001APJP (M-A) from 50 to 30. The plant should sh…"
[T+0:00:14] classifier_decision  llm-planned
[T+0:00:14] scenario_started     llm-planned
[T+0:00:14] step_fired           zload2
[T+0:00:17] step_completed       zload2 ✓ — LS 373305:PENDING=?, 373304:PENDING=?, 373303:PENDING=?
[T+0:00:17] step_fired           email_to_plant
[T+0:00:17] email_received       from plant — Subject "Loading Slip 373305 - SO 3290108" — "Invoice 7682614527 OBD 5070000130 attached."
[T+0:00:17] scenario_aborted     reason: superseded by new inbound email
[T+0:00:18] step_completed       email_to_plant ✓
[T+0:00:18] scenario_completed   llm-planned
[T+0:00:20] classifier_decision  llm-planned
[T+0:00:20] scenario_started     llm-planned
[T+0:00:20] step_fired           process_plant_invoice
[T+0:00:20] step_completed       process_plant_invoice ✓
[T+0:00:20] scenario_completed   llm-planned
```

## Email thread

```
[2026-05-31T07:41:08.855Z] OUTBOUND to test-branch@example.com [type=ls_dispatch] — Subject: "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780213267786"
  Body: Dispatch Recommendation - AUTO-MOCK-NEWORDER-1780213267786 Dear Sales Team, Sales Order 3290108 I have reviewed the stock availability for Sales Order 3290108. Here is the dispatch recommendation: M-A [YE1EDWO00001APJP] : Stock is confirmed available. Proceed with 50 units from Batch A-26. M-B [YV6FRYENE0000PJP] : Stock is confirmed available. Proceed with 100 units from Batch 30-07-2025. M-C [YA4COWOCR000043P] : Stock is confirmed available. Proceed with 250 units from Batch 20. Best regards, Sales Order Dispatch Co-ordinator

[2026-05-31T07:41:09.044Z] INBOUND from test-branch@example.com [type=ls_dispatch] — Subject: "Re: Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780213267786"
  Body: Confirmed. Release everything.

[2026-05-31T07:41:11.423Z] OUTBOUND to test-branch@example.com [type=dispatch_confirmation] — Subject: "Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780213267786"
  Body: Dear Branch Team, Dispatch plan ready for Purchase Order AUTO-MOCK-NEWORDER-1780213267786 (Customer 1). Total 10.665 t — fits in 1 vehicle (capacity 35 t). Proposed dispatch (grouped by bundle): Bundle 1 — 10.665 t (of 35 t capacity): - SO 3290108 / YA4COWOCR000043P (Batch 20): 250 units, 6.625 t - SO 3290108 / YE1EDWO00001APJP (Batch A-26): 50 units, 1.320 t - SO 3290108 / YV6FRYENE0000PJP (Batch 30-07-2025): 100 units, 2.720 t Please reply with: - "yes" / "confirm" to proceed with the above plan, or - the changes you want (e.g. "skip OOWJ on SO 1234567", "send only 15 of OP7WJ"). Once confirmed we will create the loading slips. Best regards, Sales Order Dispatch Co-ordinator

[2026-05-31T07:41:12.435Z] INBOUND from test-branch@example.com [type=dispatch_confirmation] — Subject: "Re: Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780213267786"
  Body: Confirmed. Proceed.

[2026-05-31T07:41:15.031Z] OUTBOUND to test-branch@example.com [type=vehicle_details] — Subject: "Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780213267786 (1 bundle)"
  Body: Dear Branch Team, Loading slips for Purchase Order AUTO-MOCK-NEWORDER-1780213267786 are now ready in SAP. The PO is split into 1 bundle: Bundle 1 (~10.66 t): - SO 3290108 / LS 373303 / Material PENDING - SO 3290108 / LS 373304 / Material PENDING - SO 3290108 / LS 373305 / Material PENDING Please reply with vehicle/transport details for each bundle in the format below: Bundle 1: , , Best regards, Sales Order Dispatch Co-ordinator

[2026-05-31T07:41:19.260Z] INBOUND from test-branch@example.com [type=vehicle_details] — Subject: "Re: Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780213267786 (1 bundle)"
  Body: Vehicle: MH12OP9012, Driver: 9333333333, LR: LR-008 dated 2026-05-31

[2026-05-31T07:41:26.614Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373303 - SO 3290108"
  Body: Invoice 7682614527 OBD 5070000130 attached.

[2026-05-31T07:41:26.614Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373304 - SO 3290108"
  Body: Invoice 7682614527 OBD 5070000130 attached.

[2026-05-31T07:41:26.614Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373305 - SO 3290108"
  Body: Invoice 7682614527 OBD 5070000130 attached.
```

## Final DB state

- **SO.status**: ls_created
- **PO.dispatchRound**: 1
- **Material rows**: 3
- **LoadingSlipItem rows**: 3
- **Invoice**: none
- **Shipments**: 0

### Materials

| Material | Batch | Ordered | Available | Dispatch |
|---|---|---|---|---|
| YE1EDWO00001APJP | A-26 | 50 | 50 | 50 |
| YV6FRYENE0000PJP | 30-07-2025 | 100 | 100 | 100 |
| YA4COWOCR000043P | 20 | 250 | 250 | 250 |

## Run log

```
[2026-05-31T07:41:07.786Z] Pushing NEW ORDER for SO 3290108
[2026-05-31T07:41:08.635Z] SO row created — soId=cmpth0l8s00vnsx3p1wwlke46 poId=cmpth0l8p00vlsx3pzznuxgst
[2026-05-31T07:41:08.635Z] Step 1/5: waiting for outbound "ls_dispatch" (timeout 30000ms)
[2026-05-31T07:41:09.044Z] Step 1: targeting email r89ojttn with reply: "Confirmed. Release everything."
[2026-05-31T07:41:11.428Z] Step 1: handleReplyV2 returned matched=true
[2026-05-31T07:41:12.433Z] Step 2/5: waiting for outbound "dispatch_confirmation" (timeout 30000ms)
[2026-05-31T07:41:12.434Z] Step 2: targeting email jsg9j89i with reply: "Confirmed. Proceed."
[2026-05-31T07:41:14.745Z] Step 2: handleReplyV2 returned matched=true
[2026-05-31T07:41:15.749Z] Step 3/5: waiting for outbound "vehicle_details" (timeout 30000ms)
[2026-05-31T07:41:15.751Z] Step 3: targeting email jispdyrt with reply: "Vehicle: MH12OP9012, Driver: 9333333333, LR: LR-008 dated 2026-05-31"
[2026-05-31T07:41:19.276Z] Step 3: handleReplyV2 returned matched=true
[2026-05-31T07:41:19.278Z]   [operator input sim] persisted lrNumber=LR-008 lrDate=2026-05-31 on SO
[2026-05-31T07:41:20.281Z] Step 4/5: waiting for outbound "plant_ls" (timeout 30000ms)
[2026-05-31T07:41:20.283Z] Step 4: targeting email ly1hvo8q with reply: "Update: please reduce YE1EDWO00001APJP (M-A) from 50 to 30. The plant should shi"
[2026-05-31T07:41:25.602Z] Step 4: handleReplyV2 returned matched=true
[2026-05-31T07:41:26.606Z] Step 5/5: waiting for outbound "plant_ls" (timeout 30000ms)
[2026-05-31T07:41:26.609Z] Step 5: targeting email ly1hvo8q with reply: "Invoice 7682614527 OBD 5070000130 attached."
[2026-05-31T07:41:26.615Z]   [plant invoice sim] marked 3 plant_ls Email row(s) in bundle hyml7ah9 as replied with mock PDF URL
[2026-05-31T07:41:29.271Z] Step 5: handleReplyV2 returned matched=true
[2026-05-31T07:41:47.359Z] No Shipment rows appeared — ZLOAD3-B1 likely did not fire (test does not cover full lifecycle)
```
