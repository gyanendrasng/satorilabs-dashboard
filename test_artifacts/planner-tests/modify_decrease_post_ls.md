# Test case: modify_decrease_post_ls

**Description**: Branch asks to decrease M-A 50→30 AFTER plant_ls has been sent. Expect ZLOAD2 (no VA02, no 2nd_release).
**SO Number**: 3290108
**Customer**: TEST-CUST-POST-DEC
**Started**: 2026-05-31T12:12:22.537Z
**Finished**: 2026-05-31T12:12:55.593Z (duration 33.1s)
**Result**: ❌ FAIL

## Failures
- SAP transaction sequence missing: ZLOAD2, ZLOAD3-B1, VTO1N-B. Actual order: ZSO-VISIBILITY → ZLOAD1 → ZLOAD3-B1 → VTO1N-B

## SAP transactions (instruction payloads)

| # | Transaction | State | Work ID | Enqueued | Finished |
|---|---|---|---|---|---|
| 1 | ZSO-VISIBILITY | done | `tvg0c5i1` | 2026-05-31T12:12:23.596Z | 2026-05-31T12:12:23.838Z |
| 2 | ZLOAD1 | done | `gwhsoyux` | 2026-05-31T12:12:34.033Z | 2026-05-31T12:12:34.289Z |
| 3 | ZLOAD3-B1 | done | `2vmvl7xa` | 2026-05-31T12:12:50.650Z | 2026-05-31T12:12:50.880Z |
| 4 | VTO1N-B | done | `z42f57pe` | 2026-05-31T12:12:53.675Z | 2026-05-31T12:12:53.888Z |

### Transaction 1 — ZSO-VISIBILITY

- **Work ID**: `cmptqpf3f00wzsx7btvg0c5i1`
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

- **Work ID**: `cmptqpn5d00ydsx7bgwhsoyux`
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
      "bundle_id": "cmptqpn5800ybsx7bjlbuob8c",
      "bundle_number": 1
    }
  }
  ```

### Transaction 3 — ZLOAD3-B1

- **Work ID**: `cmptqpzyx010dsx7b2vmvl7xa`
- **State**: done
- **Instruction sent to SAP**:
  ```
  VPN is connected, SAP is logged in. Just execute ZLOAD3-B1 for sales order 3290108 (Bundle 1)
  ```
- **Structured args**:
  ```json
  {
    "transaction_code": "ZLOAD3-B1",
    "so_number": "3290108",
    "attachments": [
      {
        "filename": "373303.pdf",
        "content_base64": "JVBERi0xLjQKJW1vY2stZTJlLXBkZgo="
      },
      {
        "filename": "373304.pdf",
        "content_base64": "JVBERi0xLjQKJW1vY2stZTJlLXBkZgo="
      },
      {
        "filename": "373305.pdf",
        "content_base64": "JVBERi0xLjQKJW1vY2stZTJlLXBkZgo="
      }
    ],
    "extraction_context": "For each file, extract the loading slip number, loaded quantity, invoice number, and invoice date",
    "meta": {
      "so_number": "3290108",
      "bundle_id": "cmptqpn5800ybsx7bjlbuob8c",
      "bundle_number": 1
    }
  }
  ```

### Transaction 4 — VTO1N-B

- **Work ID**: `cmptqq2az010tsx7bz42f57pe`
- **State**: done
- **Instruction sent to SAP**:
  ```
  VPN is connected and SAP is logged in. Just go ahead and run the SAP Transaction VT01N. OBD number is 85817686, LR number is LR-008, LR date is 31.05.2026 and Vehicle number is MH12OP9012
  ```
- **Structured args**:
  ```json
  {
    "transaction_code": "VTO1N-B",
    "so_number": "3290108",
    "extraction_context": "Extract the OBD number, LR number, LR date and Vehicle number",
    "meta": {
      "so_number": "3290108",
      "shipment_id": "cmptqq04w010nsx7bscm6nfsq",
      "bundle_id": "cmptqpn5800ybsx7bjlbuob8c",
      "bundle_number": 1,
      "obd_number": "85817686"
    }
  }
  ```

## Event chain (audit trail)

```
[T+0:00:00] email_received       from branch — Subject "NEW ORDER 3290108" — "Dear Sales Team, Please create SO 3290108 for customer TEST-CUST-POST-DEC. Mate…"
[T+0:00:00] classifier_decision  action=new_order
[T+0:00:00] step_completed       zso_visibility ✓ — materials YE1EDWO00001APJP=50, YV6FRYENE0000PJP=100, YA4COWOCR000043P=250
[T+0:00:00] email_sent           ls_dispatch to test-branch@example.com — "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-178022954…"
[T+0:00:00] step_completed       zso_visibility ✓
[T+0:00:00] email_received       from branch — Subject "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-178022954…" — "Confirmed. Release everything."
[T+0:00:03] classifier_decision  llm-planned
[T+0:00:03] scenario_started     llm-planned
[T+0:00:03] step_fired           email_confirm_bundle_details
[T+0:00:03] email_sent           dispatch_confirmation to test-branch@example.com — "Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780229542555"
[T+0:00:03] step_completed       email_confirm_bundle_details ✓
[T+0:00:03] scenario_completed   llm-planned
[T+0:00:04] email_received       from branch — Subject "Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780229542555" — "Confirmed. Proceed."
[T+0:00:10] classifier_decision  llm-planned
[T+0:00:10] scenario_started     llm-planned
[T+0:00:10] step_fired           zload1
[T+0:00:10] email_sent           vehicle_details to test-branch@example.com — "Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780229542…"
[T+0:00:10] step_completed       zload1 ✓ — LS 373305:PENDING=?, 373304:PENDING=?, 373303:PENDING=?
[T+0:00:10] step_fired           email_to_branch_for_vehicle
[T+0:00:10] step_completed       email_to_branch_for_vehicle ✓
[T+0:00:10] scenario_completed   llm-planned
[T+0:00:11] email_received       from branch — Subject "Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780229542…" — "Vehicle: MH12OP9012, Driver: 9333333333, LR: LR-008 dated 2026-05-31"
[T+0:00:14] classifier_decision  llm-planned
[T+0:00:14] scenario_started     llm-planned
[T+0:00:14] step_fired           email_to_plant
[T+0:00:15] email_sent           plant_ls to test-plant@example.com — "Loading Slip 373303 - SO 3290108"
[T+0:00:15] email_sent           plant_ls to test-plant@example.com — "Loading Slip 373304 - SO 3290108"
[T+0:00:15] email_sent           plant_ls to test-plant@example.com — "Loading Slip 373305 - SO 3290108"
[T+0:00:15] step_completed       email_to_plant ✓
[T+0:00:15] scenario_completed   llm-planned
[T+0:00:16] email_received       from branch — Subject "Loading Slip 373305 - SO 3290108" — "Update: please reduce YE1EDWO00001APJP (M-A) from 50 to 30. The plant should sh…"
[T+0:00:19] classifier_decision  llm-planned
[T+0:00:19] scenario_started     llm-planned
[T+0:00:19] step_fired           zload2
[T+0:00:23] email_received       from plant — Subject "Loading Slip 373305 - SO 3290108" — "Invoice 7682614527 OBD 5070000130 attached."
[T+0:00:27] classifier_decision  llm-planned
[T+0:00:27] scenario_started     llm-planned
[T+0:00:27] step_fired           process_plant_invoice
[T+0:00:27] step_completed       process_plant_invoice ✓
[T+0:00:27] scenario_completed   llm-planned
[T+0:00:27] step_completed       process_plant_invoice ✓
[T+0:00:27] scenario_completed   llm-planned
[T+0:00:27] step_completed       zload3b1 ✓
[T+0:00:30] step_completed       vto1n ✓
```

## Email thread

```
[2026-05-31T12:12:23.829Z] OUTBOUND to test-branch@example.com [type=ls_dispatch] — Subject: "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780229542555"
  Body: Dispatch Recommendation - AUTO-MOCK-NEWORDER-1780229542555 Dear Sales Team, Sales Order 3290108 I have reviewed the stock availability for Sales Order 3290108. Here is the dispatch recommendation: M-A [YE1EDWO00001APJP] : Stock is confirmed available. Proceed with 50 units from Batch A-26. M-B [YV6FRYENE0000PJP] : Stock is confirmed available. Proceed with 100 units from Batch 30-07-2025. M-C [YA4COWOCR000043P] : Stock is confirmed available. Proceed with 250 units from Batch 20. Best regards, Sales Order Dispatch Co-ordinator

[2026-05-31T12:12:24.012Z] INBOUND from test-branch@example.com [type=ls_dispatch] — Subject: "Re: Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780229542555"
  Body: Confirmed. Release everything.

[2026-05-31T12:12:27.018Z] OUTBOUND to test-branch@example.com [type=dispatch_confirmation] — Subject: "Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780229542555"
  Body: Dear Branch Team, Dispatch plan ready for Purchase Order AUTO-MOCK-NEWORDER-1780229542555 (Customer 1). Total 10.665 t — fits in 1 vehicle (capacity 35 t). Proposed dispatch (grouped by bundle): Bundle 1 — 10.665 t (of 35 t capacity): - SO 3290108 / YA4COWOCR000043P (Batch 20): 250 units, 6.625 t - SO 3290108 / YE1EDWO00001APJP (Batch A-26): 50 units, 1.320 t - SO 3290108 / YV6FRYENE0000PJP (Batch 30-07-2025): 100 units, 2.720 t Please reply with: - "yes" / "confirm" to proceed with the above plan, or - the changes you want (e.g. "skip OOWJ on SO 1234567", "send only 15 of OP7WJ"). Once confirmed we will create the loading slips. Best regards, Sales Order Dispatch Co-ordinator

[2026-05-31T12:12:28.028Z] INBOUND from test-branch@example.com [type=dispatch_confirmation] — Subject: "Re: Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780229542555"
  Body: Confirmed. Proceed.

[2026-05-31T12:12:34.292Z] OUTBOUND to test-branch@example.com [type=vehicle_details] — Subject: "Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780229542555 (1 bundle)"
  Body: Dear Branch Team, Loading slips for Purchase Order AUTO-MOCK-NEWORDER-1780229542555 are now ready in SAP. The PO is split into 1 bundle: Bundle 1 (~10.66 t): - SO 3290108 / LS 373303 / Material PENDING - SO 3290108 / LS 373304 / Material PENDING - SO 3290108 / LS 373305 / Material PENDING Please reply with vehicle/transport details for each bundle in the format below: Bundle 1: , , Best regards, Sales Order Dispatch Co-ordinator

[2026-05-31T12:12:38.879Z] INBOUND from test-branch@example.com [type=vehicle_details] — Subject: "Re: Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780229542555 (1 bundle)"
  Body: Vehicle: MH12OP9012, Driver: 9333333333, LR: LR-008 dated 2026-05-31

[2026-05-31T12:12:46.591Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373303 - SO 3290108"
  Body: Invoice 7682614527 OBD 5070000130 attached.

[2026-05-31T12:12:46.591Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373304 - SO 3290108"
  Body: Invoice 7682614527 OBD 5070000130 attached.

[2026-05-31T12:12:46.591Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373305 - SO 3290108"
  Body: Invoice 7682614527 OBD 5070000130 attached.
```

## Final DB state

- **SO.status**: completed
- **PO.dispatchRound**: 1
- **Material rows**: 3
- **LoadingSlipItem rows**: 3
- **Invoice**: #7682614527
- **Shipments**: 1 (shipped)

### Materials

| Material | Batch | Ordered | Available | Dispatch |
|---|---|---|---|---|
| YE1EDWO00001APJP | A-26 | 50 | 50 | 50 |
| YV6FRYENE0000PJP | 30-07-2025 | 100 | 100 | 100 |
| YA4COWOCR000043P | 20 | 250 | 250 | 250 |

## Run log

```
[2026-05-31T12:12:22.555Z] Pushing NEW ORDER for SO 3290108
[2026-05-31T12:12:23.599Z] SO row created — soId=cmptqpf3500wtsx7b17mv0xok poId=cmptqpf3100wrsx7b3lbnijoa
[2026-05-31T12:12:23.599Z] Step 1/5: waiting for outbound "ls_dispatch" (timeout 30000ms)
[2026-05-31T12:12:24.012Z] Step 1: targeting email 57dt1dgw with reply: "Confirmed. Release everything."
[2026-05-31T12:12:27.023Z] Step 1: handleReplyV2 returned matched=true
[2026-05-31T12:12:28.026Z] Step 2/5: waiting for outbound "dispatch_confirmation" (timeout 30000ms)
[2026-05-31T12:12:28.028Z] Step 2: targeting email 4n011xh8 with reply: "Confirmed. Proceed."
[2026-05-31T12:12:34.037Z] Step 2: handleReplyV2 returned matched=true
[2026-05-31T12:12:35.041Z] Step 3/5: waiting for outbound "vehicle_details" (timeout 30000ms)
[2026-05-31T12:12:35.043Z] Step 3: targeting email vinn2rie with reply: "Vehicle: MH12OP9012, Driver: 9333333333, LR: LR-008 dated 2026-05-31"
[2026-05-31T12:12:38.899Z] Step 3: handleReplyV2 returned matched=true
[2026-05-31T12:12:38.901Z]   [operator input sim] persisted lrNumber=LR-008 lrDate=2026-05-31 on SO
[2026-05-31T12:12:39.902Z] Step 4/5: waiting for outbound "plant_ls" (timeout 30000ms)
[2026-05-31T12:12:39.902Z] Step 4: targeting email yt9qwbmo with reply: "Update: please reduce YE1EDWO00001APJP (M-A) from 50 to 30. The plant should shi"
[2026-05-31T12:12:45.578Z] Step 4: handleReplyV2 returned matched=true
[2026-05-31T12:12:46.583Z] Step 5/5: waiting for outbound "plant_ls" (timeout 30000ms)
[2026-05-31T12:12:46.585Z] Step 5: targeting email yt9qwbmo with reply: "Invoice 7682614527 OBD 5070000130 attached."
[2026-05-31T12:12:46.593Z]   [plant invoice sim] marked 3 plant_ls Email row(s) in bundle jlbuob8c as replied with mock PDF URL
[2026-05-31T12:12:50.662Z] Step 5: handleReplyV2 returned matched=true
[2026-05-31T12:12:53.668Z] Shipment(s) created (1); simulating operator VT01N click per shipment
[2026-05-31T12:12:53.681Z]   triggerVto1n(scm6nfsq) enqueued (obd=85817686)
```
