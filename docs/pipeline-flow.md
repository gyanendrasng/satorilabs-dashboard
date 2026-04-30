# Dispatch pipeline — entity model & event flow

Mirrors the hierarchy diagram (PO → SOs → Line Items → LSs → Invoice → Dispatch)
but with the actual DB tables and the events that move data between them.

---

## 1. Entity hierarchy

Maps directly to the boxes in the original SAP-side diagram. Colors of LSIs in
the original = bundle assignment in ours.

```
                         ┌──────────────┐
                         │   Customer   │   id, name, weightage (truck capacity in tonnes)
                         └──────┬───────┘
                                │ 1:N
                                ▼
                         ┌──────────────┐
                         │ PurchaseOrder│   poNumber=AUTO-${gmail msgId}
                         └──┬─────────┬─┘
                            │ 1:N     │ 1:N
                ┌───────────┘         └────────────┐
                ▼                                   ▼
        ┌──────────────┐                    ┌──────────────┐
        │  SalesOrder  │ … 1–4 per email …  │    Bundle    │ … N per PO …
        │ (Cyan box)   │                    │ (truck-sized │
        │              │                    │  package of  │
        │              │                    │  LSIs)       │
        └──┬─────────┬─┘                    └──┬─────────┬─┘
           │ 1:N     │ 1:N                     │ 1:N     │ 1:N
           ▼         ▼                         ▼         ▼
      ┌─────────┐ ┌──────────┐         ┌────────────┐ ┌─────────┐
      │Material │ │   LSI    │ ←───────│  Shipment  │ │   LSI   │
      │(Line    │ │(LS-Px-S- │         │            │ │   …     │
      │ Item    │ │ Sx-Lx)   │         │ obdNumber  │ │         │
      │ box)    │ │          │         │ invoiceNo  │ │         │
      └─────────┘ └──────────┘         │ status     │ └─────────┘
                                        │ ← maps to ← │
                                        │ "IN-B*-*" + │
                                        │ "D-B*-*"    │
                                        └────────────┘
```

### Cardinalities

| Relation | Card | Notes |
|---|---|---|
| Customer → PO | 1:N | one Customer can place many POs over time |
| PO → SO | 1:N | up to 4 SOs per NEW ORDER email |
| PO → Bundle | 1:N | bundles are per-PO trucks |
| SO → Material | 1:N | one row per (material code, batch) the SO orders |
| SO → LSI | 1:N | one row per LS file SAP creates |
| Material → Bundle | N:1 | bundling decision lives here (`Material.bundleId`) |
| LSI → Bundle | N:1 | inherited from its Material at ZLOAD1 callback |
| LSI → Shipment | N:1 | set when ZLOAD3-B1 returns |
| **Bundle ↔ SO** | **N:N (via Shipment)** | one Shipment per (Bundle, SO) pair = one ZLOAD3-B1 request |

### One Shipment per ZLOAD3-B1 request

This is the key insight that drove the schema:

```
        Bundle B1                        Bundle B2
      ┌──────────┐                     ┌──────────┐
      │ LSIs of  │                     │ LSIs of  │
      │ SO-1     │   ← Shipment(B1,SO1)│ SO-1     │   ← Shipment(B2,SO1)
      │ in B1    │     OBD = "OBD-1"   │ in B2    │     OBD = "OBD-3"
      └──────────┘                     ├──────────┤
                                       │ LSIs of  │   ← Shipment(B2,SO2)
                                       │ SO-2     │     OBD = "OBD-4"
                                       │ in B2    │
                                       └──────────┘
```

A 2-bundle PO with one SO spanning both bundles produces **2 separate
Shipments** for that SO — distinct OBDs, no overwrites.

---

## 2. Pipeline timeline (happy path)

```
          PER-PO         PER-(BUNDLE,SO)        PER-LSI                EVENT
─────────────────────────────────────────────────────────────────────────────────
  ① NEW ORDER email arrives
     ├─ AI extracts customer_id + 1–4 SO numbers
     ├─ create/upsert Customer (default 31 t)
     ├─ create PO + N SalesOrders (visibilityState='firing')
     └─ enqueue ZSO-VISIBILITY × N on WorkQueue (one per SO)

  ② ZSO-VISIBILITY runs serially via WorkQueue
                    │
                    │  /chat → auto_gui2 → SAP → /visibility-data
                    ▼
        ┌──────────────────────┐
        │ Material rows written│   ← (per SO, per material, per batch)
        │ visibilityState=     │
        │   'received'         │
        └──────────────────────┘

  ③ When all SOs in PO have visibility:
     ├─ assembleAndSendCombinedEmail(po)
     ├─ ONE prose recommendation email → BRANCH_EMAIL
     │   "I have reviewed the stock availability for SOs A, B, C, D…"
     └─ Email row workflowState='awaiting_reply'

  ④ Branch replies (release_all / release_part / wait)
     ├─ release_*: per-SO release plan computed
     │             from Material rows (qty = min(requested, available)
     │             for release_part; full requested for release_all)
     ├─ Total weight summed across the PO
     └─ wait: SO.waitUntil = now + 3 days, silent recheck via cron

     ┌──────────────────────────────┐
     │  Total ≤ Customer.weightage? │
     └──┬───────────────────────────┘
        │ NO  → ⑤a vehicle-split inquiry email; on "yes",
        │       proceed to ⑤b. On amendments / "no", operator
        │       reviews on the dashboard.
        │ YES → ⑤b directly.
        ▼
  ⑤b Dispatch confirmation email — prose listing the plan,
     asks branch to reply "yes/confirm"

  ⑥ Branch confirms with "yes":
     ├─ computeBundlesForPo(po)
     │   greedy first-fit-decreasing → Material.bundleId set per row
     ├─ For each Bundle:
     │   └─ sendVehicleDetailsForBundle(bundle)  → one email per truck
     ├─ For each (Bundle, SO) pair:
     │   └─ enqueue ZLOAD1 work item
     │       payload.meta = { bundle_id, bundle_number, so_number }
     └─ WorkQueue serializes them one at a time

  ⑦ ZLOAD1 fires per (Bundle, SO) pair
                    │
                    │ /chat → auto_gui2 → SAP → /zload1-data (multipart)
                    ▼
        ┌──────────────────────┐
        │ LSI rows created     │
        │ fileUrl=R2 path      │
        │ bundleId=meta.bundle │   ← echoed via auto_gui2 meta passthrough
        └──────────────────────┘

  ⑧ Branch replies vehicle details (one truck OR all trucks in one email)
     ├─ OpenAI extracts array of {bundleNumber, vehicle, driver, container}
     └─ Each set saved on its Bundle. LSIs of completed bundles → plant.

  ⑨ Plant invoice replies (one per LS, attached PDF)
     ├─ checkForReplies stores PDF in R2 → Email.replyPdfUrl
     └─ checkAndSendBatchToAman(salesOrderId, lsi.bundleId)
        ├─ "all replied for this (Bundle, SO) pair?"
        └─ if yes → enqueue ZLOAD3-B1 work item (one per pair)

  ⑩ ZLOAD3-B1 fires per (Bundle, SO) pair
                    │
                    │ /chat with attachments + meta.bundle_id
                    │   → auto_gui2 → SAP → /processing-data
                    ▼
        ┌──────────────────────┐    ┌──────────────────────┐
        │ Shipment upsert by   │    │ LSI updates by       │
        │ (bundleId,           │    │ lsNumber:            │
        │  salesOrderId):      │    │   sapMaterialDoc     │
        │   obdNumber          │    │   sapLoadedQuantity  │
        │   invoiceNumber      │    │   shipmentId         │
        │   invoiceDate        │    └──────────────────────┘
        │   sapResults JSON    │
        │   status='created'   │
        └──────────────────────┘

  ⑪ Operator enters LR number + LR date on the SO (UI form)
     └─ PATCH /orders/sales-orders/[soId]
        ├─ Find ready Shipments (status='created', obdNumber set,
        │   bundle.vehicleNumber set)
        └─ For each Shipment → triggerVto1n(shipment.id)

  ⑫ VT01N fires per Shipment
                    │
                    │ /chat with OBD + LR + vehicle + meta.shipment_id
                    │   → auto_gui2 → SAP → /step-status
                    ▼
        Shipment.status = 'shipment-triggered' → 'shipped'
```

---

## 3. The global WorkQueue (one truck, one driver)

Every `/chat` to auto_gui2 goes through one global FIFO queue. SAP can only run
one transaction at a time, so this enforces serial firing across all POs and
all transaction types.

```
            ┌───────────────────────────────────────────────┐
            │                  WorkQueue                    │
            │  step | state    | payload (meta carries IDs) │
            ├──────────┬───────┬────────────────────────────┤
            │visibility│ done  │ SO-1                       │
            │visibility│ done  │ SO-2                       │
            │visibility│firing │ SO-3   ←── one at a time   │
            │visibility│queued │ SO-4                       │
            │ zload1   │queued │ (B1, SO-1)                 │
            │ zload1   │queued │ (B1, SO-2)                 │
            │ zload3b1 │queued │ (B2, SO-3)                 │
            │ vto1n    │queued │ shipment X                 │
            └──────────┴───────┴────────────────────────────┘

  pumpQueue() picks the oldest queued row when no row is firing.
  /step-status (auto_gui2 COMPLETION_WEBHOOK) flips firing → done|failed
  and pumps again. No retries on failure — failed work is skipped.
```

Correlation IDs ride inside `payload.meta`:
- `work_id` (cuid) — injected by `pumpQueue` so the COMPLETION webhook can match.
- `so_number`, `bundle_id`, `bundle_number` — set at enqueue time so data callbacks (`/zload1-data`, `/processing-data`) can scope writes correctly.

---

## 4. Email flow (per-PO)

```
NEW ORDER (in)                                                     ┌──────────┐
  └─────────────────────────────────────────────────────────────►  │  Branch  │
                                                                    └──────────┘
                                                                          ▲
                                              dispatch recommendation     │
                                              (1 email per PO,            │
                                               1 section per SO)          │
  Branch reply (intent)                                                   │
  ◄──────────────────────────────────────────────────────────────────────┘

      [ weight gate; possibly vehicle-split inquiry → reply → ]

  Dispatch confirmation                                                   ▲
  ──────────────────────────────────────────────────────────────────────►│
  Branch reply ("yes")                                                    │
  ◄──────────────────────────────────────────────────────────────────────┘

  Vehicle details request × N bundles                                     ▲
  ──────────────────────────────────────────────────────────────────────►│
  Branch reply (one OR many trucks per email)                             │
  ◄──────────────────────────────────────────────────────────────────────┘
                                                                    ┌──────────┐
                                                                    │  Plant   │
  LS PDF attached × N LSIs (per Bundle's vehicle details) ───────► │          │
                                                                    └──────────┘
  Plant invoice reply × N (PDF attached)        ◄─────────────────────  ┘
```

---

## 5. Files map

| Concern | File |
|---|---|
| Schema | `prisma/schema.prisma` |
| Email fetch / cron | `src/lib/email-reply-checker.ts` |
| AI extractors | `src/lib/so-extractor.ts` |
| WorkQueue | `src/lib/work-queue.ts` |
| Bundling (greedy FFD) | `src/lib/bundler.ts` |
| Combined email (HTML) | `src/lib/dispatch-email-template.ts` |
| Outbound to auto_gui2 + handlers | `src/lib/auto-gui-trigger.ts` |
| `/visibility-data` callback | `src/app/backend/orders/aman/visibility-data/route.ts` |
| `/zload1-data` callback | `src/app/backend/orders/aman/zload1-data/route.ts` |
| `/processing-data` callback | `src/app/backend/orders/aman/processing-data/route.ts` |
| `/step-status` (COMPLETION webhook) | `src/app/backend/orders/aman/step-status/route.ts` |
| Cron entrypoint | `src/app/backend/cron/check-emails/route.ts` |
| Mock auto_gui2 (tests) | `scripts/dummy-auto-gui2/server.mjs` |
