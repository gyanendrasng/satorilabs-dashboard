# Test case: modify_increase_post_ls

**Description**: Branch asks to increase M-B 100→150 AFTER plant_ls. Expect VA02 + 2nd_release + ZLOAD2.
**SO Number**: 3290110
**Customer**: TEST-CUST-POST-INC
**Started**: 2026-05-31T07:42:18.408Z
**Finished**: 2026-05-31T07:43:07.647Z (duration 49.2s)
**Result**: ❌ FAIL

## Failures
- SAP transaction sequence missing: ZLOAD2, ZLOAD3-B1, VTO1N-B. Actual order: ZSO-VISIBILITY → ZLOAD1 → VA02 → ZSO-VISIBILITY → ZLOAD3-B1 → VTO1N-B

## SAP transactions (instruction payloads)

| # | Transaction | State | Work ID | Enqueued | Finished |
|---|---|---|---|---|---|
| 1 | ZSO-VISIBILITY | done | `moyzzll6` | 2026-05-31T07:42:19.574Z | 2026-05-31T07:42:19.817Z |
| 2 | ZLOAD1 | done | `08zoms0e` | 2026-05-31T07:42:26.417Z | 2026-05-31T07:42:26.665Z |
| 3 | VA02 | done | `ujss3v7m` | 2026-05-31T07:42:39.261Z | 2026-05-31T07:42:39.479Z |
| 4 | ZSO-VISIBILITY | done | `biugh0i8` | 2026-05-31T07:42:45.811Z | 2026-05-31T07:42:46.050Z |
| 5 | ZLOAD3-B1 | done | `lixj428e` | 2026-05-31T07:43:02.696Z | 2026-05-31T07:43:02.930Z |
| 6 | VTO1N-B | done | `9bn3vyw9` | 2026-05-31T07:43:05.723Z | 2026-05-31T07:43:05.937Z |

### Transaction 1 — ZSO-VISIBILITY

- **Work ID**: `cmpth23zq014hsx3pmoyzzll6`
- **State**: done
- **Instruction sent to SAP**:
  ```
  VPN is connected and SAP is logged in. Just go ahead and run the SAP Transaction ZSO-VISIBILITY for Sales order number 3290110.
  ```
- **Structured args**:
  ```json
  {
    "transaction_code": "ZSO-VISIBILITY",
    "meta": {
      "so_number": "3290110"
    }
  }
  ```

### Transaction 2 — ZLOAD1

- **Work ID**: `cmpth299t015vsx3p08zoms0e`
- **State**: done
- **Instruction sent to SAP**:
  ```
  VPN is connected, SAP is logged in. Execute ZLOAD1 for sales order 3290110 (Bundle 1). Materials to dispatch:
  - Material: YE1EDWO00001APJP, Batch: A-26, Quantity: 50
  - Material: YV6FRYENE0000PJP, Batch: 30-07-2025, Quantity: 100
  - Material: YA4COWOCR000043P, Batch: 20, Quantity: 250
  ```
- **Structured args**:
  ```json
  {
    "transaction_code": "ZLOAD1",
    "so_number": "3290110",
    "meta": {
      "so_number": "3290110",
      "bundle_id": "cmpth299o015tsx3pyyyqljuv",
      "bundle_number": 1
    }
  }
  ```

### Transaction 3 — VA02

- **Work ID**: `cmpth2j6k017jsx3pujss3v7m`
- **State**: done
- **Instruction sent to SAP**:
  ```
  VPN is connected and SAP is logged in. Just go ahead and run the SAP Transaction VA02 for Sales Order number 3290110. For material YV6FRYENE0000PJP set the order quantity to 150
  ```
- **Structured args**:
  ```json
  {
    "transaction_code": "VA02",
    "so_number": "3290110",
    "meta": {
      "so_number": "3290110",
      "materials": [
        {
          "material": "YV6FRYENE0000PJP",
          "orderQuantity": 150
        }
      ],
      "payload_key": "{\"soNumber\":\"3290110\",\"materials\":[{\"material\":\"YV6FRYENE0000PJP\",\"orderQuantity\":150}]}"
    }
  }
  ```

### Transaction 4 — ZSO-VISIBILITY

- **Work ID**: `cmpth2o8j0187sx3pbiugh0i8`
- **State**: done
- **Instruction sent to SAP**:
  ```
  VPN is connected and SAP is logged in. Just go ahead and run the SAP Transaction ZSO-VISIBILITY for Sales order number 3290110.
  ```
- **Structured args**:
  ```json
  {
    "transaction_code": "ZSO-VISIBILITY",
    "meta": {
      "so_number": "3290110"
    }
  }
  ```

### Transaction 5 — ZLOAD3-B1

- **Work ID**: `cmpth319k019xsx3plixj428e`
- **State**: done
- **Instruction sent to SAP**:
  ```
  VPN is connected, SAP is logged in. Just execute ZLOAD3-B1 for sales order 3290110 (Bundle 1)
  ```
- **Structured args**:
  ```json
  {
    "transaction_code": "ZLOAD3-B1",
    "so_number": "3290110",
    "attachments": [
      {
        "filename": "373309.pdf",
        "content_base64": "JVBERi0xLjQKJW1vY2stZTJlLXBkZgo="
      },
      {
        "filename": "373310.pdf",
        "content_base64": "JVBERi0xLjQKJW1vY2stZTJlLXBkZgo="
      },
      {
        "filename": "373311.pdf",
        "content_base64": "JVBERi0xLjQKJW1vY2stZTJlLXBkZgo="
      }
    ],
    "extraction_context": "For each file, extract the loading slip number, loaded quantity, invoice number, and invoice date",
    "meta": {
      "so_number": "3290110",
      "bundle_id": "cmpth299o015tsx3pyyyqljuv",
      "bundle_number": 1
    }
  }
  ```

### Transaction 6 — VTO1N-B

- **Work ID**: `cmpth33ln01adsx3p9bn3vyw9`
- **State**: done
- **Instruction sent to SAP**:
  ```
  VPN is connected and SAP is logged in. Just go ahead and run the SAP Transaction VT01N. OBD number is 85817687, LR number is LR-010, LR date is 31.05.2026 and Vehicle number is MH12ST7890
  ```
- **Structured args**:
  ```json
  {
    "transaction_code": "VTO1N-B",
    "so_number": "3290110",
    "extraction_context": "Extract the OBD number, LR number, LR date and Vehicle number",
    "meta": {
      "so_number": "3290110",
      "shipment_id": "cmpth31fi01a7sx3px8ziva71",
      "bundle_id": "cmpth299o015tsx3pyyyqljuv",
      "bundle_number": 1,
      "obd_number": "85817687"
    }
  }
  ```

## Event chain (audit trail)

```
[T+0:00:00] email_received       from branch — Subject "NEW ORDER 3290110" — "Dear Sales Team, Please create SO 3290110 for customer TEST-CUST-POST-INC. Mate…"
[T+0:00:00] classifier_decision  action=new_order
[T+0:00:00] step_completed       zso_visibility ✓ — materials YE1EDWO00001APJP=50, YV6FRYENE0000PJP=100, YA4COWOCR000043P=250
[T+0:00:00] email_sent           ls_dispatch to test-branch@example.com — "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-178021333…"
[T+0:00:00] step_completed       zso_visibility ✓
[T+0:00:00] email_received       from branch — Subject "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-178021333…" — "Confirmed."
[T+0:00:03] classifier_decision  llm-planned
[T+0:00:03] scenario_started     llm-planned
[T+0:00:03] step_fired           email_confirm_bundle_details
[T+0:00:03] email_sent           dispatch_confirmation to test-branch@example.com — "Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780213338425"
[T+0:00:03] step_completed       email_confirm_bundle_details ✓
[T+0:00:03] scenario_completed   llm-planned
[T+0:00:04] email_received       from branch — Subject "Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780213338425" — "Confirmed."
[T+0:00:06] classifier_decision  llm-planned
[T+0:00:06] scenario_started     llm-planned
[T+0:00:06] step_fired           zload1
[T+0:00:07] email_sent           vehicle_details to test-branch@example.com — "Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780213338…"
[T+0:00:07] step_completed       zload1 ✓ — LS 373311:PENDING=?, 373310:PENDING=?, 373309:PENDING=?
[T+0:00:07] step_fired           email_to_branch_for_vehicle
[T+0:00:07] step_completed       email_to_branch_for_vehicle ✓
[T+0:00:07] scenario_completed   llm-planned
[T+0:00:07] email_received       from branch — Subject "Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780213338…" — "Vehicle: MH12ST7890, Driver: 9555555555, LR: LR-010 dated 2026-05-31"
[T+0:00:09] classifier_decision  llm-planned
[T+0:00:09] scenario_started     llm-planned
[T+0:00:09] step_fired           email_to_plant
[T+0:00:11] email_sent           plant_ls to test-plant@example.com — "Loading Slip 373309 - SO 3290110"
[T+0:00:11] email_sent           plant_ls to test-plant@example.com — "Loading Slip 373310 - SO 3290110"
[T+0:00:11] email_sent           plant_ls to test-plant@example.com — "Loading Slip 373311 - SO 3290110"
[T+0:00:11] step_completed       email_to_plant ✓
[T+0:00:11] scenario_completed   llm-planned
[T+0:00:12] email_received       from branch — Subject "Loading Slip 373311 - SO 3290110" — "Increase YV6FRYENE0000PJP (M-B) from 100 to 150 — we have stock available."
[T+0:00:15] classifier_decision  llm-planned
[T+0:00:15] scenario_started     llm-planned
[T+0:00:15] step_fired           stock_precheck
[T+0:00:17] step_completed       stock_precheck ✓
[T+0:00:17] step_fired           va02
[T+0:00:19] step_completed       va02 ✓ — materials YE1EDWO00001APJP=50, YV6FRYENE0000PJP=100, YA4COWOCR000043P=250
[T+0:00:19] step_fired           email_2nd_release
[T+0:00:22] email_sent           2nd_release to test-branch@example.com — "2nd Release Confirmation - SO 3290110"
[T+0:00:22] step_completed       email_2nd_release ✓
[T+0:00:22] scenario_completed   llm-planned
[T+0:00:22] email_received       from branch — Subject "2nd Release Confirmation - SO 3290110" — "Yes, do the second release."
[T+0:00:26] classifier_decision  llm-planned
[T+0:00:26] scenario_started     llm-planned
[T+0:00:26] step_fired           zso_visibility
[T+0:00:26] step_completed       zso_visibility ✓ — materials YE1EDWO00001APJP=50, YV6FRYENE0000PJP=100, YA4COWOCR000043P=250
[T+0:00:26] email_sent           ls_dispatch to test-branch@example.com — "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-178021333…"
[T+0:00:26] step_completed       zso_visibility ✓ — materials YE1EDWO00001APJP=50, YV6FRYENE0000PJP=100, YA4COWOCR000043P=250
[T+0:00:26] scenario_completed   llm-planned
[T+0:00:27] email_received       from branch — Subject "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-178021333…" — "Confirmed. The updated product plan looks good. Proceed."
[T+0:00:30] classifier_decision  llm-planned
[T+0:00:30] scenario_started     llm-planned
[T+0:00:30] step_fired           zload2
[T+0:00:32] step_completed       zload2 ✓ — LS 373311:PENDING=?, 373310:PENDING=?, 373309:PENDING=?
[T+0:00:32] step_fired           email_to_plant
[T+0:00:33] step_completed       email_to_plant ✓
[T+0:00:33] scenario_completed   llm-planned
[T+0:00:34] email_received       from branch — Subject "Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780213338425" — "Confirmed. Proceed with revised bundle plan."
[T+0:00:37] classifier_decision  llm-planned
[T+0:00:37] scenario_started     llm-planned
[T+0:00:37] step_fired           email_to_plant
[T+0:00:38] step_completed       email_to_plant ✓
[T+0:00:38] scenario_completed   llm-planned
[T+0:00:39] email_received       from plant — Subject "Loading Slip 373311 - SO 3290110" — "Invoice 7682614529 OBD 5070000132 attached."
[T+0:00:43] classifier_decision  llm-planned
[T+0:00:43] scenario_started     llm-planned
[T+0:00:43] step_fired           process_plant_invoice
[T+0:00:43] step_completed       process_plant_invoice ✓
[T+0:00:43] scenario_completed   llm-planned
[T+0:00:43] step_completed       process_plant_invoice ✓
[T+0:00:43] scenario_completed   llm-planned
[T+0:00:43] step_completed       zload3b1 ✓
[T+0:00:46] step_completed       vto1n ✓
```

## Email thread

```
[2026-05-31T07:42:19.807Z] OUTBOUND to test-branch@example.com [type=ls_dispatch] — Subject: "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780213338425"
  Body: Dispatch Recommendation - AUTO-MOCK-NEWORDER-1780213338425 Dear Sales Team, Sales Order 3290110 I have reviewed the stock availability for Sales Order 3290110. Here is the dispatch recommendation: M-A [YE1EDWO00001APJP] : Stock is confirmed available. Proceed with 50 units from Batch A-26. M-B [YV6FRYENE0000PJP] : Stock is confirmed available. Proceed with 100 units from Batch 30-07-2025. M-C [YA4COWOCR000043P] : Stock is confirmed available. Proceed with 250 units from Batch 20. Best regards, Sales Order Dispatch Co-ordinator

[2026-05-31T07:42:19.989Z] INBOUND from test-branch@example.com [type=ls_dispatch] — Subject: "Re: Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780213338425"
  Body: Confirmed.

[2026-05-31T07:42:22.711Z] OUTBOUND to test-branch@example.com [type=dispatch_confirmation] — Subject: "Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780213338425"
  Body: Dear Branch Team, Dispatch plan ready for Purchase Order AUTO-MOCK-NEWORDER-1780213338425 (Customer 1). Total 10.665 t — fits in 1 vehicle (capacity 35 t). Proposed dispatch (grouped by bundle): Bundle 1 — 10.665 t (of 35 t capacity): - SO 3290110 / YA4COWOCR000043P (Batch 20): 250 units, 6.625 t - SO 3290110 / YE1EDWO00001APJP (Batch A-26): 50 units, 1.320 t - SO 3290110 / YV6FRYENE0000PJP (Batch 30-07-2025): 100 units, 2.720 t Please reply with: - "yes" / "confirm" to proceed with the above plan, or - the changes you want (e.g. "skip OOWJ on SO 1234567", "send only 15 of OP7WJ"). Once confirmed we will create the loading slips. Best regards, Sales Order Dispatch Co-ordinator

[2026-05-31T07:42:26.670Z] OUTBOUND to test-branch@example.com [type=vehicle_details] — Subject: "Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780213338425 (1 bundle)"
  Body: Dear Branch Team, Loading slips for Purchase Order AUTO-MOCK-NEWORDER-1780213338425 are now ready in SAP. The PO is split into 1 bundle: Bundle 1 (~10.66 t): - SO 3290110 / LS 373309 / Material PENDING - SO 3290110 / LS 373310 / Material PENDING - SO 3290110 / LS 373311 / Material PENDING Please reply with vehicle/transport details for each bundle in the format below: Bundle 1: , , Best regards, Sales Order Dispatch Co-ordinator

[2026-05-31T07:42:30.602Z] INBOUND from test-branch@example.com [type=vehicle_details] — Subject: "Re: Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780213338425 (1 bundle)"
  Body: Vehicle: MH12ST7890, Driver: 9555555555, LR: LR-010 dated 2026-05-31

[2026-05-31T07:42:42.321Z] OUTBOUND to test-branch@example.com [type=2nd_release] — Subject: "2nd Release Confirmation - SO 3290110"
  Body: Hi, We have updated SO 3290110 with the following changes: - Increase YV6FRYENE0000PJP → 150 Please do the second release and confirm. Thanks.

[2026-05-31T07:42:42.519Z] INBOUND from test-branch@example.com [type=2nd_release] — Subject: "Re: 2nd Release Confirmation - SO 3290110"
  Body: Yes, do the second release.

[2026-05-31T07:42:46.044Z] OUTBOUND to test-branch@example.com [type=ls_dispatch] — Subject: "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780213338425"
  Body: Dispatch Recommendation - AUTO-MOCK-NEWORDER-1780213338425 Dear Sales Team, Sales Order 3290110 I have reviewed the stock availability for Sales Order 3290110. Here is the dispatch recommendation: M-A [YE1EDWO00001APJP] : Stock is confirmed available. Proceed with 50 units from Batch A-26. M-B [YV6FRYENE0000PJP] : Stock is confirmed available. Proceed with 100 units from Batch 30-07-2025. M-C [YA4COWOCR000043P] : Stock is confirmed available. Proceed with 250 units from Batch 20. Best regards, Sales Order Dispatch Co-ordinator

[2026-05-31T07:42:46.824Z] INBOUND from test-branch@example.com [type=ls_dispatch] — Subject: "Re: Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780213338425"
  Body: Confirmed. The updated product plan looks good. Proceed.

[2026-05-31T07:42:54.111Z] INBOUND from test-branch@example.com [type=dispatch_confirmation] — Subject: "Re: Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780213338425"
  Body: Confirmed. Proceed with revised bundle plan.

[2026-05-31T07:42:58.674Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373309 - SO 3290110"
  Body: Invoice 7682614529 OBD 5070000132 attached.

[2026-05-31T07:42:58.674Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373310 - SO 3290110"
  Body: Invoice 7682614529 OBD 5070000132 attached.

[2026-05-31T07:42:58.674Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373311 - SO 3290110"
  Body: Invoice 7682614529 OBD 5070000132 attached.
```

## Final DB state

- **SO.status**: completed
- **PO.dispatchRound**: 2
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
[2026-05-31T07:42:18.425Z] Pushing NEW ORDER for SO 3290110
[2026-05-31T07:42:19.580Z] SO row created — soId=cmpth23zf014bsx3pxbr7ebq0 poId=cmpth23zb0149sx3p60mq3tza
[2026-05-31T07:42:19.580Z] Step 1/8: waiting for outbound "ls_dispatch" (timeout 30000ms)
[2026-05-31T07:42:19.988Z] Step 1: targeting email ndxvaqnc with reply: "Confirmed."
[2026-05-31T07:42:22.716Z] Step 1: handleReplyV2 returned matched=true
[2026-05-31T07:42:23.720Z] Step 2/8: waiting for outbound "dispatch_confirmation" (timeout 30000ms)
[2026-05-31T07:42:23.722Z] Step 2: targeting email 501w0pux with reply: "Confirmed."
[2026-05-31T07:42:26.422Z] Step 2: handleReplyV2 returned matched=true
[2026-05-31T07:42:27.426Z] Step 3/8: waiting for outbound "vehicle_details" (timeout 30000ms)
[2026-05-31T07:42:27.427Z] Step 3: targeting email eteo8oxt with reply: "Vehicle: MH12ST7890, Driver: 9555555555, LR: LR-010 dated 2026-05-31"
[2026-05-31T07:42:30.620Z] Step 3: handleReplyV2 returned matched=true
[2026-05-31T07:42:30.622Z]   [operator input sim] persisted lrNumber=LR-010 lrDate=2026-05-31 on SO
[2026-05-31T07:42:31.626Z] Step 4/8: waiting for outbound "plant_ls" (timeout 30000ms)
[2026-05-31T07:42:31.629Z] Step 4: targeting email qbb9xqtp with reply: "Increase YV6FRYENE0000PJP (M-B) from 100 to 150 — we have stock available."
[2026-05-31T07:42:39.269Z] Step 4: handleReplyV2 returned matched=true
[2026-05-31T07:42:40.274Z] Step 5/8: waiting for outbound "2nd_release" (timeout 30000ms)
[2026-05-31T07:42:42.519Z] Step 5: targeting email 8whzvjwm with reply: "Yes, do the second release."
[2026-05-31T07:42:45.816Z] Step 5: handleReplyV2 returned matched=true
[2026-05-31T07:42:46.820Z] Step 6/8: waiting for outbound "ls_dispatch" (timeout 30000ms)
[2026-05-31T07:42:46.823Z] Step 6: targeting email ie96yl4x with reply: "Confirmed. The updated product plan looks good. Proceed."
[2026-05-31T07:42:53.103Z] Step 6: handleReplyV2 returned matched=true
[2026-05-31T07:42:54.108Z] Step 7/8: waiting for outbound "dispatch_confirmation" (timeout 30000ms)
[2026-05-31T07:42:54.111Z] Step 7: targeting email 501w0pux with reply: "Confirmed. Proceed with revised bundle plan."
[2026-05-31T07:42:57.664Z] Step 7: handleReplyV2 returned matched=true
[2026-05-31T07:42:58.667Z] Step 8/8: waiting for outbound "plant_ls" (timeout 30000ms)
[2026-05-31T07:42:58.669Z] Step 8: targeting email qbb9xqtp with reply: "Invoice 7682614529 OBD 5070000132 attached."
[2026-05-31T07:42:58.676Z]   [plant invoice sim] marked 3 plant_ls Email row(s) in bundle yyyqljuv as replied with mock PDF URL
[2026-05-31T07:43:02.710Z] Step 8: handleReplyV2 returned matched=true
[2026-05-31T07:43:05.716Z] Shipment(s) created (1); simulating operator VT01N click per shipment
[2026-05-31T07:43:05.729Z]   triggerVto1n(x8ziva71) enqueued (obd=85817687)
```
