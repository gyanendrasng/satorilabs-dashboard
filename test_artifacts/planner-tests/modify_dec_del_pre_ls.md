# Test case: modify_dec_del_pre_ls

**Description**: Branch asks to decrease M-A 50→30 AND delete M-C BEFORE LS. No VA02; just dispatch remainder.
**SO Number**: 3290107
**Customer**: TEST-CUST-MOD-DEC-DEL
**Started**: 2026-05-31T07:40:45.807Z
**Finished**: 2026-05-31T07:41:07.761Z (duration 22.0s)
**Result**: ✅ PASS

## SAP transactions (instruction payloads)

| # | Transaction | State | Work ID | Enqueued | Finished |
|---|---|---|---|---|---|
| 1 | ZSO-VISIBILITY | done | `1c9dfkxa` | 2026-05-31T07:40:47.126Z | 2026-05-31T07:40:47.357Z |
| 2 | ZLOAD1 | done | `qtbo1510` | 2026-05-31T07:40:54.912Z | 2026-05-31T07:40:55.141Z |
| 3 | ZLOAD3-B1 | done | `xw2ud8pt` | 2026-05-31T07:41:02.815Z | 2026-05-31T07:41:03.054Z |
| 4 | VTO1N-B | done | `cma4urqq` | 2026-05-31T07:41:05.838Z | 2026-05-31T07:41:06.052Z |

### Transaction 1 — ZSO-VISIBILITY

- **Work ID**: `cmpth04np00s0sx3p1c9dfkxa`
- **State**: done
- **Instruction sent to SAP**:
  ```
  VPN is connected and SAP is logged in. Just go ahead and run the SAP Transaction ZSO-VISIBILITY for Sales order number 3290107.
  ```
- **Structured args**:
  ```json
  {
    "transaction_code": "ZSO-VISIBILITY",
    "meta": {
      "so_number": "3290107"
    }
  }
  ```

### Transaction 2 — ZLOAD1

- **Work ID**: `cmpth0ao000tesx3pqtbo1510`
- **State**: done
- **Instruction sent to SAP**:
  ```
  VPN is connected, SAP is logged in. Execute ZLOAD1 for sales order 3290107 (Bundle 1). Materials to dispatch:
  - Material: YE1EDWO00001APJP, Batch: A-26, Quantity: 50
  - Material: YV6FRYENE0000PJP, Batch: 30-07-2025, Quantity: 100
  - Material: YA4COWOCR000043P, Batch: 20, Quantity: 250
  ```
- **Structured args**:
  ```json
  {
    "transaction_code": "ZLOAD1",
    "so_number": "3290107",
    "meta": {
      "so_number": "3290107",
      "bundle_id": "cmpth0anx00tcsx3p4t2vt996",
      "bundle_number": 1
    }
  }
  ```

### Transaction 3 — ZLOAD3-B1

- **Work ID**: `cmpth0gri00uysx3pxw2ud8pt`
- **State**: done
- **Instruction sent to SAP**:
  ```
  VPN is connected, SAP is logged in. Just execute ZLOAD3-B1 for sales order 3290107 (Bundle 1)
  ```
- **Structured args**:
  ```json
  {
    "transaction_code": "ZLOAD3-B1",
    "so_number": "3290107",
    "attachments": [
      {
        "filename": "373300.pdf",
        "content_base64": "JVBERi0xLjQKJW1vY2stZTJlLXBkZgo="
      },
      {
        "filename": "373301.pdf",
        "content_base64": "JVBERi0xLjQKJW1vY2stZTJlLXBkZgo="
      },
      {
        "filename": "373302.pdf",
        "content_base64": "JVBERi0xLjQKJW1vY2stZTJlLXBkZgo="
      }
    ],
    "extraction_context": "For each file, extract the loading slip number, loaded quantity, invoice number, and invoice date",
    "meta": {
      "so_number": "3290107",
      "bundle_id": "cmpth0anx00tcsx3p4t2vt996",
      "bundle_number": 1
    }
  }
  ```

### Transaction 4 — VTO1N-B

- **Work ID**: `cmpth0j3i00vesx3pcma4urqq`
- **State**: done
- **Instruction sent to SAP**:
  ```
  VPN is connected and SAP is logged in. Just go ahead and run the SAP Transaction VT01N. OBD number is 85817685, LR number is LR-007, LR date is 31.05.2026 and Vehicle number is MH12MN5678
  ```
- **Structured args**:
  ```json
  {
    "transaction_code": "VTO1N-B",
    "so_number": "3290107",
    "extraction_context": "Extract the OBD number, LR number, LR date and Vehicle number",
    "meta": {
      "so_number": "3290107",
      "shipment_id": "cmpth0gxj00v8sx3p4640i0c5",
      "bundle_id": "cmpth0anx00tcsx3p4t2vt996",
      "bundle_number": 1,
      "obd_number": "85817685"
    }
  }
  ```

## Event chain (audit trail)

```
[T+0:00:00] email_received       from branch — Subject "NEW ORDER 3290107" — "Dear Sales Team, Please create SO 3290107 for customer TEST-CUST-MOD-DEC-DEL. M…"
[T+0:00:00] classifier_decision  action=new_order
[T+0:00:00] step_completed       zso_visibility ✓ — materials YE1EDWO00001APJP=50, YV6FRYENE0000PJP=100, YA4COWOCR000043P=250
[T+0:00:00] email_sent           ls_dispatch to test-branch@example.com — "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-178021324…"
[T+0:00:00] step_completed       zso_visibility ✓
[T+0:00:00] email_received       from branch — Subject "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-178021324…" — "Please reduce YE1EDWO00001APJP (M-A) from 50 to 30 and drop YA4COWOCR000043P (M…"
[T+0:00:03] classifier_decision  llm-planned
[T+0:00:03] scenario_started     llm-planned
[T+0:00:03] step_fired           email_confirm_bundle_details
[T+0:00:03] email_sent           dispatch_confirmation to test-branch@example.com — "Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780213245824"
[T+0:00:03] step_completed       email_confirm_bundle_details ✓
[T+0:00:03] scenario_completed   llm-planned
[T+0:00:04] email_received       from branch — Subject "Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780213245824" — "Confirmed."
[T+0:00:07] classifier_decision  llm-planned
[T+0:00:07] scenario_started     llm-planned
[T+0:00:07] step_fired           zload1
[T+0:00:08] email_sent           vehicle_details to test-branch@example.com — "Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780213245…"
[T+0:00:08] step_completed       zload1 ✓ — LS 373302:PENDING=?, 373301:PENDING=?, 373300:PENDING=?
[T+0:00:08] step_fired           email_to_branch_for_vehicle
[T+0:00:08] step_completed       email_to_branch_for_vehicle ✓
[T+0:00:08] scenario_completed   llm-planned
[T+0:00:08] email_received       from branch — Subject "Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780213245…" — "Vehicle: MH12MN5678, Driver: 9222222222, LR: LR-007 dated 2026-05-31"
[T+0:00:11] classifier_decision  llm-planned
[T+0:00:11] scenario_started     llm-planned
[T+0:00:11] step_fired           email_to_plant
[T+0:00:12] email_sent           plant_ls to test-plant@example.com — "Loading Slip 373300 - SO 3290107"
[T+0:00:12] email_sent           plant_ls to test-plant@example.com — "Loading Slip 373301 - SO 3290107"
[T+0:00:12] email_sent           plant_ls to test-plant@example.com — "Loading Slip 373302 - SO 3290107"
[T+0:00:12] step_completed       email_to_plant ✓
[T+0:00:12] scenario_completed   llm-planned
[T+0:00:13] email_received       from plant — Subject "Loading Slip 373302 - SO 3290107" — "Invoice 7682614526 OBD 5070000129 attached."
[T+0:00:15] classifier_decision  llm-planned
[T+0:00:15] scenario_started     llm-planned
[T+0:00:15] step_fired           process_plant_invoice
[T+0:00:15] step_completed       process_plant_invoice ✓
[T+0:00:15] scenario_completed   llm-planned
[T+0:00:15] step_completed       process_plant_invoice ✓
[T+0:00:15] scenario_completed   llm-planned
[T+0:00:15] step_completed       zload3b1 ✓
[T+0:00:18] step_completed       vto1n ✓
```

## Email thread

```
[2026-05-31T07:40:47.350Z] OUTBOUND to test-branch@example.com [type=ls_dispatch] — Subject: "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780213245824"
  Body: Dispatch Recommendation - AUTO-MOCK-NEWORDER-1780213245824 Dear Sales Team, Sales Order 3290107 I have reviewed the stock availability for Sales Order 3290107. Here is the dispatch recommendation: M-A [YE1EDWO00001APJP] : Stock is confirmed available. Proceed with 50 units from Batch A-26. M-B [YV6FRYENE0000PJP] : Stock is confirmed available. Proceed with 100 units from Batch 30-07-2025. M-C [YA4COWOCR000043P] : Stock is confirmed available. Proceed with 250 units from Batch 20. Best regards, Sales Order Dispatch Co-ordinator

[2026-05-31T07:40:47.540Z] INBOUND from test-branch@example.com [type=ls_dispatch] — Subject: "Re: Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780213245824"
  Body: Please reduce YE1EDWO00001APJP (M-A) from 50 to 30 and drop YA4COWOCR000043P (M-C).

[2026-05-31T07:40:50.829Z] OUTBOUND to test-branch@example.com [type=dispatch_confirmation] — Subject: "Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780213245824"
  Body: Dear Branch Team, Dispatch plan ready for Purchase Order AUTO-MOCK-NEWORDER-1780213245824 (Customer 1). Total 10.665 t — fits in 1 vehicle (capacity 35 t). Proposed dispatch (grouped by bundle): Bundle 1 — 10.665 t (of 35 t capacity): - SO 3290107 / YA4COWOCR000043P (Batch 20): 250 units, 6.625 t - SO 3290107 / YE1EDWO00001APJP (Batch A-26): 50 units, 1.320 t - SO 3290107 / YV6FRYENE0000PJP (Batch 30-07-2025): 100 units, 2.720 t Please reply with: - "yes" / "confirm" to proceed with the above plan, or - the changes you want (e.g. "skip OOWJ on SO 1234567", "send only 15 of OP7WJ"). Once confirmed we will create the loading slips. Best regards, Sales Order Dispatch Co-ordinator

[2026-05-31T07:40:51.841Z] INBOUND from test-branch@example.com [type=dispatch_confirmation] — Subject: "Re: Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780213245824"
  Body: Confirmed.

[2026-05-31T07:40:55.146Z] OUTBOUND to test-branch@example.com [type=vehicle_details] — Subject: "Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780213245824 (1 bundle)"
  Body: Dear Branch Team, Loading slips for Purchase Order AUTO-MOCK-NEWORDER-1780213245824 are now ready in SAP. The PO is split into 1 bundle: Bundle 1 (~10.66 t): - SO 3290107 / LS 373300 / Material PENDING - SO 3290107 / LS 373301 / Material PENDING - SO 3290107 / LS 373302 / Material PENDING Please reply with vehicle/transport details for each bundle in the format below: Bundle 1: , , Best regards, Sales Order Dispatch Co-ordinator

[2026-05-31T07:40:59.552Z] INBOUND from test-branch@example.com [type=vehicle_details] — Subject: "Re: Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780213245824 (1 bundle)"
  Body: Vehicle: MH12MN5678, Driver: 9222222222, LR: LR-007 dated 2026-05-31

[2026-05-31T07:41:00.587Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373300 - SO 3290107"
  Body: Invoice 7682614526 OBD 5070000129 attached.

[2026-05-31T07:41:00.587Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373301 - SO 3290107"
  Body: Invoice 7682614526 OBD 5070000129 attached.

[2026-05-31T07:41:00.587Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373302 - SO 3290107"
  Body: Invoice 7682614526 OBD 5070000129 attached.
```

## Final DB state

- **SO.status**: completed
- **PO.dispatchRound**: 1
- **Material rows**: 3
- **LoadingSlipItem rows**: 3
- **Invoice**: #7682614526
- **Shipments**: 1 (shipped)

### Materials

| Material | Batch | Ordered | Available | Dispatch |
|---|---|---|---|---|
| YE1EDWO00001APJP | A-26 | 50 | 50 | 50 |
| YV6FRYENE0000PJP | 30-07-2025 | 100 | 100 | 100 |
| YA4COWOCR000043P | 20 | 250 | 250 | 250 |

## Run log

```
[2026-05-31T07:40:45.824Z] Pushing NEW ORDER for SO 3290107
[2026-05-31T07:40:47.129Z] SO row created — soId=cmpth04nf00rusx3phrzuv3iy poId=cmpth04nd00rssx3pwe5x44l7
[2026-05-31T07:40:47.129Z] Step 1/4: waiting for outbound "ls_dispatch" (timeout 30000ms)
[2026-05-31T07:40:47.540Z] Step 1: targeting email cv12rfdh with reply: "Please reduce YE1EDWO00001APJP (M-A) from 50 to 30 and drop YA4COWOCR000043P (M-"
[2026-05-31T07:40:50.834Z] Step 1: handleReplyV2 returned matched=true
[2026-05-31T07:40:51.838Z] Step 2/4: waiting for outbound "dispatch_confirmation" (timeout 30000ms)
[2026-05-31T07:40:51.840Z] Step 2: targeting email ys4gqn5h with reply: "Confirmed."
[2026-05-31T07:40:54.916Z] Step 2: handleReplyV2 returned matched=true
[2026-05-31T07:40:55.920Z] Step 3/4: waiting for outbound "vehicle_details" (timeout 30000ms)
[2026-05-31T07:40:55.922Z] Step 3: targeting email erg1dxzc with reply: "Vehicle: MH12MN5678, Driver: 9222222222, LR: LR-007 dated 2026-05-31"
[2026-05-31T07:40:59.573Z] Step 3: handleReplyV2 returned matched=true
[2026-05-31T07:40:59.574Z]   [operator input sim] persisted lrNumber=LR-007 lrDate=2026-05-31 on SO
[2026-05-31T07:41:00.579Z] Step 4/4: waiting for outbound "plant_ls" (timeout 30000ms)
[2026-05-31T07:41:00.581Z] Step 4: targeting email p985qce8 with reply: "Invoice 7682614526 OBD 5070000129 attached."
[2026-05-31T07:41:00.589Z]   [plant invoice sim] marked 3 plant_ls Email row(s) in bundle 4t2vt996 as replied with mock PDF URL
[2026-05-31T07:41:02.826Z] Step 4: handleReplyV2 returned matched=true
[2026-05-31T07:41:05.831Z] Shipment(s) created (1); simulating operator VT01N click per shipment
[2026-05-31T07:41:05.844Z]   triggerVto1n(4640i0c5) enqueued (obd=85817685)
```
