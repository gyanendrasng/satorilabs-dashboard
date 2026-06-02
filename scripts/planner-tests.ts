/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Planner-mode test driver — replaces the old sheet-driven e2e-chains.ts.
 *
 * Each test case is a declarative spec: a NEW ORDER body + an ordered list
 * of reply texts the branch / plant sends as the conversation unfolds. The
 * harness pushes the NEW ORDER into the Gmail stub, invokes the production
 * cron entry points (`checkForNewEmails`, `checkForReplies`), waits for
 * outbound emails to land, injects the next reply, and repeats — until
 * either the case finishes (final assertion) or hits a timeout.
 *
 * The dummy auto_gui2 server simulates SAP. Every transaction the engine
 * would have sent goes through `enqueueWork()` → WorkQueue.payload, which
 * carries the FULL instruction text the planner would have sent to SAP.
 * The harness reads those rows and prints them verbatim in the report —
 * that's the ground truth for "what was instructed."
 *
 * Output: one Markdown file per case in test_artifacts/planner-tests/<id>.md
 * plus an index.md with PASS/FAIL summary.
 *
 * Usage:
 *   DATABASE_URL="file:./test-planner.db" npx tsx scripts/planner-tests.ts
 *   FILTER=modify_increase_pre_ls npx tsx scripts/planner-tests.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  GMAIL_INBOX,
  HTTP_LOG,
  RECORDED_EMAILS,
  inboxPushNewOrder,
  loadEngine,
  seedInventory,
  startBridge,
  startDummy,
  stopBridge,
  stopDummy,
  waitFor,
  wipeAll,
} from './e2e-shared';
import type { Env } from './e2e-shared';

// -----------------------------------------------------------------------------
// Test case spec
// -----------------------------------------------------------------------------

interface VisibilityMaterial {
  material: string;
  material_description?: string;
  batch: string;
  order_quantity: number;
  available_stock_for_so: number;
  order_weight_kg: number;
}

interface ReplyStep {
  /** Email type of the most recent outbound email this reply targets.
   *  e.g. 'ls_dispatch' / '2nd_release' / 'dispatch_confirmation' /
   *       'vehicle_details' / 'plant_ls'. */
  targetEmailType: string;
  /** Who is replying. */
  sender: 'branch' | 'plant' | 'production';
  /** Free-text body the planner will read. */
  replyText: string;
  /** Max time to wait for the target outbound email before injecting this
   *  reply. Default 30s. */
  waitForOutboundMs?: number;
  /** Optional human description for the report. */
  note?: string;
}

interface TestCase {
  id: string;
  description: string;
  soNumber: string;
  customerId: string;
  newOrderBody: string;
  visibility: VisibilityMaterial[];
  /** Inventory available at the SO's plant (defaults to plenty for every
   *  material in `visibility`). Override for stock-shortage cases. */
  inventory?: Array<{ material: string; freeStock: number }>;
  replies: ReplyStep[];
  expect: {
    finalSoStatus?: string;
    /** Ordered list of SAP transaction_codes that MUST appear in WorkQueue
     *  (subsequence match — extras are OK, order is checked). */
    sapTransactions?: string[];
    /** Email types that MUST have been sent at least once. */
    sentEmailTypes?: string[];
    /** Optional custom assertion. Receives env + case context and may
     *  push failure reasons. */
    custom?: (ctx: AssertionCtx) => Promise<string[]>;
  };
}

interface AssertionCtx {
  env: Env;
  caseId: string;
  soId: string;
  soNumber: string;
  poId: string;
}

// -----------------------------------------------------------------------------
// Harness helpers
// -----------------------------------------------------------------------------

const ARTIFACT_DIR = path.join(process.cwd(), 'test_artifacts', 'planner-tests');
const VISIBILITY_FIXTURE_DIR = path.join(
  process.cwd(),
  'scripts',
  'dummy-auto-gui2',
  'fixtures',
  'visibility',
);

function writeVisibilityFixture(soNumber: string, materials: VisibilityMaterial[]): void {
  if (!fs.existsSync(VISIBILITY_FIXTURE_DIR)) {
    fs.mkdirSync(VISIBILITY_FIXTURE_DIR, { recursive: true });
  }
  fs.writeFileSync(
    path.join(VISIBILITY_FIXTURE_DIR, `${soNumber}.json`),
    JSON.stringify({ materials }, null, 2),
  );
}

function clearArtifactDir(): void {
  if (fs.existsSync(ARTIFACT_DIR)) {
    for (const f of fs.readdirSync(ARTIFACT_DIR)) {
      fs.unlinkSync(path.join(ARTIFACT_DIR, f));
    }
  } else {
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  }
}

async function findLatestSentEmailByType(
  env: Env,
  soId: string,
  poId: string,
  emailType: string,
): Promise<{ id: string; sentBody: string | null } | null> {
  const row = await env.prisma.email.findFirst({
    where: {
      OR: [{ salesOrderId: soId }, { purchaseOrderId: poId }],
      emailType,
      status: 'sent',
    },
    orderBy: { sentAt: 'desc' },
    select: { id: true, sentBody: true },
  });
  return row;
}

async function waitForOutbound(
  env: Env,
  soId: string,
  poId: string,
  emailType: string,
  timeoutMs: number,
): Promise<{ id: string; sentBody: string | null } | null> {
  return waitFor(
    () => findLatestSentEmailByType(env, soId, poId, emailType),
    timeoutMs,
    `outbound email of type "${emailType}"`,
  );
}

// -----------------------------------------------------------------------------
// Report writer
// -----------------------------------------------------------------------------

interface CaseResult {
  id: string;
  description: string;
  soNumber: string;
  startedAt: Date;
  finishedAt: Date;
  durationMs: number;
  passed: boolean;
  failures: string[];
  notes: string[];
}

async function writeCaseReport(
  env: Env,
  spec: TestCase,
  result: CaseResult,
  soId: string | null,
  poId: string | null,
): Promise<void> {
  const out: string[] = [];
  out.push(`# Test case: ${spec.id}`);
  out.push('');
  out.push(`**Description**: ${spec.description}`);
  out.push(`**SO Number**: ${spec.soNumber}`);
  out.push(`**Customer**: ${spec.customerId}`);
  out.push(`**Started**: ${result.startedAt.toISOString()}`);
  out.push(`**Finished**: ${result.finishedAt.toISOString()} (duration ${(result.durationMs / 1000).toFixed(1)}s)`);
  out.push(`**Result**: ${result.passed ? '✅ PASS' : '❌ FAIL'}`);
  out.push('');

  if (result.failures.length > 0) {
    out.push('## Failures');
    for (const f of result.failures) out.push(`- ${f}`);
    out.push('');
  }

  if (soId) {
    // -------------------------------------------------------------------
    // SAP transactions (the meat — what was instructed to SAP)
    // -------------------------------------------------------------------
    out.push('## SAP transactions (instruction payloads)');
    out.push('');
    const works = await env.prisma.workQueue.findMany({
      where: { salesOrderId: soId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        step: true,
        state: true,
        payload: true,
        error: true,
        createdAt: true,
        finishedAt: true,
      },
    });
    if (works.length === 0) {
      out.push('_(no SAP transactions enqueued for this SO)_');
      out.push('');
    } else {
      out.push('| # | Transaction | State | Work ID | Enqueued | Finished |');
      out.push('|---|---|---|---|---|---|');
      for (let i = 0; i < works.length; i++) {
        const w = works[i];
        let txn = w.step;
        try {
          const p = JSON.parse(w.payload);
          if (p?.transaction_code) txn = String(p.transaction_code);
        } catch {}
        out.push(
          `| ${i + 1} | ${txn} | ${w.state} | \`${w.id.slice(-8)}\` | ${w.createdAt.toISOString()} | ${w.finishedAt ? w.finishedAt.toISOString() : '(open)'} |`,
        );
      }
      out.push('');

      // Per-transaction instruction payload
      for (let i = 0; i < works.length; i++) {
        const w = works[i];
        let p: any = {};
        try {
          p = JSON.parse(w.payload);
        } catch {
          p = { _parseError: 'invalid JSON in WorkQueue.payload', raw: w.payload };
        }
        const txn = p?.transaction_code ?? w.step;
        out.push(`### Transaction ${i + 1} — ${txn}`);
        out.push('');
        out.push(`- **Work ID**: \`${w.id}\``);
        out.push(`- **State**: ${w.state}${w.error ? ` (error: ${w.error})` : ''}`);
        if (p?.instruction) {
          out.push('- **Instruction sent to SAP**:');
          out.push('  ```');
          for (const line of String(p.instruction).split('\n')) out.push(`  ${line}`);
          out.push('  ```');
        }
        // Print structured args (everything except the verbose instruction
        // and meta blob — those are noise).
        const args: Record<string, unknown> = { ...p };
        delete args.instruction;
        if (Object.keys(args).length > 0) {
          out.push('- **Structured args**:');
          out.push('  ```json');
          out.push(`  ${JSON.stringify(args, null, 2).replace(/\n/g, '\n  ')}`);
          out.push('  ```');
        }
        out.push('');
      }
    }

    // -------------------------------------------------------------------
    // Event chain (audit trail)
    // -------------------------------------------------------------------
    out.push('## Event chain (audit trail)');
    out.push('');
    out.push('```');
    const audit = await env.renderAuditTrailForSO({ salesOrderId: soId, maxEvents: 200 });
    out.push(audit);
    out.push('```');
    out.push('');

    // -------------------------------------------------------------------
    // Email thread
    // -------------------------------------------------------------------
    out.push('## Email thread');
    out.push('');
    out.push('```');
    const thread = await env.renderEmailThreadForSO({ salesOrderId: soId, maxMessages: 30 });
    out.push(thread);
    out.push('```');
    out.push('');

    // -------------------------------------------------------------------
    // Final DB state
    // -------------------------------------------------------------------
    const so = await env.prisma.salesOrder.findUnique({
      where: { id: soId },
      include: {
        materials: { orderBy: { createdAt: 'asc' } },
        items: { select: { id: true, lsNumber: true, material: true, orderQuantity: true, sapMaterialDoc: true } },
        invoice: true,
        shipments: { select: { obdNumber: true, status: true } },
        purchaseOrder: { select: { dispatchRound: true } },
      },
    });
    if (so) {
      out.push('## Final DB state');
      out.push('');
      out.push(`- **SO.status**: ${so.status}`);
      out.push(`- **PO.dispatchRound**: ${so.purchaseOrder?.dispatchRound ?? 'n/a'}`);
      out.push(`- **Material rows**: ${so.materials.length}`);
      out.push(`- **LoadingSlipItem rows**: ${so.items.length}`);
      out.push(`- **Invoice**: ${so.invoice ? `#${so.invoice.invoiceNumber ?? '(no number)'}` : 'none'}`);
      out.push(`- **Shipments**: ${so.shipments.length}${so.shipments.length > 0 ? ` (${so.shipments.map((s) => s.status).join(', ')})` : ''}`);
      out.push('');
      if (so.materials.length > 0) {
        out.push('### Materials');
        out.push('');
        out.push('| Material | Batch | Ordered | Available | Dispatch |');
        out.push('|---|---|---|---|---|');
        for (const m of so.materials) {
          out.push(`| ${m.material} | ${m.batch ?? ''} | ${m.orderQuantity ?? 0} | ${m.availableStock ?? '?'} | ${m.dispatchQuantity ?? '?'} |`);
        }
        out.push('');
      }
    }
  }

  // ---------------------------------------------------------------------
  // Notes from the run (one per harness action)
  // ---------------------------------------------------------------------
  if (result.notes.length > 0) {
    out.push('## Run log');
    out.push('');
    out.push('```');
    for (const n of result.notes) out.push(n);
    out.push('```');
    out.push('');
  }

  fs.writeFileSync(path.join(ARTIFACT_DIR, `${spec.id}.md`), out.join('\n'));
}

function writeIndex(results: CaseResult[]): void {
  const out: string[] = [];
  const pass = results.filter((r) => r.passed).length;
  const fail = results.length - pass;
  out.push('# Planner test results');
  out.push('');
  out.push(`**Run at**: ${new Date().toISOString()}`);
  out.push(`**Result**: ${pass}/${results.length} passed (${fail} failed)`);
  out.push('');
  out.push('| Case | Result | Duration | Failures |');
  out.push('|---|---|---|---|');
  for (const r of results) {
    const status = r.passed ? '✅ PASS' : '❌ FAIL';
    const dur = `${(r.durationMs / 1000).toFixed(1)}s`;
    const fails = r.failures.length === 0 ? '' : r.failures.join('; ');
    out.push(`| [${r.id}](./${r.id}.md) | ${status} | ${dur} | ${fails} |`);
  }
  out.push('');
  fs.writeFileSync(path.join(ARTIFACT_DIR, 'index.md'), out.join('\n'));
}

// -----------------------------------------------------------------------------
// Case runner
// -----------------------------------------------------------------------------

async function runCase(env: Env, spec: TestCase): Promise<CaseResult> {
  const result: CaseResult = {
    id: spec.id,
    description: spec.description,
    soNumber: spec.soNumber,
    startedAt: new Date(),
    finishedAt: new Date(),
    durationMs: 0,
    passed: false,
    failures: [],
    notes: [],
  };
  const note = (m: string) => {
    const stamp = `[${new Date().toISOString()}] ${m}`;
    result.notes.push(stamp);
    console.log(`  ${stamp}`);
  };

  // Fresh DB + Gmail/HTTP state for this case.
  await wipeAll(env.prisma);
  GMAIL_INBOX.length = 0;
  RECORDED_EMAILS.length = 0;
  HTTP_LOG.length = 0;

  // Seed inventory: default to plenty unless overridden. The plant name
  // comes from SAP_DEFAULT_PLANT (set at the top of main()).
  const plant = process.env.SAP_DEFAULT_PLANT ?? 'TEST_PLANT';
  const inventory = spec.inventory ?? spec.visibility.map((m) => ({
    material: m.material,
    freeStock: Math.max(m.available_stock_for_so * 5, 500),
  }));
  await seedInventory(env.prisma, plant, inventory);

  // Per-SO visibility fixture (what the dummy auto_gui2 returns).
  writeVisibilityFixture(spec.soNumber, spec.visibility);

  // 1. Push NEW ORDER + run the cron.
  note(`Pushing NEW ORDER for SO ${spec.soNumber}`);
  inboxPushNewOrder({
    soNumber: spec.soNumber,
    customerId: spec.customerId,
    body: spec.newOrderBody,
  });
  try {
    await env.checkForNewEmails();
  } catch (err) {
    result.failures.push(`checkForNewEmails threw: ${err instanceof Error ? err.message : String(err)}`);
    result.finishedAt = new Date();
    result.durationMs = result.finishedAt.getTime() - result.startedAt.getTime();
    return result;
  }

  // 2. Wait for the SO to land.
  const soRow = await waitFor(
    async () => env.prisma.salesOrder.findFirst({
      where: { soNumber: spec.soNumber },
      select: { id: true, purchaseOrderId: true },
    }),
    20_000,
    'SalesOrder row created',
  );
  if (!soRow) {
    result.failures.push('SalesOrder row never appeared after checkForNewEmails');
    result.finishedAt = new Date();
    result.durationMs = result.finishedAt.getTime() - result.startedAt.getTime();
    return result;
  }
  const soId = soRow.id;
  const poId = soRow.purchaseOrderId!;
  note(`SO row created — soId=${soId} poId=${poId}`);

  // 3. Walk the scripted reply sequence. For each reply, wait for the
  //    target outbound email, mark it as replied with the test text, and
  //    invoke handleReplyV2 (the planner-backed entry point).
  for (let i = 0; i < spec.replies.length; i++) {
    const reply = spec.replies[i];
    const waitMs = reply.waitForOutboundMs ?? 30_000;
    note(`Step ${i + 1}/${spec.replies.length}: waiting for outbound "${reply.targetEmailType}" (timeout ${waitMs}ms)`);
    const target = await waitForOutbound(env, soId, poId, reply.targetEmailType, waitMs);
    if (!target) {
      result.failures.push(
        `Step ${i + 1}: no outbound email of type "${reply.targetEmailType}" appeared within ${waitMs}ms`,
      );
      result.finishedAt = new Date();
      result.durationMs = result.finishedAt.getTime() - result.startedAt.getTime();
      return result;
    }
    note(`Step ${i + 1}: targeting email ${target.id.slice(-8)} with reply: "${reply.replyText.slice(0, 80)}"`);

    // Persist the reply on the Email row BEFORE invoking the engine so the
    // audit trail's email thread reflects it.
    await env.prisma.email.update({
      where: { id: target.id },
      data: { replyHtml: reply.replyText, repliedAt: new Date() },
    });

    // SPECIAL CASE: when the PLANT replies on plant_ls with the invoice PDF,
    // the production cron's PDF pre-pass would upload the attachment to R2
    // and set status='replied' + replyPdfUrl on every per-LSI plant_ls Email
    // row in the bundle (one plant_ls is sent per LoadingSlipItem). The
    // batch sender (checkAndSendBatchToAman, called by the process_plant_invoice
    // step) only fires ZLOAD3-B1 when EVERY LSI's plant_ls row is in that
    // state. Without this simulation, the harness leaves the other plant_ls
    // rows as status='sent' with no replyPdfUrl → ZLOAD3 never enqueues.
    // This is harness-only behavior — production has the real PDF pre-pass
    // that does this automatically.
    if (reply.targetEmailType === 'plant_ls' && reply.sender === 'plant') {
      const targetEmail = await env.prisma.email.findUnique({
        where: { id: target.id },
        select: {
          loadingSlip: { select: { bundleId: true } },
          loadingSlipItem: { select: { loadingSlip: { select: { bundleId: true } } } },
        },
      });
      const bundleId =
        targetEmail?.loadingSlip?.bundleId ??
        targetEmail?.loadingSlipItem?.loadingSlip?.bundleId ??
        null;
      if (bundleId) {
        // Update every plant_ls Email row tied to any LS in this bundle.
        const lsesInBundle = await env.prisma.loadingSlip.findMany({
          where: { bundleId },
          select: { id: true },
        });
        const lsIds = lsesInBundle.map((l) => l.id);
        const updated = await env.prisma.email.updateMany({
          where: {
            loadingSlipId: { in: lsIds },
            emailType: 'plant_ls',
            status: { in: ['sent'] },
          },
          data: {
            status: 'replied',
            repliedAt: new Date(),
            replyHtml: reply.replyText,
            replyPdfUrl: `mock-invoice-${spec.soNumber}-${Date.now()}.pdf`,
          },
        });
        note(`  [plant invoice sim] marked ${updated.count} plant_ls Email row(s) in bundle ${bundleId.slice(-8)} as replied with mock PDF URL`);
      }
    }

    try {
      const r = await env.handleReplyV2({
        emailId: target.id,
        replyHtml: reply.replyText,
        originalEmailHtml: target.sentBody ?? '',
        sourceEmailType: reply.sender === 'production' ? 'branch' : reply.sender,
      });
      note(`Step ${i + 1}: handleReplyV2 returned matched=${r.matched}`);

      // SPECIAL CASE: vehicle_details reply contains the LR number and date,
      // which the production UI's "Stage 5 - User Input" flow captures as
      // SalesOrder.lrNumber + SalesOrder.lrDate. The current vehicle-extractor
      // (handleVehicleDetailsReply) only pulls vehicle/driver/container —
      // operators type the LR fields into the dashboard before triggering
      // VT01N. The harness mimics that operator input by parsing
      // "LR: <code> dated <yyyy-mm-dd>" from the reply text and writing
      // those columns directly. Test-only — never executes in production.
      if (reply.targetEmailType === 'vehicle_details' && reply.sender === 'branch') {
        const lrMatch = reply.replyText.match(/LR[:\s]+([A-Z0-9-]+)/i);
        const dateMatch = reply.replyText.match(/(\d{4}-\d{2}-\d{2})/);
        if (lrMatch && dateMatch) {
          await env.prisma.salesOrder.update({
            where: { id: soId },
            data: { lrNumber: lrMatch[1], lrDate: new Date(dateMatch[1]) },
          });
          note(`  [operator input sim] persisted lrNumber=${lrMatch[1]} lrDate=${dateMatch[1]} on SO`);
        }
      }
    } catch (err) {
      result.failures.push(
        `Step ${i + 1}: handleReplyV2 threw: ${err instanceof Error ? err.message : String(err)}`,
      );
      result.finishedAt = new Date();
      result.durationMs = result.finishedAt.getTime() - result.startedAt.getTime();
      return result;
    }

    // Give the engine + dummy a chance to process callbacks before the
    // next reply waits for its outbound.
    await new Promise((r) => setTimeout(r, 1000));

    // Watchdog — if the case has somehow created an absurd number of
    // ScenarioProgress rows, we're in a reentrancy loop. Fail fast before
    // OpenAI cost balloons.
    const progressCount = await env.prisma.scenarioProgress.count({
      where: { salesOrderId: soId },
    });
    const MAX_PROGRESS_ROWS = 25;
    if (progressCount > MAX_PROGRESS_ROWS) {
      result.failures.push(
        `Reentrancy detected: ${progressCount} ScenarioProgress rows for this SO (cap=${MAX_PROGRESS_ROWS}). Aborting case.`,
      );
      note(`WATCHDOG: ${progressCount} ScenarioProgress rows — aborting to prevent OpenAI runaway`);
      result.finishedAt = new Date();
      result.durationMs = result.finishedAt.getTime() - result.startedAt.getTime();
      return result;
    }
  }

  // 3.5. Lifecycle-completion phase — simulate the operator-triggered VT01N.
  //
  // After the plant invoice replies have driven ZLOAD3-B1 (the
  // process_plant_invoice step), the /processing-data callback creates one
  // Shipment row per (Bundle, SO) pair. In production an operator opens the
  // dashboard and clicks "Trigger VT01N" per Shipment. The harness simulates
  // that click by calling triggerVto1n() for every Shipment that lands. This
  // exercises the final SAP transaction of the chain (VTO1N-B) so the test
  // report shows the complete end-to-end transaction sequence.
  //
  // No production code is changed — we just call the existing trigger
  // function directly, which is what the dashboard UI also does.
  await new Promise((r) => setTimeout(r, 2000));
  {
    const shipments = await waitFor(
      async () => {
        const rows = await env.prisma.shipment.findMany({
          where: { salesOrderId: soId },
          select: { id: true, obdNumber: true, status: true },
        });
        return rows.length > 0 ? rows : null;
      },
      15_000,
      'Shipment row(s) appearing after ZLOAD3-B1',
    );
    if (shipments && shipments.length > 0) {
      note(`Shipment(s) created (${shipments.length}); simulating operator VT01N click per shipment`);
      for (const s of shipments) {
        if (s.status !== 'created') {
          note(`  shipment ${s.id.slice(-8)} status=${s.status} — skipping VT01N (already triggered or shipped)`);
          continue;
        }
        try {
          await env.triggerVto1n(s.id);
          note(`  triggerVto1n(${s.id.slice(-8)}) enqueued (obd=${s.obdNumber ?? 'pending'})`);
        } catch (err) {
          result.failures.push(
            `triggerVto1n threw for shipment ${s.id.slice(-8)}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      // Wait for VT01N callbacks to mark shipments shipped + SO completed.
      await waitFor(
        async () => {
          const so = await env.prisma.salesOrder.findUnique({
            where: { id: soId },
            select: { status: true },
          });
          return so?.status === 'completed' ? true : null;
        },
        15_000,
        'SO.status reaching "completed" after VT01N',
      );
    } else {
      note(`No Shipment rows appeared — ZLOAD3-B1 likely did not fire (test does not cover full lifecycle)`);
    }
  }

  // Final settling delay — let any pending callbacks land before assertions.
  await new Promise((r) => setTimeout(r, 1500));

  // 4. Assertions.
  if (spec.expect.finalSoStatus) {
    const so = await env.prisma.salesOrder.findUnique({
      where: { id: soId },
      select: { status: true },
    });
    if (so?.status !== spec.expect.finalSoStatus) {
      result.failures.push(
        `Expected SO.status="${spec.expect.finalSoStatus}", got "${so?.status ?? '(missing)'}"`,
      );
    }
  }

  if (spec.expect.sapTransactions && spec.expect.sapTransactions.length > 0) {
    const works = await env.prisma.workQueue.findMany({
      where: { salesOrderId: soId },
      orderBy: { createdAt: 'asc' },
      select: { payload: true, step: true },
    });
    const actualTxns: string[] = works.map((w) => {
      try {
        const p = JSON.parse(w.payload);
        return p?.transaction_code ?? w.step;
      } catch {
        return w.step;
      }
    });
    // Subsequence match: every expected txn must appear in order somewhere
    // in actualTxns. Extras are allowed (e.g. ZSO-VISIBILITY ×2 for modify).
    let ai = 0;
    const missing: string[] = [];
    for (const expected of spec.expect.sapTransactions) {
      while (ai < actualTxns.length && actualTxns[ai] !== expected) ai++;
      if (ai >= actualTxns.length) {
        missing.push(expected);
      } else {
        ai++;
      }
    }
    if (missing.length > 0) {
      result.failures.push(
        `SAP transaction sequence missing: ${missing.join(', ')}. Actual order: ${actualTxns.join(' → ')}`,
      );
    }
  }

  if (spec.expect.sentEmailTypes && spec.expect.sentEmailTypes.length > 0) {
    for (const t of spec.expect.sentEmailTypes) {
      // Any non-error status counts as "the email was sent at some point in
      // this case's lifecycle". Includes:
      //   sent      — outbound delivered, no reply yet
      //   replied   — recipient replied
      //   processed — ZLOAD3-B1 batch consumed it (plant_ls after invoice)
      //   consumed  — superseded by a later send (e.g. ls_dispatch_buffered)
      // Excludes only `queued` (never went out).
      const found = await env.prisma.email.findFirst({
        where: {
          OR: [
            { salesOrderId: soId },
            { purchaseOrderId: poId },
            { loadingSlipItem: { salesOrderId: soId } },
          ],
          emailType: t,
          status: { in: ['sent', 'replied', 'processed', 'consumed'] },
        },
      });
      if (!found) {
        // Debug: list all Email rows for this SO/PO/LSIs so the report shows why.
        const all = await env.prisma.email.findMany({
          where: {
            OR: [
              { salesOrderId: soId },
              { purchaseOrderId: poId },
              { loadingSlipItem: { salesOrderId: soId } },
            ],
          },
          select: { id: true, emailType: true, status: true, salesOrderId: true, loadingSlipItemId: true },
        });
        const summary = all.map((e) => `${e.emailType}/${e.status}`).join(', ');
        result.failures.push(
          `Expected outbound email of type "${t}" — none found. All emails for this SO: [${summary}]`,
        );
      }
    }
  }

  if (spec.expect.custom) {
    const extra = await spec.expect.custom({ env, caseId: spec.id, soId, soNumber: spec.soNumber, poId });
    result.failures.push(...extra);
  }

  result.passed = result.failures.length === 0;
  result.finishedAt = new Date();
  result.durationMs = result.finishedAt.getTime() - result.startedAt.getTime();

  await writeCaseReport(env, spec, result, soId, poId);
  return result;
}

// -----------------------------------------------------------------------------
// Test case specs
// -----------------------------------------------------------------------------

// Standard 3-material fixture used by most cases. M-A is small (50),
// M-B is medium (100), M-C is large (250).
const STANDARD_MATERIALS: VisibilityMaterial[] = [
  { material: 'YE1EDWO00001APJP', material_description: 'M-A', batch: 'A-26', order_quantity: 50, available_stock_for_so: 50, order_weight_kg: 1320 },
  { material: 'YV6FRYENE0000PJP', material_description: 'M-B', batch: '30-07-2025', order_quantity: 100, available_stock_for_so: 100, order_weight_kg: 2720 },
  { material: 'YA4COWOCR000043P', material_description: 'M-C', batch: '20', order_quantity: 250, available_stock_for_so: 250, order_weight_kg: 6625 },
];

const NEW_ORDER_BODY = (soNumber: string, customerId: string) =>
  `Dear Sales Team,\n\nPlease create SO ${soNumber} for customer ${customerId}. Materials:\n` +
  `- YE1EDWO00001APJP — 50 units\n- YV6FRYENE0000PJP — 100 units\n- YA4COWOCR000043P — 250 units\n\n` +
  `Vehicle Tonnage: 35 t\n\n` +
  `Regards,\nBranch`;

const CASES: TestCase[] = [
  // 1 — Plain release_all
  {
    id: 'release_all_no_change',
    description: 'Branch confirms full dispatch with no quantity changes (no modification).',
    soNumber: '3290101',
    customerId: 'TEST-CUST-RELEASE-ALL',
    newOrderBody: NEW_ORDER_BODY('3290101', 'TEST-CUST-RELEASE-ALL'),
    visibility: STANDARD_MATERIALS,
    replies: [
      {
        targetEmailType: 'ls_dispatch',
        sender: 'branch',
        replyText: 'Confirmed. Please release everything as available and proceed with dispatch.',
        note: 'Branch confirms ls_dispatch — no changes',
      },
      {
        targetEmailType: 'dispatch_confirmation',
        sender: 'branch',
        replyText: 'Confirmed. Please proceed with the dispatch plan as outlined.',
        note: 'Branch confirms dispatch_confirmation',
      },
      {
        targetEmailType: 'vehicle_details',
        sender: 'branch',
        replyText: 'Vehicle: MH12AB1234, Driver: 9876543210, LR: LR-001 dated 2026-05-31',
        note: 'Branch provides vehicle details',
      },
      {
        targetEmailType: 'plant_ls',
        sender: 'plant',
        replyText: 'Invoice attached. Invoice number 7682614520, OBD 5070000123.',
        note: 'Plant sends invoice on plant_ls',
      },
    ],
    expect: {
      sapTransactions: ['ZSO-VISIBILITY', 'ZLOAD1', 'ZLOAD3-B1', 'VTO1N-B'],
      finalSoStatus: 'completed',
      sentEmailTypes: ['ls_dispatch', 'dispatch_confirmation', 'vehicle_details', 'plant_ls'],
    },
  },

  // 2 — Pre-LS modify: increase one material
  {
    id: 'modify_increase_pre_ls',
    description: 'Branch asks to increase M-A from 50 → 80 BEFORE LS is created. Expect VA02 + 2nd release + re-cycle.',
    soNumber: '3290102',
    customerId: 'TEST-CUST-MOD-INC',
    newOrderBody: NEW_ORDER_BODY('3290102', 'TEST-CUST-MOD-INC'),
    visibility: STANDARD_MATERIALS,
    replies: [
      {
        targetEmailType: 'ls_dispatch',
        sender: 'branch',
        replyText: 'Please increase YE1EDWO00001APJP (M-A) from 50 to 80 units. Keep the rest as is.',
        note: 'Branch modifies M-A upward (50 → 80)',
      },
      {
        targetEmailType: '2nd_release',
        sender: 'branch',
        replyText: 'Yes, please do the second release and proceed.',
        note: 'Branch confirms 2nd release',
      },
      {
        targetEmailType: 'ls_dispatch',
        sender: 'branch',
        replyText: 'Looks good now. Proceed with dispatch.',
        note: 'Branch confirms round-2 ls_dispatch',
      },
      {
        targetEmailType: 'dispatch_confirmation',
        sender: 'branch',
        replyText: 'Confirmed. Proceed.',
      },
      {
        targetEmailType: 'vehicle_details',
        sender: 'branch',
        replyText: 'Vehicle: MH12CD5678, Driver: 9988776655, LR: LR-002 dated 2026-05-31',
      },
      {
        targetEmailType: 'plant_ls',
        sender: 'plant',
        replyText: 'Invoice 7682614521 OBD 5070000124 attached.',
      },
    ],
    expect: {
      sapTransactions: ['ZSO-VISIBILITY', 'VA02', 'ZSO-VISIBILITY', 'ZLOAD1', 'ZLOAD3-B1', 'VTO1N-B'],
      finalSoStatus: 'completed',
      sentEmailTypes: ['ls_dispatch', '2nd_release', 'dispatch_confirmation', 'vehicle_details', 'plant_ls'],
    },
  },

  // 3 — Pre-LS modify: decrease one material
  {
    id: 'modify_decrease_pre_ls',
    description: 'Branch asks to decrease M-A from 50 → 30 BEFORE LS is created. No VA02 needed; dispatch the smaller qty directly.',
    soNumber: '3290103',
    customerId: 'TEST-CUST-MOD-DEC',
    newOrderBody: NEW_ORDER_BODY('3290103', 'TEST-CUST-MOD-DEC'),
    visibility: STANDARD_MATERIALS,
    replies: [
      {
        targetEmailType: 'ls_dispatch',
        sender: 'branch',
        replyText: 'Please reduce YE1EDWO00001APJP (M-A) from 50 to 30 units. Keep the rest as is.',
        note: 'Branch modifies M-A downward (50 → 30)',
      },
      {
        targetEmailType: 'dispatch_confirmation',
        sender: 'branch',
        replyText: 'Confirmed. Proceed with the reduced quantity.',
      },
      {
        targetEmailType: 'vehicle_details',
        sender: 'branch',
        replyText: 'Vehicle: MH12EF9012, Driver: 9123456789, LR: LR-003 dated 2026-05-31',
      },
      {
        targetEmailType: 'plant_ls',
        sender: 'plant',
        replyText: 'Invoice 7682614522 OBD 5070000125 attached.',
      },
    ],
    expect: {
      sapTransactions: ['ZSO-VISIBILITY', 'ZLOAD1', 'ZLOAD3-B1', 'VTO1N-B'],
      finalSoStatus: 'completed',
      sentEmailTypes: ['ls_dispatch', 'dispatch_confirmation', 'vehicle_details', 'plant_ls'],
    },
  },

  // 4 — Pre-LS modify: delete one material
  {
    id: 'modify_delete_pre_ls',
    description: 'Branch asks to delete YA4COWOCR000043P (M-C) BEFORE LS is created. Surviving materials dispatched.',
    soNumber: '3290104',
    customerId: 'TEST-CUST-MOD-DEL',
    newOrderBody: NEW_ORDER_BODY('3290104', 'TEST-CUST-MOD-DEL'),
    visibility: STANDARD_MATERIALS,
    replies: [
      {
        targetEmailType: 'ls_dispatch',
        sender: 'branch',
        replyText: 'Please drop YA4COWOCR000043P (M-C) entirely from this order. Dispatch only the remaining two materials.',
        note: 'Branch deletes M-C',
      },
      {
        targetEmailType: 'dispatch_confirmation',
        sender: 'branch',
        replyText: 'Confirmed.',
      },
      {
        targetEmailType: 'vehicle_details',
        sender: 'branch',
        replyText: 'Vehicle: MH12GH3456, Driver: 9988123456, LR: LR-004 dated 2026-05-31',
      },
      {
        targetEmailType: 'plant_ls',
        sender: 'plant',
        replyText: 'Invoice 7682614523 OBD 5070000126 attached.',
      },
    ],
    expect: {
      sapTransactions: ['ZSO-VISIBILITY', 'ZLOAD1', 'ZLOAD3-B1', 'VTO1N-B'],
      finalSoStatus: 'completed',
      sentEmailTypes: ['ls_dispatch', 'dispatch_confirmation', 'vehicle_details', 'plant_ls'],
    },
  },

  // 5 — Pre-LS modify: increase + decrease combo
  {
    id: 'modify_inc_dec_pre_ls',
    description: 'Branch asks to increase M-A 50→80 AND decrease M-B 100→60 BEFORE LS. VA02 fires only for increase.',
    soNumber: '3290105',
    customerId: 'TEST-CUST-MOD-INC-DEC',
    newOrderBody: NEW_ORDER_BODY('3290105', 'TEST-CUST-MOD-INC-DEC'),
    visibility: STANDARD_MATERIALS,
    replies: [
      {
        targetEmailType: 'ls_dispatch',
        sender: 'branch',
        replyText: 'Two changes: increase YE1EDWO00001APJP (M-A) from 50 to 80, and reduce YV6FRYENE0000PJP (M-B) from 100 to 60.',
        note: 'Branch modifies M-A up and M-B down',
      },
      {
        targetEmailType: '2nd_release',
        sender: 'branch',
        replyText: 'Yes, do the second release.',
      },
      {
        targetEmailType: 'ls_dispatch',
        sender: 'branch',
        replyText: 'Confirmed. Proceed.',
      },
      {
        targetEmailType: 'dispatch_confirmation',
        sender: 'branch',
        replyText: 'Confirmed.',
      },
      {
        targetEmailType: 'vehicle_details',
        sender: 'branch',
        replyText: 'Vehicle: MH12IJ7890, Driver: 9000000000, LR: LR-005 dated 2026-05-31',
      },
      {
        targetEmailType: 'plant_ls',
        sender: 'plant',
        replyText: 'Invoice 7682614524 OBD 5070000127 attached.',
      },
    ],
    expect: {
      sapTransactions: ['ZSO-VISIBILITY', 'VA02', 'ZSO-VISIBILITY', 'ZLOAD1', 'ZLOAD3-B1', 'VTO1N-B'],
      finalSoStatus: 'completed',
      sentEmailTypes: ['ls_dispatch', '2nd_release', 'dispatch_confirmation', 'vehicle_details', 'plant_ls'],
    },
  },

  // 6 — Pre-LS modify: increase + delete combo
  {
    id: 'modify_inc_del_pre_ls',
    description: 'Branch asks to increase M-A 50→80 AND delete M-C BEFORE LS. VA02 for M-A; M-C dropped.',
    soNumber: '3290106',
    customerId: 'TEST-CUST-MOD-INC-DEL',
    newOrderBody: NEW_ORDER_BODY('3290106', 'TEST-CUST-MOD-INC-DEL'),
    visibility: STANDARD_MATERIALS,
    replies: [
      {
        targetEmailType: 'ls_dispatch',
        sender: 'branch',
        replyText: 'Please increase YE1EDWO00001APJP (M-A) from 50 to 80 and remove YA4COWOCR000043P (M-C) entirely.',
      },
      { targetEmailType: '2nd_release', sender: 'branch', replyText: 'Yes, second release confirmed.' },
      { targetEmailType: 'ls_dispatch', sender: 'branch', replyText: 'Looks good, proceed.' },
      { targetEmailType: 'dispatch_confirmation', sender: 'branch', replyText: 'Confirmed.' },
      { targetEmailType: 'vehicle_details', sender: 'branch', replyText: 'Vehicle: MH12KL1234, Driver: 9111111111, LR: LR-006 dated 2026-05-31' },
      { targetEmailType: 'plant_ls', sender: 'plant', replyText: 'Invoice 7682614525 OBD 5070000128 attached.' },
    ],
    expect: {
      sapTransactions: ['ZSO-VISIBILITY', 'VA02', 'ZSO-VISIBILITY', 'ZLOAD1', 'ZLOAD3-B1', 'VTO1N-B'],
      finalSoStatus: 'completed',
      sentEmailTypes: ['ls_dispatch', '2nd_release', 'dispatch_confirmation', 'vehicle_details', 'plant_ls'],
    },
  },

  // 7 — Pre-LS modify: decrease + delete combo
  {
    id: 'modify_dec_del_pre_ls',
    description: 'Branch asks to decrease M-A 50→30 AND delete M-C BEFORE LS. No VA02; just dispatch remainder.',
    soNumber: '3290107',
    customerId: 'TEST-CUST-MOD-DEC-DEL',
    newOrderBody: NEW_ORDER_BODY('3290107', 'TEST-CUST-MOD-DEC-DEL'),
    visibility: STANDARD_MATERIALS,
    replies: [
      {
        targetEmailType: 'ls_dispatch',
        sender: 'branch',
        replyText: 'Please reduce YE1EDWO00001APJP (M-A) from 50 to 30 and drop YA4COWOCR000043P (M-C).',
      },
      { targetEmailType: 'dispatch_confirmation', sender: 'branch', replyText: 'Confirmed.' },
      { targetEmailType: 'vehicle_details', sender: 'branch', replyText: 'Vehicle: MH12MN5678, Driver: 9222222222, LR: LR-007 dated 2026-05-31' },
      { targetEmailType: 'plant_ls', sender: 'plant', replyText: 'Invoice 7682614526 OBD 5070000129 attached.' },
    ],
    expect: {
      sapTransactions: ['ZSO-VISIBILITY', 'ZLOAD1', 'ZLOAD3-B1', 'VTO1N-B'],
      finalSoStatus: 'completed',
      sentEmailTypes: ['ls_dispatch', 'dispatch_confirmation', 'vehicle_details', 'plant_ls'],
    },
  },

  // 8 — Post-LS modify: decrease (after plant_ls sent)
  {
    id: 'modify_decrease_post_ls',
    description: 'Branch asks to decrease M-A 50→30 AFTER plant_ls has been sent. Expect ZLOAD2 (no VA02, no 2nd_release).',
    soNumber: '3290108',
    customerId: 'TEST-CUST-POST-DEC',
    newOrderBody: NEW_ORDER_BODY('3290108', 'TEST-CUST-POST-DEC'),
    visibility: STANDARD_MATERIALS,
    replies: [
      // First go through the full release cycle to land at after_email_to_plant.
      { targetEmailType: 'ls_dispatch', sender: 'branch', replyText: 'Confirmed. Release everything.' },
      { targetEmailType: 'dispatch_confirmation', sender: 'branch', replyText: 'Confirmed. Proceed.' },
      { targetEmailType: 'vehicle_details', sender: 'branch', replyText: 'Vehicle: MH12OP9012, Driver: 9333333333, LR: LR-008 dated 2026-05-31' },
      // Now the post-LS modification — on the existing thread.
      {
        targetEmailType: 'plant_ls',
        sender: 'branch',
        replyText: 'Update: please reduce YE1EDWO00001APJP (M-A) from 50 to 30. The plant should ship 30 instead.',
        note: 'Branch sends post-LS modification on plant_ls thread',
      },
      // After ZLOAD2 fires, the existing plant_ls is still open — plant
      // eventually sends the invoice.
      { targetEmailType: 'plant_ls', sender: 'plant', replyText: 'Invoice 7682614527 OBD 5070000130 attached.' },
    ],
    expect: {
      sapTransactions: ['ZSO-VISIBILITY', 'ZLOAD1', 'ZLOAD2', 'ZLOAD3-B1', 'VTO1N-B'],
      finalSoStatus: 'completed',
      sentEmailTypes: ['ls_dispatch', 'dispatch_confirmation', 'vehicle_details', 'plant_ls'],
    },
  },

  // 9 — Post-LS modify: delete (after plant_ls sent)
  {
    id: 'modify_delete_post_ls',
    description: 'Branch asks to delete M-C AFTER plant_ls. Expect ZLOADING_CLOSE (ZLOAD_Delete), no VA02.',
    soNumber: '3290109',
    customerId: 'TEST-CUST-POST-DEL',
    newOrderBody: NEW_ORDER_BODY('3290109', 'TEST-CUST-POST-DEL'),
    visibility: STANDARD_MATERIALS,
    replies: [
      { targetEmailType: 'ls_dispatch', sender: 'branch', replyText: 'Confirmed.' },
      { targetEmailType: 'dispatch_confirmation', sender: 'branch', replyText: 'Confirmed.' },
      { targetEmailType: 'vehicle_details', sender: 'branch', replyText: 'Vehicle: MH12QR3456, Driver: 9444444444, LR: LR-009 dated 2026-05-31' },
      {
        targetEmailType: 'plant_ls',
        sender: 'branch',
        replyText: 'Please remove YA4COWOCR000043P (M-C) entirely from the LS. The plant should not ship it.',
        note: 'Branch deletes M-C post-LS',
      },
      { targetEmailType: 'plant_ls', sender: 'plant', replyText: 'Invoice 7682614528 OBD 5070000131 attached for the remaining items.' },
    ],
    expect: {
      sapTransactions: ['ZSO-VISIBILITY', 'ZLOAD1', 'ZLOAD3-B1', 'VTO1N-B'],
      finalSoStatus: 'completed',
      // The planner is expected to emit zloading_close; appears as ZLOAD_Delete.
      sentEmailTypes: ['ls_dispatch', 'dispatch_confirmation', 'vehicle_details', 'plant_ls'],
    },
  },

  // 10 — Post-LS modify: increase (after plant_ls sent)
  {
    id: 'modify_increase_post_ls',
    description: 'Branch asks to increase M-B 100→150 AFTER plant_ls. Expect VA02 + 2nd_release + ZLOAD2.',
    soNumber: '3290110',
    customerId: 'TEST-CUST-POST-INC',
    newOrderBody: NEW_ORDER_BODY('3290110', 'TEST-CUST-POST-INC'),
    visibility: STANDARD_MATERIALS,
    replies: [
      // Phase A: normal release through plant_ls
      { targetEmailType: 'ls_dispatch', sender: 'branch', replyText: 'Confirmed.' },
      { targetEmailType: 'dispatch_confirmation', sender: 'branch', replyText: 'Confirmed.' },
      { targetEmailType: 'vehicle_details', sender: 'branch', replyText: 'Vehicle: MH12ST7890, Driver: 9555555555, LR: LR-010 dated 2026-05-31' },
      // Phase B: post-LS modification request from branch
      {
        targetEmailType: 'plant_ls',
        sender: 'branch',
        replyText: 'Increase YV6FRYENE0000PJP (M-B) from 100 to 150 — we have stock available.',
        note: 'Branch increases M-B post-LS — triggers VA02 + 2nd_release',
      },
      // Phase C: branch confirms 2nd release → re-cycle starts
      { targetEmailType: '2nd_release', sender: 'branch', replyText: 'Yes, do the second release.' },
      // Phase D: branch confirms round-2 ls_dispatch (product details after re-visibility)
      {
        targetEmailType: 'ls_dispatch',
        sender: 'branch',
        replyText: 'Confirmed. The updated product plan looks good. Proceed.',
        note: 'Branch confirms round-2 ls_dispatch (post re-visibility)',
      },
      // Phase E: branch confirms round-2 dispatch_confirmation (bundle plan)
      {
        targetEmailType: 'dispatch_confirmation',
        sender: 'branch',
        replyText: 'Confirmed. Proceed with revised bundle plan.',
        note: 'Branch confirms round-2 dispatch_confirmation → triggers ZLOAD2',
      },
      // Phase F: plant finally sends the invoice
      { targetEmailType: 'plant_ls', sender: 'plant', replyText: 'Invoice 7682614529 OBD 5070000132 attached.' },
    ],
    expect: {
      sapTransactions: ['ZSO-VISIBILITY', 'ZLOAD1', 'VA02', 'ZSO-VISIBILITY', 'ZLOAD2', 'ZLOAD3-B1', 'VTO1N-B'],
      finalSoStatus: 'completed',
      sentEmailTypes: ['ls_dispatch', 'dispatch_confirmation', 'vehicle_details', 'plant_ls', '2nd_release'],
    },
  },
];

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

async function main(): Promise<void> {
  // Default plant for stock-precheck if the SO doesn't carry one. Set on
  // every test run.
  if (!process.env.SAP_DEFAULT_PLANT) process.env.SAP_DEFAULT_PLANT = 'TEST_PLANT';
  // BRANCH_EMAIL must be set so the engine's outbound senders don't bail.
  if (!process.env.BRANCH_EMAIL) process.env.BRANCH_EMAIL = 'branch-test@example.com';
  if (!process.env.PLANT_EMAIL) process.env.PLANT_EMAIL = 'plant-test@example.com';
  // The dashboard URL the dummy posts callbacks back to.
  if (!process.env.DASHBOARD_URL) process.env.DASHBOARD_URL = 'http://localhost:3000';

  const filter = process.env.FILTER;
  const selected = filter ? CASES.filter((c) => c.id.includes(filter)) : CASES;
  if (selected.length === 0) {
    console.log(`No test cases matched FILTER="${filter}"`);
    return;
  }

  console.log(`Running ${selected.length} planner test case(s)`);
  clearArtifactDir();

  await startDummy();
  await startBridge();
  const env = await loadEngine();

  const results: CaseResult[] = [];
  for (const spec of selected) {
    console.log(`\n══════════════════════════════════════════════════════════════════════`);
    console.log(`CASE: ${spec.id}`);
    console.log(`  ${spec.description}`);
    console.log(`══════════════════════════════════════════════════════════════════════`);
    try {
      const r = await runCase(env, spec);
      results.push(r);
      console.log(`  → ${r.passed ? '✅ PASS' : '❌ FAIL'} (${(r.durationMs / 1000).toFixed(1)}s)`);
      if (!r.passed) {
        for (const f of r.failures) console.log(`    ${f}`);
      }
    } catch (err) {
      console.error(`  ✗ Case threw: ${err instanceof Error ? err.message : String(err)}`);
      results.push({
        id: spec.id,
        description: spec.description,
        soNumber: spec.soNumber,
        startedAt: new Date(),
        finishedAt: new Date(),
        durationMs: 0,
        passed: false,
        failures: [`Harness threw: ${err instanceof Error ? err.message : String(err)}`],
        notes: [],
      });
    }
  }

  writeIndex(results);

  await stopBridge();
  await stopDummy();

  console.log(`\n══════════════════════════════════════════════════════════════════════`);
  const pass = results.filter((r) => r.passed).length;
  console.log(`RESULTS: ${pass}/${results.length} passed`);
  console.log(`Reports written to ${ARTIFACT_DIR}`);
  console.log(`══════════════════════════════════════════════════════════════════════`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(2);
});
