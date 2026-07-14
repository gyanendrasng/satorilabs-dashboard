# Satori Labs Dashboard

## Project Overview
Next.js dashboard for managing sales orders, loading slips, and dispatch email workflows. Deployed on Vercel.

## Tech Stack
- **Framework:** Next.js (App Router)
- **Database:** Prisma ORM
- **Email:** Gmail API
- **Storage:** S3/R2 for reply PDFs
- **Backend service:** auto_gui2 (Python) for SAP automation and LLM-based email processing

## Key Environment Variables
- `PLANT_EMAIL` — recipient for loading slip emails
- `BRANCH_EMAIL` — branch email to watch for new orders
- `PRODUCTION_EMAIL` — production team email for material inquiries/reminders
- `CRON_SECRET` — optional auth token for cron endpoint
- `AUTO_GUI_HOST` / `AUTO_GUI_PORT` — auto_gui2 backend connection

### LLM provider (planner + new-order extractor)
Every LLM call goes through `src/lib/llm-service.ts`. Provider + model are picked from env at boot:
- `LLM_PROVIDER` — one of `openai` | `groq` | `together` | `deepinfra` | `runpod` | `gemini` (default `openai`)
- `LLM_MODEL` — model id (defaults per provider; e.g. `gpt-4o` for openai, `gemini-2.5-flash` for gemini)
- `LLM_TEMPERATURE` — default 0.7 (per-call override available)
- `LLM_MAX_TOKENS` — default 16000 (planner emits long structured JSON; smaller caps truncate the response and break the Zod parse). Per-call override available; the planner itself locks 16000 regardless of env and retries up to 3 times on parse / Zod failure with exponential backoff.
- `LLM_BASE_URL` — optional override for OpenAI-compatible providers (self-hosted vLLM etc.)

API keys (only the one matching the active provider is required):
- `OPENAI_API_KEY`, `GROQ_API_KEY`, `TOGETHER_API_KEY`, `DEEPINFRA_API_KEY`, `RUNPOD_API_KEY`, `GEMINI_API_KEY`

## Email Monitoring Cron

> **Before editing anything in this area — read [docs/email-reply-detection.md](docs/email-reply-detection.md).**
> The reply detection has been broken & re-fixed several times when the matcher, the poll filter, the `ProcessedEmail` dedup, and `handleReplyV2`'s `replyHtml` invariant were changed independently. The doc captures the invariants, failure modes, and anti-patterns. If you change `src/lib/email-reply-checker.ts` or `handleReplyV2` in `src/lib/scenario-engine.ts`, update that doc's change log.

### How It Works
The cron is defined in `vercel.json` and hits `GET /backend/cron/check-emails` every minute.

The route is at `src/app/backend/cron/check-emails/route.ts` and runs 3 checks:

1. **`checkForNewEmails()`** — Scans for unread "NEW ORDER" emails from `BRANCH_EMAIL`, extracts SO number, triggers ZSO-VISIBILITY on auto_gui2, creates PO+SO in DB.
2. **`checkForReplies()`** — Checks all emails with `status: 'sent'` for thread replies. Routes to:
   - Branch reply workflow (classifies intent: release_all/release_part/wait)
   - Production reply (extracts timeline days)
   - Production reminder reply (classifies confirmation: ready/wait_more)
   - Also handles PDF invoice attachments (uploads to R2)
3. **`checkWorkflowTimers()`** — Finds emails with `workflowState: 'waiting_timer'` where `waitUntil` has passed, calls auto_gui2 `/email/reminder` to generate reminder email, sends to production.

### Starting the Cron

**Production (Vercel):**
Automatic — Vercel reads `vercel.json` crons config on deploy. No manual action needed.

**Local development:**
```bash
# Start the Next.js dev server
npm run dev

# Then trigger the cron manually:
curl http://localhost:3000/backend/cron/check-emails

# With auth (if CRON_SECRET is set):
curl -H "Authorization: Bearer YOUR_CRON_SECRET" http://localhost:3000/backend/cron/check-emails
```

To run it on a schedule locally, use a system cron or a watch command:
```bash
# Every minute via watch
watch -n 60 'curl -s http://localhost:3000/backend/cron/check-emails'
```

### Key Files
- `vercel.json` — Cron schedule config (`* * * * *` = every minute)
- `src/app/backend/cron/check-emails/route.ts` — Cron API route handler
- `src/lib/email-reply-checker.ts` — Core logic: `checkForReplies()`, `checkWorkflowTimers()`, `checkForNewEmails()`
- `src/lib/email-service.ts` — Sends loading slip emails, creates Email records in DB
- `src/lib/auto-gui-trigger.ts` — Handlers for branch reply, production reply, production confirmation workflows

## Reset DB (clear all SO data)
```bash
npx prisma db push --schema prisma/schema.prisma && npx prisma generate --schema prisma/schema.prisma && npx prisma db execute --schema prisma/schema.prisma --stdin <<< "DELETE FROM email; DELETE FROM loading_slip_item; DELETE FROM invoice; DELETE FROM sales_order; DELETE FROM purchase_order; DELETE FROM processed_email; DELETE FROM current_so;"
```

## Email Workflow States
- `sent` → waiting for reply
- `replied` → reply received (may have PDF)
- `workflowState: 'waiting_timer'` → waiting for timer to elapse before sending reminder
- `workflowState: 'awaiting_confirmation'` → reminder sent, waiting for production confirmation
- `workflowState: 'completed'` → workflow finished

## Modify-after-bundling (branch asks to change qty after loading slips exist)
The planner (`src/lib/llm-planner.ts`) routes a branch increase based on whether
loading slips already exist (`loading slips exist (bundles frozen): yes` in SO
state) and, when they do but plant_ls is NOT yet sent, on what the BRANCH chooses:

- **No LS yet** (bundles computed, ZLOAD1 not fired) → Rule 6 (normal pre-LS).
- **LS exist, plant_ls NOT sent** → ask the branch "preserve or recreate?" (Rule 6b fork):
  - **recreate** → Path [A] (Rule 6b-A): `zloading_close(all)` wipe → re-bundle →
    redo pipeline. Stock precheck is 3-way (fully/partial/none); partial/none
    inform the branch and wait.
  - **preserve** → Path [B] = Rule 6e surgical flow (same as post-plant_ls), EXCEPT
    overflow creates an **extra vehicle (new bundle)** on the same PO instead of a
    new SO, and the terminal `email_modified_ls_to_plant` sends the FULL LS set
    (first intimation).
- **LS sent to plant** → Rule 6e surgical flow; overflow → new SO.

Key plumbing: `bundle_capacity_assessment` takes `overflowMode: 'new_so'|'new_bundle'`;
the `new_bundle` verdict is `allocated_with_new_bundle`; `createSingleBundleForPo`
(`src/lib/bundler.ts`) adds one bundle without wiping; the Phase-3 overflow leg is a
`zload1` step with `args.createNewBundle=true`. Every "inform the branch" step is a
WAIT point (send + stop, resume on reply).

## auto_gui2 Backend Endpoints Used
- `POST /chat` — Triggers SAP transactions (ZSO-VISIBILITY, ZLOAD3, etc.)
- `POST /email/reminder` — Generates reminder email content via LLM
- `POST /email/classify-branch-reply` — Classifies branch reply intent
- `POST /email/extract-production-timeline` — Extracts days from production reply
- `POST /email/classify-production-confirmation` — Classifies if materials are ready
