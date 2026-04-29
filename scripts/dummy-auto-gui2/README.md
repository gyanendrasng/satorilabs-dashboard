# Dummy auto_gui2 server

Mocks the auto_gui2 service so the dashboard can be exercised end-to-end
without SAP, VPN, or a Windows host. Single Node script, no install.

## Run

```bash
node scripts/dummy-auto-gui2/server.mjs
```

In another terminal, start the dashboard:

```bash
AUTO_GUI_HOST=localhost AUTO_GUI_PORT=8000 npm run dev
```

The dashboard's outgoing `/chat` calls now hit the dummy. The dummy fires
the matching data callback (`/visibility-data`, `/zload1-data`, or
`/processing-data`) and then sends a COMPLETION webhook to
`/backend/orders/aman/step-status` so the WorkQueue advances.

Trigger the cron once to seed orders, then watch the queue march forward:

```bash
curl http://localhost:3000/backend/cron/check-emails
```

## Environment

| Var | Default | Effect |
|---|---|---|
| `PORT` | `8000` | Where the dummy listens |
| `DASHBOARD_URL` | `http://localhost:3000` | Where to POST callbacks |
| `DUMMY_DELAY_MS` | `2000` | Simulated SAP run time per `/chat` |
| `DUMMY_FAIL_RATE` | `0` | 0..1 chance any `/chat` returns failure |
| `DUMMY_FAIL_TRANSACTIONS` | `` | Comma list that always fails (e.g. `ZLOAD1,VTO1N-B`) |
| `DUMMY_LS_PER_SO` | `0` | Cap LSs per ZLOAD1 fire (0 = one per material) |

## Fixtures

Drop JSON files under `fixtures/` to override defaults per SO. Files are
optional — the server falls back to baked-in defaults.

```
fixtures/
  visibility/
    1234567.json          # ZSO-VISIBILITY result for SO 1234567
    _default.json         # used when no SO-specific file
  branch-reply/
    release_all.json      # canned intent classifications
    release_part.json
    wait.json
  processing/
    1234567.json          # ZLOAD3-B1 result rows for SO 1234567
```

### `visibility/<so>.json`
```json
{
  "materials": [
    { "material": "OP7WJ-1234", "material_description": "...", "batch": "B001",
      "order_quantity": 20, "available_stock_for_so": 20, "order_weight_kg": 480 },
    ...
  ]
}
```

### `branch-reply/<intent>.json` (intent ∈ release_all | release_part | wait)
```json
{
  "success": true,
  "intent": "release_part",
  "materials": [{ "material": "...", "batch": "...", "quantity": 13 }]
}
```

The server picks the intent from keywords in `branch_reply_html` (`wait`,
`hold`, `partial`, etc.); fixture only kicks in if it exists for that intent.

### `processing/<so>.json`
```json
{
  "items": [
    { "sales_order": "1234567", "material_doc": "4900012345",
      "delivery_no": "8000054321", "invoice_no": "HRJ-2024-001234" }
  ]
}
```

## What it covers

| Stage | How dummy handles it |
|---|---|
| ZSO-VISIBILITY | sends `/visibility-data` JSON with materials fixture, then `/step-status` success |
| ZLOAD1 | parses materials from instruction, posts one multipart `/zload1-data` per material with a stub PDF, echoes `bundle_id` from `meta` so per-bundle linking works, then `/step-status` |
| ZLOAD3-B1 | sends `/processing-data` with one invoice row per attached PDF, then `/step-status` |
| ZLOAD3-A | no data callback in dashboard's current flow — only `/step-status` |
| VTO1N-B | only `/step-status` |
| `/email/branch-reply` | classifies reply by keyword, returns a canned `{intent, materials, ...}` (or fixture) |

## Failure modes

- Random per-call: `DUMMY_FAIL_RATE=0.2 node scripts/dummy-auto-gui2/server.mjs`
- Always fail one transaction: `DUMMY_FAIL_TRANSACTIONS=ZLOAD3-B1 node ...`

A failure sends `success: false` on the COMPLETION webhook; the dashboard
marks the WorkQueue row `failed` and pumps the next item (no retries).

## Limitations

- Doesn't actually run anything in SAP. Material/batch/qty/weight values
  come from fixtures or defaults — they're not derived from real SAP state.
- LS PDFs are minimal valid PDFs but don't have realistic invoice content.
- Doesn't model rate limits, network errors, or partial multipart uploads.
- `/email/production-reply` and `/email/production-confirmation` aren't
  stubbed (current dashboard flow doesn't hit them after the wait-recheck
  refactor).
