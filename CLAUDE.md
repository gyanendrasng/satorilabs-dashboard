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

## Email Monitoring Cron

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

## auto_gui2 Backend Endpoints Used
- `POST /chat` — Triggers SAP transactions (ZSO-VISIBILITY, ZLOAD3, etc.)
- `POST /email/reminder` — Generates reminder email content via LLM
- `POST /email/classify-branch-reply` — Classifies branch reply intent
- `POST /email/extract-production-timeline` — Extracts days from production reply
- `POST /email/classify-production-confirmation` — Classifies if materials are ready
