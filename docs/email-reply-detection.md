# Email Reply Detection — Design & Invariants

How the dashboard cron detects new inbound replies on Gmail threads and routes
them to the LLM planner. This is the result of several iterations against real
prod incidents; the comments at the top of
[`src/lib/email-reply-checker.ts`](../src/lib/email-reply-checker.ts) refer
back to this document.

Read this **before** touching the cron's reply detection, the
`Email.status` transitions, the `ProcessedEmail` dedup table, or
`handleReplyV2` in the scenario engine. Multiple subtle bugs have shipped
when one of these pieces was changed without considering the others.

---

## 1. The cast of characters

| Component | File | Role |
|---|---|---|
| `checkForReplies()` | [src/lib/email-reply-checker.ts](../src/lib/email-reply-checker.ts) | Runs every minute via cron. Iterates pending `Email` rows, finds new inbound replies on Gmail, calls the planner. |
| `Email` table | [prisma/schema.prisma](../prisma/schema.prisma) — model `Email` | One row per outbound we sent. Carries `gmailMessageId`, `gmailThreadId`, `status`, `workflowState`, `replyHtml`. |
| `ProcessedEmail` table | [prisma/schema.prisma](../prisma/schema.prisma) — model `ProcessedEmail` | Keyed by `gmailMessageId`. Dedup table for inbound replies we've already handled. |
| `handleReplyV2()` | [src/lib/scenario-engine.ts](../src/lib/scenario-engine.ts) | Receives a new reply, aborts any active scenario, builds a fresh plan via the LLM. |
| `planNextSteps()` | [src/lib/llm-planner.ts](../src/lib/llm-planner.ts) | Builds the user prompt (audit trail + email thread + SO snapshot) and calls the LLM. |

---

## 2. The pipeline at one glance

```
┌────────────────────────────────────────────────────────────────────────┐
│ cron tick                                                              │
└────────────────────────────────────────────────────────────────────────┘
        │
        ▼
┌────────────────────────────────────────────────────────────────────────┐
│ pendingEmails = Email WHERE                                            │
│   (status='sent'    AND workflowState IS NULL OR != 'completed')       │
│   OR status='replied'                                                  │
└────────────────────────────────────────────────────────────────────────┘
        │
        ▼ for each pending email row
┌────────────────────────────────────────────────────────────────────────┐
│ getThreadMessages(email.gmailThreadId)                                 │
│   → all messages on this Gmail thread (full headers + labels)          │
└────────────────────────────────────────────────────────────────────────┘
        │
        ▼
┌────────────────────────────────────────────────────────────────────────┐
│ ourRfc822Id = RFC822 Message-ID of email.gmailMessageId                │
│   (the outbound this row represents)                                   │
└────────────────────────────────────────────────────────────────────────┘
        │
        ▼
┌────────────────────────────────────────────────────────────────────────┐
│ For each INBOX/¬SENT message on the thread:                            │
│   walk the In-Reply-To chain upwards until we hit a SENT (outbound)    │
│   message — that's the "nearest outbound ancestor."                    │
│   Keep the inbound iff that ancestor's Message-ID == ourRfc822Id.      │
└────────────────────────────────────────────────────────────────────────┘
        │
        ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Drop replies already in ProcessedEmail (per-Gmail-id dedup).           │
│ latestReply = the most recent unprocessed one.                         │
└────────────────────────────────────────────────────────────────────────┘
        │
        ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Update Email row: replyHtml = new body, repliedAt = now,               │
│ status = 'replied', replyPdfUrl = R2 key if an invoice PDF.            │
└────────────────────────────────────────────────────────────────────────┘
        │
        ▼
┌────────────────────────────────────────────────────────────────────────┐
│ handleReplyV2() → planNextSteps() → engine fires the new plan.         │
└────────────────────────────────────────────────────────────────────────┘
        │
        ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Upsert latestReply.id (and any older unprocessed siblings under the    │
│ same outbound ancestor) into ProcessedEmail. Done.                     │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 3. The poll filter (which Email rows are checked?)

```ts
// src/lib/email-reply-checker.ts
where: {
  OR: [
    {
      status: 'sent',
      OR: [
        { workflowState: null },
        { workflowState: { not: 'completed' } },
      ],
    },
    { status: 'replied' },
  ],
}
```

### Why each clause exists

1. **`status='sent'` AND `workflowState != 'completed'`** — original case. The
   first inbound reply to an outbound. The `workflowState='completed'` exclusion
   prevents reprocessing rows where the engine already fired downstream work
   (e.g. ZLOAD1 was triggered fire-and-forget; the row is in a terminal state
   even though no actual reply came in).

2. **`status='replied'`** — new since 2026-06-13. Keeps the email visible to
   the cron AFTER a first reply, so **follow-up replies on the same thread**
   are detected. Branch can ask for a modification on the dispatch_confirmation
   thread after they've already confirmed it; we used to lose that reply
   because the email had transitioned to `status='replied'` and dropped out of
   the poll forever.

### What's NOT polled

- `status='processed'` — terminal for plant_ls invoice flows (ZLOAD3 ran).
- `status='consumed'` — superseded by a later send.
- `status='queued'` — never went out (held by some upstream gate).

These are intentional. Once a plant_ls is `processed`, the SO is in shipment
phase and a branch reply on the original thread is no longer meaningful.

---

## 4. Matching an inbound reply to the right outbound

The hardest part. The matcher must answer: **of all the inbound messages on
this Gmail thread, which ones are responses to THIS specific outbound (this
Email row)?**

### Why "same Gmail thread" is not enough

A single Gmail thread can carry many of our outbounds:

- The plant_ls fan-out sends N emails (one per loading slip) into one Gmail
  thread (the per-(PO, plant) anchor — see "Thread anchoring & subjects" below).
  The plant replies separately to each → one Gmail thread, N inbound replies,
  each addressed to a different LS.
- The per-PO branch thread anchors every branch-facing email
  (ls_dispatch, dispatch_confirmation, vehicle_details, 2nd_release, …) on
  one thread.

If the matcher just said "any inbound on this thread is a reply to me," then
every Email row sharing the thread would claim every inbound. We had this
bug in 2026-06-13 — LS 373431's iteration picked up LS 373437's reply because
they shared a thread.

### Why "single-hop In-Reply-To" is not enough

`In-Reply-To` names the immediate parent of a reply — usually the outbound
the sender clicked "Reply" on. Single-hop matching `inReplyTo == ourRfc822Id`
correctly disambiguates plant_ls fan-out.

BUT branch replies can be multi-hop. After the branch sends one reply, they
sometimes click "Reply" on **their own previous reply** (an inbound, not our
outbound) when they send a second message. The new reply's `In-Reply-To`
points at the first reply, NOT at our outbound. Single-hop matching loses
that second reply.

Concrete incident (2026-06-15):

```
1. We send vehicle_details (outbound).
2. Branch replies with vehicle info (inbound 1).
   In-Reply-To: <vehicle_details-msg-id>
3. We send plant_ls (outbound on the per-plant thread).
4. Before plant replies, branch replies again on the SAME thread,
   but clicks Reply on inbound 1, not on vehicle_details.
   (inbound 2). In-Reply-To: <inbound-1-msg-id>
```

With single-hop matching, vehicle_details's iteration looks for inbounds
with `In-Reply-To == <vehicle_details-msg-id>` and finds inbound 1 only.
Inbound 2 is invisible. ❌

### The fix: walk the In-Reply-To chain

The matcher resolves each inbound's "nearest outbound ancestor" by walking
`In-Reply-To` upwards through prior inbounds until it hits a SENT (outbound)
message.

```ts
// Simplified — see src/lib/email-reply-checker.ts for the full version.
const nearestOutboundAncestorRfc822 = (msg) => {
  const seen = new Set();
  let cur = msg;
  let depth = 32; // safety cap
  while (cur && depth-- > 0) {
    const inReplyTo = readHeader(cur, 'In-Reply-To').trim();
    if (!inReplyTo) return null;
    if (seen.has(inReplyTo)) return null; // cycle guard
    seen.add(inReplyTo);
    const parent = byRfc822Id.get(inReplyTo);
    if (!parent) return null; // chain dead-ends outside this thread
    if (isOutbound(parent)) {
      return readHeader(parent, 'Message-ID');
    }
    cur = parent; // continue walking
  }
  return null;
};
```

`byRfc822Id` is built once per thread by indexing every thread message's
`Message-ID` header (stored with both wrapped `<id>` and unwrapped `id`
variants for robustness against angle-bracket inconsistencies).

### What this correctly handles

| Scenario | Inbound chain | Nearest outbound ancestor | Matched email row |
|---|---|---|---|
| Branch replies once to vehicle_details | reply → vehicle_details | vehicle_details | vehicle_details ✓ |
| Branch replies twice (2nd is reply to 1st) | reply 2 → reply 1 → vehicle_details | vehicle_details | vehicle_details ✓ (the new fix) |
| Branch replies on dispatch_confirmation thread (older email) | reply → dispatch_confirmation | dispatch_confirmation | dispatch_confirmation ✓ |
| Plant replies directly to LS 373431's PDF | reply → LS 373431 outbound | LS 373431 | LS 373431 only ✓ |
| Plant clicks Reply on LS 373437 and sends 7 messages | reply → LS 373437 | LS 373437 | LS 373437 only (Gmail-level limitation — the plant addressed the messages to that thread root, not to each LS) |

### What this REFUSES to match

- The `References` header (which contains the full thread chain). Every
  reply in the thread references every prior Message-ID, so matching against
  it would re-create the cross-pollination bug. **Only `In-Reply-To` is
  authoritative for parent.**
- Position-in-thread heuristics ("the latest inbound is my reply"). When the
  thread contains multiple outbounds, "latest inbound" is ambiguous and
  routes replies to the wrong pending row.

---

## 4b. Thread anchoring & subjects (one conversation per stakeholder)

Every outbound is anchored so each stakeholder sees **one** conversation, and —
critically — every email on a thread shares **one subject**. Gmail only keeps
messages in a conversation when the `threadId`, the `References` chain, **and the
subject** all line up; a differing subject forks a new conversation on the
recipient's side even when we pass the right `threadId`. Anchoring lives in
[`src/lib/po-thread.ts`](../src/lib/po-thread.ts).

| Stakeholder | Thread key | Shared subject | Where stored |
|---|---|---|---|
| Branch | per **PO** (the NEW ORDER thread) | `Re: <NEW ORDER subject>` | `PurchaseOrder.branchThreadId` / `branchAnchorMsgId` / `branchSubject` |
| Plant | per **(PO, plant email)** | `Loading Slips - PO <poNumber>` | `PoRecipientThread` (`@@unique([purchaseOrderId, recipientEmail])`) |
| Production | per **PO** | `Material readiness - PO <poNumber>` | `PoRecipientThread`, `kind='production'` |

- **Branch** subject is the branch's own NEW ORDER subject, captured at intake
  (`branchSubject`) and reused as `Re: <subject>` by `resolvePoThreadAnchor(po,'branch')`.
  The per-step purpose (vehicle details, dispatch confirmation, …) moves to the
  body's first line via `withPurposeLine` / `withPurposeLineHtml`.
- **Plant** is per (PO, plant) so a PO that dispatches from several plants gets
  one thread per plant (one email per loading slip is unchanged). The LS number
  lives in the body + attachment filename, not the subject.
- **Subject changes do NOT affect reply detection.** The matcher (§4) keys only on
  `threadId` + the `In-Reply-To` chain. Unifying subjects only changes how the
  *recipient's* client groups messages; our routing is unchanged.

---

## 5. Per-Gmail-message dedup (`ProcessedEmail`)

```ts
// after handleReplyV2 returns, mark every matched reply as processed
for (const msg of unprocessed) {
  await prisma.processedEmail.upsert({
    where: { gmailMessageId: msg.id },
    create: {
      gmailMessageId: msg.id,
      gmailThreadId: email.gmailThreadId,
      soNumbers: soNumber,
    },
    update: {}, // no-op
  });
}
```

### Why this exists

Once we extended the poll to `status='replied'`, every cron tick re-sees the
same inbound message on the same thread. Without dedup, the planner would
fire over and over on the same reply.

`ProcessedEmail.gmailMessageId` is `@id` (unique) — `upsert` is race-safe
across concurrent cron ticks.

### Critical scope rule

Only mark replies that the **header-scoped matcher (§4) accepted** as
processed. Earlier versions marked every reply on the thread as processed
after handling one — that caused sibling outbounds on the same thread to
think all their replies were already handled when they hadn't been. The
matcher must run first; only its output is fed into the dedup write.

### Recovering from a poisoned `ProcessedEmail`

If the dedup table was wrongly populated (e.g. a prior buggy build marked
sibling-thread replies as processed when they weren't actually handled), the
fix is to delete the orphan rows:

```bash
sqlite3 prisma/dev.db "
  DELETE FROM processed_email
  WHERE gmailThreadId = '<thread-id>'
    AND gmailMessageId NOT IN (SELECT gmailMessageId FROM email WHERE status = 'replied');
"
```

This keeps the dedup row for the one reply that was correctly processed
(its Email row has `status='replied'`) and removes the orphans.

---

## 6. `handleReplyV2` invariants

When the cron decides a new reply belongs to an Email row, it calls
`handleReplyV2({ emailId, replyHtml, originalEmailHtml, sourceEmailType })`.

The handler **always overwrites** `replyHtml` on the Email row:

```ts
await prisma.email.update({
  where: { id: email.id },
  data: {
    replyHtml: args.replyHtml,   // overwrite — NOT `email.replyHtml ?? args.replyHtml`
    repliedAt: new Date(),
    status: 'replied',
    workflowState: 'completed',
  },
});
```

### Why overwrite

Because the poll now sees `status='replied'` rows. On a follow-up reply, the
Email row already has a `replyHtml` from the first reply. If we preserved
the old body, the planner's user prompt would render the OLD reply as the
latest inbound — even though the cron just found a fresh one. The dedup is
at the Gmail-message-id level (`ProcessedEmail`); the Email row's
`replyHtml` is the working buffer for "what reply does the planner see right
now."

---

## 7. `Email.status` lifecycle

```
queued ── (rare; held by upstream gate)
  │
  ▼
sent ── outbound delivered, no reply yet
  │
  ▼ first inbound reply lands & is processed
replied ── repliedAt set, replyHtml carries latest reply, workflowState='completed'
  │     │
  │     └─ follow-up inbound on same thread → cron polls again, replyHtml
  │        gets overwritten, planner fires fresh plan, repliedAt bumps,
  │        status stays 'replied'.
  │
  ▼ (plant_ls only) ZLOAD3 ran on the LS's bundle
processed ── terminal. NOT polled. Plant invoice has been ingested.
```

`consumed` is the orthogonal "superseded by a later send" state and is also
not polled.

---

## 8. End-to-end traces (worked examples)

### Trace A — plant_ls fan-out, plant replies directly to each LS

State at start: 7 plant_ls Email rows on one thread, each `status='sent'`.

Plant clicks Reply on each LS PDF individually and sends 7 replies.

Cron tick:
1. Pending list: 7 plant_ls rows (all `status='sent'`).
2. Iterate LS 373431's row.
   - Thread has 8 messages (1 dispatch + 7 replies).
   - `ourRfc822Id` = LS 373431's Message-ID.
   - Chain-walk each inbound: 7 of them have one-hop chains landing on
     7 different outbounds.
   - The reply whose chain hits LS 373431 → in `replyMessages`. Just 1.
   - `ProcessedEmail` empty → `unprocessed = [that 1 reply]`.
   - Upload its PDF, call `handleReplyV2`, planner fires
     `process_plant_invoice` (or similar; BatchSender gate then waits for
     siblings).
   - Mark that reply's id in `ProcessedEmail`.
3. Iterate LS 373432's row → matches a different reply → process it.
4. ... etc for LS 373433..373437.

Result: each LS Email row → its own reply processed → BatchSender sees
`7/7 LS(s) have replies` → fires ZLOAD3-B1 per bundle.

### Trace B — branch replies twice on dispatch_confirmation

State at start: dispatch_confirmation Email row has `status='replied'`
(branch already confirmed bundles). Cron poll: included in pending list.

Branch sends a new reply on the same dispatch_confirmation thread, asking
to change a material.

Cron tick:
1. Iterate dispatch_confirmation row.
   - Thread has dispatch_confirmation + reply 1 (confirm) + (possibly)
     downstream outbounds + reply 2 (the new modify request).
   - `ourRfc822Id` = dispatch_confirmation's Message-ID.
   - Chain-walk for reply 2:
     - If reply 2's `In-Reply-To` is dispatch_confirmation → 1 hop, matches.
     - If reply 2's `In-Reply-To` is reply 1 → walk to dispatch_confirmation
       (2 hops), matches.
     - Either way → in `replyMessages`.
   - Reply 1 also in `replyMessages` (chain hits dispatch_confirmation), but
     it's in `ProcessedEmail` from the first run → filtered out.
   - `unprocessed = [reply 2]`.
2. Overwrite `replyHtml` on dispatch_confirmation Email with reply 2's body.
3. `handleReplyV2` → planner sees the new body as the latest inbound, sees
   plant_ls in the audit trail, applies Rule 6e (post-plant_ls modify).
4. Mark reply 2's id in `ProcessedEmail`.

### Trace C — first-time reply (the original case)

State at start: vehicle_details `status='sent'`. No replies yet.

Branch sends vehicle info.

Cron tick:
1. Iterate vehicle_details row.
   - Thread has vehicle_details + 1 inbound.
   - Chain-walk: inbound → vehicle_details (1 hop) → matches.
   - `unprocessed = [the one inbound]`.
2. Set `replyHtml`, transition to `status='replied'`, call `handleReplyV2`.
3. Mark its id in `ProcessedEmail`.

Identical to pre-fix behavior. No regression.

---

## 9. Failure modes & limits

### Plant clicks "Reply" on one outbound and sends N messages

All N replies share the same `In-Reply-To` (the one they clicked Reply on).
The chain-walk routes all N to the same Email row. The other N-1 outbound
Email rows on the thread look like they have no reply.

**Not fixable at the dashboard level** — it's an upstream choice by the
sender. The remedy is to ask the plant / branch to click Reply on each
individual email.

### Thread depth > 32

The chain walk caps at 32 hops. Threads this deep shouldn't exist in this
business flow. If you hit this, the cap is a safety latch against
pathological data and the matcher will treat the reply as unmatched.

### Cyclic `In-Reply-To`

Defended via a `Set<string>` of visited Message-IDs in the chain walk.
Returns `null` if a cycle is detected. The reply goes unmatched.

### Missing `Message-ID` header on an outbound

`byRfc822Id` won't index it; the chain walk dead-ends at that outbound and
returns `null`. Replies under that outbound become unmatchable. **Should
never happen** for emails we send via the Gmail API — Gmail injects a
`Message-ID` automatically — but worth knowing as a possible failure mode if
a future code path ever writes an Email row from a non-Gmail source.

### `In-Reply-To` parent not in this thread

The chain walks until it can't find the parent in the thread's message
index. Returns `null`. Reply is unmatched. This is correct behavior — the
reply genuinely doesn't belong here.

### `status='processed'` Email rows

Excluded from the poll. If the branch tries to reply on a plant_ls thread
after the invoice has been ingested (ZLOAD3 ran), that reply will not be
detected. This is intentional — the SO is in shipment phase by then.

---

## 10. Anti-patterns to avoid

1. **Do NOT match against `References`.** It contains the entire thread
   chain and produces false positives across every prior outbound in the
   thread. Use only `In-Reply-To` as the per-hop link.

2. **Do NOT mark "all replies on a thread" as processed.** Only mark the
   replies that the header-scoped matcher claimed for THIS email row.
   Sibling outbounds on the same thread are responsible for marking their
   own.

3. **Do NOT preserve the prior `replyHtml`** on follow-up replies in
   `handleReplyV2`. Always overwrite. The dedup is at the `ProcessedEmail`
   level; the Email row carries the current reply, not a history.

4. **Do NOT filter the poll on `workflowState` for `status='replied'` rows.**
   `workflowState='completed'` was correct for first-replies (terminal); on
   replied rows it would block follow-ups. Only apply the workflowState gate
   to `status='sent'` rows.

5. **Do NOT use temporal heuristics** like "the latest inbound on the
   thread is my reply." With multiple outbounds on one thread that's not
   well-defined and routes replies to the wrong Email row.

6. **Do NOT drop the dispatch-message slice optimization** (`messages.slice(dispatchIdx + 1)`)
   without considering replies that arrive BEFORE the dispatch in thread
   order. The chain walk doesn't need it for correctness, but earlier
   versions assumed it. We removed it after switching to the chain walk;
   if you re-add it, make sure you handle the case where the dispatch
   isn't at the top of the thread (e.g. branch threads where the original
   NEW ORDER predates everything else).

---

## 11. Operational runbook

### Symptom: a reply is on Gmail but the cron isn't seeing it

Check, in order:

1. **Does the Email row exist?** `SELECT id, status, workflowState, emailType, gmailThreadId FROM email WHERE gmailMessageId = '<msg-id>'`.
2. **Is it in the poll filter?**
   - If `status='processed'` or `status='consumed'` → that's why; will not be polled.
   - If `status='sent'` AND `workflowState='completed'` → that's why.
3. **Is the reply's `In-Reply-To` reachable to this outbound via the chain?**
   Pull the Gmail thread and trace `In-Reply-To` headers manually.
4. **Is the reply's Gmail message id already in `ProcessedEmail`?**
   `SELECT * FROM processed_email WHERE gmailMessageId = '<reply-id>'`. If
   yes, it was processed already; check if the Email row's `replyHtml`
   actually reflects the latest body.

### Symptom: the planner is firing the same plan repeatedly on the same reply

Inspect `ProcessedEmail` — the dedup is failing. Either the reply id isn't
being upserted on success, or the cron is invoking `handleReplyV2` before
the upsert. Should not happen with the current sequence; check for a
regression that moved the upsert.

### Symptom: a reply got matched to the wrong Email row

Walk the reply's `In-Reply-To` chain manually against the thread. The
chain's first SENT ancestor is what the matcher routes to. If that's not
the expected Email row, the sender clicked Reply on a different outbound
than you expected — Gmail-level routing, not a dashboard bug.

### Cleanup: clear stale `ProcessedEmail` for a thread

When a prior buggy build poisoned the dedup table:

```bash
sqlite3 prisma/dev.db "
  DELETE FROM processed_email
  WHERE gmailThreadId = '<thread-id>'
    AND gmailMessageId NOT IN (SELECT gmailMessageId FROM email WHERE status = 'replied');
"
```

---

## 12. Change log

- **2026-06-13** — Extended poll to `status='replied'`. Added per-message
  `ProcessedEmail` dedup. `handleReplyV2` now always overwrites `replyHtml`.
- **2026-06-14 morning** — Added `In-Reply-To` header match alongside Gmail
  thread match (was: thread-id only). Discovered `References` is too loose;
  removed it from the matcher.
- **2026-06-14 afternoon** — Engine-side loop guard on
  `bundle_capacity_assessment` (not directly part of the cron, but related —
  it caps how many times the planner can re-fire the same Rule 6e step if
  the audit trail render forgets the verdicts).
- **2026-06-15** — Replaced single-hop `In-Reply-To == ourRfc822Id` with
  multi-hop chain walk (`nearestOutboundAncestorRfc822`) so follow-up
  replies that target prior inbounds still resolve to the right outbound.
  Documented in this file.
- **2026-06-26** — One conversation per stakeholder (§4b). Branch emails now
  reuse `Re: <NEW ORDER subject>` (captured as `PurchaseOrder.branchSubject`);
  per-step purpose moved to the body. Plant threads are now per **(PO, plant)**
  and production reminders are anchored per **PO**, both via the new
  `PoRecipientThread` table. The matcher is unchanged — it never read the
  subject. (Touched: `po-thread.ts`, `email-service.ts`, `stock-shortage-email.ts`,
  `email-reply-checker.ts`, `scenario-engine.ts`, `auto-gui-trigger.ts`,
  `branch-*-email.ts`, `ask-vehicle-details/route.ts`.)
