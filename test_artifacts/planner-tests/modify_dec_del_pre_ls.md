# Test case: modify_dec_del_pre_ls

**Description**: Branch asks to decrease M-A 50→30 AND delete M-C BEFORE LS. No VA02; just dispatch remainder.
**SO Number**: 3290107
**Customer**: TEST-CUST-MOD-DEC-DEL
**Started**: 2026-05-31T12:12:00.379Z
**Finished**: 2026-05-31T12:12:22.530Z (duration 22.2s)
**Result**: ✅ PASS

## SAP transactions (instruction payloads)

| # | Transaction | State | Work ID | Enqueued | Finished |
|---|---|---|---|---|---|
| 1 | ZSO-VISIBILITY | done | `db4x6dgg` | 2026-05-31T12:12:01.275Z | 2026-05-31T12:12:01.507Z |
| 2 | ZLOAD1 | done | `wr7lvszv` | 2026-05-31T12:12:08.818Z | 2026-05-31T12:12:09.073Z |
| 3 | ZLOAD3-B1 | done | `mb0knpjx` | 2026-05-31T12:12:17.587Z | 2026-05-31T12:12:17.832Z |
| 4 | VTO1N-B | done | `cvepd5lk` | 2026-05-31T12:12:20.611Z | 2026-05-31T12:12:20.818Z |

### Transaction 1 — ZSO-VISIBILITY

- **Work ID**: `cmptqoxvf00t0sx7bdb4x6dgg`
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

- **Work ID**: `cmptqp3ox00uesx7bwr7lvszv`
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
      "bundle_id": "cmptqp3oq00ucsx7bhs9khuwl",
      "bundle_number": 1
    }
  }
  ```

### Transaction 3 — ZLOAD3-B1

- **Work ID**: `cmptqpagj00w4sx7bmb0knpjx`
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
      "bundle_id": "cmptqp3oq00ucsx7bhs9khuwl",
      "bundle_number": 1
    }
  }
  ```

### Transaction 4 — VTO1N-B

- **Work ID**: `cmptqpcsj00wksx7bcvepd5lk`
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
      "shipment_id": "cmptqpamm00wesx7bzznuhvha",
      "bundle_id": "cmptqp3oq00ucsx7bhs9khuwl",
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
[T+0:00:00] email_sent           ls_dispatch to test-branch@example.com — "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-178022952…"
[T+0:00:00] step_completed       zso_visibility ✓
[T+0:00:00] email_received       from branch — Subject "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-178022952…" — "Please reduce YE1EDWO00001APJP (M-A) from 50 to 30 and drop YA4COWOCR000043P (M…"
[T+0:00:03] classifier_decision  llm-planned
[T+0:00:03] scenario_started     llm-planned
[T+0:00:03] step_fired           email_confirm_bundle_details
[T+0:00:03] email_sent           dispatch_confirmation to test-branch@example.com — "Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780229520394"
[T+0:00:03] step_completed       email_confirm_bundle_details ✓
[T+0:00:03] scenario_completed   llm-planned
[T+0:00:04] email_received       from branch — Subject "Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780229520394" — "Confirmed."
[T+0:00:07] classifier_decision  llm-planned
[T+0:00:07] scenario_started     llm-planned
[T+0:00:07] step_fired           zload1
[T+0:00:07] email_sent           vehicle_details to test-branch@example.com — "Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780229520…"
[T+0:00:07] step_completed       zload1 ✓ — LS 373302:PENDING=?, 373301:PENDING=?, 373300:PENDING=?
[T+0:00:07] step_fired           email_to_branch_for_vehicle
[T+0:00:07] step_completed       email_to_branch_for_vehicle ✓
[T+0:00:07] scenario_completed   llm-planned
[T+0:00:08] email_received       from branch — Subject "Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780229520…" — "Vehicle: MH12MN5678, Driver: 9222222222, LR: LR-007 dated 2026-05-31"
[T+0:00:10] classifier_decision  llm-planned
[T+0:00:10] scenario_started     llm-planned
[T+0:00:10] step_fired           email_to_plant
[T+0:00:12] email_sent           plant_ls to test-plant@example.com — "Loading Slip 373300 - SO 3290107"
[T+0:00:12] email_sent           plant_ls to test-plant@example.com — "Loading Slip 373301 - SO 3290107"
[T+0:00:12] email_sent           plant_ls to test-plant@example.com — "Loading Slip 373302 - SO 3290107"
[T+0:00:12] step_completed       email_to_plant ✓
[T+0:00:12] scenario_completed   llm-planned
[T+0:00:13] email_received       from plant — Subject "Loading Slip 373302 - SO 3290107" — "Invoice 7682614526 OBD 5070000129 attached."
[T+0:00:16] classifier_decision  llm-planned
[T+0:00:16] scenario_started     llm-planned
[T+0:00:16] step_fired           process_plant_invoice
[T+0:00:16] step_completed       process_plant_invoice ✓
[T+0:00:16] scenario_completed   llm-planned
[T+0:00:16] step_completed       process_plant_invoice ✓
[T+0:00:16] scenario_completed   llm-planned
[T+0:00:16] step_completed       zload3b1 ✓
[T+0:00:19] step_completed       vto1n ✓
```

## Email thread

```
[2026-05-31T12:12:01.500Z] OUTBOUND to test-branch@example.com [type=ls_dispatch] — Subject: "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780229520394"
  Body: Dispatch Recommendation - AUTO-MOCK-NEWORDER-1780229520394 Dear Sales Team, Sales Order 3290107 I have reviewed the stock availability for Sales Order 3290107. Here is the dispatch recommendation: M-A [YE1EDWO00001APJP] : Stock is confirmed available. Proceed with 50 units from Batch A-26. M-B [YV6FRYENE0000PJP] : Stock is confirmed available. Proceed with 100 units from Batch 30-07-2025. M-C [YA4COWOCR000043P] : Stock is confirmed available. Proceed with 250 units from Batch 20. Best regards, Sales Order Dispatch Co-ordinator

[2026-05-31T12:12:01.685Z] INBOUND from test-branch@example.com [type=ls_dispatch] — Subject: "Re: Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780229520394"
  Body: Please reduce YE1EDWO00001APJP (M-A) from 50 to 30 and drop YA4COWOCR000043P (M-C).

[2026-05-31T12:12:05.057Z] OUTBOUND to test-branch@example.com [type=dispatch_confirmation] — Subject: "Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780229520394"
  Body: Dear Branch Team, Dispatch plan ready for Purchase Order AUTO-MOCK-NEWORDER-1780229520394 (Customer 1). Total 10.665 t — fits in 1 vehicle (capacity 35 t). Proposed dispatch (grouped by bundle): Bundle 1 — 10.665 t (of 35 t capacity): - SO 3290107 / YA4COWOCR000043P (Batch 20): 250 units, 6.625 t - SO 3290107 / YE1EDWO00001APJP (Batch A-26): 50 units, 1.320 t - SO 3290107 / YV6FRYENE0000PJP (Batch 30-07-2025): 100 units, 2.720 t Please reply with: - "yes" / "confirm" to proceed with the above plan, or - the changes you want (e.g. "skip OOWJ on SO 1234567", "send only 15 of OP7WJ"). Once confirmed we will create the loading slips. Best regards, Sales Order Dispatch Co-ordinator

[2026-05-31T12:12:06.064Z] INBOUND from test-branch@example.com [type=dispatch_confirmation] — Subject: "Re: Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780229520394"
  Body: Confirmed.

[2026-05-31T12:12:09.077Z] OUTBOUND to test-branch@example.com [type=vehicle_details] — Subject: "Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780229520394 (1 bundle)"
  Body: Dear Branch Team, Loading slips for Purchase Order AUTO-MOCK-NEWORDER-1780229520394 are now ready in SAP. The PO is split into 1 bundle: Bundle 1 (~10.66 t): - SO 3290107 / LS 373300 / Material PENDING - SO 3290107 / LS 373301 / Material PENDING - SO 3290107 / LS 373302 / Material PENDING Please reply with vehicle/transport details for each bundle in the format below: Bundle 1: , , Best regards, Sales Order Dispatch Co-ordinator

[2026-05-31T12:12:13.300Z] INBOUND from test-branch@example.com [type=vehicle_details] — Subject: "Re: Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780229520394 (1 bundle)"
  Body: Vehicle: MH12MN5678, Driver: 9222222222, LR: LR-007 dated 2026-05-31

[2026-05-31T12:12:14.331Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373300 - SO 3290107"
  Body: Invoice 7682614526 OBD 5070000129 attached.

[2026-05-31T12:12:14.331Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373301 - SO 3290107"
  Body: Invoice 7682614526 OBD 5070000129 attached.

[2026-05-31T12:12:14.331Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373302 - SO 3290107"
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
[2026-05-31T12:12:00.394Z] Pushing NEW ORDER for SO 3290107
[2026-05-31T12:12:01.278Z] SO row created — soId=cmptqoxv600susx7bwnx633if poId=cmptqoxv400sssx7b7ocdn7xy
[2026-05-31T12:12:01.278Z] Step 1/4: waiting for outbound "ls_dispatch" (timeout 30000ms)
[2026-05-31T12:12:01.684Z] Step 1: targeting email oag3jqgc with reply: "Please reduce YE1EDWO00001APJP (M-A) from 50 to 30 and drop YA4COWOCR000043P (M-"
[2026-05-31T12:12:05.062Z] Step 1: handleReplyV2 returned matched=true
[2026-05-31T12:12:06.063Z] Step 2/4: waiting for outbound "dispatch_confirmation" (timeout 30000ms)
[2026-05-31T12:12:06.064Z] Step 2: targeting email lfmbldrx with reply: "Confirmed."
[2026-05-31T12:12:08.822Z] Step 2: handleReplyV2 returned matched=true
[2026-05-31T12:12:09.827Z] Step 3/4: waiting for outbound "vehicle_details" (timeout 30000ms)
[2026-05-31T12:12:09.830Z] Step 3: targeting email 16pbgj8l with reply: "Vehicle: MH12MN5678, Driver: 9222222222, LR: LR-007 dated 2026-05-31"
[2026-05-31T12:12:13.320Z] Step 3: handleReplyV2 returned matched=true
[2026-05-31T12:12:13.321Z]   [operator input sim] persisted lrNumber=LR-007 lrDate=2026-05-31 on SO
[2026-05-31T12:12:14.324Z] Step 4/4: waiting for outbound "plant_ls" (timeout 30000ms)
[2026-05-31T12:12:14.326Z] Step 4: targeting email ohr0v5pw with reply: "Invoice 7682614526 OBD 5070000129 attached."
[2026-05-31T12:12:14.333Z]   [plant invoice sim] marked 3 plant_ls Email row(s) in bundle hs9khuwl as replied with mock PDF URL
[2026-05-31T12:12:17.598Z] Step 4: handleReplyV2 returned matched=true
[2026-05-31T12:12:20.605Z] Shipment(s) created (1); simulating operator VT01N click per shipment
[2026-05-31T12:12:20.616Z]   triggerVto1n(zznuhvha) enqueued (obd=85817685)
```
