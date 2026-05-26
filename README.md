# Satori Labs Dashboard

Next.js dashboard for managing sales orders, loading slips, and dispatch email
workflows. Backed by Prisma (SQLite for dev, Postgres on Vercel) and integrated
with the `auto_gui2` Python service for SAP UI automation.

See [CLAUDE.md](CLAUDE.md) for architecture notes and
[DISPATCH_FLOW_ENGINE.md](DISPATCH_FLOW_ENGINE.md) for the scenario engine.

---

## Running locally

This is a Node.js / Next.js project — **no virtualenv needed**.

### One-time setup

```bash
npm install                                                       # install deps
npx prisma db push --schema prisma/schema.prisma --skip-generate  # sync schema → dev.db
npx prisma generate --schema prisma/schema.prisma                 # regenerate client
```

Use `prisma db push` (not `migrate deploy`) on a dev SQLite DB — the local DB
may have drifted from `prisma/migrations/`, and `db push` is additive (no data
loss).

### Start the dev server

```bash
npm run dev
```

Serves at [http://localhost:3000](http://localhost:3000) with Turbopack
hot-reload. The middleware compiles in ~120ms; full ready in ~1s.

Stop with `Ctrl-C` (foreground) or `kill <pid>` if backgrounded.

### Verify

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/                      # → 200
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/backend/cron/check-emails    # → 200
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/backend/cron/sync-inventory  # → 200
```

### Production build (locally)

```bash
npm run build && npm start
```

---

## Cron endpoints

Vercel cron schedules are defined in [vercel.json](vercel.json). Locally the
schedule does NOT fire — trigger manually via `curl`:

| Endpoint                                | Vercel schedule | Local trigger |
|-----------------------------------------|-----------------|---------------|
| `/backend/cron/check-emails`            | `* * * * *`     | `curl http://localhost:3000/backend/cron/check-emails` |
| `/backend/cron/daily-mb51`              | `30 5 * * *`    | `curl http://localhost:3000/backend/cron/daily-mb51` |
| `/backend/cron/sync-inventory`          | `*/15 * * * *`  | `curl http://localhost:3000/backend/cron/sync-inventory` |

If `CRON_SECRET` is set in `.env`, add `-H "Authorization: Bearer $CRON_SECRET"`.

To run a cron on a loop locally:

```bash
watch -n 60  'curl -s http://localhost:3000/backend/cron/check-emails'
watch -n 900 'curl -s http://localhost:3000/backend/cron/sync-inventory'
```

---

## Environment variables (`.env`)

| Var | Purpose |
|---|---|
| `DATABASE_URL`         | Prisma datasource. Local: `file:./dev.db`. |
| `AUTO_GUI_HOST` / `AUTO_GUI_PORT` | auto_gui2 backend connection (default `localhost:8000`). |
| `BRANCH_EMAIL`         | Branch inbox to watch for new orders. |
| `PLANT_EMAIL`          | Plant recipient for LS emails. |
| `PRODUCTION_EMAIL`     | Production team for material inquiries. |
| `OPENAI_API_KEY`       | LLM classifier (scenario selector + reply intent). |
| `CRON_SECRET`          | Optional auth token for cron endpoints. |
| `SCENARIO_ENGINE_ENABLED` | `'true'` to route branch/plant replies through the new scenario engine. Defaults off (legacy path). |
| `SAP_DEFAULT_PLANT`    | Fallback plant code (e.g. `7581`) when `SalesOrder.plant` is null. Used by the free-stock pre-check that gates VA02 on modification scenarios. |
| `UNIFIED_CLASSIFIER_ENABLED` | `'true'` to route ALL inbound emails (NEW ORDER + every reply type) through one unified LLM call (`classifyReply`). Returns a tagged-union intent; the dispatcher invokes the appropriate handler with pre-classified fields. When unclassifiable, escalates to `SUPERVISOR_EMAIL`. Defaults off (each email type uses its own classifier). |
| `SUPERVISOR_EMAIL`     | Recipient for `supervisor_inquiry` emails when the unified classifier returns `action='other'`. Defaults to `amanrai369@gmail.com`. Caps the escalation chain at 3 hops. |

Gmail OAuth tokens are managed separately — see existing setup notes.

---

## Kicking off a flow end-to-end

The dashboard is driven entirely by email — no UI button starts a flow.

### Mailbox roles

- **Dispatch inbox** — the Gmail account whose refresh token is in
  `GOOGLE_REFRESH_TOKEN`. The dashboard reads & writes all mail via this
  account (Gmail API `userId: 'me'`).
- **Branch account** (`BRANCH_EMAIL`) — a *different* Gmail account you
  control. You send `NEW ORDER` emails and dispatch-approval replies from
  here. The dashboard sends outbound dispatch / 2nd-release / shortage
  emails TO this address.
- **Plant account** (`PLANT_EMAIL`) and **Production account**
  (`PRODUCTION_EMAIL`) — recipients for LS emails and material inquiries
  respectively. For local testing it's fine to point all three of
  `BRANCH_EMAIL` / `PLANT_EMAIL` / `PRODUCTION_EMAIL` at the same human
  inbox — the dashboard correlates replies by Gmail thread ID + `emailType`,
  not by sender address. Just be sure to reply on the *right thread* when
  switching roles.

Outbound mail is always *sent from* the Dispatch inbox (token owner). So in
the recipient's UI, every dashboard-generated email shows up "from <token
owner>" regardless of which role it represents.

### Step 1 — Send the kickoff email

| Field | Value |
|---|---|
| **From** | `BRANCH_EMAIL` |
| **To** | The Dispatch inbox |
| **Subject** | Must contain the literal string `NEW ORDER`. E.g. `NEW ORDER - 3260671` |
| **Body** | Plain text or HTML containing a `customer_id` and 1–4 SO numbers (each ≥ 7 digits) |

Minimum-viable body (the LLM extractor + regex fallback both handle richer
phrasings too):

```
customer_id: CUST-1001

Please process the following sales orders:
  - 3260671
  - 3260672
```

Constraints from [src/lib/so-extractor.ts](src/lib/so-extractor.ts):

- SO numbers are 7+ digit numeric strings
- 1 to 4 SO numbers per email
- Unknown `customer_id` values are auto-created

### Step 2 — Tick the cron

Trigger the cron once (or wait for the Vercel schedule in production):

```bash
curl http://localhost:3000/backend/cron/check-emails
```

`checkForNewEmails()` will:
1. Search Gmail for `from:<BRANCH_EMAIL> subject:"NEW ORDER" newer_than:1d is:unread`
2. Extract `customer_id` and SO numbers via OpenAI (regex fallback)
3. Create `PurchaseOrder` + `SalesOrder` rows
4. Enqueue `ZSO-VISIBILITY` on auto_gui2 via `/chat`
5. Mark the email as processed

### Step 3 — auto_gui2 takes over

auto_gui2 runs ZSO-VISIBILITY in SAP, then POSTs back to
`/backend/orders/aman/visibility-data` with the materials list. The dashboard
then sends the dispatch-approval email back to `BRANCH_EMAIL`.

If auto_gui2 isn't running locally, SOs sit in `visibilityState: 'queued'`.
Either start auto_gui2, or use `scripts/dummy-auto-gui2.mjs` as a stub
(confirm its contract first).

### Step 4 — Reply as the branch

When the branch account replies to the dispatch-approval email, the next
`/backend/cron/check-emails` tick picks it up. The reply goes through:

- `classifyBranchReply` (legacy 3-intent path), **or**
- `selectScenarioForReply` (Phase E LLM scenario selector) when
  `SCENARIO_ENGINE_ENABLED=true`.

Reply phrasings that map to scenarios (paraphrase freely — the LLM handles it):

| Scenario | Reply phrasing |
|---|---|
| Release all (row 9) | "Please release everything as available." |
| Release part (row 10) | "Release M-A and M-B; skip M-C." |
| Wait (row 15) | "Hold on — please wait for materials." |
| Modify - Increase (rows 11 / 32) | "Please increase M-A to 150." |
| Modify - Inc+Dec (rows 12 / 33) | "Increase M-A to 150 and decrease M-B to 60." |
| Modify - Delete (rows 14 / 36) | "Please delete M-C from the order." |
| Modify - Decrease (row 35) | "Reduce M-A to 60 units." |

For an **increase scenario** to hit the new free-stock pre-check (rather than
abort with `plant_unknown`), make sure:

1. `SAP_DEFAULT_PLANT` is set in `.env`, AND
2. Either seed `inventory_snapshot` rows manually, or have auto_gui2's
   `/inventory/latest` endpoint serving data so the 15-min sync cron
   populates the table.

### Smoke check

```bash
# After sending the NEW ORDER email and ticking the cron:
sqlite3 prisma/dev.db "SELECT soNumber, status, visibilityState, intentLabel \
  FROM sales_order ORDER BY createdAt DESC LIMIT 5;"

# Scenario engine state (only populated when SCENARIO_ENGINE_ENABLED=true):
sqlite3 prisma/dev.db "SELECT scenarioKey, state, currentStepIndex, error \
  FROM scenario_progress ORDER BY createdAt DESC LIMIT 5;"

# Per-SO event timeline (Phase E audit log):
sqlite3 prisma/dev.db "SELECT type, payload FROM scenario_event \
  ORDER BY createdAt DESC LIMIT 20;"
```

---

## Reset the local DB

Drops all SO/PO/LS/email/inventory data and re-syncs schema:

```bash
npx prisma db push --schema prisma/schema.prisma && \
npx prisma generate --schema prisma/schema.prisma && \
npx prisma db execute --schema prisma/schema.prisma --stdin <<< "
  DELETE FROM email;
  DELETE FROM loading_slip_item;
  DELETE FROM invoice;
  DELETE FROM sales_order;
  DELETE FROM purchase_order;
  DELETE FROM processed_email;
  DELETE FROM current_so;
  DELETE FROM inventory_snapshot;
  DELETE FROM inventory_sync_state;
"
```

---

## Scripts

| Command          | Purpose |
|------------------|---------|
| `npm run dev`    | Start dev server (Turbopack). |
| `npm run build`  | Production build. |
| `npm start`      | Serve the production build. |
| `npm run lint`   | Lint. |

End-to-end harness for the scenario engine:

```bash
rm -f prisma/test-scenarios.db
DATABASE_URL="file:./test-scenarios.db" \
  npx prisma db push --schema prisma/schema.prisma --skip-generate

DATABASE_URL="file:./test-scenarios.db" \
  SCENARIO_ENGINE_ENABLED=true \
  SAP_DEFAULT_PLANT=7581 \
  BRANCH_EMAIL=test-branch@example.com \
  PLANT_EMAIL=test-plant@example.com \
  OPENAI_API_KEY="sk-..." \
  npx tsx scripts/test-scenarios-e2e.ts
```

Expected: **35/35 PASS**. Latest run report:
[SCENARIO_TEST_RESULTS_PHASE_E.md](SCENARIO_TEST_RESULTS_PHASE_E.md).
