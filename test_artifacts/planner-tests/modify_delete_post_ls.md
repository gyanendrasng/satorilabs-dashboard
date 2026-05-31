# Test case: modify_delete_post_ls

**Description**: Branch asks to delete M-C AFTER plant_ls. Expect ZLOADING_CLOSE (ZLOAD_Delete), no VA02.
**SO Number**: 3290109
**Customer**: TEST-CUST-POST-DEL
**Started**: 2026-05-31T07:41:48.876Z
**Finished**: 2026-05-31T07:42:18.401Z (duration 29.5s)
**Result**: ✅ PASS

## SAP transactions (instruction payloads)

| # | Transaction | State | Work ID | Enqueued | Finished |
|---|---|---|---|---|---|
| 1 | ZSO-VISIBILITY | done | `01szv5bz` | 2026-05-31T07:41:49.753Z | 2026-05-31T07:41:49.983Z |
| 2 | ZLOAD1 | done | `qogk57rm` | 2026-05-31T07:41:57.384Z | 2026-05-31T07:41:57.625Z |
| 3 | ZLOADING_CLOSE | done | `qa7jfgop` | 2026-05-31T07:42:08.696Z | 2026-05-31T07:42:08.914Z |
| 4 | ZLOAD3-B1 | done | `av5fhij2` | 2026-05-31T07:42:13.451Z | 2026-05-31T07:42:13.687Z |
| 5 | VTO1N-B | done | `k1ps7nov` | 2026-05-31T07:42:16.478Z | 2026-05-31T07:42:16.689Z |

### Transaction 1 — ZSO-VISIBILITY

- **Work ID**: `cmpth1gzc00zssx3p01szv5bz`
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

- **Work ID**: `cmpth1mvc0116sx3pqogk57rm`
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
      "bundle_id": "cmpth1mv60114sx3pe9r19lgr",
      "bundle_number": 1
    }
  }
  ```

### Transaction 3 — ZLOADING_CLOSE

- **Work ID**: `cmpth1vlj012qsx3pqa7jfgop`
- **State**: done
- **Instruction sent to SAP**:
  ```
  VPN is connected and SAP is logged in. Just go ahead and run the SAP Transaction ZLOADING_CLOSE for Sales Order number 3290109. Close material YA4COWOCR000043P.
  ```
- **Structured args**:
  ```json
  {
    "transaction_code": "ZLOADING_CLOSE",
    "so_number": "3290109",
    "meta": {
      "so_number": "3290109",
      "materials": [
        "YA4COWOCR000043P"
      ],
      "materials_key": "[\"YA4COWOCR000043P\"]"
    }
  }
  ```

### Transaction 4 — ZLOAD3-B1

- **Work ID**: `cmpth1z9m013msx3pav5fhij2`
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
      "bundle_id": "cmpth1mv60114sx3pe9r19lgr",
      "bundle_number": 1
    }
  }
  ```

### Transaction 5 — VTO1N-B

- **Work ID**: `cmpth21lp0142sx3pk1ps7nov`
- **State**: done
- **Instruction sent to SAP**:
  ```
  VPN is connected and SAP is logged in. Just go ahead and run the SAP Transaction VT01N. OBD number is 85817686, LR number is LR-009, LR date is 31.05.2026 and Vehicle number is MH12QR3456
  ```
- **Structured args**:
  ```json
  {
    "transaction_code": "VTO1N-B",
    "so_number": "3290109",
    "extraction_context": "Extract the OBD number, LR number, LR date and Vehicle number",
    "meta": {
      "so_number": "3290109",
      "shipment_id": "cmpth1zfm013wsx3pxjqdfwpq",
      "bundle_id": "cmpth1mv60114sx3pe9r19lgr",
      "bundle_number": 1,
      "obd_number": "85817686"
    }
  }
  ```

## Event chain (audit trail)

```
[T+0:00:00] email_received       from branch — Subject "NEW ORDER 3290109" — "Dear Sales Team, Please create SO 3290109 for customer TEST-CUST-POST-DEL. Mate…"
[T+0:00:00] classifier_decision  action=new_order
[T+0:00:00] step_completed       zso_visibility ✓ — materials YE1EDWO00001APJP=50, YV6FRYENE0000PJP=100, YA4COWOCR000043P=250
[T+0:00:00] email_sent           ls_dispatch to test-branch@example.com — "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-178021330…"
[T+0:00:00] step_completed       zso_visibility ✓
[T+0:00:00] email_received       from branch — Subject "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-178021330…" — "Confirmed."
[T+0:00:03] classifier_decision  llm-planned
[T+0:00:03] scenario_started     llm-planned
[T+0:00:03] step_fired           email_confirm_bundle_details
[T+0:00:03] email_sent           dispatch_confirmation to test-branch@example.com — "Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780213308894"
[T+0:00:03] step_completed       email_confirm_bundle_details ✓
[T+0:00:03] scenario_completed   llm-planned
[T+0:00:04] email_received       from branch — Subject "Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780213308894" — "Confirmed."
[T+0:00:07] classifier_decision  llm-planned
[T+0:00:07] scenario_started     llm-planned
[T+0:00:07] step_fired           zload1
[T+0:00:07] email_sent           vehicle_details to test-branch@example.com — "Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780213308…"
[T+0:00:07] step_completed       zload1 ✓ — LS 373308:PENDING=?, 373307:PENDING=?, 373306:PENDING=?
[T+0:00:07] step_fired           email_to_branch_for_vehicle
[T+0:00:07] step_completed       email_to_branch_for_vehicle ✓
[T+0:00:07] scenario_completed   llm-planned
[T+0:00:08] email_received       from branch — Subject "Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780213308…" — "Vehicle: MH12QR3456, Driver: 9444444444, LR: LR-009 dated 2026-05-31"
[T+0:00:11] classifier_decision  llm-planned
[T+0:00:11] scenario_started     llm-planned
[T+0:00:11] step_fired           email_to_plant
[T+0:00:12] email_sent           plant_ls to test-plant@example.com — "Loading Slip 373306 - SO 3290109"
[T+0:00:12] email_sent           plant_ls to test-plant@example.com — "Loading Slip 373307 - SO 3290109"
[T+0:00:12] email_sent           plant_ls to test-plant@example.com — "Loading Slip 373308 - SO 3290109"
[T+0:00:12] step_completed       email_to_plant ✓
[T+0:00:12] scenario_completed   llm-planned
[T+0:00:13] email_received       from branch — Subject "Loading Slip 373308 - SO 3290109" — "Please remove YA4COWOCR000043P (M-C) entirely from the LS. The plant should not…"
[T+0:00:16] classifier_decision  llm-planned
[T+0:00:16] scenario_started     llm-planned
[T+0:00:16] step_fired           zloading_close
[T+0:00:19] step_completed       zloading_close ✓ — LS 373308:PENDING=?, 373307:PENDING=?, 373306:PENDING=?
[T+0:00:19] step_fired           email_to_plant
[T+0:00:19] email_sent           plant_ls to test-plant@example.com — "Loading Slip 373306 - SO 3290109"
[T+0:00:19] email_sent           plant_ls to test-plant@example.com — "Loading Slip 373307 - SO 3290109"
[T+0:00:19] email_sent           plant_ls to test-plant@example.com — "Loading Slip 373308 - SO 3290109"
[T+0:00:19] step_completed       email_to_plant ✓
[T+0:00:19] scenario_completed   llm-planned
[T+0:00:19] email_received       from plant — Subject "Loading Slip 373308 - SO 3290109" — "Invoice 7682614528 OBD 5070000131 attached for the remaining items."
[T+0:00:23] classifier_decision  llm-planned
[T+0:00:23] scenario_started     llm-planned
[T+0:00:23] step_fired           process_plant_invoice
[T+0:00:23] step_completed       process_plant_invoice ✓
[T+0:00:23] scenario_completed   llm-planned
[T+0:00:23] step_completed       process_plant_invoice ✓
[T+0:00:23] scenario_completed   llm-planned
[T+0:00:23] step_completed       zload3b1 ✓
[T+0:00:26] step_completed       vto1n ✓
```

## Email thread

```
[2026-05-31T07:41:49.978Z] OUTBOUND to test-branch@example.com [type=ls_dispatch] — Subject: "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780213308894"
  Body: Dispatch Recommendation - AUTO-MOCK-NEWORDER-1780213308894 Dear Sales Team, Sales Order 3290109 I have reviewed the stock availability for Sales Order 3290109. Here is the dispatch recommendation: M-A [YE1EDWO00001APJP] : Stock is confirmed available. Proceed with 50 units from Batch A-26. M-B [YV6FRYENE0000PJP] : Stock is confirmed available. Proceed with 100 units from Batch 30-07-2025. M-C [YA4COWOCR000043P] : Stock is confirmed available. Proceed with 250 units from Batch 20. Best regards, Sales Order Dispatch Co-ordinator

[2026-05-31T07:41:50.162Z] INBOUND from test-branch@example.com [type=ls_dispatch] — Subject: "Re: Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780213308894"
  Body: Confirmed.

[2026-05-31T07:41:53.601Z] OUTBOUND to test-branch@example.com [type=dispatch_confirmation] — Subject: "Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780213308894"
  Body: Dear Branch Team, Dispatch plan ready for Purchase Order AUTO-MOCK-NEWORDER-1780213308894 (Customer 1). Total 10.665 t — fits in 1 vehicle (capacity 35 t). Proposed dispatch (grouped by bundle): Bundle 1 — 10.665 t (of 35 t capacity): - SO 3290109 / YA4COWOCR000043P (Batch 20): 250 units, 6.625 t - SO 3290109 / YE1EDWO00001APJP (Batch A-26): 50 units, 1.320 t - SO 3290109 / YV6FRYENE0000PJP (Batch 30-07-2025): 100 units, 2.720 t Please reply with: - "yes" / "confirm" to proceed with the above plan, or - the changes you want (e.g. "skip OOWJ on SO 1234567", "send only 15 of OP7WJ"). Once confirmed we will create the loading slips. Best regards, Sales Order Dispatch Co-ordinator

[2026-05-31T07:41:54.606Z] INBOUND from test-branch@example.com [type=dispatch_confirmation] — Subject: "Re: Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780213308894"
  Body: Confirmed.

[2026-05-31T07:41:57.629Z] OUTBOUND to test-branch@example.com [type=vehicle_details] — Subject: "Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780213308894 (1 bundle)"
  Body: Dear Branch Team, Loading slips for Purchase Order AUTO-MOCK-NEWORDER-1780213308894 are now ready in SAP. The PO is split into 1 bundle: Bundle 1 (~10.66 t): - SO 3290109 / LS 373306 / Material PENDING - SO 3290109 / LS 373307 / Material PENDING - SO 3290109 / LS 373308 / Material PENDING Please reply with vehicle/transport details for each bundle in the format below: Bundle 1: , , Best regards, Sales Order Dispatch Co-ordinator

[2026-05-31T07:42:01.823Z] INBOUND from test-branch@example.com [type=vehicle_details] — Subject: "Re: Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780213308894 (1 bundle)"
  Body: Vehicle: MH12QR3456, Driver: 9444444444, LR: LR-009 dated 2026-05-31

[2026-05-31T07:42:09.593Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373308 - SO 3290109"
  Body: Please remove YA4COWOCR000043P (M-C) entirely from the LS. The plant should not ship it.

[2026-05-31T07:42:09.710Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373306 - SO 3290109"
  Body: Invoice 7682614528 OBD 5070000131 attached for the remaining items.

[2026-05-31T07:42:09.710Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373307 - SO 3290109"
  Body: Invoice 7682614528 OBD 5070000131 attached for the remaining items.

[2026-05-31T07:42:09.710Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373306 - SO 3290109"
  Body: Invoice 7682614528 OBD 5070000131 attached for the remaining items.

[2026-05-31T07:42:09.710Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373307 - SO 3290109"
  Body: Invoice 7682614528 OBD 5070000131 attached for the remaining items.

[2026-05-31T07:42:09.710Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373308 - SO 3290109"
  Body: Invoice 7682614528 OBD 5070000131 attached for the remaining items.
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
[2026-05-31T07:41:48.893Z] Pushing NEW ORDER for SO 3290109
[2026-05-31T07:41:49.755Z] SO row created — soId=cmpth1gz400zmsx3pjka1cu4i poId=cmpth1gz200zksx3palooz1uv
[2026-05-31T07:41:49.755Z] Step 1/5: waiting for outbound "ls_dispatch" (timeout 30000ms)
[2026-05-31T07:41:50.162Z] Step 1: targeting email fpc30fge with reply: "Confirmed."
[2026-05-31T07:41:53.605Z] Step 1: handleReplyV2 returned matched=true
[2026-05-31T07:41:54.606Z] Step 2/5: waiting for outbound "dispatch_confirmation" (timeout 30000ms)
[2026-05-31T07:41:54.606Z] Step 2: targeting email jryau9ol with reply: "Confirmed."
[2026-05-31T07:41:57.389Z] Step 2: handleReplyV2 returned matched=true
[2026-05-31T07:41:58.394Z] Step 3/5: waiting for outbound "vehicle_details" (timeout 30000ms)
[2026-05-31T07:41:58.396Z] Step 3: targeting email gbba6vnh with reply: "Vehicle: MH12QR3456, Driver: 9444444444, LR: LR-009 dated 2026-05-31"
[2026-05-31T07:42:01.888Z] Step 3: handleReplyV2 returned matched=true
[2026-05-31T07:42:01.892Z]   [operator input sim] persisted lrNumber=LR-009 lrDate=2026-05-31 on SO
[2026-05-31T07:42:02.894Z] Step 4/5: waiting for outbound "plant_ls" (timeout 30000ms)
[2026-05-31T07:42:02.894Z] Step 4: targeting email n2ydwpwl with reply: "Please remove YA4COWOCR000043P (M-C) entirely from the LS. The plant should not "
[2026-05-31T07:42:08.704Z] Step 4: handleReplyV2 returned matched=true
[2026-05-31T07:42:09.706Z] Step 5/5: waiting for outbound "plant_ls" (timeout 30000ms)
[2026-05-31T07:42:09.707Z] Step 5: targeting email zdoc0pi8 with reply: "Invoice 7682614528 OBD 5070000131 attached for the remaining items."
[2026-05-31T07:42:09.712Z]   [plant invoice sim] marked 5 plant_ls Email row(s) in bundle e9r19lgr as replied with mock PDF URL
[2026-05-31T07:42:13.465Z] Step 5: handleReplyV2 returned matched=true
[2026-05-31T07:42:16.470Z] Shipment(s) created (1); simulating operator VT01N click per shipment
[2026-05-31T07:42:16.485Z]   triggerVto1n(xjqdfwpq) enqueued (obd=85817686)
```
