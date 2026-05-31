# Test case: modify_delete_pre_ls

**Description**: Branch asks to delete YA4COWOCR000043P (M-C) BEFORE LS is created. Surviving materials dispatched.
**SO Number**: 3290104
**Customer**: TEST-CUST-MOD-DEL
**Started**: 2026-05-31T07:39:12.019Z
**Finished**: 2026-05-31T07:39:32.387Z (duration 20.4s)
**Result**: ✅ PASS

## SAP transactions (instruction payloads)

| # | Transaction | State | Work ID | Enqueued | Finished |
|---|---|---|---|---|---|
| 1 | ZSO-VISIBILITY | done | `hrjyyb5u` | 2026-05-31T07:39:12.774Z | 2026-05-31T07:39:13.008Z |
| 2 | ZLOAD1 | done | `zoansohy` | 2026-05-31T07:39:19.541Z | 2026-05-31T07:39:19.787Z |
| 3 | ZLOAD3-B1 | done | `lduz0ptz` | 2026-05-31T07:39:27.431Z | 2026-05-31T07:39:27.667Z |
| 4 | VTO1N-B | done | `9qohgprx` | 2026-05-31T07:39:30.464Z | 2026-05-31T07:39:30.676Z |

### Transaction 1 — ZSO-VISIBILITY

- **Work ID**: `cmptgy3uu00ddsx3phrjyyb5u`
- **State**: done
- **Instruction sent to SAP**:
  ```
  VPN is connected and SAP is logged in. Just go ahead and run the SAP Transaction ZSO-VISIBILITY for Sales order number 3290104.
  ```
- **Structured args**:
  ```json
  {
    "transaction_code": "ZSO-VISIBILITY",
    "meta": {
      "so_number": "3290104"
    }
  }
  ```

### Transaction 2 — ZLOAD1

- **Work ID**: `cmptgy92t00ersx3pzoansohy`
- **State**: done
- **Instruction sent to SAP**:
  ```
  VPN is connected, SAP is logged in. Execute ZLOAD1 for sales order 3290104 (Bundle 1). Materials to dispatch:
  - Material: YE1EDWO00001APJP, Batch: A-26, Quantity: 50
  - Material: YV6FRYENE0000PJP, Batch: 30-07-2025, Quantity: 100
  - Material: YA4COWOCR000043P, Batch: 20, Quantity: 250
  ```
- **Structured args**:
  ```json
  {
    "transaction_code": "ZLOAD1",
    "so_number": "3290104",
    "meta": {
      "so_number": "3290104",
      "bundle_id": "cmptgy92o00epsx3pia49lxf5",
      "bundle_number": 1
    }
  }
  ```

### Transaction 3 — ZLOAD3-B1

- **Work ID**: `cmptgyf5y00gbsx3plduz0ptz`
- **State**: done
- **Instruction sent to SAP**:
  ```
  VPN is connected, SAP is logged in. Just execute ZLOAD3-B1 for sales order 3290104 (Bundle 1)
  ```
- **Structured args**:
  ```json
  {
    "transaction_code": "ZLOAD3-B1",
    "so_number": "3290104",
    "attachments": [
      {
        "filename": "373291.pdf",
        "content_base64": "JVBERi0xLjQKJW1vY2stZTJlLXBkZgo="
      },
      {
        "filename": "373292.pdf",
        "content_base64": "JVBERi0xLjQKJW1vY2stZTJlLXBkZgo="
      },
      {
        "filename": "373293.pdf",
        "content_base64": "JVBERi0xLjQKJW1vY2stZTJlLXBkZgo="
      }
    ],
    "extraction_context": "For each file, extract the loading slip number, loaded quantity, invoice number, and invoice date",
    "meta": {
      "so_number": "3290104",
      "bundle_id": "cmptgy92o00epsx3pia49lxf5",
      "bundle_number": 1
    }
  }
  ```

### Transaction 4 — VTO1N-B

- **Work ID**: `cmptgyhi800grsx3p9qohgprx`
- **State**: done
- **Instruction sent to SAP**:
  ```
  VPN is connected and SAP is logged in. Just go ahead and run the SAP Transaction VT01N. OBD number is 85817682, LR number is LR-004, LR date is 31.05.2026 and Vehicle number is MH12GH3456
  ```
- **Structured args**:
  ```json
  {
    "transaction_code": "VTO1N-B",
    "so_number": "3290104",
    "extraction_context": "Extract the OBD number, LR number, LR date and Vehicle number",
    "meta": {
      "so_number": "3290104",
      "shipment_id": "cmptgyfby00glsx3pk1gv9hhr",
      "bundle_id": "cmptgy92o00epsx3pia49lxf5",
      "bundle_number": 1,
      "obd_number": "85817682"
    }
  }
  ```

## Event chain (audit trail)

```
[T+0:00:00] email_received       from branch — Subject "NEW ORDER 3290104" — "Dear Sales Team, Please create SO 3290104 for customer TEST-CUST-MOD-DEL. Mater…"
[T+0:00:00] classifier_decision  action=new_order
[T+0:00:00] step_completed       zso_visibility ✓ — materials YE1EDWO00001APJP=50, YV6FRYENE0000PJP=100, YA4COWOCR000043P=250
[T+0:00:00] email_sent           ls_dispatch to test-branch@example.com — "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-178021315…"
[T+0:00:00] step_completed       zso_visibility ✓
[T+0:00:00] email_received       from branch — Subject "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-178021315…" — "Please drop YA4COWOCR000043P (M-C) entirely from this order. Dispatch only the …"
[T+0:00:03] classifier_decision  llm-planned
[T+0:00:03] scenario_started     llm-planned
[T+0:00:03] step_fired           email_confirm_bundle_details
[T+0:00:03] email_sent           dispatch_confirmation to test-branch@example.com — "Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780213152038"
[T+0:00:03] step_completed       email_confirm_bundle_details ✓
[T+0:00:03] scenario_completed   llm-planned
[T+0:00:04] email_received       from branch — Subject "Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780213152038" — "Confirmed."
[T+0:00:06] classifier_decision  llm-planned
[T+0:00:06] scenario_started     llm-planned
[T+0:00:06] step_fired           zload1
[T+0:00:07] email_sent           vehicle_details to test-branch@example.com — "Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780213152…"
[T+0:00:07] step_completed       zload1 ✓ — LS 373293:PENDING=?, 373292:PENDING=?, 373291:PENDING=?
[T+0:00:07] step_fired           email_to_branch_for_vehicle
[T+0:00:07] step_completed       email_to_branch_for_vehicle ✓
[T+0:00:07] scenario_completed   llm-planned
[T+0:00:07] email_received       from branch — Subject "Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780213152…" — "Vehicle: MH12GH3456, Driver: 9988123456, LR: LR-004 dated 2026-05-31"
[T+0:00:09] classifier_decision  llm-planned
[T+0:00:09] scenario_started     llm-planned
[T+0:00:09] step_fired           email_to_plant
[T+0:00:11] email_sent           plant_ls to test-plant@example.com — "Loading Slip 373291 - SO 3290104"
[T+0:00:11] email_sent           plant_ls to test-plant@example.com — "Loading Slip 373292 - SO 3290104"
[T+0:00:11] email_sent           plant_ls to test-plant@example.com — "Loading Slip 373293 - SO 3290104"
[T+0:00:11] step_completed       email_to_plant ✓
[T+0:00:11] scenario_completed   llm-planned
[T+0:00:12] email_received       from plant — Subject "Loading Slip 373293 - SO 3290104" — "Invoice 7682614523 OBD 5070000126 attached."
[T+0:00:14] classifier_decision  llm-planned
[T+0:00:14] scenario_started     llm-planned
[T+0:00:14] step_fired           process_plant_invoice
[T+0:00:14] step_completed       process_plant_invoice ✓
[T+0:00:14] scenario_completed   llm-planned
[T+0:00:14] step_completed       process_plant_invoice ✓
[T+0:00:14] scenario_completed   llm-planned
[T+0:00:14] step_completed       zload3b1 ✓
[T+0:00:17] step_completed       vto1n ✓
```

## Email thread

```
[2026-05-31T07:39:12.999Z] OUTBOUND to test-branch@example.com [type=ls_dispatch] — Subject: "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780213152038"
  Body: Dispatch Recommendation - AUTO-MOCK-NEWORDER-1780213152038 Dear Sales Team, Sales Order 3290104 I have reviewed the stock availability for Sales Order 3290104. Here is the dispatch recommendation: M-A [YE1EDWO00001APJP] : Stock is confirmed available. Proceed with 50 units from Batch A-26. M-B [YV6FRYENE0000PJP] : Stock is confirmed available. Proceed with 100 units from Batch 30-07-2025. M-C [YA4COWOCR000043P] : Stock is confirmed available. Proceed with 250 units from Batch 20. Best regards, Sales Order Dispatch Co-ordinator

[2026-05-31T07:39:13.185Z] INBOUND from test-branch@example.com [type=ls_dispatch] — Subject: "Re: Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780213152038"
  Body: Please drop YA4COWOCR000043P (M-C) entirely from this order. Dispatch only the remaining two materials.

[2026-05-31T07:39:16.077Z] OUTBOUND to test-branch@example.com [type=dispatch_confirmation] — Subject: "Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780213152038"
  Body: Dear Branch Team, Dispatch plan ready for Purchase Order AUTO-MOCK-NEWORDER-1780213152038 (Customer 1). Total 10.665 t — fits in 1 vehicle (capacity 35 t). Proposed dispatch (grouped by bundle): Bundle 1 — 10.665 t (of 35 t capacity): - SO 3290104 / YA4COWOCR000043P (Batch 20): 250 units, 6.625 t - SO 3290104 / YE1EDWO00001APJP (Batch A-26): 50 units, 1.320 t - SO 3290104 / YV6FRYENE0000PJP (Batch 30-07-2025): 100 units, 2.720 t Please reply with: - "yes" / "confirm" to proceed with the above plan, or - the changes you want (e.g. "skip OOWJ on SO 1234567", "send only 15 of OP7WJ"). Once confirmed we will create the loading slips. Best regards, Sales Order Dispatch Co-ordinator

[2026-05-31T07:39:17.086Z] INBOUND from test-branch@example.com [type=dispatch_confirmation] — Subject: "Re: Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780213152038"
  Body: Confirmed.

[2026-05-31T07:39:19.792Z] OUTBOUND to test-branch@example.com [type=vehicle_details] — Subject: "Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780213152038 (1 bundle)"
  Body: Dear Branch Team, Loading slips for Purchase Order AUTO-MOCK-NEWORDER-1780213152038 are now ready in SAP. The PO is split into 1 bundle: Bundle 1 (~10.66 t): - SO 3290104 / LS 373291 / Material PENDING - SO 3290104 / LS 373292 / Material PENDING - SO 3290104 / LS 373293 / Material PENDING Please reply with vehicle/transport details for each bundle in the format below: Bundle 1: , , Best regards, Sales Order Dispatch Co-ordinator

[2026-05-31T07:39:24.102Z] INBOUND from test-branch@example.com [type=vehicle_details] — Subject: "Re: Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780213152038 (1 bundle)"
  Body: Vehicle: MH12GH3456, Driver: 9988123456, LR: LR-004 dated 2026-05-31

[2026-05-31T07:39:25.138Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373291 - SO 3290104"
  Body: Invoice 7682614523 OBD 5070000126 attached.

[2026-05-31T07:39:25.138Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373292 - SO 3290104"
  Body: Invoice 7682614523 OBD 5070000126 attached.

[2026-05-31T07:39:25.138Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: Loading Slip 373293 - SO 3290104"
  Body: Invoice 7682614523 OBD 5070000126 attached.
```

## Final DB state

- **SO.status**: completed
- **PO.dispatchRound**: 1
- **Material rows**: 3
- **LoadingSlipItem rows**: 3
- **Invoice**: #7682614523
- **Shipments**: 1 (shipped)

### Materials

| Material | Batch | Ordered | Available | Dispatch |
|---|---|---|---|---|
| YE1EDWO00001APJP | A-26 | 50 | 50 | 50 |
| YV6FRYENE0000PJP | 30-07-2025 | 100 | 100 | 100 |
| YA4COWOCR000043P | 20 | 250 | 250 | 250 |

## Run log

```
[2026-05-31T07:39:12.038Z] Pushing NEW ORDER for SO 3290104
[2026-05-31T07:39:12.777Z] SO row created — soId=cmptgy3um00d7sx3pnifb04x9 poId=cmptgy3uk00d5sx3p80orzu49
[2026-05-31T07:39:12.777Z] Step 1/4: waiting for outbound "ls_dispatch" (timeout 30000ms)
[2026-05-31T07:39:13.184Z] Step 1: targeting email om4aglo4 with reply: "Please drop YA4COWOCR000043P (M-C) entirely from this order. Dispatch only the r"
[2026-05-31T07:39:16.082Z] Step 1: handleReplyV2 returned matched=true
[2026-05-31T07:39:17.084Z] Step 2/4: waiting for outbound "dispatch_confirmation" (timeout 30000ms)
[2026-05-31T07:39:17.086Z] Step 2: targeting email j8sdtwys with reply: "Confirmed."
[2026-05-31T07:39:19.546Z] Step 2: handleReplyV2 returned matched=true
[2026-05-31T07:39:20.550Z] Step 3/4: waiting for outbound "vehicle_details" (timeout 30000ms)
[2026-05-31T07:39:20.553Z] Step 3: targeting email 1wa52mlt with reply: "Vehicle: MH12GH3456, Driver: 9988123456, LR: LR-004 dated 2026-05-31"
[2026-05-31T07:39:24.125Z] Step 3: handleReplyV2 returned matched=true
[2026-05-31T07:39:24.126Z]   [operator input sim] persisted lrNumber=LR-004 lrDate=2026-05-31 on SO
[2026-05-31T07:39:25.129Z] Step 4/4: waiting for outbound "plant_ls" (timeout 30000ms)
[2026-05-31T07:39:25.132Z] Step 4: targeting email rchfznr7 with reply: "Invoice 7682614523 OBD 5070000126 attached."
[2026-05-31T07:39:25.140Z]   [plant invoice sim] marked 3 plant_ls Email row(s) in bundle ia49lxf5 as replied with mock PDF URL
[2026-05-31T07:39:27.445Z] Step 4: handleReplyV2 returned matched=true
[2026-05-31T07:39:30.455Z] Shipment(s) created (1); simulating operator VT01N click per shipment
[2026-05-31T07:39:30.470Z]   triggerVto1n(k1gv9hhr) enqueued (obd=85817682)
```
