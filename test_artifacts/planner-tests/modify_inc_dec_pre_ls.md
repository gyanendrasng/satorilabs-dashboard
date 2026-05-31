# Test case: modify_inc_dec_pre_ls

**Description**: Branch asks to increase M-A 50→80 AND decrease M-B 100→60 BEFORE LS. VA02 fires only for increase.
**SO Number**: 3290105
**Customer**: TEST-CUST-MOD-INC-DEC
**Started**: 2026-05-31T07:39:32.396Z
**Finished**: 2026-05-31T07:40:08.237Z (duration 35.8s)
**Result**: ✅ PASS

## SAP transactions (instruction payloads)

| # | Transaction | State | Work ID | Enqueued | Finished |
|---|---|---|---|---|---|
| 1 | ZSO-VISIBILITY | done | `bmi6slaa` | 2026-05-31T07:39:33.486Z | 2026-05-31T07:39:33.722Z |
| 2 | VA02 | done | `zmfhd2iy` | 2026-05-31T07:39:41.952Z | 2026-05-31T07:39:42.169Z |
| 3 | ZSO-VISIBILITY | done | `6dnkbzc3` | 2026-05-31T07:39:48.576Z | 2026-05-31T07:39:48.804Z |
| 4 | ZLOAD1 | done | `l0ttxet1` | 2026-05-31T07:39:55.588Z | 2026-05-31T07:39:55.834Z |
| 5 | ZLOAD3-B1 | done | `hmq0bgwx` | 2026-05-31T07:40:03.287Z | 2026-05-31T07:40:03.531Z |
| 6 | VTO1N-B | done | `btbfu4xd` | 2026-05-31T07:40:06.317Z | 2026-05-31T07:40:06.530Z |

### Transaction 1 — ZSO-VISIBILITY

- **Work ID**: `cmptgyju500h6sx3pbmi6slaa`
- **State**: done
- **Instruction sent to SAP**:
  ```
  VPN is connected and SAP is logged in. Just go ahead and run the SAP Transaction ZSO-VISIBILITY for Sales order number 3290105.
  ```
- **Structured args**:
  ```json
  {
    "transaction_code": "ZSO-VISIBILITY",
    "meta": {
      "so_number": "3290105"
    }
  }
  ```

### Transaction 2 — VA02

- **Work ID**: `cmptgyqdc00i2sx3pzmfhd2iy`
- **State**: done
- **Instruction sent to SAP**:
  ```
  VPN is connected and SAP is logged in. Just go ahead and run the SAP Transaction VA02 for Sales Order number 3290105. For material YE1EDWO00001APJP set the order quantity to 80
  ```
- **Structured args**:
  ```json
  {
    "transaction_code": "VA02",
    "so_number": "3290105",
    "meta": {
      "so_number": "3290105",
      "materials": [
        {
          "material": "YE1EDWO00001APJP",
          "orderQuantity": 80
        }
      ],
      "payload_key": "{\"soNumber\":\"3290105\",\"materials\":[{\"material\":\"YE1EDWO00001APJP\",\"orderQuantity\":80}]}"
    }
  }
  ```

### Transaction 3 — ZSO-VISIBILITY

- **Work ID**: `cmptgyvhc00iqsx3p6dnkbzc3`
- **State**: done
- **Instruction sent to SAP**:
  ```
  VPN is connected and SAP is logged in. Just go ahead and run the SAP Transaction ZSO-VISIBILITY for Sales order number 3290105.
  ```
- **Structured args**:
  ```json
  {
    "transaction_code": "ZSO-VISIBILITY",
    "meta": {
      "so_number": "3290105"
    }
  }
  ```

### Transaction 4 — ZLOAD1

- **Work ID**: `cmptgz0w300k6sx3pl0ttxet1`
- **State**: done
- **Instruction sent to SAP**:
  ```
  VPN is connected, SAP is logged in. Execute ZLOAD1 for sales order 3290105 (Bundle 1). Materials to dispatch:
  - Material: YE1EDWO00001APJP, Batch: A-26, Quantity: 50
  - Material: YV6FRYENE0000PJP, Batch: 30-07-2025, Quantity: 100
  - Material: YA4COWOCR000043P, Batch: 20, Quantity: 250
  ```
- **Structured args**:
  ```json
  {
    "transaction_code": "ZLOAD1",
    "so_number": "3290105",
    "meta": {
      "so_number": "3290105",
      "bundle_id": "cmptgz0vy00k4sx3p1vxg088n",
      "bundle_number": 1
    }
  }
  ```

### Transaction 5 — ZLOAD3-B1

- **Work ID**: `cmptgz6ty00lqsx3phmq0bgwx`
- **State**: done
- **Instruction sent to SAP**:
  ```
  VPN is connected, SAP is logged in. Just execute ZLOAD3-B1 for sales order 3290105 (Bundle 1)
  ```
- **Structured args**:
  ```json
  {
    "transaction_code": "ZLOAD3-B1",
    "so_number": "3290105",
    "attachments": [
      {
        "filename": "373294.pdf",
        "content_base64": "JVBERi0xLjQKJW1vY2stZTJlLXBkZgo="
      },
      {
        "filename": "373295.pdf",
        "content_base64": "JVBERi0xLjQKJW1vY2stZTJlLXBkZgo="
      },
      {
        "filename": "373296.pdf",
        "content_base64": "JVBERi0xLjQKJW1vY2stZTJlLXBkZgo="
      }
    ],
    "extraction_context": "For each file, extract the loading slip number, loaded quantity, invoice number, and invoice date",
    "meta": {
      "so_number": "3290105",
      "bundle_id": "cmptgz0vy00k4sx3p1vxg088n",
      "bundle_number": 1
    }
  }
  ```

### Transaction 6 — VTO1N-B

- **Work ID**: `cmptgz96400m6sx3pbtbfu4xd`
- **State**: done
- **Instruction sent to SAP**:
  ```
  VPN is connected and SAP is logged in. Just go ahead and run the SAP Transaction VT01N. OBD number is 85817683, LR number is LR-005, LR date is 31.05.2026 and Vehicle number is MH12IJ7890
  ```
- **Structured args**:
  ```json
  {
    "transaction_code": "VTO1N-B",
    "so_number": "3290105",
    "extraction_context": "Extract the OBD number, LR number, LR date and Vehicle number",
    "meta": {
      "so_number": "3290105",
      "shipment_id": "cmptgz70200m0sx3pe89ortlw",
      "bundle_id": "cmptgz0vy00k4sx3p1vxg088n",
      "bundle_number": 1,
      "obd_number": "85817683"
    }
  }
  ```

## Event chain (audit trail)

```
[T+0:00:00] email_received       from branch — Subject "NEW ORDER 3290105" — "Dear Sales Team, Please create SO 3290105 for customer TEST-CUST-MOD-INC-DEC. M…"
[T+0:00:00] classifier_decision  action=new_order
[T+0:00:00] step_completed       zso_visibility ✓ — materials YE1EDWO00001APJP=50, YV6FRYENE0000PJP=100, YA4COWOCR000043P=250
[T+0:00:00] email_sent           ls_dispatch to test-branch@example.com — "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-178021317…"
[T+0:00:00] step_completed       zso_visibility ✓
[T+0:00:00] email_received       from branch — Subject "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-178021317…" — "Two changes: increase YE1EDWO00001APJP (M-A) from 50 to 80, and reduce YV6FRYEN…"
[T+0:00:03] classifier_decision  llm-planned
[T+0:00:03] scenario_started     llm-planned
[T+0:00:03] step_fired           stock_precheck
[T+0:00:06] step_completed       stock_precheck ✓
[T+0:00:06] step_fired           va02
[T+0:00:08] step_completed       va02 ✓ — materials YE1EDWO00001APJP=?, YV6FRYENE0000PJP=?, YA4COWOCR000043P=?
[T+0:00:08] step_fired           email_2nd_release
[T+0:00:11] email_sent           2nd_release to test-branch@example.com — "2nd Release Confirmation - SO 3290105"
[T+0:00:11] step_completed       email_2nd_release ✓
[T+0:00:11] scenario_completed   llm-planned
[T+0:00:12] email_received       from branch — Subject "2nd Release Confirmation - SO 3290105" — "Yes, do the second release."
[T+0:00:15] classifier_decision  llm-planned
[T+0:00:15] scenario_started     llm-planned
[T+0:00:15] step_fired           zso_visibility
[T+0:00:15] step_completed       zso_visibility ✓ — materials YE1EDWO00001APJP=50, YV6FRYENE0000PJP=100, YA4COWOCR000043P=250
[T+0:00:15] email_sent           ls_dispatch to test-branch@example.com — "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-178021317…"
[T+0:00:15] step_completed       zso_visibility ✓ — materials YE1EDWO00001APJP=50, YV6FRYENE0000PJP=100, YA4COWOCR000043P=250
[T+0:00:15] scenario_completed   llm-planned
[T+0:00:16] email_received       from branch — Subject "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-178021317…" — "Confirmed. Proceed."
[T+0:00:18] classifier_decision  llm-planned
[T+0:00:18] scenario_started     llm-planned
[T+0:00:18] step_fired           email_confirm_bundle_details
[T+0:00:18] email_sent           dispatch_confirmation to test-branch@example.com — "Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780213172413"
[T+0:00:18] step_completed       email_confirm_bundle_details ✓
[T+0:00:18] scenario_completed   llm-planned
[T+0:00:19] email_received       from branch — Subject "Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780213172413" — "Confirmed."
[T+0:00:22] classifier_decision  llm-planned
[T+0:00:22] scenario_started     llm-planned
[T+0:00:22] step_fired           zload1
[T+0:00:22] email_sent           vehicle_details to test-branch@example.com — "Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780213172…"
[T+0:00:22] step_completed       zload1 ✓ — LS 373296:PENDING=?, 373295:PENDING=?, 373294:PENDING=?
[T+0:00:22] step_fired           email_to_branch_for_vehicle
[T+0:00:22] step_completed       email_to_branch_for_vehicle ✓
[T+0:00:22] scenario_completed   llm-planned
[T+0:00:23] email_received       from branch — Subject "Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780213172…" — "Vehicle: MH12IJ7890, Driver: 9000000000, LR: LR-005 dated 2026-05-31"
[T+0:00:25] classifier_decision  llm-planned
[T+0:00:25] scenario_started     llm-planned
[T+0:00:25] step_fired           email_to_plant
[T+0:00:26] email_sent           plant_ls to test-plant@example.com — "Loading Slip 373294 - SO 3290105"
[T+0:00:26] email_sent           plant_ls to test-plant@example.com — "Loading Slip 373295 - SO 3290105"
[T+0:00:26] email_sent           plant_ls to test-plant@example.com — "Loading Slip 373296 - SO 3290105"
[T+0:00:26] step_completed       email_to_plant ✓
[T+0:00:26] scenario_completed   llm-planned
[T+0:00:27] email_received       from plant — Subject "Loading Slip 373296 - SO 3290105" — "Invoice 7682614524 OBD 5070000127 attached."
[T+0:00:29] classifier_decision  llm-planned
[T+0:00:29] scenario_started     llm-planned
[T+0:00:29] step_fired           process_plant_invoice
[T+0:00:29] step_completed       process_plant_invoice ✓
[T+0:00:29] scenario_completed   llm-planned
[T+0:00:29] step_completed       process_plant_invoice ✓
[T+0:00:29] scenario_completed   llm-planned
[T+0:00:30] step_completed       zload3b1 ✓
[T+0:00:33] step_completed       vto1n ✓
```

## Email thread

```
[2026-05-31T07:39:33.712Z] OUTBOUND to test-branch@example.com [type=ls_dispatch] — Subject: "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780213172413"
  Body: Dispatch Recommendation - AUTO-MOCK-NEWORDER-1780213172413 Dear Sales Team, Sales Order 3290105 I have reviewed the stock availability for Sales Order 3290105. Here is the dispatch recommendation: M-A [YE1EDWO00001APJP] : Stock is confirmed available. Proceed with 50 units from Batch A-26. M-B [YV6FRYENE0000PJP] : Stock is confirmed available. Proceed with 100 units from Batch 30-07-2025. M-C [YA4COWOCR000043P] : Stock is confirmed available. Proceed with 250 units from Batch 20. Best regards, Sales Order Dispatch Co-ordinator

[2026-05-31T07:39:33.898Z] INBOUND from test-branch@example.com [type=ls_dispatch] — Subject: "Re: Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780213172413"
  Body: Two changes: increase YE1EDWO00001APJP (M-A) from 50 to 80, and reduce YV6FRYENE0000PJP (M-B) from 100 to 60.

[2026-05-31T07:39:45.424Z] OUTBOUND to test-branch@example.com [type=2nd_release] — Subject: "2nd Release Confirmation - SO 3290105"
  Body: Hi, We have updated SO 3290105 with the following changes: - Increase YE1EDWO00001APJP → 80 - Decrease YV6FRYENE0000PJP → 60 Please do the second release and confirm. Thanks.

[2026-05-31T07:39:45.629Z] INBOUND from test-branch@example.com [type=2nd_release] — Subject: "Re: 2nd Release Confirmation - SO 3290105"
  Body: Yes, do the second release.

[2026-05-31T07:39:48.800Z] OUTBOUND to test-branch@example.com [type=ls_dispatch] — Subject: "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780213172413"
  Body: Dispatch Recommendation - AUTO-MOCK-NEWORDER-1780213172413 Dear Sales Team, Sales Order 3290105 I have reviewed the stock availability for Sales Order 3290105. Here is the dispatch recommendation: M-A [YE1EDWO00001APJP] : Stock is confirmed available. Proceed with 50 units from Batch A-26. M-B [YV6FRYENE0000PJP] : Stock is confirmed available. Proceed with 100 units from Batch 30-07-2025. M-C [YA4COWOCR000043P] : Stock is confirmed available. Proceed with 250 units from Batch 20. Best regards, Sales Order Dispatch Co-ordinator

[2026-05-31T07:39:49.589Z] INBOUND from test-branch@example.com [type=ls_dispatch] — Subject: "Re: Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780213172413"
  Body: Confirmed. Proceed.

[2026-05-31T07:39:51.856Z] OUTBOUND to test-branch@example.com [type=dispatch_confirmation] — Subject: "Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780213172413"
  Body: Dear Branch Team, Dispatch plan ready for Purchase Order AUTO-MOCK-NEWORDER-1780213172413 (Customer 1). Total 10.665 t — fits in 1 vehicle (capacity 35 t). Proposed dispatch (grouped by bundle): Bundle 1 — 10.665 t (of 35 t capacity): - SO 3290105 / YA4COWOCR000043P (Batch 20): 250 units, 6.625 t - SO 3290105 / YE1EDWO00001APJP (Batch A-26): 50 units, 1.320 t - SO 3290105 / YV6FRYENE0000PJP (Batch 30-07-2025): 100 units, 2.720 t Please reply with: - "yes" / "confirm" to proceed with the above plan, or - the changes you want (e.g. "skip OOWJ on SO 1234567", "send only 15 of OP7WJ"). Once confirmed we will create the loading slips. Best regards, Sales Order Dispatch Co-ordinator

[2026-05-31T07:39:52.868Z] INBOUND from test-branch@example.com [type=dispatch_confirmation] — Subject: "Re: Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780213172413"
  Body: Confirmed.

[2026-05-31T07:39:55.838Z] OUTBOUND to test-branch@example.com [type=vehicle_details] — Subject: "Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780213172413 (1 bundle)"
  Body: Dear Branch Team, Loading slips for Purchase Order AUTO-MOCK-NEWORDER-1780213172413 are now ready in SAP. The PO is split into 1 bundle: Bundle 1 (~10.66 t): - SO 3290105 / LS 373294 / Material PENDING - SO 3290105 / LS 373295 / Material PENDING - SO 3290105 / LS 373296 / Material PENDING Please reply with vehicle/transport details for each bundle in the format below: Bundle 1: , , Best regards, Sales Order Dispatch Co-ordinator

[2026-05-31T07:39:59.765Z] INBOUND from test-branch@example.com [type=vehicle_details] — Subject: "Re: Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780213172413 (1 bundle)"
  Body: Vehicle: MH12IJ7890, Driver: 9000000000, LR: LR-005 dated 2026-05-31

[2026-05-31T07:40:00.790Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373294 - SO 3290105"
  Body: Invoice 7682614524 OBD 5070000127 attached.

[2026-05-31T07:40:00.790Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373295 - SO 3290105"
  Body: Invoice 7682614524 OBD 5070000127 attached.

[2026-05-31T07:40:00.790Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373296 - SO 3290105"
  Body: Invoice 7682614524 OBD 5070000127 attached.
```

## Final DB state

- **SO.status**: completed
- **PO.dispatchRound**: 2
- **Material rows**: 3
- **LoadingSlipItem rows**: 3
- **Invoice**: #7682614524
- **Shipments**: 1 (shipped)

### Materials

| Material | Batch | Ordered | Available | Dispatch |
|---|---|---|---|---|
| YE1EDWO00001APJP | A-26 | 50 | 50 | 50 |
| YV6FRYENE0000PJP | 30-07-2025 | 100 | 100 | 100 |
| YA4COWOCR000043P | 20 | 250 | 250 | 250 |

## Run log

```
[2026-05-31T07:39:32.413Z] Pushing NEW ORDER for SO 3290105
[2026-05-31T07:39:33.490Z] SO row created — soId=cmptgyjtm00h0sx3pk5en3pki poId=cmptgyjtj00gysx3pblavtqi4
[2026-05-31T07:39:33.490Z] Step 1/6: waiting for outbound "ls_dispatch" (timeout 30000ms)
[2026-05-31T07:39:33.897Z] Step 1: targeting email 2ihtbmz7 with reply: "Two changes: increase YE1EDWO00001APJP (M-A) from 50 to 80, and reduce YV6FRYENE"
[2026-05-31T07:39:41.960Z] Step 1: handleReplyV2 returned matched=true
[2026-05-31T07:39:42.966Z] Step 2/6: waiting for outbound "2nd_release" (timeout 30000ms)
[2026-05-31T07:39:45.628Z] Step 2: targeting email nqok5k4p with reply: "Yes, do the second release."
[2026-05-31T07:39:48.581Z] Step 2: handleReplyV2 returned matched=true
[2026-05-31T07:39:49.586Z] Step 3/6: waiting for outbound "ls_dispatch" (timeout 30000ms)
[2026-05-31T07:39:49.589Z] Step 3: targeting email ah143j63 with reply: "Confirmed. Proceed."
[2026-05-31T07:39:51.861Z] Step 3: handleReplyV2 returned matched=true
[2026-05-31T07:39:52.866Z] Step 4/6: waiting for outbound "dispatch_confirmation" (timeout 30000ms)
[2026-05-31T07:39:52.868Z] Step 4: targeting email hbmsb2mj with reply: "Confirmed."
[2026-05-31T07:39:55.593Z] Step 4: handleReplyV2 returned matched=true
[2026-05-31T07:39:56.597Z] Step 5/6: waiting for outbound "vehicle_details" (timeout 30000ms)
[2026-05-31T07:39:56.599Z] Step 5: targeting email zer751ci with reply: "Vehicle: MH12IJ7890, Driver: 9000000000, LR: LR-005 dated 2026-05-31"
[2026-05-31T07:39:59.781Z] Step 5: handleReplyV2 returned matched=true
[2026-05-31T07:39:59.782Z]   [operator input sim] persisted lrNumber=LR-005 lrDate=2026-05-31 on SO
[2026-05-31T07:40:00.786Z] Step 6/6: waiting for outbound "plant_ls" (timeout 30000ms)
[2026-05-31T07:40:00.787Z] Step 6: targeting email 75esb38i with reply: "Invoice 7682614524 OBD 5070000127 attached."
[2026-05-31T07:40:00.791Z]   [plant invoice sim] marked 3 plant_ls Email row(s) in bundle 1vxg088n as replied with mock PDF URL
[2026-05-31T07:40:03.299Z] Step 6: handleReplyV2 returned matched=true
[2026-05-31T07:40:06.307Z] Shipment(s) created (1); simulating operator VT01N click per shipment
[2026-05-31T07:40:06.323Z]   triggerVto1n(e89ortlw) enqueued (obd=85817683)
```
