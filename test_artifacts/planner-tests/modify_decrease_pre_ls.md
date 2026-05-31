# Test case: modify_decrease_pre_ls

**Description**: Branch asks to decrease M-A from 50 → 30 BEFORE LS is created. No VA02 needed; dispatch the smaller qty directly.
**SO Number**: 3290103
**Customer**: TEST-CUST-MOD-DEC
**Started**: 2026-05-31T07:38:51.198Z
**Finished**: 2026-05-31T07:39:12.011Z (duration 20.8s)
**Result**: ✅ PASS

## SAP transactions (instruction payloads)

| # | Transaction | State | Work ID | Enqueued | Finished |
|---|---|---|---|---|---|
| 1 | ZSO-VISIBILITY | done | `txj90z16` | 2026-05-31T07:38:51.955Z | 2026-05-31T07:38:52.181Z |
| 2 | ZLOAD1 | done | `9bvitcw0` | 2026-05-31T07:38:58.539Z | 2026-05-31T07:38:58.773Z |
| 3 | ZLOAD3-B1 | done | `hinyr1wx` | 2026-05-31T07:39:07.056Z | 2026-05-31T07:39:07.288Z |
| 4 | VTO1N-B | done | `cy9nnnce` | 2026-05-31T07:39:10.083Z | 2026-05-31T07:39:10.296Z |

### Transaction 1 — ZSO-VISIBILITY

- **Work ID**: `cmptgxnsj009ksx3ptxj90z16`
- **State**: done
- **Instruction sent to SAP**:
  ```
  VPN is connected and SAP is logged in. Just go ahead and run the SAP Transaction ZSO-VISIBILITY for Sales order number 3290103.
  ```
- **Structured args**:
  ```json
  {
    "transaction_code": "ZSO-VISIBILITY",
    "meta": {
      "so_number": "3290103"
    }
  }
  ```

### Transaction 2 — ZLOAD1

- **Work ID**: `cmptgxsve00aysx3p9bvitcw0`
- **State**: done
- **Instruction sent to SAP**:
  ```
  VPN is connected, SAP is logged in. Execute ZLOAD1 for sales order 3290103 (Bundle 1). Materials to dispatch:
  - Material: YE1EDWO00001APJP, Batch: A-26, Quantity: 50
  - Material: YV6FRYENE0000PJP, Batch: 30-07-2025, Quantity: 100
  - Material: YA4COWOCR000043P, Batch: 20, Quantity: 250
  ```
- **Structured args**:
  ```json
  {
    "transaction_code": "ZLOAD1",
    "so_number": "3290103",
    "meta": {
      "so_number": "3290103",
      "bundle_id": "cmptgxsvc00awsx3przuwfocf",
      "bundle_number": 1
    }
  }
  ```

### Transaction 3 — ZLOAD3-B1

- **Work ID**: `cmptgxzfz00cisx3phinyr1wx`
- **State**: done
- **Instruction sent to SAP**:
  ```
  VPN is connected, SAP is logged in. Just execute ZLOAD3-B1 for sales order 3290103 (Bundle 1)
  ```
- **Structured args**:
  ```json
  {
    "transaction_code": "ZLOAD3-B1",
    "so_number": "3290103",
    "attachments": [
      {
        "filename": "373288.pdf",
        "content_base64": "JVBERi0xLjQKJW1vY2stZTJlLXBkZgo="
      },
      {
        "filename": "373289.pdf",
        "content_base64": "JVBERi0xLjQKJW1vY2stZTJlLXBkZgo="
      },
      {
        "filename": "373290.pdf",
        "content_base64": "JVBERi0xLjQKJW1vY2stZTJlLXBkZgo="
      }
    ],
    "extraction_context": "For each file, extract the loading slip number, loaded quantity, invoice number, and invoice date",
    "meta": {
      "so_number": "3290103",
      "bundle_id": "cmptgxsvc00awsx3przuwfocf",
      "bundle_number": 1
    }
  }
  ```

### Transaction 4 — VTO1N-B

- **Work ID**: `cmptgy1s200cysx3pcy9nnnce`
- **State**: done
- **Instruction sent to SAP**:
  ```
  VPN is connected and SAP is logged in. Just go ahead and run the SAP Transaction VT01N. OBD number is 85817681, LR number is LR-003, LR date is 31.05.2026 and Vehicle number is MH12EF9012
  ```
- **Structured args**:
  ```json
  {
    "transaction_code": "VTO1N-B",
    "so_number": "3290103",
    "extraction_context": "Extract the OBD number, LR number, LR date and Vehicle number",
    "meta": {
      "so_number": "3290103",
      "shipment_id": "cmptgxzly00cssx3ptzgc6e5s",
      "bundle_id": "cmptgxsvc00awsx3przuwfocf",
      "bundle_number": 1,
      "obd_number": "85817681"
    }
  }
  ```

## Event chain (audit trail)

```
[T+0:00:00] email_received       from branch — Subject "NEW ORDER 3290103" — "Dear Sales Team, Please create SO 3290103 for customer TEST-CUST-MOD-DEC. Mater…"
[T+0:00:00] classifier_decision  action=new_order
[T+0:00:00] step_completed       zso_visibility ✓ — materials YE1EDWO00001APJP=50, YV6FRYENE0000PJP=100, YA4COWOCR000043P=250
[T+0:00:00] email_sent           ls_dispatch to test-branch@example.com — "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-178021313…"
[T+0:00:00] step_completed       zso_visibility ✓
[T+0:00:00] email_received       from branch — Subject "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-178021313…" — "Please reduce YE1EDWO00001APJP (M-A) from 50 to 30 units. Keep the rest as is."
[T+0:00:02] classifier_decision  llm-planned
[T+0:00:02] scenario_started     llm-planned
[T+0:00:02] step_fired           email_confirm_bundle_details
[T+0:00:02] email_sent           dispatch_confirmation to test-branch@example.com — "Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780213131215"
[T+0:00:02] step_completed       email_confirm_bundle_details ✓
[T+0:00:02] scenario_completed   llm-planned
[T+0:00:03] email_received       from branch — Subject "Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780213131215" — "Confirmed. Proceed with the reduced quantity."
[T+0:00:06] classifier_decision  llm-planned
[T+0:00:06] scenario_started     llm-planned
[T+0:00:06] step_fired           zload1
[T+0:00:06] email_sent           vehicle_details to test-branch@example.com — "Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780213131…"
[T+0:00:06] step_completed       zload1 ✓ — LS 373290:PENDING=?, 373289:PENDING=?, 373288:PENDING=?
[T+0:00:06] step_fired           email_to_branch_for_vehicle
[T+0:00:06] step_completed       email_to_branch_for_vehicle ✓
[T+0:00:06] scenario_completed   llm-planned
[T+0:00:07] email_received       from branch — Subject "Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780213131…" — "Vehicle: MH12EF9012, Driver: 9123456789, LR: LR-003 dated 2026-05-31"
[T+0:00:09] classifier_decision  llm-planned
[T+0:00:09] scenario_started     llm-planned
[T+0:00:09] step_fired           email_to_plant
[T+0:00:11] email_sent           plant_ls to test-plant@example.com — "Loading Slip 373288 - SO 3290103"
[T+0:00:11] email_sent           plant_ls to test-plant@example.com — "Loading Slip 373289 - SO 3290103"
[T+0:00:11] email_sent           plant_ls to test-plant@example.com — "Loading Slip 373290 - SO 3290103"
[T+0:00:11] step_completed       email_to_plant ✓
[T+0:00:11] scenario_completed   llm-planned
[T+0:00:12] email_received       from plant — Subject "Loading Slip 373290 - SO 3290103" — "Invoice 7682614522 OBD 5070000125 attached."
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
[2026-05-31T07:38:52.176Z] OUTBOUND to test-branch@example.com [type=ls_dispatch] — Subject: "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780213131215"
  Body: Dispatch Recommendation - AUTO-MOCK-NEWORDER-1780213131215 Dear Sales Team, Sales Order 3290103 I have reviewed the stock availability for Sales Order 3290103. Here is the dispatch recommendation: M-A [YE1EDWO00001APJP] : Stock is confirmed available. Proceed with 50 units from Batch A-26. M-B [YV6FRYENE0000PJP] : Stock is confirmed available. Proceed with 100 units from Batch 30-07-2025. M-C [YA4COWOCR000043P] : Stock is confirmed available. Proceed with 250 units from Batch 20. Best regards, Sales Order Dispatch Co-ordinator

[2026-05-31T07:38:52.363Z] INBOUND from test-branch@example.com [type=ls_dispatch] — Subject: "Re: Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780213131215"
  Body: Please reduce YE1EDWO00001APJP (M-A) from 50 to 30 units. Keep the rest as is.

[2026-05-31T07:38:54.921Z] OUTBOUND to test-branch@example.com [type=dispatch_confirmation] — Subject: "Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780213131215"
  Body: Dear Branch Team, Dispatch plan ready for Purchase Order AUTO-MOCK-NEWORDER-1780213131215 (Customer 1). Total 10.665 t — fits in 1 vehicle (capacity 35 t). Proposed dispatch (grouped by bundle): Bundle 1 — 10.665 t (of 35 t capacity): - SO 3290103 / YA4COWOCR000043P (Batch 20): 250 units, 6.625 t - SO 3290103 / YE1EDWO00001APJP (Batch A-26): 50 units, 1.320 t - SO 3290103 / YV6FRYENE0000PJP (Batch 30-07-2025): 100 units, 2.720 t Please reply with: - "yes" / "confirm" to proceed with the above plan, or - the changes you want (e.g. "skip OOWJ on SO 1234567", "send only 15 of OP7WJ"). Once confirmed we will create the loading slips. Best regards, Sales Order Dispatch Co-ordinator

[2026-05-31T07:38:55.934Z] INBOUND from test-branch@example.com [type=dispatch_confirmation] — Subject: "Re: Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780213131215"
  Body: Confirmed. Proceed with the reduced quantity.

[2026-05-31T07:38:58.776Z] OUTBOUND to test-branch@example.com [type=vehicle_details] — Subject: "Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780213131215 (1 bundle)"
  Body: Dear Branch Team, Loading slips for Purchase Order AUTO-MOCK-NEWORDER-1780213131215 are now ready in SAP. The PO is split into 1 bundle: Bundle 1 (~10.66 t): - SO 3290103 / LS 373288 / Material PENDING - SO 3290103 / LS 373289 / Material PENDING - SO 3290103 / LS 373290 / Material PENDING Please reply with vehicle/transport details for each bundle in the format below: Bundle 1: , , Best regards, Sales Order Dispatch Co-ordinator

[2026-05-31T07:39:03.118Z] INBOUND from test-branch@example.com [type=vehicle_details] — Subject: "Re: Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780213131215 (1 bundle)"
  Body: Vehicle: MH12EF9012, Driver: 9123456789, LR: LR-003 dated 2026-05-31

[2026-05-31T07:39:04.147Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373288 - SO 3290103"
  Body: Invoice 7682614522 OBD 5070000125 attached.

[2026-05-31T07:39:04.147Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373289 - SO 3290103"
  Body: Invoice 7682614522 OBD 5070000125 attached.

[2026-05-31T07:39:04.147Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373290 - SO 3290103"
  Body: Invoice 7682614522 OBD 5070000125 attached.
```

## Final DB state

- **SO.status**: completed
- **PO.dispatchRound**: 1
- **Material rows**: 3
- **LoadingSlipItem rows**: 3
- **Invoice**: #7682614522
- **Shipments**: 1 (shipped)

### Materials

| Material | Batch | Ordered | Available | Dispatch |
|---|---|---|---|---|
| YE1EDWO00001APJP | A-26 | 50 | 50 | 50 |
| YV6FRYENE0000PJP | 30-07-2025 | 100 | 100 | 100 |
| YA4COWOCR000043P | 20 | 250 | 250 | 250 |

## Run log

```
[2026-05-31T07:38:51.215Z] Pushing NEW ORDER for SO 3290103
[2026-05-31T07:38:51.957Z] SO row created — soId=cmptgxnsd009esx3p1a3hh7pd poId=cmptgxnsc009csx3phtcsnvew
[2026-05-31T07:38:51.957Z] Step 1/4: waiting for outbound "ls_dispatch" (timeout 30000ms)
[2026-05-31T07:38:52.362Z] Step 1: targeting email 7zqiyw0h with reply: "Please reduce YE1EDWO00001APJP (M-A) from 50 to 30 units. Keep the rest as is."
[2026-05-31T07:38:54.926Z] Step 1: handleReplyV2 returned matched=true
[2026-05-31T07:38:55.931Z] Step 2/4: waiting for outbound "dispatch_confirmation" (timeout 30000ms)
[2026-05-31T07:38:55.933Z] Step 2: targeting email altyek88 with reply: "Confirmed. Proceed with the reduced quantity."
[2026-05-31T07:38:58.541Z] Step 2: handleReplyV2 returned matched=true
[2026-05-31T07:38:59.546Z] Step 3/4: waiting for outbound "vehicle_details" (timeout 30000ms)
[2026-05-31T07:38:59.549Z] Step 3: targeting email 8dmluyod with reply: "Vehicle: MH12EF9012, Driver: 9123456789, LR: LR-003 dated 2026-05-31"
[2026-05-31T07:39:03.139Z] Step 3: handleReplyV2 returned matched=true
[2026-05-31T07:39:03.140Z]   [operator input sim] persisted lrNumber=LR-003 lrDate=2026-05-31 on SO
[2026-05-31T07:39:04.142Z] Step 4/4: waiting for outbound "plant_ls" (timeout 30000ms)
[2026-05-31T07:39:04.144Z] Step 4: targeting email xb6p3ir7 with reply: "Invoice 7682614522 OBD 5070000125 attached."
[2026-05-31T07:39:04.147Z]   [plant invoice sim] marked 3 plant_ls Email row(s) in bundle rzuwfocf as replied with mock PDF URL
[2026-05-31T07:39:07.069Z] Step 4: handleReplyV2 returned matched=true
[2026-05-31T07:39:10.074Z] Shipment(s) created (1); simulating operator VT01N click per shipment
[2026-05-31T07:39:10.092Z]   triggerVto1n(tzgc6e5s) enqueued (obd=85817681)
```
