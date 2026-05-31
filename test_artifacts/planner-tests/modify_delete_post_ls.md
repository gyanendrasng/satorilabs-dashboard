# Test case: modify_delete_post_ls

**Description**: Branch asks to delete M-C AFTER plant_ls. Expect ZLOADING_CLOSE (ZLOAD_Delete), no VA02.
**SO Number**: 3290109
**Customer**: TEST-CUST-POST-DEL
**Started**: 2026-05-31T12:12:55.600Z
**Finished**: 2026-05-31T12:13:27.718Z (duration 32.1s)
**Result**: ✅ PASS

## SAP transactions (instruction payloads)

| # | Transaction | State | Work ID | Enqueued | Finished |
|---|---|---|---|---|---|
| 1 | ZSO-VISIBILITY | done | `dwlcg3rc` | 2026-05-31T12:12:56.843Z | 2026-05-31T12:12:57.072Z |
| 2 | ZLOAD1 | done | `ict9px1b` | 2026-05-31T12:13:06.985Z | 2026-05-31T12:13:07.219Z |
| 3 | ZLOAD3-B1 | done | `7sqjcvua` | 2026-05-31T12:13:22.760Z | 2026-05-31T12:13:22.995Z |
| 4 | VTO1N-B | done | `tvuywudw` | 2026-05-31T12:13:25.792Z | 2026-05-31T12:13:26.006Z |

### Transaction 1 — ZSO-VISIBILITY

- **Work ID**: `cmptqq4qy0118sx7bdwlcg3rc`
- **State**: done
- **Instruction sent to SAP**:
  ```
  VPN is connected and SAP is logged in. Just go ahead and run the SAP Transaction ZSO-VISIBILITY for Sales order number 3290109.
  ```
- **Structured args**:
  ```json
  {
    "transaction_code": "ZSO-VISIBILITY",
    "meta": {
      "so_number": "3290109"
    }
  }
  ```

### Transaction 2 — ZLOAD1

- **Work ID**: `cmptqqckp012msx7bict9px1b`
- **State**: done
- **Instruction sent to SAP**:
  ```
  VPN is connected, SAP is logged in. Execute ZLOAD1 for sales order 3290109 (Bundle 1). Materials to dispatch:
  - Material: YE1EDWO00001APJP, Batch: A-26, Quantity: 50
  - Material: YV6FRYENE0000PJP, Batch: 30-07-2025, Quantity: 100
  - Material: YA4COWOCR000043P, Batch: 20, Quantity: 250
  ```
- **Structured args**:
  ```json
  {
    "transaction_code": "ZLOAD1",
    "so_number": "3290109",
    "meta": {
      "so_number": "3290109",
      "bundle_id": "cmptqqckl012ksx7b1bii60zp",
      "bundle_number": 1
    }
  }
  ```

### Transaction 3 — ZLOAD3-B1

- **Work ID**: `cmptqqoqv014msx7b7sqjcvua`
- **State**: done
- **Instruction sent to SAP**:
  ```
  VPN is connected, SAP is logged in. Just execute ZLOAD3-B1 for sales order 3290109 (Bundle 1)
  ```
- **Structured args**:
  ```json
  {
    "transaction_code": "ZLOAD3-B1",
    "so_number": "3290109",
    "attachments": [
      {
        "filename": "373306.pdf",
        "content_base64": "JVBERi0xLjQKJW1vY2stZTJlLXBkZgo="
      },
      {
        "filename": "373307.pdf",
        "content_base64": "JVBERi0xLjQKJW1vY2stZTJlLXBkZgo="
      },
      {
        "filename": "373308.pdf",
        "content_base64": "JVBERi0xLjQKJW1vY2stZTJlLXBkZgo="
      }
    ],
    "extraction_context": "For each file, extract the loading slip number, loaded quantity, invoice number, and invoice date",
    "meta": {
      "so_number": "3290109",
      "bundle_id": "cmptqqckl012ksx7b1bii60zp",
      "bundle_number": 1
    }
  }
  ```

### Transaction 4 — VTO1N-B

- **Work ID**: `cmptqqr340152sx7btvuywudw`
- **State**: done
- **Instruction sent to SAP**:
  ```
  VPN is connected and SAP is logged in. Just go ahead and run the SAP Transaction VT01N. OBD number is 85817687, LR number is LR-009, LR date is 31.05.2026 and Vehicle number is MH12QR3456
  ```
- **Structured args**:
  ```json
  {
    "transaction_code": "VTO1N-B",
    "so_number": "3290109",
    "extraction_context": "Extract the OBD number, LR number, LR date and Vehicle number",
    "meta": {
      "so_number": "3290109",
      "shipment_id": "cmptqqowx014wsx7b4xnil4kx",
      "bundle_id": "cmptqqckl012ksx7b1bii60zp",
      "bundle_number": 1,
      "obd_number": "85817687"
    }
  }
  ```

## Event chain (audit trail)

```
[T+0:00:00] email_received       from branch — Subject "NEW ORDER 3290109" — "Dear Sales Team, Please create SO 3290109 for customer TEST-CUST-POST-DEL. Mate…"
[T+0:00:00] classifier_decision  action=new_order
[T+0:00:00] step_completed       zso_visibility ✓ — materials YE1EDWO00001APJP=50, YV6FRYENE0000PJP=100, YA4COWOCR000043P=250
[T+0:00:00] email_sent           ls_dispatch to test-branch@example.com — "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-178022957…"
[T+0:00:00] step_completed       zso_visibility ✓
[T+0:00:00] email_received       from branch — Subject "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-178022957…" — "Confirmed."
[T+0:00:05] classifier_decision  llm-planned
[T+0:00:05] scenario_started     llm-planned
[T+0:00:05] step_fired           email_confirm_bundle_details
[T+0:00:05] email_sent           dispatch_confirmation to test-branch@example.com — "Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780229575617"
[T+0:00:05] step_completed       email_confirm_bundle_details ✓
[T+0:00:05] scenario_completed   llm-planned
[T+0:00:06] email_received       from branch — Subject "Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780229575617" — "Confirmed."
[T+0:00:10] classifier_decision  llm-planned
[T+0:00:10] scenario_started     llm-planned
[T+0:00:10] step_fired           zload1
[T+0:00:10] email_sent           vehicle_details to test-branch@example.com — "Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780229575…"
[T+0:00:10] step_completed       zload1 ✓ — LS 373308:PENDING=?, 373307:PENDING=?, 373306:PENDING=?
[T+0:00:10] step_fired           email_to_branch_for_vehicle
[T+0:00:10] step_completed       email_to_branch_for_vehicle ✓
[T+0:00:10] scenario_completed   llm-planned
[T+0:00:11] email_received       from branch — Subject "Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780229575…" — "Vehicle: MH12QR3456, Driver: 9444444444, LR: LR-009 dated 2026-05-31"
[T+0:00:13] classifier_decision  llm-planned
[T+0:00:13] scenario_started     llm-planned
[T+0:00:13] step_fired           email_to_plant
[T+0:00:14] email_sent           plant_ls to test-plant@example.com — "Loading Slip 373306 - SO 3290109"
[T+0:00:14] email_sent           plant_ls to test-plant@example.com — "Loading Slip 373307 - SO 3290109"
[T+0:00:14] email_sent           plant_ls to test-plant@example.com — "Loading Slip 373308 - SO 3290109"
[T+0:00:14] step_completed       email_to_plant ✓
[T+0:00:14] scenario_completed   llm-planned
[T+0:00:15] email_received       from branch — Subject "Loading Slip 373308 - SO 3290109" — "Please remove YA4COWOCR000043P (M-C) entirely from the LS. The plant should not…"
[T+0:00:19] classifier_decision  llm-planned
[T+0:00:19] scenario_started     llm-planned
[T+0:00:19] step_fired           zloading_close
[T+0:00:23] email_received       from plant — Subject "Loading Slip 373308 - SO 3290109" — "Invoice 7682614528 OBD 5070000131 attached for the remaining items."
[T+0:00:25] classifier_decision  llm-planned
[T+0:00:25] scenario_started     llm-planned
[T+0:00:25] step_fired           process_plant_invoice
[T+0:00:25] step_completed       process_plant_invoice ✓
[T+0:00:25] scenario_completed   llm-planned
[T+0:00:25] step_completed       process_plant_invoice ✓
[T+0:00:25] scenario_completed   llm-planned
[T+0:00:26] step_completed       zload3b1 ✓
[T+0:00:29] step_completed       vto1n ✓
```

## Email thread

```
[2026-05-31T12:12:57.067Z] OUTBOUND to test-branch@example.com [type=ls_dispatch] — Subject: "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780229575617"
  Body: Dispatch Recommendation - AUTO-MOCK-NEWORDER-1780229575617 Dear Sales Team, Sales Order 3290109 I have reviewed the stock availability for Sales Order 3290109. Here is the dispatch recommendation: M-A [YE1EDWO00001APJP] : Stock is confirmed available. Proceed with 50 units from Batch A-26. M-B [YV6FRYENE0000PJP] : Stock is confirmed available. Proceed with 100 units from Batch 30-07-2025. M-C [YA4COWOCR000043P] : Stock is confirmed available. Proceed with 250 units from Batch 20. Best regards, Sales Order Dispatch Co-ordinator

[2026-05-31T12:12:57.250Z] INBOUND from test-branch@example.com [type=ls_dispatch] — Subject: "Re: Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780229575617"
  Body: Confirmed.

[2026-05-31T12:13:01.979Z] OUTBOUND to test-branch@example.com [type=dispatch_confirmation] — Subject: "Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780229575617"
  Body: Dear Branch Team, Dispatch plan ready for Purchase Order AUTO-MOCK-NEWORDER-1780229575617 (Customer 1). Total 10.665 t — fits in 1 vehicle (capacity 35 t). Proposed dispatch (grouped by bundle): Bundle 1 — 10.665 t (of 35 t capacity): - SO 3290109 / YA4COWOCR000043P (Batch 20): 250 units, 6.625 t - SO 3290109 / YE1EDWO00001APJP (Batch A-26): 50 units, 1.320 t - SO 3290109 / YV6FRYENE0000PJP (Batch 30-07-2025): 100 units, 2.720 t Please reply with: - "yes" / "confirm" to proceed with the above plan, or - the changes you want (e.g. "skip OOWJ on SO 1234567", "send only 15 of OP7WJ"). Once confirmed we will create the loading slips. Best regards, Sales Order Dispatch Co-ordinator

[2026-05-31T12:13:02.989Z] INBOUND from test-branch@example.com [type=dispatch_confirmation] — Subject: "Re: Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780229575617"
  Body: Confirmed.

[2026-05-31T12:13:07.222Z] OUTBOUND to test-branch@example.com [type=vehicle_details] — Subject: "Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780229575617 (1 bundle)"
  Body: Dear Branch Team, Loading slips for Purchase Order AUTO-MOCK-NEWORDER-1780229575617 are now ready in SAP. The PO is split into 1 bundle: Bundle 1 (~10.66 t): - SO 3290109 / LS 373306 / Material PENDING - SO 3290109 / LS 373307 / Material PENDING - SO 3290109 / LS 373308 / Material PENDING Please reply with vehicle/transport details for each bundle in the format below: Bundle 1: , , Best regards, Sales Order Dispatch Co-ordinator

[2026-05-31T12:13:11.787Z] INBOUND from test-branch@example.com [type=vehicle_details] — Subject: "Re: Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780229575617 (1 bundle)"
  Body: Vehicle: MH12QR3456, Driver: 9444444444, LR: LR-009 dated 2026-05-31

[2026-05-31T12:13:19.898Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373306 - SO 3290109"
  Body: Invoice 7682614528 OBD 5070000131 attached for the remaining items.

[2026-05-31T12:13:19.898Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373307 - SO 3290109"
  Body: Invoice 7682614528 OBD 5070000131 attached for the remaining items.

[2026-05-31T12:13:19.898Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373308 - SO 3290109"
  Body: Invoice 7682614528 OBD 5070000131 attached for the remaining items.
```

## Final DB state

- **SO.status**: completed
- **PO.dispatchRound**: 1
- **Material rows**: 3
- **LoadingSlipItem rows**: 3
- **Invoice**: #7682614528
- **Shipments**: 1 (shipped)

### Materials

| Material | Batch | Ordered | Available | Dispatch |
|---|---|---|---|---|
| YE1EDWO00001APJP | A-26 | 50 | 50 | 50 |
| YV6FRYENE0000PJP | 30-07-2025 | 100 | 100 | 100 |
| YA4COWOCR000043P | 20 | 250 | 250 | 250 |

## Run log

```
[2026-05-31T12:12:55.617Z] Pushing NEW ORDER for SO 3290109
[2026-05-31T12:12:56.845Z] SO row created — soId=cmptqq4qs0112sx7bgfvp759a poId=cmptqq4qr0110sx7bg96ci4ht
[2026-05-31T12:12:56.845Z] Step 1/5: waiting for outbound "ls_dispatch" (timeout 30000ms)
[2026-05-31T12:12:57.250Z] Step 1: targeting email j61nf4hk with reply: "Confirmed."
[2026-05-31T12:13:01.984Z] Step 1: handleReplyV2 returned matched=true
[2026-05-31T12:13:02.987Z] Step 2/5: waiting for outbound "dispatch_confirmation" (timeout 30000ms)
[2026-05-31T12:13:02.989Z] Step 2: targeting email gag4zuy1 with reply: "Confirmed."
[2026-05-31T12:13:06.988Z] Step 2: handleReplyV2 returned matched=true
[2026-05-31T12:13:07.991Z] Step 3/5: waiting for outbound "vehicle_details" (timeout 30000ms)
[2026-05-31T12:13:07.993Z] Step 3: targeting email 7g9ifenh with reply: "Vehicle: MH12QR3456, Driver: 9444444444, LR: LR-009 dated 2026-05-31"
[2026-05-31T12:13:11.803Z] Step 3: handleReplyV2 returned matched=true
[2026-05-31T12:13:11.804Z]   [operator input sim] persisted lrNumber=LR-009 lrDate=2026-05-31 on SO
[2026-05-31T12:13:12.807Z] Step 4/5: waiting for outbound "plant_ls" (timeout 30000ms)
[2026-05-31T12:13:12.809Z] Step 4: targeting email 7mxnvpf6 with reply: "Please remove YA4COWOCR000043P (M-C) entirely from the LS. The plant should not "
[2026-05-31T12:13:18.889Z] Step 4: handleReplyV2 returned matched=true
[2026-05-31T12:13:19.892Z] Step 5/5: waiting for outbound "plant_ls" (timeout 30000ms)
[2026-05-31T12:13:19.893Z] Step 5: targeting email 7mxnvpf6 with reply: "Invoice 7682614528 OBD 5070000131 attached for the remaining items."
[2026-05-31T12:13:19.900Z]   [plant invoice sim] marked 3 plant_ls Email row(s) in bundle 1bii60zp as replied with mock PDF URL
[2026-05-31T12:13:22.781Z] Step 5: handleReplyV2 returned matched=true
[2026-05-31T12:13:25.786Z] Shipment(s) created (1); simulating operator VT01N click per shipment
[2026-05-31T12:13:25.798Z]   triggerVto1n(4xnil4kx) enqueued (obd=85817687)
```
