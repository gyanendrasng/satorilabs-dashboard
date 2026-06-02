# Test case: release_all_no_change

**Description**: Branch confirms full dispatch with no quantity changes (no modification).
**SO Number**: 3290101
**Customer**: TEST-CUST-RELEASE-ALL
**Started**: 2026-06-02T14:32:22.681Z
**Finished**: 2026-06-02T14:32:55.366Z (duration 32.7s)
**Result**: ✅ PASS

## SAP transactions (instruction payloads)

| # | Transaction | State | Work ID | Enqueued | Finished |
|---|---|---|---|---|---|
| 1 | ZSO-VISIBILITY | done | `yy54pmr4` | 2026-06-02T14:32:25.232Z | 2026-06-02T14:32:25.545Z |
| 2 | ZLOAD1 | done | `2jy2dyno` | 2026-06-02T14:32:37.773Z | 2026-06-02T14:32:38.878Z |
| 3 | ZLOAD3-B1 | done | `e8s2vs5u` | 2026-06-02T14:32:50.408Z | 2026-06-02T14:32:50.649Z |
| 4 | VTO1N-B | done | `1ahaoc0n` | 2026-06-02T14:32:53.444Z | 2026-06-02T14:32:53.661Z |

### Transaction 1 — ZSO-VISIBILITY

- **Work ID**: `cmpwql768000csxb4yy54pmr4`
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

- **Work ID**: `cmpwqlguk001qsxb42jy2dyno`
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
      "bundle_id": "cmpwqlgu5001osxb4zz0r84ae",
      "bundle_number": 1,
      "dedup_key": "so:3290101|bundle:1"
    }
  }
  ```

### Transaction 3 — ZLOAD3-B1

- **Work ID**: `cmpwqlqlk003gsxb4e8s2vs5u`
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
      "bundle_id": "cmpwqlgu5001osxb4zz0r84ae",
      "bundle_number": 1
    }
  }
  ```

### Transaction 4 — VTO1N-B

- **Work ID**: `cmpwqlsxv003wsxb41ahaoc0n`
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
      "shipment_id": "cmpwqlqrr003qsxb438fzq21a",
      "bundle_id": "cmpwqlgu5001osxb4zz0r84ae",
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
[T+0:00:00] email_sent           ls_dispatch to test-branch@example.com — "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-178041074…"
[T+0:00:00] step_completed       zso_visibility ✓
[T+0:00:00] email_received       from branch — Subject "Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-178041074…" — "Confirmed. Please release everything as available and proceed with dispatch."
[T+0:00:07] classifier_decision  llm-planned
[T+0:00:07] scenario_started     llm-planned
[T+0:00:07] step_fired           email_confirm_bundle_details
[T+0:00:07] email_sent           dispatch_confirmation to test-branch@example.com — "Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780410742703"
[T+0:00:07] step_completed       email_confirm_bundle_details ✓
[T+0:00:07] scenario_completed   llm-planned
[T+0:00:08] email_received       from branch — Subject "Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780410742703" — "Confirmed. Please proceed with the dispatch plan as outlined."
[T+0:00:12] classifier_decision  llm-planned
[T+0:00:12] scenario_started     llm-planned
[T+0:00:12] step_fired           zload1
[T+0:00:13] email_sent           vehicle_details to test-branch@example.com — "Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780410742…"
[T+0:00:13] step_completed       zload1 ✓ — LS 373284:PENDING=?, 373283:PENDING=?, 373282:PENDING=?
[T+0:00:13] step_fired           email_to_branch_for_vehicle
[T+0:00:13] step_completed       email_to_branch_for_vehicle ✓
[T+0:00:13] scenario_completed   llm-planned
[T+0:00:13] email_received       from branch — Subject "Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780410742…" — "Vehicle: MH12AB1234, Driver: 9876543210, LR: LR-001 dated 2026-05-31"
[T+0:00:17] classifier_decision  llm-planned
[T+0:00:17] scenario_started     llm-planned
[T+0:00:17] step_fired           email_to_plant
[T+0:00:19] email_sent           plant_ls to test-plant@example.com — "Loading Slip 373282 - SO 3290101"
[T+0:00:19] email_sent           plant_ls to test-plant@example.com — "Loading Slip 373283 - SO 3290101"
[T+0:00:19] email_sent           plant_ls to test-plant@example.com — "Loading Slip 373284 - SO 3290101"
[T+0:00:19] step_completed       email_to_plant ✓
[T+0:00:19] scenario_completed   llm-planned
[T+0:00:20] email_received       from plant — Subject "Loading Slip 373284 - SO 3290101" — "Invoice attached. Invoice number 7682614520, OBD 5070000123."
[T+0:00:25] classifier_decision  llm-planned
[T+0:00:25] scenario_started     llm-planned
[T+0:00:25] step_fired           process_plant_invoice
[T+0:00:25] step_completed       process_plant_invoice ✓
[T+0:00:25] scenario_completed   llm-planned
[T+0:00:25] step_completed       process_plant_invoice ✓
[T+0:00:25] scenario_completed   llm-planned
[T+0:00:25] step_completed       zload3b1 ✓
[T+0:00:28] step_completed       vto1n ✓
```

## Email thread

```
--- Turn 1 [2026-06-02T14:32:25.534Z] US → test-branch@example.com [type=ls_dispatch] ---
Subject: Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780410742703
Dispatch Recommendation - AUTO-MOCK-NEWORDER-1780410742703 Dear Sales Team, Sales Order 3290101 I have reviewed the stock availability for Sales Order 3290101. Here is the dispatch recommendation: M-A [YE1EDWO00001APJP] : Stock is confirmed available. Proceed with 50 units from Batch A-26. M-B [YV6FRYENE0000PJP] : Stock is confirmed available. Proceed with 100 units from Batch 30-07-2025. M-C [YA4COWOCR000043P] : Stock is confirmed available. Proceed with 250 units from Batch 20. Best regards, Sales Order Dispatch Co-ordinator

--- Turn 2 [2026-06-02T14:32:25.641Z] test-branch@example.com → US [type=ls_dispatch] ---
Subject: Re: Dispatch Approval Request - PO AUTO-MOCK-NEWORDER-1780410742703
Confirmed. Please release everything as available and proceed with dispatch.

--- Turn 3 [2026-06-02T14:32:33.058Z] US → test-branch@example.com [type=dispatch_confirmation] ---
Subject: Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780410742703
Dear Branch Team, Dispatch plan ready for Purchase Order AUTO-MOCK-NEWORDER-1780410742703 (Customer 1). Total 10.665 t — fits in 1 vehicle (capacity 35 t). Proposed dispatch (grouped by bundle): Bundle 1 — 10.665 t (of 35 t capacity): - SO 3290101 / YA4COWOCR000043P (Batch 20): 250 units, 6.625 t - SO 3290101 / YE1EDWO00001APJP (Batch A-26): 50 units, 1.320 t - SO 3290101 / YV6FRYENE0000PJP (Batch 30-07-2025): 100 units, 2.720 t Please reply with: - "yes" / "confirm" to proceed with the above plan, or - the changes you want (e.g. "skip OOWJ on SO 1234567", "send only 15 of OP7WJ"). Once confirmed we will create the loading slips. Best regards, Sales Order Dispatch Co-ordinator

--- Turn 4 [2026-06-02T14:32:34.066Z] test-branch@example.com → US [type=dispatch_confirmation] ---
Subject: Re: Dispatch Confirmation - PO AUTO-MOCK-NEWORDER-1780410742703
Confirmed. Please proceed with the dispatch plan as outlined.

--- Turn 5 [2026-06-02T14:32:38.881Z] US → test-branch@example.com [type=vehicle_details] ---
Subject: Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780410742703 (1 bundle)
Dear Branch Team, Loading slips for Purchase Order AUTO-MOCK-NEWORDER-1780410742703 are now ready in SAP. The PO is split into 1 bundle: Bundle 1 (~10.66 t): - SO 3290101 / LS 373282 / Material PENDING - SO 3290101 / LS 373283 / Material PENDING - SO 3290101 / LS 373284 / Material PENDING Please reply with vehicle/transport details for each bundle in the format below: Bundle 1: , , Best regards, Sales Order Dispatch Co-ordinator

--- Turn 6 [2026-06-02T14:32:44.905Z] test-branch@example.com → US [type=vehicle_details] ---
Subject: Re: Vehicle Details Required - PO AUTO-MOCK-NEWORDER-1780410742703 (1 bundle)
Vehicle: MH12AB1234, Driver: 9876543210, LR: LR-001 dated 2026-05-31

--- Turn 7 [2026-06-02T14:32:45.934Z] test-plant@example.com → US [type=plant_ls] ---
Subject: Re: Loading Slip 373282 - SO 3290101
Invoice attached. Invoice number 7682614520, OBD 5070000123.

--- Turn 8 [2026-06-02T14:32:45.934Z] test-plant@example.com → US [type=plant_ls] ---
Subject: Re: Loading Slip 373283 - SO 3290101
Invoice attached. Invoice number 7682614520, OBD 5070000123.

--- Turn 9 [2026-06-02T14:32:45.934Z] test-plant@example.com → US [type=plant_ls]   ← LATEST INBOUND (plan for THIS) ---
Subject: Re: Loading Slip 373284 - SO 3290101
Invoice attached. Invoice number 7682614520, OBD 5070000123.
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
| YV6FRYENE0000PJP | 30-07-2025 | 100 | 100 | 100 |
| YA4COWOCR000043P | 20 | 250 | 250 | 250 |

## Run log

```
[2026-06-02T14:32:22.702Z] Pushing NEW ORDER for SO 3290101
[2026-06-02T14:32:25.236Z] SO row created — soId=cmpwql7610006sxb4c4eges6g poId=cmpwql75z0004sxb4kfs1bqi2
[2026-06-02T14:32:25.236Z] Step 1/4: waiting for outbound "ls_dispatch" (timeout 30000ms)
[2026-06-02T14:32:25.641Z] Step 1: targeting email e5e7n8yb with reply: "Confirmed. Please release everything as available and proceed with dispatch."
[2026-06-02T14:32:33.062Z] Step 1: handleReplyV2 returned matched=true
[2026-06-02T14:32:34.065Z] Step 2/4: waiting for outbound "dispatch_confirmation" (timeout 30000ms)
[2026-06-02T14:32:34.066Z] Step 2: targeting email 3vrxi3sp with reply: "Confirmed. Please proceed with the dispatch plan as outlined."
[2026-06-02T14:32:37.776Z] Step 2: handleReplyV2 returned matched=true
[2026-06-02T14:32:38.856Z] Step 3/4: waiting for outbound "vehicle_details" (timeout 30000ms)
[2026-06-02T14:32:39.058Z] Step 3: targeting email vp00pna7 with reply: "Vehicle: MH12AB1234, Driver: 9876543210, LR: LR-001 dated 2026-05-31"
[2026-06-02T14:32:44.923Z] Step 3: handleReplyV2 returned matched=true
[2026-06-02T14:32:44.924Z]   [operator input sim] persisted lrNumber=LR-001 lrDate=2026-05-31 on SO
[2026-06-02T14:32:45.928Z] Step 4/4: waiting for outbound "plant_ls" (timeout 30000ms)
[2026-06-02T14:32:45.929Z] Step 4: targeting email 48d76bwv with reply: "Invoice attached. Invoice number 7682614520, OBD 5070000123."
[2026-06-02T14:32:45.936Z]   [plant invoice sim] marked 3 plant_ls Email row(s) in bundle zz0r84ae as replied with mock PDF URL
[2026-06-02T14:32:50.430Z] Step 4: handleReplyV2 returned matched=true
[2026-06-02T14:32:53.436Z] Shipment(s) created (1); simulating operator VT01N click per shipment
[2026-06-02T14:32:53.449Z]   triggerVto1n(38fzq21a) enqueued (obd=85817679)
```
