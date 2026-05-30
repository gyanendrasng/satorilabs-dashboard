# Chain: plant_invoice_arrival

**Description**: Isolates SAP tail — plant sends invoice, ZLOAD3-B1 → VT01N → completed
**SO Number**: 3280005
**Seed Stage**: after_email_to_plant
**Scenario Key**: (none — went through legacy handlers only)
**Started**: 2026-05-30T08:03:01.726Z
**Finished**: 2026-05-30T08:03:03.023Z (duration: 1297ms)
**Result**: ✅ PASS

## Step-by-step execution

### Step 1 — Plant replies with invoice PDF — triggers ZLOAD3-B1

**Action**: `plant_invoice_reply`
**Duration**: 214ms
**Outcome**: ✓ pass

**Driver notes**:
- Marking 3 plant_ls email(s) replied with synthetic PDF
- Firing checkAndSendBatchToAman with bundleId=cmps2cvsh007bsxyjsso4t509
- checkAndSendBatchToAman returned success=true

### Step 2 — Wait for Shipment row from /processing-data callback

**Action**: `wait_for_shipment`
**Duration**: 408ms
**Outcome**: ✓ pass

**Driver notes**:
- Shipment found (id=cmps2cvyu007ysxyj1lsjpgbv status=created obd=85817683) after 202ms

### Step 3 — Trigger VT01N for the Shipment

**Action**: `trigger_vt01n`
**Duration**: 222ms
**Outcome**: ✓ pass

**Driver notes**:
- Firing triggerVto1n on Shipment cmps2cvyu007ysxyj1lsjpgbv

### Step 4 — Wait for SO status = completed

**Action**: `wait_for_so_status`
**Duration**: 417ms
**Outcome**: ✓ pass

**Driver notes**:
- SO.status=completed after 204ms

## Final DB state

| Field | Value |
|---|---|
| SO.status | `completed` |
| ScenarioProgress.state | `(none)` |
| LoadingSlipItem count | 3 |
| LSI with sapMaterialDoc | 3 |
| Invoice.invoiceNumber | `7682614524` |
| Invoice.obdNumber | `85817683` |
| Shipment.status | `shipped` |
| ScenarioEvent count | 0 |

## Complete audit trail (chronological)

```
(no prior actions on this SO yet)
```

## Complete email thread (chronological)

```
[2026-05-30T08:03:01.755Z] OUTBOUND to test-plant@example.com [type=plant_ls] — Subject: "LS PRE-YE1EDWO00001APJP for SO 3280005"
  Body: Loading slip PRE-YE1EDWO00001APJP

[2026-05-30T08:03:01.756Z] OUTBOUND to test-plant@example.com [type=plant_ls] — Subject: "LS PRE-YV6FRYENE0000PJP for SO 3280005"
  Body: Loading slip PRE-YV6FRYENE0000PJP

[2026-05-30T08:03:01.757Z] OUTBOUND to test-plant@example.com [type=plant_ls] — Subject: "LS PRE-YA4COWOCR000043P for SO 3280005"
  Body: Loading slip PRE-YA4COWOCR000043P

[2026-05-30T08:03:01.760Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: LS PRE-YE1EDWO00001APJP for SO 3280005"
  Body: Plant invoice attached. Invoice 7682614520, OBD 85817679.

[2026-05-30T08:03:01.761Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: LS PRE-YV6FRYENE0000PJP for SO 3280005"
  Body: Plant invoice attached. Invoice 7682614520, OBD 85817679.

[2026-05-30T08:03:01.761Z] INBOUND from test-plant@example.com [type=plant_ls] — Subject: "Re: LS PRE-YA4COWOCR000043P for SO 3280005"
  Body: Plant invoice attached. Invoice 7682614520, OBD 85817679.
```

## Verifications

- ✓ SO.status === `completed` (actual: `completed`)
- ✓ LSI count ≥ 3 (actual: 3)
- ✓ LSI with sapMaterialDoc ≥ 3 (actual: 3)
- ✓ Invoice number present (actual: `7682614524`)
- ✓ Shipment row exists (actual status: `shipped`)
