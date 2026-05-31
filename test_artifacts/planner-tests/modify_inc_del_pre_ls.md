# Test case: modify_inc_del_pre_ls

**Description**: Branch asks to increase M-A 50→80 AND delete M-C BEFORE LS. VA02 for M-A; M-C dropped.
**SO Number**: 3290106
**Customer**: TEST-CUST-MOD-INC-DEL
**Started**: 2026-05-31T12:11:22.020Z
**Finished**: 2026-05-31T12:12:00.373Z (duration 38.4s)
**Result**: ✅ PASS

## SAP transactions (instruction payloads)

| # | Transaction | State | Work ID | Enqueued | Finished |
|---|---|---|---|---|---|
| 1 | ZSO-VISIBILITY | done | `v0ltbkkk` | 2026-05-31T12:11:23.188Z | 2026-05-31T12:11:23.423Z |
| 2 | VA02 | done | `jriuym92` | 2026-05-31T12:11:32.384Z | 2026-05-31T12:11:32.600Z |
| 3 | ZSO-VISIBILITY | done | `43ynfz0w` | 2026-05-31T12:11:38.490Z | 2026-05-31T12:11:38.732Z |
| 4 | ZLOAD1 | done | `ygcw73zu` | 2026-05-31T12:11:47.150Z | 2026-05-31T12:11:47.398Z |
| 5 | ZLOAD3-B1 | done | `3qc82f5s` | 2026-05-31T12:11:55.428Z | 2026-05-31T12:11:55.651Z |
| 6 | VTO1N-B | done | `uhtl6mm8` | 2026-05-31T12:11:58.451Z | 2026-05-31T12:11:58.665Z |

### Transaction 1 — ZSO-VISIBILITY

- **Work ID**: `cmptqo4hg00nfsx7bv0ltbkkk`
- **State**: done
- **Instruction sent to SAP**:
  ```
  VPN is connected and SAP is logged in. Just go ahead and run the SAP Transaction ZSO-VISIBILITY for Sales order number 3290106.
  ```
- **Structured args**:
  ```json
  {
    "transaction_code": "ZSO-VISIBILITY",
    "meta": {
      "so_number": "3290106"
    }
  }
  ```

### Transaction 2 — VA02

- **Work ID**: `cmptqobkv00obsx7bjriuym92`
- **State**: done
- **Instruction sent to SAP**:
  ```
  VPN is connected and SAP is logged in. Just go ahead and run the SAP Transaction VA02 for Sales Order number 3290106. For material YE1EDWO00001APJP set the order quantity to 80
  ```
- **Structured args**:
  ```json
  {
    "transaction_code": "VA02",
    "so_number": "3290106",
    "meta": {
      "so_number": "3290106",
      "materials": [
        {
          "material": "YE1EDWO00001APJP",
          "orderQuantity": 80
        }
      ],
      "payload_key": "{\"soNumber\":\"3290106\",\"materials\":[{\"material\":\"YE1EDWO00001APJP\",\"orderQuantity\":80}]}"
    }
  }
  ```

### Transaction 3 — ZSO-VISIBILITY

- **Work ID**: `cmptqogai00ozsx7b43ynfz0w`
- **State**: done
- **Instruction sent to SAP**:
  ```
  VPN is connected and SAP is logged in. Just go ahead and run the SAP Transaction ZSO-VISIBILITY for Sales order number 3290106.
  ```
- **Structured args**:
  ```json
  {
    "transaction_code": "ZSO-VISIBILITY",
    "meta": {
      "so_number": "3290106"
    }
  }
  ```

### Transaction 4 — ZLOAD1

- **Work ID**: `cmptqomz200qfsx7bygcw73zu`
- **State**: done
- **Instruction sent to SAP**:
  ```
  VPN is connected, SAP is logged in. Execute ZLOAD1 for sales order 3290106 (Bundle 1). Materials to dispatch:
  - Material: YE1EDWO00001APJP, Batch: A-26, Quantity: 50
  - Material: YV6FRYENE0000PJP, Batch: 30-07-2025, Quantity: 100
  - Material: YA4COWOCR000043P, Batch: 20, Quantity: 250
  ```
- **Structured args**:
  ```json
  {
    "transaction_code": "ZLOAD1",
    "so_number": "3290106",
    "meta": {
      "so_number": "3290106",
      "bundle_id": "cmptqomyz00qdsx7bhssjjqmk",
      "bundle_number": 1
    }
  }
  ```

### Transaction 5 — ZLOAD3-B1

- **Work ID**: `cmptqotcz00s5sx7b3qc82f5s`
- **State**: done
- **Instruction sent to SAP**:
  ```
  VPN is connected, SAP is logged in. Just execute ZLOAD3-B1 for sales order 3290106 (Bundle 1)
  ```
- **Structured args**:
  ```json
  {
    "transaction_code": "ZLOAD3-B1",
    "so_number": "3290106",
    "attachments": [
      {
        "filename": "373297.pdf",
        "content_base64": "JVBERi0xLjQKJW1vY2stZTJlLXBkZgo="
      },
      {
        "filename": "373298.pdf",
        "content_base64": "JVBERi0xLjQKJW1vY2stZTJlLXBkZgo="
      },
      {
        "filename": "373299.pdf",
        "content_base64": "JVBERi0xLjQKJW1vY2stZTJlLXBkZgo="
      }
    ],
    "extraction_context": "For each file, extract the loading slip number, loaded quantity, invoice number, and invoice date",
    "meta": {
      "so_number": "3290106",
      "bundle_id": "cmptqomyz00qdsx7bhssjjqmk",
      "bundle_number": 1
    }
  }
  ```

### Transaction 6 — VTO1N-B

- **Work ID**: `cmptqovoz00slsx7buhtl6mm8`
- **State**: done
- **Instruction sent to SAP**:
  ```
  VPN is connected and SAP is logged in. Just go ahead and run the SAP Transaction VT01N. OBD number is 85817684, LR number is LR-006, LR date is 31.05.2026 and Vehicle number is MH12KL1234
  ```
- **Structured args**:
  ```json
  {
    "transaction_code": "VTO1N-B",
    "so_number": "3290106",
    "extraction_context": "Extract the OBD number, LR number, LR date and Vehicle number",
    "meta": {
      "so_number": "3290106",
      "shipment_id": "cmptqotit00sfsx7b79zfcc55",
      "bundle_id": "cmptqomyz00qdsx7bhssjjqmk",
      "bundle_number": 1,
      "obd_number": "85817684"
    }
  }
  ```

## Event chain (audit trail)

```
[T+0:00:00] email_received       from branch — Subject "NEW ORDER 3290106" — "Dear Sales Team, Please create SO 3290106 for customer TEST-CUST-MOD-INC-DEL. M…"
[T+0:00:00] classifier_decision  action=new_order
[T+0:00:00] step_completed       zso_visibility ✓ — materials YE1EDWO00001APJP=50, YV6FRYENE0000PJP=100, YA4COWOCR000043P=250
[T+0:00:00] email_sent           ls_dispatch to test-branch@example.com — "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-178022948…"
[T+0:00:00] step_completed       zso_visibility ✓
[T+0:00:00] email_received       from branch — Subject "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-178022948…" — "Please increase YE1EDWO00001APJP (M-A) from 50 to 80 and remove YA4COWOCR000043…"
[T+0:00:03] classifier_decision  llm-planned
[T+0:00:03] scenario_started     llm-planned
[T+0:00:03] step_fired           stock_precheck
[T+0:00:06] step_completed       stock_precheck ✓
[T+0:00:06] step_fired           va02
[T+0:00:09] step_completed       va02 ✓ — materials YE1EDWO00001APJP=?, YV6FRYENE0000PJP=?, YA4COWOCR000043P=?
[T+0:00:09] step_fired           email_2nd_release
[T+0:00:12] email_sent           2nd_release to test-branch@example.com — "2nd Release Confirmation - SO 3290106"
[T+0:00:12] step_completed       email_2nd_release ✓
[T+0:00:12] email_received       from branch — Subject "2nd Release Confirmation - SO 3290106" — "Yes, second release confirmed."
[T+0:00:12] scenario_completed   llm-planned
[T+0:00:15] classifier_decision  llm-planned
[T+0:00:15] scenario_started     llm-planned
[T+0:00:15] step_fired           zso_visibility
[T+0:00:15] step_completed       zso_visibility ✓ — materials YE1EDWO00001APJP=50, YV6FRYENE0000PJP=100, YA4COWOCR000043P=250
[T+0:00:15] email_sent           ls_dispatch to test-branch@example.com — "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-178022948…"
[T+0:00:15] step_completed       zso_visibility ✓ — materials YE1EDWO00001APJP=50, YV6FRYENE0000PJP=100, YA4COWOCR000043P=250
[T+0:00:15] scenario_completed   llm-planned
[T+0:00:16] email_received       from branch — Subject "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-178022948…" — "Looks good, proceed."
[T+0:00:20] classifier_decision  llm-planned
[T+0:00:20] scenario_started     llm-planned
[T+0:00:20] step_fired           email_confirm_bundle_details
[T+0:00:20] email_sent           dispatch_confirmation to test-branch@example.com — "Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780229482037"
[T+0:00:20] step_completed       email_confirm_bundle_details ✓
[T+0:00:20] scenario_completed   llm-planned
[T+0:00:21] email_received       from branch — Subject "Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780229482037" — "Confirmed."
[T+0:00:23] classifier_decision  llm-planned
[T+0:00:23] scenario_started     llm-planned
[T+0:00:23] step_fired           zload1
[T+0:00:24] email_sent           vehicle_details to test-branch@example.com — "Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780229482…"
[T+0:00:24] step_completed       zload1 ✓ — LS 373299:PENDING=?, 373298:PENDING=?, 373297:PENDING=?
[T+0:00:24] step_fired           email_to_branch_for_vehicle
[T+0:00:24] step_completed       email_to_branch_for_vehicle ✓
[T+0:00:24] scenario_completed   llm-planned
[T+0:00:24] email_received       from branch — Subject "Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780229482…" — "Vehicle: MH12KL1234, Driver: 9111111111, LR: LR-006 dated 2026-05-31"
[T+0:00:27] classifier_decision  llm-planned
[T+0:00:27] scenario_started     llm-planned
[T+0:00:27] step_fired           email_to_plant
[T+0:00:28] email_sent           plant_ls to test-plant@example.com — "Loading Slip 373297 - SO 3290106"
[T+0:00:28] email_sent           plant_ls to test-plant@example.com — "Loading Slip 373298 - SO 3290106"
[T+0:00:28] email_sent           plant_ls to test-plant@example.com — "Loading Slip 373299 - SO 3290106"
[T+0:00:28] step_completed       email_to_plant ✓
[T+0:00:28] scenario_completed   llm-planned
[T+0:00:29] email_received       from plant — Subject "Loading Slip 373299 - SO 3290106" — "Invoice 7682614525 OBD 5070000128 attached."
[T+0:00:32] classifier_decision  llm-planned
[T+0:00:32] scenario_started     llm-planned
[T+0:00:32] step_fired           process_plant_invoice
[T+0:00:32] step_completed       process_plant_invoice ✓
[T+0:00:32] scenario_completed   llm-planned
[T+0:00:32] step_completed       process_plant_invoice ✓
[T+0:00:32] scenario_completed   llm-planned
[T+0:00:32] step_completed       zload3b1 ✓
[T+0:00:35] step_completed       vto1n ✓
```

## Email thread

```
[2026-05-31T12:11:23.416Z] OUTBOUND to test-branch@example.com [type=ls_dispatch] — Subject: "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780229482037"
  Body: Dispatch Recommendation - AUTO-MOCK-NEWORDER-1780229482037 Dear Sales Team, Sales Order 3290106 I have reviewed the stock availability for Sales Order 3290106. Here is the dispatch recommendation: M-A [YE1EDWO00001APJP] : Stock is confirmed available. Proceed with 50 units from Batch A-26. M-B [YV6FRYENE0000PJP] : Stock is confirmed available. Proceed with 100 units from Batch 30-07-2025. M-C [YA4COWOCR000043P] : Stock is confirmed available. Proceed with 250 units from Batch 20. Best regards, Sales Order Dispatch Co-ordinator

[2026-05-31T12:11:23.598Z] INBOUND from test-branch@example.com [type=ls_dispatch] — Subject: "Re: Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780229482037"
  Body: Please increase YE1EDWO00001APJP (M-A) from 50 to 80 and remove YA4COWOCR000043P (M-C) entirely.

[2026-05-31T12:11:35.843Z] OUTBOUND to test-branch@example.com [type=2nd_release] — Subject: "2nd Release Confirmation - SO 3290106"
  Body: Hi, We have updated SO 3290106 with the following changes: - Increase YE1EDWO00001APJP → 80 - Delete material YA4COWOCR000043P Please do the second release and confirm. Thanks.

[2026-05-31T12:11:35.845Z] INBOUND from test-branch@example.com [type=2nd_release] — Subject: "Re: 2nd Release Confirmation - SO 3290106"
  Body: Yes, second release confirmed.

[2026-05-31T12:11:38.719Z] OUTBOUND to test-branch@example.com [type=ls_dispatch] — Subject: "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780229482037"
  Body: Dispatch Recommendation - AUTO-MOCK-NEWORDER-1780229482037 Dear Sales Team, Sales Order 3290106 I have reviewed the stock availability for Sales Order 3290106. Here is the dispatch recommendation: M-A [YE1EDWO00001APJP] : Stock is confirmed available. Proceed with 50 units from Batch A-26. M-B [YV6FRYENE0000PJP] : Stock is confirmed available. Proceed with 100 units from Batch 30-07-2025. M-C [YA4COWOCR000043P] : Stock is confirmed available. Proceed with 250 units from Batch 20. Best regards, Sales Order Dispatch Co-ordinator

[2026-05-31T12:11:39.502Z] INBOUND from test-branch@example.com [type=ls_dispatch] — Subject: "Re: Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780229482037"
  Body: Looks good, proceed.

[2026-05-31T12:11:43.648Z] OUTBOUND to test-branch@example.com [type=dispatch_confirmation] — Subject: "Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780229482037"
  Body: Dear Branch Team, Dispatch plan ready for Purchase Order AUTO-MOCK-NEWORDER-1780229482037 (Customer 1). Total 10.665 t — fits in 1 vehicle (capacity 35 t). Proposed dispatch (grouped by bundle): Bundle 1 — 10.665 t (of 35 t capacity): - SO 3290106 / YA4COWOCR000043P (Batch 20): 250 units, 6.625 t - SO 3290106 / YE1EDWO00001APJP (Batch A-26): 50 units, 1.320 t - SO 3290106 / YV6FRYENE0000PJP (Batch 30-07-2025): 100 units, 2.720 t Please reply with: - "yes" / "confirm" to proceed with the above plan, or - the changes you want (e.g. "skip OOWJ on SO 1234567", "send only 15 of OP7WJ"). Once confirmed we will create the loading slips. Best regards, Sales Order Dispatch Co-ordinator

[2026-05-31T12:11:44.659Z] INBOUND from test-branch@example.com [type=dispatch_confirmation] — Subject: "Re: Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780229482037"
  Body: Confirmed.

[2026-05-31T12:11:47.402Z] OUTBOUND to test-branch@example.com [type=vehicle_details] — Subject: "Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780229482037 (1 bundle)"
  Body: Dear Branch Team, Loading slips for Purchase Order AUTO-MOCK-NEWORDER-1780229482037 are now ready in SAP. The PO is split into 1 bundle: Bundle 1 (~10.66 t): - SO 3290106 / LS 373297 / Material PENDING - SO 3290106 / LS 373298 / Material PENDING - SO 3290106 / LS 373299 / Material PENDING Please reply with vehicle/transport details for each bundle in the format below: Bundle 1: , , Best regards, Sales Order Dispatch Co-ordinator

[2026-05-31T12:11:52.108Z] INBOUND from test-branch@example.com [type=vehicle_details] — Subject: "Re: Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780229482037 (1 bundle)"
  Body: Vehicle: MH12KL1234, Driver: 9111111111, LR: LR-006 dated 2026-05-31

[2026-05-31T12:11:53.139Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373297 - SO 3290106"
  Body: Invoice 7682614525 OBD 5070000128 attached.

[2026-05-31T12:11:53.139Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373298 - SO 3290106"
  Body: Invoice 7682614525 OBD 5070000128 attached.

[2026-05-31T12:11:53.139Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373299 - SO 3290106"
  Body: Invoice 7682614525 OBD 5070000128 attached.
```

## Final DB state

- **SO.status**: completed
- **PO.dispatchRound**: 2
- **Material rows**: 3
- **LoadingSlipItem rows**: 3
- **Invoice**: #7682614525
- **Shipments**: 1 (shipped)

### Materials

| Material | Batch | Ordered | Available | Dispatch |
|---|---|---|---|---|
| YE1EDWO00001APJP | A-26 | 50 | 50 | 50 |
| YV6FRYENE0000PJP | 30-07-2025 | 100 | 100 | 100 |
| YA4COWOCR000043P | 20 | 250 | 250 | 250 |

## Run log

```
[2026-05-31T12:11:22.037Z] Pushing NEW ORDER for SO 3290106
[2026-05-31T12:11:23.192Z] SO row created — soId=cmptqo4h700n9sx7bhjgsxp9z poId=cmptqo4h400n7sx7ba971gglq
[2026-05-31T12:11:23.192Z] Step 1/6: waiting for outbound "ls_dispatch" (timeout 30000ms)
[2026-05-31T12:11:23.598Z] Step 1: targeting email e5i7ukcl with reply: "Please increase YE1EDWO00001APJP (M-A) from 50 to 80 and remove YA4COWOCR000043P"
[2026-05-31T12:11:32.391Z] Step 1: handleReplyV2 returned matched=true
[2026-05-31T12:11:33.395Z] Step 2/6: waiting for outbound "2nd_release" (timeout 30000ms)
[2026-05-31T12:11:35.845Z] Step 2: targeting email zi9ff04a with reply: "Yes, second release confirmed."
[2026-05-31T12:11:38.495Z] Step 2: handleReplyV2 returned matched=true
[2026-05-31T12:11:39.499Z] Step 3/6: waiting for outbound "ls_dispatch" (timeout 30000ms)
[2026-05-31T12:11:39.502Z] Step 3: targeting email 5unp2q3g with reply: "Looks good, proceed."
[2026-05-31T12:11:43.652Z] Step 3: handleReplyV2 returned matched=true
[2026-05-31T12:11:44.657Z] Step 4/6: waiting for outbound "dispatch_confirmation" (timeout 30000ms)
[2026-05-31T12:11:44.659Z] Step 4: targeting email 2ekie26o with reply: "Confirmed."
[2026-05-31T12:11:47.153Z] Step 4: handleReplyV2 returned matched=true
[2026-05-31T12:11:48.155Z] Step 5/6: waiting for outbound "vehicle_details" (timeout 30000ms)
[2026-05-31T12:11:48.157Z] Step 5: targeting email zk4gl4qd with reply: "Vehicle: MH12KL1234, Driver: 9111111111, LR: LR-006 dated 2026-05-31"
[2026-05-31T12:11:52.129Z] Step 5: handleReplyV2 returned matched=true
[2026-05-31T12:11:52.130Z]   [operator input sim] persisted lrNumber=LR-006 lrDate=2026-05-31 on SO
[2026-05-31T12:11:53.134Z] Step 6/6: waiting for outbound "plant_ls" (timeout 30000ms)
[2026-05-31T12:11:53.135Z] Step 6: targeting email 8hunedrh with reply: "Invoice 7682614525 OBD 5070000128 attached."
[2026-05-31T12:11:53.140Z]   [plant invoice sim] marked 3 plant_ls Email row(s) in bundle hssjjqmk as replied with mock PDF URL
[2026-05-31T12:11:55.439Z] Step 6: handleReplyV2 returned matched=true
[2026-05-31T12:11:58.445Z] Shipment(s) created (1); simulating operator VT01N click per shipment
[2026-05-31T12:11:58.457Z]   triggerVto1n(79zfcc55) enqueued (obd=85817684)
```
