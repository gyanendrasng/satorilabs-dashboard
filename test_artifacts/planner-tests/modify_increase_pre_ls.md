# Test case: modify_increase_pre_ls

**Description**: Branch asks to increase M-A from 50 → 80 BEFORE LS is created. Expect VA02 + 2nd release + re-cycle.
**SO Number**: 3290102
**Customer**: TEST-CUST-MOD-INC
**Started**: 2026-05-31T12:09:24.779Z
**Finished**: 2026-05-31T12:10:00.833Z (duration 36.1s)
**Result**: ✅ PASS

## SAP transactions (instruction payloads)

| # | Transaction | State | Work ID | Enqueued | Finished |
|---|---|---|---|---|---|
| 1 | ZSO-VISIBILITY | done | `n7b35bgp` | 2026-05-31T12:09:25.759Z | 2026-05-31T12:09:25.996Z |
| 2 | VA02 | done | `qtx42ju3` | 2026-05-31T12:09:34.323Z | 2026-05-31T12:09:34.541Z |
| 3 | ZSO-VISIBILITY | done | `vscgh2xl` | 2026-05-31T12:09:40.243Z | 2026-05-31T12:09:40.481Z |
| 4 | ZLOAD1 | done | `hjo0zyow` | 2026-05-31T12:09:47.284Z | 2026-05-31T12:09:47.552Z |
| 5 | ZLOAD3-B1 | done | `075s4v7s` | 2026-05-31T12:09:55.889Z | 2026-05-31T12:09:56.123Z |
| 6 | VTO1N-B | done | `5d7z5161` | 2026-05-31T12:09:58.915Z | 2026-05-31T12:09:59.122Z |

### Transaction 1 — ZSO-VISIBILITY

- **Work ID**: `cmptqllvi004bsx7bn7b35bgp`
- **State**: done
- **Instruction sent to SAP**:
  ```
  VPN is connected and SAP is logged in. Just go ahead and run the SAP Transaction ZSO-VISIBILITY for Sales order number 3290102.
  ```
- **Structured args**:
  ```json
  {
    "transaction_code": "ZSO-VISIBILITY",
    "meta": {
      "so_number": "3290102"
    }
  }
  ```

### Transaction 2 — VA02

- **Work ID**: `cmptqlshe0057sx7bqtx42ju3`
- **State**: done
- **Instruction sent to SAP**:
  ```
  VPN is connected and SAP is logged in. Just go ahead and run the SAP Transaction VA02 for Sales Order number 3290102. For material YE1EDWO00001APJP set the order quantity to 80
  ```
- **Structured args**:
  ```json
  {
    "transaction_code": "VA02",
    "so_number": "3290102",
    "meta": {
      "so_number": "3290102",
      "materials": [
        {
          "material": "YE1EDWO00001APJP",
          "orderQuantity": 80
        }
      ],
      "payload_key": "{\"soNumber\":\"3290102\",\"materials\":[{\"material\":\"YE1EDWO00001APJP\",\"orderQuantity\":80}]}"
    }
  }
  ```

### Transaction 3 — ZSO-VISIBILITY

- **Work ID**: `cmptqlx1v005vsx7bvscgh2xl`
- **State**: done
- **Instruction sent to SAP**:
  ```
  VPN is connected and SAP is logged in. Just go ahead and run the SAP Transaction ZSO-VISIBILITY for Sales order number 3290102.
  ```
- **Structured args**:
  ```json
  {
    "transaction_code": "ZSO-VISIBILITY",
    "meta": {
      "so_number": "3290102"
    }
  }
  ```

### Transaction 4 — ZLOAD1

- **Work ID**: `cmptqm2hg007bsx7bhjo0zyow`
- **State**: done
- **Instruction sent to SAP**:
  ```
  VPN is connected, SAP is logged in. Execute ZLOAD1 for sales order 3290102 (Bundle 1). Materials to dispatch:
  - Material: YE1EDWO00001APJP, Batch: A-26, Quantity: 50
  - Material: YV6FRYENE0000PJP, Batch: 30-07-2025, Quantity: 100
  - Material: YA4COWOCR000043P, Batch: 20, Quantity: 250
  ```
- **Structured args**:
  ```json
  {
    "transaction_code": "ZLOAD1",
    "so_number": "3290102",
    "meta": {
      "so_number": "3290102",
      "bundle_id": "cmptqm2h90079sx7bjlzvl0y4",
      "bundle_number": 1
    }
  }
  ```

### Transaction 5 — ZLOAD3-B1

- **Work ID**: `cmptqm94g0091sx7b075s4v7s`
- **State**: done
- **Instruction sent to SAP**:
  ```
  VPN is connected, SAP is logged in. Just execute ZLOAD3-B1 for sales order 3290102 (Bundle 1)
  ```
- **Structured args**:
  ```json
  {
    "transaction_code": "ZLOAD3-B1",
    "so_number": "3290102",
    "attachments": [
      {
        "filename": "373285.pdf",
        "content_base64": "JVBERi0xLjQKJW1vY2stZTJlLXBkZgo="
      },
      {
        "filename": "373286.pdf",
        "content_base64": "JVBERi0xLjQKJW1vY2stZTJlLXBkZgo="
      },
      {
        "filename": "373287.pdf",
        "content_base64": "JVBERi0xLjQKJW1vY2stZTJlLXBkZgo="
      }
    ],
    "extraction_context": "For each file, extract the loading slip number, loaded quantity, invoice number, and invoice date",
    "meta": {
      "so_number": "3290102",
      "bundle_id": "cmptqm2h90079sx7bjlzvl0y4",
      "bundle_number": 1
    }
  }
  ```

### Transaction 6 — VTO1N-B

- **Work ID**: `cmptqmbgj009hsx7b5d7z5161`
- **State**: done
- **Instruction sent to SAP**:
  ```
  VPN is connected and SAP is logged in. Just go ahead and run the SAP Transaction VT01N. OBD number is 85817680, LR number is LR-002, LR date is 31.05.2026 and Vehicle number is MH12CD5678
  ```
- **Structured args**:
  ```json
  {
    "transaction_code": "VTO1N-B",
    "so_number": "3290102",
    "extraction_context": "Extract the OBD number, LR number, LR date and Vehicle number",
    "meta": {
      "so_number": "3290102",
      "shipment_id": "cmptqm9ai009bsx7bvurdh6ey",
      "bundle_id": "cmptqm2h90079sx7bjlzvl0y4",
      "bundle_number": 1,
      "obd_number": "85817680"
    }
  }
  ```

## Event chain (audit trail)

```
[T+0:00:00] email_received       from branch — Subject "NEW ORDER 3290102" — "Dear Sales Team, Please create SO 3290102 for customer TEST-CUST-MOD-INC. Mater…"
[T+0:00:00] classifier_decision  action=new_order
[T+0:00:00] step_completed       zso_visibility ✓ — materials YE1EDWO00001APJP=50, YV6FRYENE0000PJP=100, YA4COWOCR000043P=250
[T+0:00:00] email_sent           ls_dispatch to test-branch@example.com — "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-178022936…"
[T+0:00:00] step_completed       zso_visibility ✓
[T+0:00:00] email_received       from branch — Subject "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-178022936…" — "Please increase YE1EDWO00001APJP (M-A) from 50 to 80 units. Keep the rest as is."
[T+0:00:03] classifier_decision  llm-planned
[T+0:00:03] scenario_started     llm-planned
[T+0:00:03] step_fired           stock_precheck
[T+0:00:06] step_completed       stock_precheck ✓
[T+0:00:06] step_fired           va02
[T+0:00:08] step_completed       va02 ✓ — materials YE1EDWO00001APJP=?, YV6FRYENE0000PJP=?, YA4COWOCR000043P=?
[T+0:00:08] step_fired           email_2nd_release
[T+0:00:11] email_sent           2nd_release to test-branch@example.com — "2nd Release Confirmation - SO 3290102"
[T+0:00:11] step_completed       email_2nd_release ✓
[T+0:00:11] scenario_completed   llm-planned
[T+0:00:11] email_received       from branch — Subject "2nd Release Confirmation - SO 3290102" — "Yes, please do the second release and proceed."
[T+0:00:14] classifier_decision  llm-planned
[T+0:00:14] scenario_started     llm-planned
[T+0:00:14] step_fired           zso_visibility
[T+0:00:14] step_completed       zso_visibility ✓ — materials YE1EDWO00001APJP=50, YV6FRYENE0000PJP=100, YA4COWOCR000043P=250
[T+0:00:14] email_sent           ls_dispatch to test-branch@example.com — "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-178022936…"
[T+0:00:14] step_completed       zso_visibility ✓ — materials YE1EDWO00001APJP=50, YV6FRYENE0000PJP=100, YA4COWOCR000043P=250
[T+0:00:14] scenario_completed   llm-planned
[T+0:00:15] email_received       from branch — Subject "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-178022936…" — "Looks good now. Proceed with dispatch."
[T+0:00:17] classifier_decision  llm-planned
[T+0:00:17] scenario_started     llm-planned
[T+0:00:17] step_fired           email_confirm_bundle_details
[T+0:00:17] email_sent           dispatch_confirmation to test-branch@example.com — "Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780229364797"
[T+0:00:17] step_completed       email_confirm_bundle_details ✓
[T+0:00:17] scenario_completed   llm-planned
[T+0:00:18] email_received       from branch — Subject "Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780229364797" — "Confirmed. Proceed."
[T+0:00:21] classifier_decision  llm-planned
[T+0:00:21] scenario_started     llm-planned
[T+0:00:21] step_fired           zload1
[T+0:00:21] email_sent           vehicle_details to test-branch@example.com — "Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780229364…"
[T+0:00:21] step_completed       zload1 ✓ — LS 373287:PENDING=?, 373286:PENDING=?, 373285:PENDING=?
[T+0:00:21] step_fired           email_to_branch_for_vehicle
[T+0:00:21] step_completed       email_to_branch_for_vehicle ✓
[T+0:00:21] scenario_completed   llm-planned
[T+0:00:22] email_received       from branch — Subject "Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780229364…" — "Vehicle: MH12CD5678, Driver: 9988776655, LR: LR-002 dated 2026-05-31"
[T+0:00:24] classifier_decision  llm-planned
[T+0:00:24] scenario_started     llm-planned
[T+0:00:24] step_fired           email_to_plant
[T+0:00:26] email_sent           plant_ls to test-plant@example.com — "Loading Slip 373285 - SO 3290102"
[T+0:00:26] email_sent           plant_ls to test-plant@example.com — "Loading Slip 373286 - SO 3290102"
[T+0:00:26] email_sent           plant_ls to test-plant@example.com — "Loading Slip 373287 - SO 3290102"
[T+0:00:26] step_completed       email_to_plant ✓
[T+0:00:26] scenario_completed   llm-planned
[T+0:00:27] email_received       from plant — Subject "Loading Slip 373287 - SO 3290102" — "Invoice 7682614521 OBD 5070000124 attached."
[T+0:00:30] classifier_decision  llm-planned
[T+0:00:30] scenario_started     llm-planned
[T+0:00:30] step_fired           process_plant_invoice
[T+0:00:30] step_completed       process_plant_invoice ✓
[T+0:00:30] scenario_completed   llm-planned
[T+0:00:30] step_completed       process_plant_invoice ✓
[T+0:00:30] scenario_completed   llm-planned
[T+0:00:30] step_completed       zload3b1 ✓
[T+0:00:33] step_completed       vto1n ✓
```

## Email thread

```
[2026-05-31T12:09:25.988Z] OUTBOUND to test-branch@example.com [type=ls_dispatch] — Subject: "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780229364797"
  Body: Dispatch Recommendation - AUTO-MOCK-NEWORDER-1780229364797 Dear Sales Team, Sales Order 3290102 I have reviewed the stock availability for Sales Order 3290102. Here is the dispatch recommendation: M-A [YE1EDWO00001APJP] : Stock is confirmed available. Proceed with 50 units from Batch A-26. M-B [YV6FRYENE0000PJP] : Stock is confirmed available. Proceed with 100 units from Batch 30-07-2025. M-C [YA4COWOCR000043P] : Stock is confirmed available. Proceed with 250 units from Batch 20. Best regards, Sales Order Dispatch Co-ordinator

[2026-05-31T12:09:26.170Z] INBOUND from test-branch@example.com [type=ls_dispatch] — Subject: "Re: Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780229364797"
  Body: Please increase YE1EDWO00001APJP (M-A) from 50 to 80 units. Keep the rest as is.

[2026-05-31T12:09:37.056Z] OUTBOUND to test-branch@example.com [type=2nd_release] — Subject: "2nd Release Confirmation - SO 3290102"
  Body: Hi, We have updated SO 3290102 with the following changes: - Increase YE1EDWO00001APJP → 80 Please do the second release and confirm. Thanks.

[2026-05-31T12:09:37.172Z] INBOUND from test-branch@example.com [type=2nd_release] — Subject: "Re: 2nd Release Confirmation - SO 3290102"
  Body: Yes, please do the second release and proceed.

[2026-05-31T12:09:40.472Z] OUTBOUND to test-branch@example.com [type=ls_dispatch] — Subject: "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780229364797"
  Body: Dispatch Recommendation - AUTO-MOCK-NEWORDER-1780229364797 Dear Sales Team, Sales Order 3290102 I have reviewed the stock availability for Sales Order 3290102. Here is the dispatch recommendation: M-A [YE1EDWO00001APJP] : Stock is confirmed available. Proceed with 50 units from Batch A-26. M-B [YV6FRYENE0000PJP] : Stock is confirmed available. Proceed with 100 units from Batch 30-07-2025. M-C [YA4COWOCR000043P] : Stock is confirmed available. Proceed with 250 units from Batch 20. Best regards, Sales Order Dispatch Co-ordinator

[2026-05-31T12:09:41.251Z] INBOUND from test-branch@example.com [type=ls_dispatch] — Subject: "Re: Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780229364797"
  Body: Looks good now. Proceed with dispatch.

[2026-05-31T12:09:43.589Z] OUTBOUND to test-branch@example.com [type=dispatch_confirmation] — Subject: "Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780229364797"
  Body: Dear Branch Team, Dispatch plan ready for Purchase Order AUTO-MOCK-NEWORDER-1780229364797 (Customer 1). Total 10.665 t — fits in 1 vehicle (capacity 35 t). Proposed dispatch (grouped by bundle): Bundle 1 — 10.665 t (of 35 t capacity): - SO 3290102 / YA4COWOCR000043P (Batch 20): 250 units, 6.625 t - SO 3290102 / YE1EDWO00001APJP (Batch A-26): 50 units, 1.320 t - SO 3290102 / YV6FRYENE0000PJP (Batch 30-07-2025): 100 units, 2.720 t Please reply with: - "yes" / "confirm" to proceed with the above plan, or - the changes you want (e.g. "skip OOWJ on SO 1234567", "send only 15 of OP7WJ"). Once confirmed we will create the loading slips. Best regards, Sales Order Dispatch Co-ordinator

[2026-05-31T12:09:44.625Z] INBOUND from test-branch@example.com [type=dispatch_confirmation] — Subject: "Re: Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780229364797"
  Body: Confirmed. Proceed.

[2026-05-31T12:09:47.556Z] OUTBOUND to test-branch@example.com [type=vehicle_details] — Subject: "Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780229364797 (1 bundle)"
  Body: Dear Branch Team, Loading slips for Purchase Order AUTO-MOCK-NEWORDER-1780229364797 are now ready in SAP. The PO is split into 1 bundle: Bundle 1 (~10.66 t): - SO 3290102 / LS 373285 / Material PENDING - SO 3290102 / LS 373286 / Material PENDING - SO 3290102 / LS 373287 / Material PENDING Please reply with vehicle/transport details for each bundle in the format below: Bundle 1: , , Best regards, Sales Order Dispatch Co-ordinator

[2026-05-31T12:09:52.019Z] INBOUND from test-branch@example.com [type=vehicle_details] — Subject: "Re: Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780229364797 (1 bundle)"
  Body: Vehicle: MH12CD5678, Driver: 9988776655, LR: LR-002 dated 2026-05-31

[2026-05-31T12:09:53.071Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373285 - SO 3290102"
  Body: Invoice 7682614521 OBD 5070000124 attached.

[2026-05-31T12:09:53.071Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373286 - SO 3290102"
  Body: Invoice 7682614521 OBD 5070000124 attached.

[2026-05-31T12:09:53.071Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373287 - SO 3290102"
  Body: Invoice 7682614521 OBD 5070000124 attached.
```

## Final DB state

- **SO.status**: completed
- **PO.dispatchRound**: 2
- **Material rows**: 3
- **LoadingSlipItem rows**: 3
- **Invoice**: #7682614521
- **Shipments**: 1 (shipped)

### Materials

| Material | Batch | Ordered | Available | Dispatch |
|---|---|---|---|---|
| YE1EDWO00001APJP | A-26 | 50 | 50 | 50 |
| YV6FRYENE0000PJP | 30-07-2025 | 100 | 100 | 100 |
| YA4COWOCR000043P | 20 | 250 | 250 | 250 |

## Run log

```
[2026-05-31T12:09:24.797Z] Pushing NEW ORDER for SO 3290102
[2026-05-31T12:09:25.763Z] SO row created — soId=cmptqllv80045sx7b1nx17bwc poId=cmptqllv40043sx7b5zxp635z
[2026-05-31T12:09:25.763Z] Step 1/6: waiting for outbound "ls_dispatch" (timeout 30000ms)
[2026-05-31T12:09:26.170Z] Step 1: targeting email lt7g0geg with reply: "Please increase YE1EDWO00001APJP (M-A) from 50 to 80 units. Keep the rest as is."
[2026-05-31T12:09:34.330Z] Step 1: handleReplyV2 returned matched=true
[2026-05-31T12:09:35.332Z] Step 2/6: waiting for outbound "2nd_release" (timeout 30000ms)
[2026-05-31T12:09:37.172Z] Step 2: targeting email sqj9hziu with reply: "Yes, please do the second release and proceed."
[2026-05-31T12:09:40.247Z] Step 2: handleReplyV2 returned matched=true
[2026-05-31T12:09:41.250Z] Step 3/6: waiting for outbound "ls_dispatch" (timeout 30000ms)
[2026-05-31T12:09:41.251Z] Step 3: targeting email rx5lov8e with reply: "Looks good now. Proceed with dispatch."
[2026-05-31T12:09:43.595Z] Step 3: handleReplyV2 returned matched=true
[2026-05-31T12:09:44.618Z] Step 4/6: waiting for outbound "dispatch_confirmation" (timeout 30000ms)
[2026-05-31T12:09:44.623Z] Step 4: targeting email 76e2ut6b with reply: "Confirmed. Proceed."
[2026-05-31T12:09:47.289Z] Step 4: handleReplyV2 returned matched=true
[2026-05-31T12:09:48.292Z] Step 5/6: waiting for outbound "vehicle_details" (timeout 30000ms)
[2026-05-31T12:09:48.293Z] Step 5: targeting email 3lqizzlo with reply: "Vehicle: MH12CD5678, Driver: 9988776655, LR: LR-002 dated 2026-05-31"
[2026-05-31T12:09:52.053Z] Step 5: handleReplyV2 returned matched=true
[2026-05-31T12:09:52.055Z]   [operator input sim] persisted lrNumber=LR-002 lrDate=2026-05-31 on SO
[2026-05-31T12:09:53.063Z] Step 6/6: waiting for outbound "plant_ls" (timeout 30000ms)
[2026-05-31T12:09:53.065Z] Step 6: targeting email ld0d8lqz with reply: "Invoice 7682614521 OBD 5070000124 attached."
[2026-05-31T12:09:53.072Z]   [plant invoice sim] marked 3 plant_ls Email row(s) in bundle jlzvl0y4 as replied with mock PDF URL
[2026-05-31T12:09:55.907Z] Step 6: handleReplyV2 returned matched=true
[2026-05-31T12:09:58.912Z] Shipment(s) created (1); simulating operator VT01N click per shipment
[2026-05-31T12:09:58.918Z]   triggerVto1n(vurdh6ey) enqueued (obd=85817680)
```
