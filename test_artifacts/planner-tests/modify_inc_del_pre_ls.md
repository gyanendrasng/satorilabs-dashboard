# Test case: modify_inc_del_pre_ls

**Description**: Branch asks to increase M-A 50→80 AND delete M-C BEFORE LS. VA02 for M-A; M-C dropped.
**SO Number**: 3290106
**Customer**: TEST-CUST-MOD-INC-DEL
**Started**: 2026-05-31T07:40:08.241Z
**Finished**: 2026-05-31T07:40:45.797Z (duration 37.6s)
**Result**: ✅ PASS

## SAP transactions (instruction payloads)

| # | Transaction | State | Work ID | Enqueued | Finished |
|---|---|---|---|---|---|
| 1 | ZSO-VISIBILITY | done | `853v5385` | 2026-05-31T07:40:11.230Z | 2026-05-31T07:40:11.460Z |
| 2 | VA02 | done | `b9xjm1l6` | 2026-05-31T07:40:19.836Z | 2026-05-31T07:40:20.056Z |
| 3 | ZSO-VISIBILITY | done | `dw5wst7x` | 2026-05-31T07:40:25.272Z | 2026-05-31T07:40:25.512Z |
| 4 | ZLOAD1 | done | `4rgi01f0` | 2026-05-31T07:40:32.466Z | 2026-05-31T07:40:32.710Z |
| 5 | ZLOAD3-B1 | done | `f53u0kup` | 2026-05-31T07:40:40.843Z | 2026-05-31T07:40:41.075Z |
| 6 | VTO1N-B | done | `ky00lzja` | 2026-05-31T07:40:43.872Z | 2026-05-31T07:40:44.085Z |

### Transaction 1 — ZSO-VISIBILITY

- **Work ID**: `cmptgzcym00mlsx3p853v5385`
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

- **Work ID**: `cmptgzjlo00nhsx3pb9xjm1l6`
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

- **Work ID**: `cmptgznsn00o5sx3pdw5wst7x`
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

- **Work ID**: `cmptgztci00plsx3p4rgi01f0`
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
      "bundle_id": "cmptgztce00pjsx3pllyzi6h0",
      "bundle_number": 1
    }
  }
  ```

### Transaction 5 — ZLOAD3-B1

- **Work ID**: `cmptgzzt600r5sx3pf53u0kup`
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
      "bundle_id": "cmptgztce00pjsx3pllyzi6h0",
      "bundle_number": 1
    }
  }
  ```

### Transaction 6 — VTO1N-B

- **Work ID**: `cmpth025b00rlsx3pky00lzja`
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
      "shipment_id": "cmptgzzz400rfsx3p63730xlx",
      "bundle_id": "cmptgztce00pjsx3pllyzi6h0",
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
[T+0:00:00] email_sent           ls_dispatch to test-branch@example.com — "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-178021320…"
[T+0:00:00] step_completed       zso_visibility ✓
[T+0:00:00] email_received       from branch — Subject "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-178021320…" — "Please increase YE1EDWO00001APJP (M-A) from 50 to 80 and remove YA4COWOCR000043…"
[T+0:00:04] classifier_decision  llm-planned
[T+0:00:04] scenario_started     llm-planned
[T+0:00:04] step_fired           stock_precheck
[T+0:00:06] step_completed       stock_precheck ✓
[T+0:00:06] step_fired           va02
[T+0:00:08] step_completed       va02 ✓ — materials YE1EDWO00001APJP=?, YV6FRYENE0000PJP=?, YA4COWOCR000043P=?
[T+0:00:08] step_fired           email_2nd_release
[T+0:00:11] email_sent           2nd_release to test-branch@example.com — "2nd Release Confirmation - SO 3290106"
[T+0:00:11] step_completed       email_2nd_release ✓
[T+0:00:11] scenario_completed   llm-planned
[T+0:00:11] email_received       from branch — Subject "2nd Release Confirmation - SO 3290106" — "Yes, second release confirmed."
[T+0:00:14] classifier_decision  llm-planned
[T+0:00:14] scenario_started     llm-planned
[T+0:00:14] step_fired           zso_visibility
[T+0:00:14] step_completed       zso_visibility ✓ — materials YE1EDWO00001APJP=50, YV6FRYENE0000PJP=100, YA4COWOCR000043P=250
[T+0:00:14] email_sent           ls_dispatch to test-branch@example.com — "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-178021320…"
[T+0:00:14] step_completed       zso_visibility ✓ — materials YE1EDWO00001APJP=50, YV6FRYENE0000PJP=100, YA4COWOCR000043P=250
[T+0:00:14] scenario_completed   llm-planned
[T+0:00:15] email_received       from branch — Subject "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-178021320…" — "Looks good, proceed."
[T+0:00:17] classifier_decision  llm-planned
[T+0:00:17] scenario_started     llm-planned
[T+0:00:17] step_fired           email_confirm_bundle_details
[T+0:00:17] email_sent           dispatch_confirmation to test-branch@example.com — "Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780213208256"
[T+0:00:17] step_completed       email_confirm_bundle_details ✓
[T+0:00:17] scenario_completed   llm-planned
[T+0:00:18] email_received       from branch — Subject "Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780213208256" — "Confirmed."
[T+0:00:21] classifier_decision  llm-planned
[T+0:00:21] scenario_started     llm-planned
[T+0:00:21] step_fired           zload1
[T+0:00:21] email_sent           vehicle_details to test-branch@example.com — "Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780213208…"
[T+0:00:21] step_completed       zload1 ✓ — LS 373299:PENDING=?, 373298:PENDING=?, 373297:PENDING=?
[T+0:00:21] step_fired           email_to_branch_for_vehicle
[T+0:00:21] step_completed       email_to_branch_for_vehicle ✓
[T+0:00:21] scenario_completed   llm-planned
[T+0:00:22] email_received       from branch — Subject "Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780213208…" — "Vehicle: MH12KL1234, Driver: 9111111111, LR: LR-006 dated 2026-05-31"
[T+0:00:24] classifier_decision  llm-planned
[T+0:00:24] scenario_started     llm-planned
[T+0:00:24] step_fired           email_to_plant
[T+0:00:25] email_sent           plant_ls to test-plant@example.com — "Loading Slip 373297 - SO 3290106"
[T+0:00:25] email_sent           plant_ls to test-plant@example.com — "Loading Slip 373298 - SO 3290106"
[T+0:00:25] email_sent           plant_ls to test-plant@example.com — "Loading Slip 373299 - SO 3290106"
[T+0:00:25] step_completed       email_to_plant ✓
[T+0:00:25] scenario_completed   llm-planned
[T+0:00:26] email_received       from plant — Subject "Loading Slip 373299 - SO 3290106" — "Invoice 7682614525 OBD 5070000128 attached."
[T+0:00:29] classifier_decision  llm-planned
[T+0:00:29] scenario_started     llm-planned
[T+0:00:29] step_fired           process_plant_invoice
[T+0:00:29] step_completed       process_plant_invoice ✓
[T+0:00:29] scenario_completed   llm-planned
[T+0:00:29] step_completed       process_plant_invoice ✓
[T+0:00:29] scenario_completed   llm-planned
[T+0:00:29] step_completed       zload3b1 ✓
[T+0:00:32] step_completed       vto1n ✓
```

## Email thread

```
[2026-05-31T07:40:11.454Z] OUTBOUND to test-branch@example.com [type=ls_dispatch] — Subject: "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780213208256"
  Body: Dispatch Recommendation - AUTO-MOCK-NEWORDER-1780213208256 Dear Sales Team, Sales Order 3290106 I have reviewed the stock availability for Sales Order 3290106. Here is the dispatch recommendation: M-A [YE1EDWO00001APJP] : Stock is confirmed available. Proceed with 50 units from Batch A-26. M-B [YV6FRYENE0000PJP] : Stock is confirmed available. Proceed with 100 units from Batch 30-07-2025. M-C [YA4COWOCR000043P] : Stock is confirmed available. Proceed with 250 units from Batch 20. Best regards, Sales Order Dispatch Co-ordinator

[2026-05-31T07:40:11.640Z] INBOUND from test-branch@example.com [type=ls_dispatch] — Subject: "Re: Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780213208256"
  Body: Please increase YE1EDWO00001APJP (M-A) from 50 to 80 and remove YA4COWOCR000043P (M-C) entirely.

[2026-05-31T07:40:22.287Z] OUTBOUND to test-branch@example.com [type=2nd_release] — Subject: "2nd Release Confirmation - SO 3290106"
  Body: Hi, We have updated SO 3290106 with the following changes: - Increase YE1EDWO00001APJP → 80 - Delete material YA4COWOCR000043P Please do the second release and confirm. Thanks.

[2026-05-31T07:40:22.484Z] INBOUND from test-branch@example.com [type=2nd_release] — Subject: "Re: 2nd Release Confirmation - SO 3290106"
  Body: Yes, second release confirmed.

[2026-05-31T07:40:25.503Z] OUTBOUND to test-branch@example.com [type=ls_dispatch] — Subject: "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780213208256"
  Body: Dispatch Recommendation - AUTO-MOCK-NEWORDER-1780213208256 Dear Sales Team, Sales Order 3290106 I have reviewed the stock availability for Sales Order 3290106. Here is the dispatch recommendation: M-A [YE1EDWO00001APJP] : Stock is confirmed available. Proceed with 50 units from Batch A-26. M-B [YV6FRYENE0000PJP] : Stock is confirmed available. Proceed with 100 units from Batch 30-07-2025. M-C [YA4COWOCR000043P] : Stock is confirmed available. Proceed with 250 units from Batch 20. Best regards, Sales Order Dispatch Co-ordinator

[2026-05-31T07:40:26.281Z] INBOUND from test-branch@example.com [type=ls_dispatch] — Subject: "Re: Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780213208256"
  Body: Looks good, proceed.

[2026-05-31T07:40:28.974Z] OUTBOUND to test-branch@example.com [type=dispatch_confirmation] — Subject: "Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780213208256"
  Body: Dear Branch Team, Dispatch plan ready for Purchase Order AUTO-MOCK-NEWORDER-1780213208256 (Customer 1). Total 10.665 t — fits in 1 vehicle (capacity 35 t). Proposed dispatch (grouped by bundle): Bundle 1 — 10.665 t (of 35 t capacity): - SO 3290106 / YA4COWOCR000043P (Batch 20): 250 units, 6.625 t - SO 3290106 / YE1EDWO00001APJP (Batch A-26): 50 units, 1.320 t - SO 3290106 / YV6FRYENE0000PJP (Batch 30-07-2025): 100 units, 2.720 t Please reply with: - "yes" / "confirm" to proceed with the above plan, or - the changes you want (e.g. "skip OOWJ on SO 1234567", "send only 15 of OP7WJ"). Once confirmed we will create the loading slips. Best regards, Sales Order Dispatch Co-ordinator

[2026-05-31T07:40:29.983Z] INBOUND from test-branch@example.com [type=dispatch_confirmation] — Subject: "Re: Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780213208256"
  Body: Confirmed.

[2026-05-31T07:40:32.714Z] OUTBOUND to test-branch@example.com [type=vehicle_details] — Subject: "Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780213208256 (1 bundle)"
  Body: Dear Branch Team, Loading slips for Purchase Order AUTO-MOCK-NEWORDER-1780213208256 are now ready in SAP. The PO is split into 1 bundle: Bundle 1 (~10.66 t): - SO 3290106 / LS 373297 / Material PENDING - SO 3290106 / LS 373298 / Material PENDING - SO 3290106 / LS 373299 / Material PENDING Please reply with vehicle/transport details for each bundle in the format below: Bundle 1: , , Best regards, Sales Order Dispatch Co-ordinator

[2026-05-31T07:40:36.973Z] INBOUND from test-branch@example.com [type=vehicle_details] — Subject: "Re: Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780213208256 (1 bundle)"
  Body: Vehicle: MH12KL1234, Driver: 9111111111, LR: LR-006 dated 2026-05-31

[2026-05-31T07:40:38.002Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373297 - SO 3290106"
  Body: Invoice 7682614525 OBD 5070000128 attached.

[2026-05-31T07:40:38.002Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373298 - SO 3290106"
  Body: Invoice 7682614525 OBD 5070000128 attached.

[2026-05-31T07:40:38.002Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373299 - SO 3290106"
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
[2026-05-31T07:40:08.256Z] Pushing NEW ORDER for SO 3290106
[2026-05-31T07:40:11.232Z] SO row created — soId=cmptgzcyf00mfsx3p20co4x4c poId=cmptgzcye00mdsx3pgvukr5ec
[2026-05-31T07:40:11.232Z] Step 1/6: waiting for outbound "ls_dispatch" (timeout 30000ms)
[2026-05-31T07:40:11.640Z] Step 1: targeting email qv0uozze with reply: "Please increase YE1EDWO00001APJP (M-A) from 50 to 80 and remove YA4COWOCR000043P"
[2026-05-31T07:40:19.846Z] Step 1: handleReplyV2 returned matched=true
[2026-05-31T07:40:20.851Z] Step 2/6: waiting for outbound "2nd_release" (timeout 30000ms)
[2026-05-31T07:40:22.484Z] Step 2: targeting email d3mgsw46 with reply: "Yes, second release confirmed."
[2026-05-31T07:40:25.277Z] Step 2: handleReplyV2 returned matched=true
[2026-05-31T07:40:26.279Z] Step 3/6: waiting for outbound "ls_dispatch" (timeout 30000ms)
[2026-05-31T07:40:26.281Z] Step 3: targeting email wjcygzjd with reply: "Looks good, proceed."
[2026-05-31T07:40:28.979Z] Step 3: handleReplyV2 returned matched=true
[2026-05-31T07:40:29.982Z] Step 4/6: waiting for outbound "dispatch_confirmation" (timeout 30000ms)
[2026-05-31T07:40:29.983Z] Step 4: targeting email 4ws4g0m0 with reply: "Confirmed."
[2026-05-31T07:40:32.470Z] Step 4: handleReplyV2 returned matched=true
[2026-05-31T07:40:33.476Z] Step 5/6: waiting for outbound "vehicle_details" (timeout 30000ms)
[2026-05-31T07:40:33.479Z] Step 5: targeting email 70cl10e9 with reply: "Vehicle: MH12KL1234, Driver: 9111111111, LR: LR-006 dated 2026-05-31"
[2026-05-31T07:40:36.990Z] Step 5: handleReplyV2 returned matched=true
[2026-05-31T07:40:36.991Z]   [operator input sim] persisted lrNumber=LR-006 lrDate=2026-05-31 on SO
[2026-05-31T07:40:37.995Z] Step 6/6: waiting for outbound "plant_ls" (timeout 30000ms)
[2026-05-31T07:40:37.997Z] Step 6: targeting email 8529qii5 with reply: "Invoice 7682614525 OBD 5070000128 attached."
[2026-05-31T07:40:38.003Z]   [plant invoice sim] marked 3 plant_ls Email row(s) in bundle llyzi6h0 as replied with mock PDF URL
[2026-05-31T07:40:40.854Z] Step 6: handleReplyV2 returned matched=true
[2026-05-31T07:40:43.863Z] Shipment(s) created (1); simulating operator VT01N click per shipment
[2026-05-31T07:40:43.877Z]   triggerVto1n(63730xlx) enqueued (obd=85817684)
```
