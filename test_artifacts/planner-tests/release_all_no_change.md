# Test case: release_all_no_change

**Description**: Branch confirms full dispatch with no quantity changes (no modification).
**SO Number**: 3290101
**Customer**: TEST-CUST-RELEASE-ALL
**Started**: 2026-05-31T07:37:53.082Z
**Finished**: 2026-05-31T07:38:15.219Z (duration 22.1s)
**Result**: ✅ PASS

## SAP transactions (instruction payloads)

| # | Transaction | State | Work ID | Enqueued | Finished |
|---|---|---|---|---|---|
| 1 | ZSO-VISIBILITY | done | `pzwku3kw` | 2026-05-31T07:37:55.436Z | 2026-05-31T07:37:55.750Z |
| 2 | ZLOAD1 | done | `0srlnlz5` | 2026-05-31T07:38:02.149Z | 2026-05-31T07:38:02.392Z |
| 3 | ZLOAD3-B1 | done | `8wxqt2jl` | 2026-05-31T07:38:10.263Z | 2026-05-31T07:38:10.508Z |
| 4 | VTO1N-B | done | `ayg0v3tj` | 2026-05-31T07:38:13.295Z | 2026-05-31T07:38:13.511Z |

### Transaction 1 — ZSO-VISIBILITY

- **Work ID**: `cmptgwg6k000csx3ppzwku3kw`
- **State**: done
- **Instruction sent to SAP**:
  ```
  VPN is connected and SAP is logged in. Just go ahead and run the SAP Transaction ZSO-VISIBILITY for Sales order number 3290101.
  ```
- **Structured args**:
  ```json
  {
    "transaction_code": "ZSO-VISIBILITY",
    "meta": {
      "so_number": "3290101"
    }
  }
  ```

### Transaction 2 — ZLOAD1

- **Work ID**: `cmptgwld0001qsx3p0srlnlz5`
- **State**: done
- **Instruction sent to SAP**:
  ```
  VPN is connected, SAP is logged in. Execute ZLOAD1 for sales order 3290101 (Bundle 1). Materials to dispatch:
  - Material: YE1EDWO00001APJP, Batch: A-26, Quantity: 50
  - Material: YV6FRYENE0000PJP, Batch: 30-07-2025, Quantity: 100
  - Material: YA4COWOCR000043P, Batch: 20, Quantity: 250
  ```
- **Structured args**:
  ```json
  {
    "transaction_code": "ZLOAD1",
    "so_number": "3290101",
    "meta": {
      "so_number": "3290101",
      "bundle_id": "cmptgwlcx001osx3pjskl0cye",
      "bundle_number": 1
    }
  }
  ```

### Transaction 3 — ZLOAD3-B1

- **Work ID**: `cmptgwrmf003asx3p8wxqt2jl`
- **State**: done
- **Instruction sent to SAP**:
  ```
  VPN is connected, SAP is logged in. Just execute ZLOAD3-B1 for sales order 3290101 (Bundle 1)
  ```
- **Structured args**:
  ```json
  {
    "transaction_code": "ZLOAD3-B1",
    "so_number": "3290101",
    "attachments": [
      {
        "filename": "373282.pdf",
        "content_base64": "JVBERi0xLjQKJW1vY2stZTJlLXBkZgo="
      },
      {
        "filename": "373283.pdf",
        "content_base64": "JVBERi0xLjQKJW1vY2stZTJlLXBkZgo="
      },
      {
        "filename": "373284.pdf",
        "content_base64": "JVBERi0xLjQKJW1vY2stZTJlLXBkZgo="
      }
    ],
    "extraction_context": "For each file, extract the loading slip number, loaded quantity, invoice number, and invoice date",
    "meta": {
      "so_number": "3290101",
      "bundle_id": "cmptgwlcx001osx3pjskl0cye",
      "bundle_number": 1
    }
  }
  ```

### Transaction 4 — VTO1N-B

- **Work ID**: `cmptgwtyn003qsx3payg0v3tj`
- **State**: done
- **Instruction sent to SAP**:
  ```
  VPN is connected and SAP is logged in. Just go ahead and run the SAP Transaction VT01N. OBD number is 85817679, LR number is LR-001, LR date is 31.05.2026 and Vehicle number is MH12AB1234
  ```
- **Structured args**:
  ```json
  {
    "transaction_code": "VTO1N-B",
    "so_number": "3290101",
    "extraction_context": "Extract the OBD number, LR number, LR date and Vehicle number",
    "meta": {
      "so_number": "3290101",
      "shipment_id": "cmptgwrsq003ksx3pv6h1mt4j",
      "bundle_id": "cmptgwlcx001osx3pjskl0cye",
      "bundle_number": 1,
      "obd_number": "85817679"
    }
  }
  ```

## Event chain (audit trail)

```
[T+0:00:00] email_received       from branch — Subject "NEW ORDER 3290101" — "Dear Sales Team, Please create SO 3290101 for customer TEST-CUST-RELEASE-ALL. M…"
[T+0:00:00] classifier_decision  action=new_order
[T+0:00:00] step_completed       zso_visibility ✓ — materials YE1EDWO00001APJP=50, YV6FRYENE0000PJP=100, YA4COWOCR000043P=250
[T+0:00:00] email_sent           ls_dispatch to test-branch@example.com — "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-178021307…"
[T+0:00:00] step_completed       zso_visibility ✓
[T+0:00:00] email_received       from branch — Subject "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-178021307…" — "Confirmed. Please release everything as available and proceed with dispatch."
[T+0:00:03] classifier_decision  llm-planned
[T+0:00:03] scenario_started     llm-planned
[T+0:00:03] step_fired           email_confirm_bundle_details
[T+0:00:03] email_sent           dispatch_confirmation to test-branch@example.com — "Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780213073135"
[T+0:00:03] step_completed       email_confirm_bundle_details ✓
[T+0:00:03] scenario_completed   llm-planned
[T+0:00:04] email_received       from branch — Subject "Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780213073135" — "Confirmed. Please proceed with the dispatch plan as outlined."
[T+0:00:06] classifier_decision  llm-planned
[T+0:00:06] scenario_started     llm-planned
[T+0:00:06] step_fired           zload1
[T+0:00:06] email_sent           vehicle_details to test-branch@example.com — "Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780213073…"
[T+0:00:06] step_completed       zload1 ✓ — LS 373284:PENDING=?, 373283:PENDING=?, 373282:PENDING=?
[T+0:00:06] step_fired           email_to_branch_for_vehicle
[T+0:00:06] step_completed       email_to_branch_for_vehicle ✓
[T+0:00:06] scenario_completed   llm-planned
[T+0:00:07] email_received       from branch — Subject "Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780213073…" — "Vehicle: MH12AB1234, Driver: 9876543210, LR: LR-001 dated 2026-05-31"
[T+0:00:10] classifier_decision  llm-planned
[T+0:00:10] scenario_started     llm-planned
[T+0:00:10] step_fired           email_to_plant
[T+0:00:11] email_sent           plant_ls to test-plant@example.com — "Loading Slip 373282 - SO 3290101"
[T+0:00:11] email_sent           plant_ls to test-plant@example.com — "Loading Slip 373283 - SO 3290101"
[T+0:00:11] email_sent           plant_ls to test-plant@example.com — "Loading Slip 373284 - SO 3290101"
[T+0:00:11] step_completed       email_to_plant ✓
[T+0:00:11] scenario_completed   llm-planned
[T+0:00:12] email_received       from plant — Subject "Loading Slip 373284 - SO 3290101" — "Invoice attached. Invoice number 7682614520, OBD 5070000123."
[T+0:00:14] classifier_decision  llm-planned
[T+0:00:14] scenario_started     llm-planned
[T+0:00:14] step_fired           process_plant_invoice
[T+0:00:14] step_completed       process_plant_invoice ✓
[T+0:00:14] scenario_completed   llm-planned
[T+0:00:14] step_completed       process_plant_invoice ✓
[T+0:00:14] scenario_completed   llm-planned
[T+0:00:15] step_completed       zload3b1 ✓
[T+0:00:18] step_completed       vto1n ✓
```

## Email thread

```
[2026-05-31T07:37:55.739Z] OUTBOUND to test-branch@example.com [type=ls_dispatch] — Subject: "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780213073135"
  Body: Dispatch Recommendation - AUTO-MOCK-NEWORDER-1780213073135 Dear Sales Team, Sales Order 3290101 I have reviewed the stock availability for Sales Order 3290101. Here is the dispatch recommendation: M-A [YE1EDWO00001APJP] : Stock is confirmed available. Proceed with 50 units from Batch A-26. M-C [YA4COWOCR000043P] : Stock is confirmed available. Proceed with 250 units from Batch 20. M-B [YV6FRYENE0000PJP] : Stock is confirmed available. Proceed with 100 units from Batch 30-07-2025. Best regards, Sales Order Dispatch Co-ordinator

[2026-05-31T07:37:55.848Z] INBOUND from test-branch@example.com [type=ls_dispatch] — Subject: "Re: Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780213073135"
  Body: Confirmed. Please release everything as available and proceed with dispatch.

[2026-05-31T07:37:58.515Z] OUTBOUND to test-branch@example.com [type=dispatch_confirmation] — Subject: "Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780213073135"
  Body: Dear Branch Team, Dispatch plan ready for Purchase Order AUTO-MOCK-NEWORDER-1780213073135 (Customer 1). Total 10.665 t — fits in 1 vehicle (capacity 35 t). Proposed dispatch (grouped by bundle): Bundle 1 — 10.665 t (of 35 t capacity): - SO 3290101 / YA4COWOCR000043P (Batch 20): 250 units, 6.625 t - SO 3290101 / YE1EDWO00001APJP (Batch A-26): 50 units, 1.320 t - SO 3290101 / YV6FRYENE0000PJP (Batch 30-07-2025): 100 units, 2.720 t Please reply with: - "yes" / "confirm" to proceed with the above plan, or - the changes you want (e.g. "skip OOWJ on SO 1234567", "send only 15 of OP7WJ"). Once confirmed we will create the loading slips. Best regards, Sales Order Dispatch Co-ordinator

[2026-05-31T07:37:59.521Z] INBOUND from test-branch@example.com [type=dispatch_confirmation] — Subject: "Re: Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780213073135"
  Body: Confirmed. Please proceed with the dispatch plan as outlined.

[2026-05-31T07:38:02.395Z] OUTBOUND to test-branch@example.com [type=vehicle_details] — Subject: "Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780213073135 (1 bundle)"
  Body: Dear Branch Team, Loading slips for Purchase Order AUTO-MOCK-NEWORDER-1780213073135 are now ready in SAP. The PO is split into 1 bundle: Bundle 1 (~10.66 t): - SO 3290101 / LS 373282 / Material PENDING - SO 3290101 / LS 373283 / Material PENDING - SO 3290101 / LS 373284 / Material PENDING Please reply with vehicle/transport details for each bundle in the format below: Bundle 1: , , Best regards, Sales Order Dispatch Co-ordinator

[2026-05-31T07:38:06.692Z] INBOUND from test-branch@example.com [type=vehicle_details] — Subject: "Re: Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780213073135 (1 bundle)"
  Body: Vehicle: MH12AB1234, Driver: 9876543210, LR: LR-001 dated 2026-05-31

[2026-05-31T07:38:07.723Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373282 - SO 3290101"
  Body: Invoice attached. Invoice number 7682614520, OBD 5070000123.

[2026-05-31T07:38:07.723Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373283 - SO 3290101"
  Body: Invoice attached. Invoice number 7682614520, OBD 5070000123.

[2026-05-31T07:38:07.723Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373284 - SO 3290101"
  Body: Invoice attached. Invoice number 7682614520, OBD 5070000123.
```

## Final DB state

- **SO.status**: completed
- **PO.dispatchRound**: 1
- **Material rows**: 3
- **LoadingSlipItem rows**: 3
- **Invoice**: #7682614520
- **Shipments**: 1 (shipped)

### Materials

| Material | Batch | Ordered | Available | Dispatch |
|---|---|---|---|---|
| YE1EDWO00001APJP | A-26 | 50 | 50 | 50 |
| YA4COWOCR000043P | 20 | 250 | 250 | 250 |
| YV6FRYENE0000PJP | 30-07-2025 | 100 | 100 | 100 |

## Run log

```
[2026-05-31T07:37:53.134Z] Pushing NEW ORDER for SO 3290101
[2026-05-31T07:37:55.441Z] SO row created — soId=cmptgwg6b0006sx3phg3w4tu7 poId=cmptgwg690004sx3pdbw20oho
[2026-05-31T07:37:55.441Z] Step 1/4: waiting for outbound "ls_dispatch" (timeout 30000ms)
[2026-05-31T07:37:55.847Z] Step 1: targeting email el4tr8y6 with reply: "Confirmed. Please release everything as available and proceed with dispatch."
[2026-05-31T07:37:58.518Z] Step 1: handleReplyV2 returned matched=true
[2026-05-31T07:37:59.520Z] Step 2/4: waiting for outbound "dispatch_confirmation" (timeout 30000ms)
[2026-05-31T07:37:59.521Z] Step 2: targeting email 9uynbxye with reply: "Confirmed. Please proceed with the dispatch plan as outlined."
[2026-05-31T07:38:02.152Z] Step 2: handleReplyV2 returned matched=true
[2026-05-31T07:38:03.154Z] Step 3/4: waiting for outbound "vehicle_details" (timeout 30000ms)
[2026-05-31T07:38:03.155Z] Step 3: targeting email i0vysblf with reply: "Vehicle: MH12AB1234, Driver: 9876543210, LR: LR-001 dated 2026-05-31"
[2026-05-31T07:38:06.713Z] Step 3: handleReplyV2 returned matched=true
[2026-05-31T07:38:06.715Z]   [operator input sim] persisted lrNumber=LR-001 lrDate=2026-05-31 on SO
[2026-05-31T07:38:07.717Z] Step 4/4: waiting for outbound "plant_ls" (timeout 30000ms)
[2026-05-31T07:38:07.719Z] Step 4: targeting email xbpsz79v with reply: "Invoice attached. Invoice number 7682614520, OBD 5070000123."
[2026-05-31T07:38:07.725Z]   [plant invoice sim] marked 3 plant_ls Email row(s) in bundle jskl0cye as replied with mock PDF URL
[2026-05-31T07:38:10.280Z] Step 4: handleReplyV2 returned matched=true
[2026-05-31T07:38:13.287Z] Shipment(s) created (1); simulating operator VT01N click per shipment
[2026-05-31T07:38:13.302Z]   triggerVto1n(v6h1mt4j) enqueued (obd=85817679)
```
