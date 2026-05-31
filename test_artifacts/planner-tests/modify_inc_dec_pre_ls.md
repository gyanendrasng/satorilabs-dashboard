# Test case: modify_inc_dec_pre_ls

**Description**: Branch asks to increase M-A 50→80 AND decrease M-B 100→60 BEFORE LS. VA02 fires only for increase.
**SO Number**: 3290105
**Customer**: TEST-CUST-MOD-INC-DEC
**Started**: 2026-05-31T12:10:44.898Z
**Finished**: 2026-05-31T12:11:22.011Z (duration 37.1s)
**Result**: ✅ PASS

## SAP transactions (instruction payloads)

| # | Transaction | State | Work ID | Enqueued | Finished |
|---|---|---|---|---|---|
| 1 | ZSO-VISIBILITY | done | `d40yyeo9` | 2026-05-31T12:10:45.729Z | 2026-05-31T12:10:45.957Z |
| 2 | VA02 | done | `qkv22p3d` | 2026-05-31T12:10:55.506Z | 2026-05-31T12:10:55.724Z |
| 3 | ZSO-VISIBILITY | done | `c9dcgzms` | 2026-05-31T12:11:01.248Z | 2026-05-31T12:11:01.487Z |
| 4 | ZLOAD1 | done | `jakincbd` | 2026-05-31T12:11:08.507Z | 2026-05-31T12:11:08.767Z |
| 5 | ZLOAD3-B1 | done | `q904p6us` | 2026-05-31T12:11:17.064Z | 2026-05-31T12:11:17.293Z |
| 6 | VTO1N-B | done | `t0oede8x` | 2026-05-31T12:11:20.095Z | 2026-05-31T12:11:20.301Z |

### Transaction 1 — ZSO-VISIBILITY

- **Work ID**: `cmptqnbkw00husx7bd40yyeo9`
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

- **Work ID**: `cmptqnj4i00iqsx7bqkv22p3d`
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

- **Work ID**: `cmptqnnk000jesx7bc9dcgzms`
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

- **Work ID**: `cmptqnt5m00kusx7bjakincbd`
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
      "bundle_id": "cmptqnt5g00kssx7bgrorudi4",
      "bundle_number": 1
    }
  }
  ```

### Transaction 5 — ZLOAD3-B1

- **Work ID**: `cmptqnzrb00mksx7bq904p6us`
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
      "bundle_id": "cmptqnt5g00kssx7bgrorudi4",
      "bundle_number": 1
    }
  }
  ```

### Transaction 6 — VTO1N-B

- **Work ID**: `cmptqo23j00n0sx7bt0oede8x`
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
      "shipment_id": "cmptqnzx800musx7bmrsa3yqn",
      "bundle_id": "cmptqnt5g00kssx7bgrorudi4",
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
[T+0:00:00] email_sent           ls_dispatch to test-branch@example.com — "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-178022944…"
[T+0:00:00] step_completed       zso_visibility ✓
[T+0:00:00] email_received       from branch — Subject "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-178022944…" — "Two changes: increase YE1EDWO00001APJP (M-A) from 50 to 80, and reduce YV6FRYEN…"
[T+0:00:04] classifier_decision  llm-planned
[T+0:00:04] scenario_started     llm-planned
[T+0:00:04] step_fired           stock_precheck
[T+0:00:06] step_completed       stock_precheck ✓
[T+0:00:06] step_fired           va02
[T+0:00:10] step_completed       va02 ✓ — materials YE1EDWO00001APJP=?, YV6FRYENE0000PJP=?, YA4COWOCR000043P=?
[T+0:00:10] step_fired           email_2nd_release
[T+0:00:12] email_sent           2nd_release to test-branch@example.com — "2nd Release Confirmation - SO 3290105"
[T+0:00:12] step_completed       email_2nd_release ✓
[T+0:00:12] scenario_completed   llm-planned
[T+0:00:12] email_received       from branch — Subject "2nd Release Confirmation - SO 3290105" — "Yes, do the second release."
[T+0:00:15] classifier_decision  llm-planned
[T+0:00:15] scenario_started     llm-planned
[T+0:00:15] step_fired           zso_visibility
[T+0:00:15] step_completed       zso_visibility ✓ — materials YE1EDWO00001APJP=50, YV6FRYENE0000PJP=100, YA4COWOCR000043P=250
[T+0:00:15] email_sent           ls_dispatch to test-branch@example.com — "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-178022944…"
[T+0:00:15] step_completed       zso_visibility ✓ — materials YE1EDWO00001APJP=50, YV6FRYENE0000PJP=100, YA4COWOCR000043P=250
[T+0:00:15] scenario_completed   llm-planned
[T+0:00:16] email_received       from branch — Subject "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-178022944…" — "Confirmed. Proceed."
[T+0:00:19] classifier_decision  llm-planned
[T+0:00:19] scenario_started     llm-planned
[T+0:00:19] step_fired           email_confirm_bundle_details
[T+0:00:19] email_sent           dispatch_confirmation to test-branch@example.com — "Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780229444910"
[T+0:00:19] step_completed       email_confirm_bundle_details ✓
[T+0:00:19] scenario_completed   llm-planned
[T+0:00:20] email_received       from branch — Subject "Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780229444910" — "Confirmed."
[T+0:00:22] classifier_decision  llm-planned
[T+0:00:22] scenario_started     llm-planned
[T+0:00:22] step_fired           zload1
[T+0:00:23] email_sent           vehicle_details to test-branch@example.com — "Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780229444…"
[T+0:00:23] step_completed       zload1 ✓ — LS 373296:PENDING=?, 373295:PENDING=?, 373294:PENDING=?
[T+0:00:23] step_fired           email_to_branch_for_vehicle
[T+0:00:23] step_completed       email_to_branch_for_vehicle ✓
[T+0:00:23] scenario_completed   llm-planned
[T+0:00:23] email_received       from branch — Subject "Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780229444…" — "Vehicle: MH12IJ7890, Driver: 9000000000, LR: LR-005 dated 2026-05-31"
[T+0:00:26] classifier_decision  llm-planned
[T+0:00:26] scenario_started     llm-planned
[T+0:00:26] step_fired           email_to_plant
[T+0:00:27] email_sent           plant_ls to test-plant@example.com — "Loading Slip 373294 - SO 3290105"
[T+0:00:27] email_sent           plant_ls to test-plant@example.com — "Loading Slip 373295 - SO 3290105"
[T+0:00:27] email_sent           plant_ls to test-plant@example.com — "Loading Slip 373296 - SO 3290105"
[T+0:00:27] step_completed       email_to_plant ✓
[T+0:00:27] scenario_completed   llm-planned
[T+0:00:28] email_received       from plant — Subject "Loading Slip 373296 - SO 3290105" — "Invoice 7682614524 OBD 5070000127 attached."
[T+0:00:31] classifier_decision  llm-planned
[T+0:00:31] scenario_started     llm-planned
[T+0:00:31] step_fired           process_plant_invoice
[T+0:00:31] step_completed       process_plant_invoice ✓
[T+0:00:31] scenario_completed   llm-planned
[T+0:00:31] step_completed       process_plant_invoice ✓
[T+0:00:31] scenario_completed   llm-planned
[T+0:00:31] step_completed       zload3b1 ✓
[T+0:00:34] step_completed       vto1n ✓
```

## Email thread

```
[2026-05-31T12:10:45.952Z] OUTBOUND to test-branch@example.com [type=ls_dispatch] — Subject: "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780229444910"
  Body: Dispatch Recommendation - AUTO-MOCK-NEWORDER-1780229444910 Dear Sales Team, Sales Order 3290105 I have reviewed the stock availability for Sales Order 3290105. Here is the dispatch recommendation: M-A [YE1EDWO00001APJP] : Stock is confirmed available. Proceed with 50 units from Batch A-26. M-B [YV6FRYENE0000PJP] : Stock is confirmed available. Proceed with 100 units from Batch 30-07-2025. M-C [YA4COWOCR000043P] : Stock is confirmed available. Proceed with 250 units from Batch 20. Best regards, Sales Order Dispatch Co-ordinator

[2026-05-31T12:10:46.138Z] INBOUND from test-branch@example.com [type=ls_dispatch] — Subject: "Re: Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780229444910"
  Body: Two changes: increase YE1EDWO00001APJP (M-A) from 50 to 80, and reduce YV6FRYENE0000PJP (M-B) from 100 to 60.

[2026-05-31T12:10:58.058Z] OUTBOUND to test-branch@example.com [type=2nd_release] — Subject: "2nd Release Confirmation - SO 3290105"
  Body: Hi, We have updated SO 3290105 with the following changes: - Increase YE1EDWO00001APJP → 80 - Decrease YV6FRYENE0000PJP → 60 Please do the second release and confirm. Thanks.

[2026-05-31T12:10:58.153Z] INBOUND from test-branch@example.com [type=2nd_release] — Subject: "Re: 2nd Release Confirmation - SO 3290105"
  Body: Yes, do the second release.

[2026-05-31T12:11:01.480Z] OUTBOUND to test-branch@example.com [type=ls_dispatch] — Subject: "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780229444910"
  Body: Dispatch Recommendation - AUTO-MOCK-NEWORDER-1780229444910 Dear Sales Team, Sales Order 3290105 I have reviewed the stock availability for Sales Order 3290105. Here is the dispatch recommendation: M-A [YE1EDWO00001APJP] : Stock is confirmed available. Proceed with 50 units from Batch A-26. M-B [YV6FRYENE0000PJP] : Stock is confirmed available. Proceed with 100 units from Batch 30-07-2025. M-C [YA4COWOCR000043P] : Stock is confirmed available. Proceed with 250 units from Batch 20. Best regards, Sales Order Dispatch Co-ordinator

[2026-05-31T12:11:02.255Z] INBOUND from test-branch@example.com [type=ls_dispatch] — Subject: "Re: Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780229444910"
  Body: Confirmed. Proceed.

[2026-05-31T12:11:04.934Z] OUTBOUND to test-branch@example.com [type=dispatch_confirmation] — Subject: "Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780229444910"
  Body: Dear Branch Team, Dispatch plan ready for Purchase Order AUTO-MOCK-NEWORDER-1780229444910 (Customer 1). Total 10.665 t — fits in 1 vehicle (capacity 35 t). Proposed dispatch (grouped by bundle): Bundle 1 — 10.665 t (of 35 t capacity): - SO 3290105 / YA4COWOCR000043P (Batch 20): 250 units, 6.625 t - SO 3290105 / YE1EDWO00001APJP (Batch A-26): 50 units, 1.320 t - SO 3290105 / YV6FRYENE0000PJP (Batch 30-07-2025): 100 units, 2.720 t Please reply with: - "yes" / "confirm" to proceed with the above plan, or - the changes you want (e.g. "skip OOWJ on SO 1234567", "send only 15 of OP7WJ"). Once confirmed we will create the loading slips. Best regards, Sales Order Dispatch Co-ordinator

[2026-05-31T12:11:05.942Z] INBOUND from test-branch@example.com [type=dispatch_confirmation] — Subject: "Re: Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780229444910"
  Body: Confirmed.

[2026-05-31T12:11:08.783Z] OUTBOUND to test-branch@example.com [type=vehicle_details] — Subject: "Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780229444910 (1 bundle)"
  Body: Dear Branch Team, Loading slips for Purchase Order AUTO-MOCK-NEWORDER-1780229444910 are now ready in SAP. The PO is split into 1 bundle: Bundle 1 (~10.66 t): - SO 3290105 / LS 373294 / Material PENDING - SO 3290105 / LS 373295 / Material PENDING - SO 3290105 / LS 373296 / Material PENDING Please reply with vehicle/transport details for each bundle in the format below: Bundle 1: , , Best regards, Sales Order Dispatch Co-ordinator

[2026-05-31T12:11:13.028Z] INBOUND from test-branch@example.com [type=vehicle_details] — Subject: "Re: Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780229444910 (1 bundle)"
  Body: Vehicle: MH12IJ7890, Driver: 9000000000, LR: LR-005 dated 2026-05-31

[2026-05-31T12:11:14.063Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373294 - SO 3290105"
  Body: Invoice 7682614524 OBD 5070000127 attached.

[2026-05-31T12:11:14.063Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373295 - SO 3290105"
  Body: Invoice 7682614524 OBD 5070000127 attached.

[2026-05-31T12:11:14.063Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373296 - SO 3290105"
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
[2026-05-31T12:10:44.910Z] Pushing NEW ORDER for SO 3290105
[2026-05-31T12:10:45.732Z] SO row created — soId=cmptqnbkm00hosx7bkbychmsf poId=cmptqnbkk00hmsx7b9xnsiu8i
[2026-05-31T12:10:45.732Z] Step 1/6: waiting for outbound "ls_dispatch" (timeout 30000ms)
[2026-05-31T12:10:46.138Z] Step 1: targeting email re23o1bt with reply: "Two changes: increase YE1EDWO00001APJP (M-A) from 50 to 80, and reduce YV6FRYENE"
[2026-05-31T12:10:55.514Z] Step 1: handleReplyV2 returned matched=true
[2026-05-31T12:10:56.519Z] Step 2/6: waiting for outbound "2nd_release" (timeout 30000ms)
[2026-05-31T12:10:58.153Z] Step 2: targeting email kpitkzce with reply: "Yes, do the second release."
[2026-05-31T12:11:01.253Z] Step 2: handleReplyV2 returned matched=true
[2026-05-31T12:11:02.255Z] Step 3/6: waiting for outbound "ls_dispatch" (timeout 30000ms)
[2026-05-31T12:11:02.255Z] Step 3: targeting email a7r0dkvf with reply: "Confirmed. Proceed."
[2026-05-31T12:11:04.938Z] Step 3: handleReplyV2 returned matched=true
[2026-05-31T12:11:05.941Z] Step 4/6: waiting for outbound "dispatch_confirmation" (timeout 30000ms)
[2026-05-31T12:11:05.942Z] Step 4: targeting email jzejmiat with reply: "Confirmed."
[2026-05-31T12:11:08.516Z] Step 4: handleReplyV2 returned matched=true
[2026-05-31T12:11:09.522Z] Step 5/6: waiting for outbound "vehicle_details" (timeout 30000ms)
[2026-05-31T12:11:09.525Z] Step 5: targeting email u7u65qw9 with reply: "Vehicle: MH12IJ7890, Driver: 9000000000, LR: LR-005 dated 2026-05-31"
[2026-05-31T12:11:13.048Z] Step 5: handleReplyV2 returned matched=true
[2026-05-31T12:11:13.049Z]   [operator input sim] persisted lrNumber=LR-005 lrDate=2026-05-31 on SO
[2026-05-31T12:11:14.054Z] Step 6/6: waiting for outbound "plant_ls" (timeout 30000ms)
[2026-05-31T12:11:14.057Z] Step 6: targeting email 5kiq5vkw with reply: "Invoice 7682614524 OBD 5070000127 attached."
[2026-05-31T12:11:14.064Z]   [plant invoice sim] marked 3 plant_ls Email row(s) in bundle grorudi4 as replied with mock PDF URL
[2026-05-31T12:11:17.083Z] Step 6: handleReplyV2 returned matched=true
[2026-05-31T12:11:20.090Z] Shipment(s) created (1); simulating operator VT01N click per shipment
[2026-05-31T12:11:20.098Z]   triggerVto1n(mrsa3yqn) enqueued (obd=85817683)
```
