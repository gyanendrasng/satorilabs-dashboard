/**
 * End-to-end harness for the scenario engine.
 *
 * Walks every in-scope scenario from the spreadsheet through every step,
 * mocking all SAP calls and Gmail sends, calling the real OpenAI classifier.
 * Prints a per-scenario report with reply text + expected vs actual step
 * sequence + final state, plus an aggregate pass/fail summary.
 *
 *   # 1) Push schema to throwaway SQLite DB:
 *   DATABASE_URL="file:./test-scenarios.db" \
 *     npx prisma db push --schema prisma/schema.prisma --skip-generate
 *
 *   # 2) Run the harness (key inline, never written to disk):
 *   DATABASE_URL="file:./test-scenarios.db" \
 *     SCENARIO_ENGINE_ENABLED=true \
 *     BRANCH_EMAIL=test-branch@example.com \
 *     PLANT_EMAIL=test-plant@example.com \
 *     OPENAI_API_KEY="sk-..." \
 *     npx tsx scripts/test-scenarios-e2e.ts
 *
 * Note: all the mock-setup + engine-import code runs inside main() because
 * tsx transpiles to CJS (no top-level await). The order of operations is
 * still: patch namespaces FIRST, import the engine SECOND.
 */
import 'dotenv/config';
import * as fs from 'node:fs';

// ============================================================================
// Shared state — used by mocks
// ============================================================================

type RecordedCall = {
  kind: 'gmail' | 'workqueue';
  fn: string;
  args: unknown[];
  ts: string;
};
const RECORDED: RecordedCall[] = [];
let gmailSeq = 0;
const now = () => new Date().toISOString();

// Per-scenario step trail (filled by the console.log wrapper below)
const STEP_TRAILS = new Map<string, Array<{ kind: string; label?: string }>>();
let CURRENT_KEY: string | null = null;

// Stable reference to original console.log so the wrapper can call it.
const origLog = console.log;

// ============================================================================
// Test data — CASES table
// ============================================================================

const MATS = [
  { code: 'M-A', batch: 'B1', ordered: 100, available: 100, weightKg: 1000 },
  { code: 'M-B', batch: 'B1', ordered: 100, available: 100, weightKg: 1000 },
  { code: 'M-C', batch: 'B1', ordered: 100, available: 100, weightKg: 1000 },
];

const ORIGINAL_EMAIL = (soNumber: string) =>
  [
    `Dear Sales Team,`,
    ``,
    `Please find below the dispatch recommendation for Sales Order ${soNumber}:`,
    ``,
    `  - M-A (Batch B1): ordered 100 units, available 100`,
    `  - M-B (Batch B1): ordered 100 units, available 100`,
    `  - M-C (Batch B1): ordered 100 units, available 100`,
    ``,
    `Please reply with your dispatch decision.`,
  ].join('\n');

type CaseSpec = {
  key: string;
  row: number | string;
  bucket: string;
  emailType: 'branch' | 'plant';
  stage: 'before_ls' | 'after_ls_before_invoice';
  triggerEmailType: string;
  expectedIntent: 'release_all' | 'release_part' | 'wait' | 'modify';
  expectedModification?: 'increase' | 'decrease' | 'delete' | 'inc_dec' | 'inc_del' | 'dec_del';
  replyText: string;
  // Phase E additions:
  // 'novel' = expect scenario_key='unknown' (no registered scenario matches);
  //           pass criteria flips: classifier MUST escalate, finalState='aborted'.
  // 'midflow_abort' = run a primary scenario first to advance N steps, then
  //           send `secondReply` and expect action_on_active='abort_and_replace'
  //           with scenario_key=`midflowReplaceKey`. final scenario is the new one.
  // 'midflow_escalate' = same setup but secondReply is ambiguous → expect
  //           action_on_active='escalate', final state aborted on the old scenario.
  kind?: 'novel' | 'midflow_abort' | 'midflow_escalate' | 'stock_sufficient' | 'stock_short';
  // For mid-flow cases: how many steps to advance the primary scenario before
  // sending the second reply (default: 2 — past VA02 and 2nd-release).
  primarySteps?: number;
  secondReply?: string;
  midflowReplaceKey?: string;       // expected scenario_key after abort_and_replace
  // For stock_short cases: pre-seed inventory_snapshot before the run.
  // Pass criteria flips: classifier MUST pick the increase-shaped scenario,
  // engine MUST abort at stock_precheck (no VA02 fired), and a
  // stock_short_inquiry email must exist.
  inventory?: Array<{ material: string; freeStock: number }>;
};

const CASES: CaseSpec[] = [
  // ─── Branch + before_ls + release/wait (rows 9, 10, 15) ──────────────
  { key: 'branch|before_ls|release_all|-', row: 9, bucket: 'branch_release',
    emailType: 'branch', stage: 'before_ls', triggerEmailType: 'ls_dispatch',
    expectedIntent: 'release_all',
    replyText: 'Please release everything as available — full quantities approved.' },
  { key: 'branch|before_ls|release_part|-', row: 10, bucket: 'branch_release',
    emailType: 'branch', stage: 'before_ls', triggerEmailType: 'ls_dispatch',
    expectedIntent: 'release_part',
    replyText: 'Release M-A and M-B only — skip M-C for now.' },
  { key: 'branch|before_ls|wait|-', row: 15, bucket: 'branch_release',
    emailType: 'branch', stage: 'before_ls', triggerEmailType: 'ls_dispatch',
    expectedIntent: 'wait',
    replyText: 'Hold on — please wait for materials to arrive before dispatching.' },

  // ─── Branch + before_ls + modify (rows 11, 12, 13, 14, 35, 37) ───────
  { key: 'branch|before_ls|modify|increase', row: 11, bucket: 'branch_modify',
    emailType: 'branch', stage: 'before_ls', triggerEmailType: 'ls_dispatch',
    expectedIntent: 'modify', expectedModification: 'increase',
    replyText: 'Please increase M-A to 150 units (instead of 100).' },
  { key: 'branch|before_ls|modify|inc_dec', row: 12, bucket: 'branch_modify',
    emailType: 'branch', stage: 'before_ls', triggerEmailType: 'ls_dispatch',
    expectedIntent: 'modify', expectedModification: 'inc_dec',
    replyText: 'Increase M-A to 150 and decrease M-B to 60.' },
  { key: 'branch|before_ls|modify|inc_del', row: 13, bucket: 'branch_modify',
    emailType: 'branch', stage: 'before_ls', triggerEmailType: 'ls_dispatch',
    expectedIntent: 'modify', expectedModification: 'inc_del',
    replyText: 'Increase M-A to 150 and delete M-C.' },
  { key: 'branch|before_ls|modify|delete', row: 14, bucket: 'branch_modify',
    emailType: 'branch', stage: 'before_ls', triggerEmailType: 'ls_dispatch',
    expectedIntent: 'modify', expectedModification: 'delete',
    replyText: 'Please delete M-C from the order entirely.' },
  { key: 'branch|before_ls|modify|decrease', row: 35, bucket: 'branch_modify',
    emailType: 'branch', stage: 'before_ls', triggerEmailType: 'ls_dispatch',
    expectedIntent: 'modify', expectedModification: 'decrease',
    replyText: 'Reduce M-A to 60 units.' },
  { key: 'branch|before_ls|modify|dec_del', row: 37, bucket: 'branch_modify',
    emailType: 'branch', stage: 'before_ls', triggerEmailType: 'ls_dispatch',
    expectedIntent: 'modify', expectedModification: 'dec_del',
    replyText: 'Decrease M-A to 60 and delete M-C.' },

  // ─── Branch + after_ls + modify (rows 16–21) ─────────────────────────
  { key: 'branch|after_ls_before_invoice|modify|increase', row: 16, bucket: 'after_ls_branch',
    emailType: 'branch', stage: 'after_ls_before_invoice', triggerEmailType: 'vehicle_details',
    expectedIntent: 'modify', expectedModification: 'increase',
    replyText: 'Please increase M-A to 150 units on the loading slip.' },
  { key: 'branch|after_ls_before_invoice|modify|inc_dec', row: 17, bucket: 'after_ls_branch',
    emailType: 'branch', stage: 'after_ls_before_invoice', triggerEmailType: 'vehicle_details',
    expectedIntent: 'modify', expectedModification: 'inc_dec',
    replyText: 'Increase M-A to 150 and decrease M-B to 60 on the LS.' },
  { key: 'branch|after_ls_before_invoice|modify|inc_del', row: 18, bucket: 'after_ls_branch',
    emailType: 'branch', stage: 'after_ls_before_invoice', triggerEmailType: 'vehicle_details',
    expectedIntent: 'modify', expectedModification: 'inc_del',
    replyText: 'Increase M-A to 150 and remove M-C from the LS.' },
  { key: 'branch|after_ls_before_invoice|modify|decrease', row: 19, bucket: 'after_ls_branch',
    emailType: 'branch', stage: 'after_ls_before_invoice', triggerEmailType: 'vehicle_details',
    expectedIntent: 'modify', expectedModification: 'decrease',
    replyText: 'Please reduce M-A to 60 units on the LS.' },
  { key: 'branch|after_ls_before_invoice|modify|delete', row: 20, bucket: 'after_ls_branch',
    emailType: 'branch', stage: 'after_ls_before_invoice', triggerEmailType: 'vehicle_details',
    expectedIntent: 'modify', expectedModification: 'delete',
    replyText: 'Remove M-C from the LS entirely.' },
  { key: 'branch|after_ls_before_invoice|modify|dec_del', row: 21, bucket: 'after_ls_branch',
    emailType: 'branch', stage: 'after_ls_before_invoice', triggerEmailType: 'vehicle_details',
    expectedIntent: 'modify', expectedModification: 'dec_del',
    replyText: 'Reduce M-A to 60 and remove M-C from the LS.' },

  // ─── Plant + after_ls + modify (rows 25–30) ──────────────────────────
  { key: 'plant|after_ls_before_invoice|modify|increase', row: 25, bucket: 'after_ls_plant',
    emailType: 'plant', stage: 'after_ls_before_invoice', triggerEmailType: 'plant_ls',
    expectedIntent: 'modify', expectedModification: 'increase',
    replyText: 'Update: we can ship 150 units of M-A (more than ordered).' },
  { key: 'plant|after_ls_before_invoice|modify|inc_dec', row: 26, bucket: 'after_ls_plant',
    emailType: 'plant', stage: 'after_ls_before_invoice', triggerEmailType: 'plant_ls',
    expectedIntent: 'modify', expectedModification: 'inc_dec',
    replyText: 'We can ship 150 of M-A but only 60 of M-B.' },
  { key: 'plant|after_ls_before_invoice|modify|inc_del', row: 27, bucket: 'after_ls_plant',
    emailType: 'plant', stage: 'after_ls_before_invoice', triggerEmailType: 'plant_ls',
    expectedIntent: 'modify', expectedModification: 'inc_del',
    replyText: 'We can ship 150 of M-A; M-C is unavailable.' },
  { key: 'plant|after_ls_before_invoice|modify|decrease', row: 28, bucket: 'after_ls_plant',
    emailType: 'plant', stage: 'after_ls_before_invoice', triggerEmailType: 'plant_ls',
    expectedIntent: 'modify', expectedModification: 'decrease',
    replyText: 'We only have 60 of M-A available — short of ordered quantity.' },
  { key: 'plant|after_ls_before_invoice|modify|delete', row: 29, bucket: 'after_ls_plant',
    emailType: 'plant', stage: 'after_ls_before_invoice', triggerEmailType: 'plant_ls',
    expectedIntent: 'modify', expectedModification: 'delete',
    replyText: 'M-C is completely unavailable, cannot ship.' },
  { key: 'plant|after_ls_before_invoice|modify|dec_del', row: 30, bucket: 'after_ls_plant',
    emailType: 'plant', stage: 'after_ls_before_invoice', triggerEmailType: 'plant_ls',
    expectedIntent: 'modify', expectedModification: 'dec_del',
    replyText: 'Only 60 of M-A available; M-C is unavailable entirely.' },

  // ─── PHASE F: SO Modification framing (rows 32, 33, 34, 36) ──────────
  // Shares scenario keys with rows 11, 12, 13, 14 respectively. Validates
  // that the LLM picks the same scenario_key whether the email is framed
  // as "Product Clarification - Release with adjustment" or "SO Modification".

  { key: 'branch|before_ls|modify|increase', row: 32, bucket: 'branch_so_mod',
    emailType: 'branch', stage: 'before_ls', triggerEmailType: 'ls_dispatch',
    expectedIntent: 'modify', expectedModification: 'increase',
    replyText: 'Hi team, we need to update SO X — please increase the quantity of M-A from 100 to 150 units.' },

  { key: 'branch|before_ls|modify|inc_dec', row: 33, bucket: 'branch_so_mod',
    emailType: 'branch', stage: 'before_ls', triggerEmailType: 'ls_dispatch',
    expectedIntent: 'modify', expectedModification: 'inc_dec',
    replyText: 'We need to modify SO X. Increase M-A to 150 and decrease M-B to 60.' },

  { key: 'branch|before_ls|modify|inc_del', row: 34, bucket: 'branch_so_mod',
    emailType: 'branch', stage: 'before_ls', triggerEmailType: 'ls_dispatch',
    expectedIntent: 'modify', expectedModification: 'inc_del',
    replyText: 'Please modify SO X: increase M-A quantity to 150 and remove M-C line item entirely.' },

  { key: 'branch|before_ls|modify|delete', row: 36, bucket: 'branch_so_mod',
    emailType: 'branch', stage: 'before_ls', triggerEmailType: 'ls_dispatch',
    expectedIntent: 'modify', expectedModification: 'delete',
    replyText: 'Please remove M-C line item from SO X entirely.' },

  // Rows 35 and 37 — covered in Phase D (TC-05 and TC-09) but with minimal
  // imperative phrasing. Adding here with explicit SO-Modification framing
  // for strict parity with the other Phase F cases.

  { key: 'branch|before_ls|modify|decrease', row: 35, bucket: 'branch_so_mod',
    emailType: 'branch', stage: 'before_ls', triggerEmailType: 'ls_dispatch',
    expectedIntent: 'modify', expectedModification: 'decrease',
    replyText: 'Hi team, we need to modify SO X — please reduce the quantity of M-A from 100 to 60 units.' },

  { key: 'branch|before_ls|modify|dec_del', row: 37, bucket: 'branch_so_mod',
    emailType: 'branch', stage: 'before_ls', triggerEmailType: 'ls_dispatch',
    expectedIntent: 'modify', expectedModification: 'dec_del',
    replyText: 'We need to modify SO X. Decrease M-A to 60 and remove M-C line item entirely.' },

  // ─── PHASE E ADDITIONS: novel scenarios (expect 'unknown' + escalate) ─

  // Novel A: branch wants to change the delivery address — no scenario covers this.
  { key: 'unknown', row: 'novel-A', bucket: 'novel',
    emailType: 'branch', stage: 'before_ls', triggerEmailType: 'ls_dispatch',
    expectedIntent: 'modify',   // unused for novel cases
    replyText: 'Please change the delivery address to our Mumbai depot instead of the Morbi address on the SO. Same materials and quantities.',
    kind: 'novel' },

  // Novel B: branch wants to cancel the entire SO — no full-cancel scenario.
  { key: 'unknown', row: 'novel-B', bucket: 'novel',
    emailType: 'branch', stage: 'before_ls', triggerEmailType: 'ls_dispatch',
    expectedIntent: 'modify',   // unused for novel cases
    replyText: 'Please cancel this entire Sales Order. We no longer need it.',
    kind: 'novel' },

  // ─── PHASE E ADDITIONS: mid-flow re-entry ──────────────────────────────

  // Mid-flow abort_and_replace: branch first asks for an increase, scenario starts
  // and reaches 2nd_release email. Then branch sends a NEW reply asking for a
  // decrease instead. Expected: LLM picks abort_and_replace, scenario becomes
  // the decrease variant.
  { key: 'branch|before_ls|modify|increase', row: 'midflow-abort',
    bucket: 'midflow_branch', emailType: 'branch', stage: 'before_ls',
    triggerEmailType: 'ls_dispatch',
    expectedIntent: 'modify', expectedModification: 'increase',
    replyText: 'Please increase M-A to 150 units.',
    kind: 'midflow_abort',
    primarySteps: 2,     // advance past va02 + email_2nd_release (which pauses on awaiting_reply)
    secondReply: 'Actually, ignore the previous request. Reduce M-A to 60 units instead.',
    midflowReplaceKey: 'branch|before_ls|modify|decrease' },

  // Mid-flow escalate: same setup but second reply is ambiguous.
  { key: 'branch|before_ls|modify|increase', row: 'midflow-escalate',
    bucket: 'midflow_branch', emailType: 'branch', stage: 'before_ls',
    triggerEmailType: 'ls_dispatch',
    expectedIntent: 'modify', expectedModification: 'increase',
    replyText: 'Please increase M-A to 150 units.',
    kind: 'midflow_escalate',
    primarySteps: 2,
    secondReply: 'Hmm, can you remind me what we decided yesterday?' },

  // ─── PHASE G: stock_precheck (Zmatana replacement) ─────────────────────

  // TC-32 — stock sufficient: M-A free_stock=200 ≥ requested 150 → VA02 fires,
  // scenario completes. Demonstrates the precheck no-ops when stock is enough.
  { key: 'branch|before_ls|modify|increase', row: 'stock-32', bucket: 'stock_precheck',
    emailType: 'branch', stage: 'before_ls', triggerEmailType: 'ls_dispatch',
    expectedIntent: 'modify', expectedModification: 'increase',
    replyText: 'Please increase M-A to 150 units (instead of 100).',
    kind: 'stock_sufficient',
    inventory: [{ material: 'M-A', freeStock: 200 }, { material: 'M-B', freeStock: 200 }, { material: 'M-C', freeStock: 200 }] },

  // TC-33 — stock short on the increased material: M-A free_stock=80,
  // requested 150. Engine should send stock_short_inquiry email and abort.
  { key: 'branch|before_ls|modify|increase', row: 'stock-33', bucket: 'stock_precheck',
    emailType: 'branch', stage: 'before_ls', triggerEmailType: 'ls_dispatch',
    expectedIntent: 'modify', expectedModification: 'increase',
    replyText: 'Please increase M-A to 150 units (instead of 100).',
    kind: 'stock_short',
    inventory: [{ material: 'M-A', freeStock: 80 }] },

  // TC-34 — inc_dec where the INCREASED material is short. The decreased
  // line is irrelevant to the precheck.
  { key: 'branch|before_ls|modify|inc_dec', row: 'stock-34', bucket: 'stock_precheck',
    emailType: 'branch', stage: 'before_ls', triggerEmailType: 'ls_dispatch',
    expectedIntent: 'modify', expectedModification: 'inc_dec',
    replyText: 'Increase M-A to 150 and decrease M-B to 60.',
    kind: 'stock_short',
    inventory: [{ material: 'M-A', freeStock: 80 }, { material: 'M-B', freeStock: 0 }] },

  // TC-35 — inc_del where the INCREASED material is short. The deleted
  // line is irrelevant to the precheck.
  { key: 'branch|before_ls|modify|inc_del', row: 'stock-35', bucket: 'stock_precheck',
    emailType: 'branch', stage: 'before_ls', triggerEmailType: 'ls_dispatch',
    expectedIntent: 'modify', expectedModification: 'inc_del',
    replyText: 'Increase M-A to 150 and delete M-C.',
    kind: 'stock_short',
    inventory: [{ material: 'M-A', freeStock: 80 }] },
];

// ============================================================================
// Pad helper for report
// ============================================================================

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

// ============================================================================
// main — all imports + setup happens here (no top-level await)
// ============================================================================

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    origLog('ERROR: OPENAI_API_KEY not set');
    process.exit(2);
  }
  if ((process.env.SCENARIO_ENGINE_ENABLED ?? '').toLowerCase() !== 'true') {
    origLog('ERROR: SCENARIO_ENGINE_ENABLED must be "true"');
    process.exit(2);
  }
  if (!process.env.DATABASE_URL) {
    origLog('ERROR: DATABASE_URL not set (expected file:./test-scenarios.db)');
    process.exit(2);
  }
  if (!process.env.BRANCH_EMAIL) process.env.BRANCH_EMAIL = 'test-branch@example.com';
  if (!process.env.PLANT_EMAIL) process.env.PLANT_EMAIL = 'test-plant@example.com';
  if (!process.env.SAP_DEFAULT_PLANT) process.env.SAP_DEFAULT_PLANT = '7581';

  // --- Install Module.prototype.require hook BEFORE importing the engine ---
  // tsx generates read-only getters on module exports (esbuild interop), so we
  // can't mutate the namespace after the fact. Instead, intercept require() and
  // wrap the gmail/work-queue modules in a Proxy that swaps the stubbed
  // functions in transparently.
  const Module = require('node:module');
  const nextGmailIds = () => {
    gmailSeq += 1;
    return { messageId: `MOCK-MSG-${gmailSeq}`, threadId: `MOCK-THR-${gmailSeq}` };
  };
  const gmailStub = (name: string) =>
    async (...args: unknown[]) => {
      RECORDED.push({ kind: 'gmail', fn: name, args, ts: now() });
      if (name === 'getMessageRfc822Id') return `<rfc822-${gmailSeq}@mock>` as unknown as string | null;
      if (name === 'getMessageBody' || name === 'getMessageSubject') return '' as unknown as string;
      return nextGmailIds() as unknown as { messageId: string; threadId: string };
    };
  const GMAIL_STUBS: Record<string, any> = {
    sendPlainEmail: gmailStub('sendPlainEmail'),
    sendReplyEmail: gmailStub('sendReplyEmail'),
    sendHtmlEmail: gmailStub('sendHtmlEmail'),
    sendHtmlReplyEmail: gmailStub('sendHtmlReplyEmail'),
    sendEmail: gmailStub('sendEmail'),
    getMessageRfc822Id: gmailStub('getMessageRfc822Id'),
    getMessageBody: gmailStub('getMessageBody'),
    getMessageSubject: gmailStub('getMessageSubject'),
  };
  // We need a prisma reference inside the work-queue stub; resolve lazily
  // through a holder so this can be assigned after the engine imports prisma.
  const prismaHolder: { ref: any } = { ref: null };
  const wqEnqueueStub = async (args: any) => {
    RECORDED.push({ kind: 'workqueue', fn: 'enqueueWork', args: [args], ts: now() });
    return prismaHolder.ref.workQueue.create({
      data: {
        salesOrderId: args.salesOrderId ?? null,
        step: args.step,
        payload: JSON.stringify(args.payload),
        state: 'done',
        startedAt: new Date(),
        finishedAt: new Date(),
      },
    });
  };
  const wqPumpStub = async () => null;
  const origRequire = Module.prototype.require;
  Module.prototype.require = function (id: string) {
    const exp = origRequire.call(this, id);
    if (typeof id === 'string' && (id.endsWith('/gmail') || id.endsWith('\\gmail'))) {
      return new Proxy(exp, {
        get(target, key) {
          if (typeof key === 'string' && key in GMAIL_STUBS) return GMAIL_STUBS[key];
          return (target as any)[key];
        },
      });
    }
    if (typeof id === 'string' && (id.endsWith('/work-queue') || id.endsWith('\\work-queue'))) {
      return new Proxy(exp, {
        get(target, key) {
          if (key === 'enqueueWork') return wqEnqueueStub;
          if (key === 'pumpQueue') return wqPumpStub;
          return (target as any)[key];
        },
      });
    }
    return exp;
  };

  // Now load prisma (real) so the stubs above can reference it.
  const prismaImport = await import('../src/lib/prisma');
  prismaHolder.ref = prismaImport.prisma;

  // --- Console.log wrapper to capture step trail ---
  console.log = (...a: unknown[]) => {
    const line = a.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(' ');
    const m = /\[ENGINE\] .*firing step (\d+)\/\d+: (\w+)(?: \(([^)]+)\))?/.exec(line);
    if (m && CURRENT_KEY) {
      const trail = STEP_TRAILS.get(CURRENT_KEY) ?? [];
      trail.push({ kind: m[2], label: m[3] });
      STEP_TRAILS.set(CURRENT_KEY, trail);
    }
    origLog(...(a as any[]));
  };

  // --- NOW import the engine (mocks are in place) ---
  const {
    handleReplyV2,
    handleSecondReleaseReply,
    executeScenario,
    maybeAdvanceScenario,
  } = await import('../src/lib/scenario-engine');
  const { SCENARIOS, deriveStage } = await import('../src/lib/dispatch-scenarios');
  const { prisma } = prismaImport;

  type StepKind = keyof typeof STEP_TO_WORK_STEP_TYPE_HOLDER;
  const STEP_TO_WORK_STEP_TYPE_HOLDER = {
    va02: 'va02', zso_visibility: 'visibility', zload1: 'zload1',
    zload2: 'zload2', zloading_close: 'zloading_close', mb51: 'mb51',
  } as const;
  const STEP_TO_WORK_STEP: Record<string, string> = STEP_TO_WORK_STEP_TYPE_HOLDER as any;

  async function wipeAll() {
    await prisma.scenarioEvent.deleteMany({});
    await prisma.scenarioProgress.deleteMany({});
    await prisma.workQueue.deleteMany({});
    await prisma.email.deleteMany({});
    await prisma.loadingSlipItem.deleteMany({});
    await prisma.material.deleteMany({});
    await prisma.shipment.deleteMany({});
    await prisma.bundle.deleteMany({});
    await prisma.salesOrder.deleteMany({});
    await prisma.purchaseOrder.deleteMany({});
    await prisma.customer.deleteMany({});
    await prisma.currentSO.deleteMany({});
    await prisma.inventorySnapshot.deleteMany({});
  }

  async function seedInventorySnapshot(plant: string, rows: Array<{ material: string; freeStock: number }>) {
    for (const r of rows) {
      await prisma.inventorySnapshot.upsert({
        where: { material_plant: { material: r.material, plant } },
        create: { material: r.material, plant, freeStock: r.freeStock },
        update: { freeStock: r.freeStock },
      });
    }
  }

  async function seedScenario(spec: CaseSpec) {
    const cust = await prisma.customer.create({
      data: { id: `CUST-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, name: 'Test Customer', weightage: 45 },
    });
    const po = await prisma.purchaseOrder.create({
      data: {
        poNumber: `PO-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        customerName: 'Test Customer',
        customerId: cust.id,
        stage: 3,
      },
    });
    const so = await prisma.salesOrder.create({
      data: {
        soNumber: `SO-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        purchaseOrderId: po.id,
        status: spec.stage === 'after_ls_before_invoice' ? 'ls_created' : 'pending',
        requiresInput: false,
        visibilityState: 'received',
        originalThreadId: 'MOCK-THR-ANCHOR',
        originalMessageId: 'MOCK-MSG-ANCHOR',
      },
    });

    for (const m of MATS) {
      await prisma.material.create({
        data: {
          salesOrderId: so.id,
          material: m.code,
          batch: m.batch,
          orderQuantity: m.ordered,
          availableStock: m.available,
          orderWeightKg: m.weightKg,
          dispatchQuantity: m.ordered,
        },
      });
    }

    if (spec.stage === 'after_ls_before_invoice') {
      const bundle = await prisma.bundle.create({
        data: {
          purchaseOrderId: po.id, bundleNumber: 1, totalWeightKg: 3000, status: 'planned',
          vehicleNumber: 'GJ12-MOCK', driverMobile: '9876543210', containerNumber: 'CONT-1',
        },
      });
      await prisma.material.updateMany({
        where: { salesOrderId: so.id },
        data: { bundleId: bundle.id },
      });
      for (const m of MATS) {
        await prisma.loadingSlipItem.create({
          data: {
            salesOrderId: so.id,
            bundleId: bundle.id,
            lsNumber: `LS-${so.soNumber}-${m.code}`,
            material: m.code,
            orderQuantity: m.ordered,
            status: 'pending',
            fileUrl: `mock-r2/LS-${m.code}.pdf`,
          },
        });
      }
    }

    // recipientEmail reflects WHO we sent the original email to — for a
    // plant_ls trigger that's the plant, otherwise the branch. The thread
    // renderer surfaces this address as "from <X>" on the INBOUND reply,
    // so it must match the spec's emailType or the LLM gets confused about
    // who sent the reply.
    const recipientForTrigger = spec.emailType === 'plant'
      ? (process.env.PLANT_EMAIL ?? 'test-plant@example.com')
      : (process.env.BRANCH_EMAIL ?? 'test-branch@example.com');
    const trigger = await prisma.email.create({
      data: {
        salesOrderId: so.id,
        purchaseOrderId: po.id,
        gmailMessageId: `MOCK-MSG-TRIG-${so.id}`,
        gmailThreadId: `MOCK-THR-TRIG-${so.id}`,
        recipientEmail: recipientForTrigger,
        subject: 'Test trigger',
        status: 'sent',
        emailType: spec.triggerEmailType,
        sentBody: ORIGINAL_EMAIL(so.soNumber),
      },
    });

    return { cust, po, so, trigger };
  }

  // Phase E: salesOrderId is no longer unique on ScenarioProgress. Helper to
  // find the most-recent non-terminal "active" progress for an SO.
  async function getActiveProgress(soId: string) {
    return prisma.scenarioProgress.findFirst({
      where: {
        salesOrderId: soId,
        state: { notIn: ['completed', 'aborted', 'failed'] },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async function advanceForce(soId: string) {
    const p = await getActiveProgress(soId);
    if (!p) return;
    await prisma.scenarioProgress.update({
      where: { id: p.id },
      data: { currentStepIndex: p.currentStepIndex + 1, state: 'ready' },
    });
    await executeScenario({ salesOrderId: soId });
  }

  async function driveToCompletion(soId: string, key: string) {
    const SAFETY = 30;
    for (let tick = 0; tick < SAFETY; tick++) {
      const p = await getActiveProgress(soId);
      if (!p) return;
      if (['completed', 'aborted', 'failed'].includes(p.state)) return;

      const scenario = SCENARIOS[key];
      if (!scenario) return;
      const currentStep = scenario.steps[p.currentStepIndex];
      if (!currentStep) {
        await executeScenario({ salesOrderId: soId });
        continue;
      }

      switch (p.state) {
        case 'awaiting_callback': {
          const ws = STEP_TO_WORK_STEP[currentStep.kind];
          if (!ws) {
            await advanceForce(soId);
          } else {
            await maybeAdvanceScenario(soId, ws as any);
          }
          break;
        }
        case 'awaiting_reply': {
          if (currentStep.kind === 'email_2nd_release') {
            const em = await prisma.email.findFirst({
              where: { salesOrderId: soId, emailType: '2nd_release' },
              orderBy: { sentAt: 'desc' },
            });
            if (em) {
              await handleSecondReleaseReply(em.id, 'yes, please proceed');
            } else {
              await advanceForce(soId);
            }
          } else {
            await advanceForce(soId);
          }
          break;
        }
        case 'awaiting_plant_invoice':
          await maybeAdvanceScenario(soId, 'zload3b1');
          break;
        case 'awaiting_vt01n':
          await maybeAdvanceScenario(soId, 'vto1n');
          break;
        case 'ready':
          await executeScenario({ salesOrderId: soId });
          break;
        default:
          return;
      }
    }
    throw new Error(`SO ${soId} (${key}) did not terminate in ${SAFETY} ticks`);
  }

  type RunResult = {
    spec: CaseSpec;
    derivedStage: string;
    classifierOutput: any;
    expectedSteps: string[];
    actualSteps: string[];
    recorded: RecordedCall[];
    finalState: string;
    pass: boolean;
    failReasons: string[];
  };

  async function runOne(spec: CaseSpec): Promise<RunResult> {
    await wipeAll();
    CURRENT_KEY = spec.key + ':' + String(spec.row);
    STEP_TRAILS.set(CURRENT_KEY, []);
    RECORDED.length = 0;
    gmailSeq = 0;

    const { so, trigger } = await seedScenario(spec);
    // Default: every material has plenty of free stock so existing tests
    // (which exercise increase-shaped modifications) pass the precheck.
    // Stock-short tests override per-material below.
    const plant = process.env.SAP_DEFAULT_PLANT ?? '7581';
    await seedInventorySnapshot(plant, MATS.map((m) => ({ material: m.code, freeStock: 300 })));
    if (spec.inventory && spec.inventory.length > 0) {
      await seedInventorySnapshot(plant, spec.inventory);
    }
    const derivedStage = await deriveStage(so.id).catch(() => 'error');

    let classifierOutput: any = null;
    let finalState = 'no-progress-row';
    let actualSteps: string[] = [];
    let secondClassifierOutput: any = null;
    const failReasons: string[] = [];

    try {
      const result = await handleReplyV2({
        emailId: trigger.id,
        replyHtml: spec.replyText,
        originalEmailHtml: ORIGINAL_EMAIL(so.soNumber),
        sourceEmailType: spec.emailType,
      });

      const p0 = await prisma.scenarioProgress.findFirst({
        where: { salesOrderId: so.id },
        orderBy: { createdAt: 'desc' },
      });
      classifierOutput = p0?.classifierOutput ? JSON.parse(p0.classifierOutput) : null;

      // ─── Normal / midflow path: drive the first scenario forward ────
      if (result.matched && spec.kind !== 'novel') {
        if (spec.kind === 'midflow_abort' || spec.kind === 'midflow_escalate') {
          // Advance the primary scenario by `primarySteps` steps before injecting
          // the second reply. Each "step" here = one external trigger.
          const primarySteps = spec.primarySteps ?? 2;
          for (let i = 0; i < primarySteps; i++) {
            const p = await getActiveProgress(so.id);
            if (!p) break;
            const sc = SCENARIOS[p.scenarioKey];
            if (!sc) break;
            const cur = sc.steps[p.currentStepIndex];
            if (!cur) break;
            if (p.state === 'awaiting_callback') {
              const ws = STEP_TO_WORK_STEP[cur.kind];
              if (ws) await maybeAdvanceScenario(so.id, ws as any);
              else await advanceForce(so.id);
            } else if (p.state === 'awaiting_reply') {
              // For the email_2nd_release step we DON'T auto-respond — leave the
              // scenario waiting so the second reply arrives mid-flow.
              if (cur.kind === 'email_2nd_release') break;
              await advanceForce(so.id);
            } else if (p.state === 'ready') {
              await executeScenario({ salesOrderId: so.id });
            } else {
              break;
            }
          }
          // Now inject the second reply with a SECOND handleReplyV2 call.
          // We pretend it lands as a reply on the same trigger Email — clear
          // replyHtml first so engine re-records it from args.
          await prisma.email.update({
            where: { id: trigger.id },
            data: { replyHtml: null, repliedAt: null },
          });
          const r2 = await handleReplyV2({
            emailId: trigger.id,
            replyHtml: spec.secondReply ?? '',
            originalEmailHtml: ORIGINAL_EMAIL(so.soNumber),
            sourceEmailType: spec.emailType,
          });
          const p1 = await prisma.scenarioProgress.findFirst({
            where: { salesOrderId: so.id },
            orderBy: { createdAt: 'desc' },
          });
          secondClassifierOutput = p1?.classifierOutput ? JSON.parse(p1.classifierOutput) : null;
          // For abort_and_replace, drive the new scenario to completion too.
          if (spec.kind === 'midflow_abort' && r2.matched) {
            await driveToCompletion(so.id, spec.midflowReplaceKey ?? spec.key).catch((e) => {
              failReasons.push(`drive: ${e instanceof Error ? e.message : String(e)}`);
            });
          }
        } else {
          await driveToCompletion(so.id, spec.key).catch((e) => {
            failReasons.push(`drive: ${e instanceof Error ? e.message : String(e)}`);
          });
        }
      } else if (spec.kind !== 'novel') {
        failReasons.push('handleReplyV2 returned matched=false (no scenario found)');
      }

      const final = await prisma.scenarioProgress.findFirst({
        where: { salesOrderId: so.id },
        orderBy: { createdAt: 'desc' },
      });
      finalState = final?.state ?? 'no-progress-row';
      actualSteps = (STEP_TRAILS.get(CURRENT_KEY) ?? []).map((s) => s.kind);
    } catch (err) {
      failReasons.push(`runOne: ${err instanceof Error ? err.message : String(err)}`);
    }

    // ─── Pass criteria depend on spec.kind ─────────────────────────────
    const gotKey = classifierOutput?.scenario_key as string | undefined;
    const gotIntent = classifierOutput?.intent as string | undefined;
    const gotMod = classifierOutput?.modification as string | undefined;
    const gotAction2 = secondClassifierOutput?.action_on_active as string | undefined;
    const gotKey2 = secondClassifierOutput?.scenario_key as string | undefined;

    let pass = false;
    let expectedSteps: string[] = [];
    if (spec.kind === 'novel') {
      // Pass = first classifier returned 'unknown' AND finalState is 'aborted'
      const isUnknown = gotKey === 'unknown';
      const isAborted = finalState === 'aborted';
      pass = isUnknown && isAborted;
      if (!isUnknown) failReasons.push(`scenario_key: expected 'unknown', got ${gotKey}`);
      if (!isAborted) failReasons.push(`finalState: expected 'aborted', got ${finalState}`);
    } else if (spec.kind === 'midflow_abort') {
      // Pass = (1) first classifier picked the primary key, (2) second classifier
      // returned action_on_active='abort_and_replace' AND key=midflowReplaceKey,
      // (3) final state is 'completed' on the replacement scenario.
      const firstOk = gotKey === spec.key;
      const actionOk = gotAction2 === 'abort_and_replace';
      const replaceKeyOk = gotKey2 === spec.midflowReplaceKey;
      const completedOk = finalState === 'completed';
      pass = firstOk && actionOk && replaceKeyOk && completedOk;
      if (!firstOk) failReasons.push(`first scenario_key: expected ${spec.key}, got ${gotKey}`);
      if (!actionOk) failReasons.push(`action_on_active: expected abort_and_replace, got ${gotAction2}`);
      if (!replaceKeyOk) failReasons.push(`replacement key: expected ${spec.midflowReplaceKey}, got ${gotKey2}`);
      if (!completedOk) failReasons.push(`finalState: expected 'completed', got ${finalState}`);
      expectedSteps = (SCENARIOS[spec.midflowReplaceKey ?? '']?.steps ?? []).map((s) => s.kind);
    } else if (spec.kind === 'midflow_escalate') {
      // Pass = first classifier picked primary key; second returned action='escalate'; finalState is 'aborted'
      const firstOk = gotKey === spec.key;
      const actionOk = gotAction2 === 'escalate';
      const abortedOk = finalState === 'aborted';
      pass = firstOk && actionOk && abortedOk;
      if (!firstOk) failReasons.push(`first scenario_key: expected ${spec.key}, got ${gotKey}`);
      if (!actionOk) failReasons.push(`action_on_active: expected escalate, got ${gotAction2}`);
      if (!abortedOk) failReasons.push(`finalState: expected 'aborted', got ${finalState}`);
    } else if (spec.kind === 'stock_short') {
      // Pass = classifier picked the increase-shaped scenario AND engine
      // aborted at stock_precheck (no VA02 fired, stock_short_inquiry email exists).
      const keyOk = gotKey === spec.key;
      const abortedOk = finalState === 'aborted';
      const noVa02 = !actualSteps.includes('va02');
      // Check inquiry email exists
      let inquiryEmailExists = false;
      try {
        const em = await prisma.email.findFirst({
          where: { salesOrderId: so.id, emailType: 'stock_short_inquiry' },
        });
        inquiryEmailExists = !!em;
      } catch {}
      pass = keyOk && abortedOk && noVa02 && inquiryEmailExists;
      if (!keyOk) failReasons.push(`scenario_key: expected ${spec.key}, got ${gotKey}`);
      if (!abortedOk) failReasons.push(`finalState: expected 'aborted', got ${finalState}`);
      if (!noVa02) failReasons.push(`actualSteps unexpectedly contains va02: ${actualSteps.join(',')}`);
      if (!inquiryEmailExists) failReasons.push(`stock_short_inquiry email not created`);
      expectedSteps = ['stock_precheck'];
    } else if (spec.kind === 'stock_sufficient') {
      // Pass = same as a normal scenario (precheck advances, VA02 fires,
      // scenario completes). The precheck step still appears in actualSteps.
      expectedSteps = (SCENARIOS[spec.key]?.steps ?? []).map((s) => s.kind);
      const keyOk = gotKey === spec.key;
      const seqOk =
        expectedSteps.length === actualSteps.length &&
        expectedSteps.every((s, i) => s === actualSteps[i]);
      const terminalOk = finalState === 'completed';
      pass = keyOk && seqOk && terminalOk;
      if (!keyOk) failReasons.push(`scenario_key: expected ${spec.key}, got ${gotKey}`);
      if (!seqOk) failReasons.push(`step sequence mismatch (expected ${expectedSteps.length}, got ${actualSteps.length})`);
      if (!terminalOk) failReasons.push(`final state ${finalState} (expected completed)`);
    } else {
      // Standard scenario.
      expectedSteps = (SCENARIOS[spec.key]?.steps ?? []).map((s) => s.kind);
      const keyOk = gotKey === spec.key;
      const intentOk = !gotKey && gotIntent === spec.expectedIntent;
      const modOk = !gotKey && (!spec.expectedModification || gotMod === spec.expectedModification);
      const classifierOk = keyOk || (intentOk && modOk);
      const seqOk =
        expectedSteps.length === actualSteps.length &&
        expectedSteps.every((s, i) => s === actualSteps[i]);
      const terminalOk = finalState === 'completed';

      pass = classifierOk && seqOk && terminalOk;
      if (!classifierOk) {
        if (gotKey !== undefined) failReasons.push(`scenario_key: expected ${spec.key}, got ${gotKey}`);
        else {
          failReasons.push(`intent: expected ${spec.expectedIntent}, got ${gotIntent}`);
          if (spec.expectedModification) {
            failReasons.push(`modification: expected ${spec.expectedModification}, got ${gotMod}`);
          }
        }
      }
      if (!seqOk) failReasons.push(`step sequence mismatch`);
      if (!terminalOk) failReasons.push(`final state ${finalState} (expected completed)`);
    }

    return {
      spec,
      derivedStage,
      classifierOutput: secondClassifierOutput
        ? { first: classifierOutput, second: secondClassifierOutput }
        : classifierOutput,
      expectedSteps,
      actualSteps,
      recorded: [...RECORDED],
      finalState,
      pass,
      failReasons,
    };
  }

  function renderReport(results: RunResult[]): string {
    const out: string[] = [];
    out.push('='.repeat(82));
    out.push('SCENARIO ENGINE END-TO-END HARNESS — REPORT');
    out.push(`Generated: ${new Date().toISOString()}`);
    out.push('='.repeat(82));

    for (const r of results) {
      out.push('');
      out.push(`──── ${r.spec.key} (row ${r.spec.row}) ────`);
      out.push(`Bucket:        ${r.spec.bucket}`);
      out.push(`Expected stage: ${r.spec.stage}    Derived: ${r.derivedStage}`);
      out.push(`Email source:  ${r.spec.emailType}    Trigger emailType: ${r.spec.triggerEmailType}`);
      out.push('');
      out.push(`Reply text:`);
      out.push(`  "${r.spec.replyText}"`);
      out.push('');
      const renderClassifierBlock = (label: string, c: any) => {
        if (!c) {
          out.push(`  ${label}: (no output)`);
          return;
        }
        out.push(`  ${label}:`);
        if (c.scenario_key !== undefined) {
          out.push(`    scenario_key = ${c.scenario_key}`);
          if (c.action_on_active) out.push(`    action_on_active = ${c.action_on_active}`);
          if (c.escalate_reason) out.push(`    escalate_reason = "${c.escalate_reason}"`);
        } else {
          out.push(`    intent       = ${c.intent}`);
          out.push(`    modification = ${c.modification ?? '-'}`);
        }
        const mats = (c.materials ?? []) as any[];
        out.push(`    materials    = ${mats.length} item(s)`);
        for (const m of mats) {
          out.push(`       • ${m.material_code} batch=${m.batch || '-'} op=${m.operation ?? '-'} qty=${m.quantity ?? '-'}`);
        }
        if (c.reasoning) out.push(`    reasoning    = "${c.reasoning}"`);
      };
      out.push(`Classifier output:`);
      if (r.classifierOutput) {
        if (r.classifierOutput.first || r.classifierOutput.second) {
          // mid-flow shape: two classifier calls
          renderClassifierBlock('FIRST call (initial reply)', r.classifierOutput.first);
          if (r.spec.secondReply) {
            out.push('');
            out.push(`  Second reply text:`);
            out.push(`    "${r.spec.secondReply}"`);
          }
          renderClassifierBlock('SECOND call (mid-flow reply)', r.classifierOutput.second);
        } else {
          renderClassifierBlock('output', r.classifierOutput);
        }
      } else {
        out.push(`  (no ScenarioProgress row created)`);
      }
      out.push('');
      out.push(`Expected steps (${r.expectedSteps.length}):`);
      r.expectedSteps.forEach((s, i) => out.push(`  ${pad(String(i + 1), 3)} ${s}`));
      out.push('');
      out.push(`Actual steps   (${r.actualSteps.length}):`);
      r.actualSteps.forEach((s, i) => {
        const exp = r.expectedSteps[i];
        const mark = exp === s ? '✓' : exp === undefined ? '?' : '✗';
        out.push(`  ${pad(String(i + 1), 3)} ${mark} ${s}${exp && exp !== s ? `  (expected ${exp})` : ''}`);
      });
      out.push('');

      const sapCalls = r.recorded.filter((c) => c.kind === 'workqueue');
      if (sapCalls.length > 0) {
        out.push(`Mocked SAP calls (${sapCalls.length}):`);
        for (const c of sapCalls) {
          const a = c.args[0] as any;
          const tx = a.payload?.transaction_code ?? '?';
          const soOrLs = a.payload?.so_number ?? a.payload?.meta?.so_number ?? a.payload?.meta?.ls_number ?? '?';
          out.push(`  • step=${a.step}  tx=${tx}  so/ls=${soOrLs}`);
        }
      } else {
        out.push(`Mocked SAP calls: (none)`);
      }

      const emails = r.recorded.filter(
        (c) => c.kind === 'gmail' && c.fn !== 'getMessageRfc822Id' && c.fn !== 'getMessageBody' && c.fn !== 'getMessageSubject'
      );
      if (emails.length > 0) {
        out.push(`Mocked emails sent (${emails.length}):`);
        for (const c of emails) {
          const args = c.args as unknown[];
          const to = String(args[0] ?? '');
          const subject = String(args[1] ?? '');
          const body = String(args[2] ?? '');
          const snip = body.replace(/\s+/g, ' ').slice(0, 100);
          out.push(`  • ${c.fn}  to=${to}  subject="${subject}"`);
          if (snip) out.push(`     body[0..100]="${snip}"`);
        }
      } else {
        out.push(`Mocked emails sent: (none)`);
      }

      out.push('');
      out.push(`Final state:  ${r.finalState}`);
      out.push(`Result:       ${r.pass ? 'PASS ✓' : 'FAIL ✗'}`);
      if (!r.pass) for (const reason of r.failReasons) out.push(`  - ${reason}`);
    }

    out.push('');
    out.push('='.repeat(82));
    const passed = results.filter((r) => r.pass).length;
    out.push(`AGGREGATE: ${passed}/${results.length} scenarios passed`);
    out.push('='.repeat(82));
    for (const r of results) {
      out.push(`  ${r.pass ? 'PASS' : 'FAIL'}  row ${pad(String(r.spec.row), 2)}  ${r.spec.key}`);
    }
    return out.join('\n');
  }

  const results: RunResult[] = [];
  for (const c of CASES) {
    origLog(`\n>>> Running ${c.key} (row ${c.row})…`);
    const r = await runOne(c);
    results.push(r);
    origLog(`<<< ${c.key}: ${r.pass ? 'PASS' : 'FAIL'}`);
  }

  origLog('\n' + renderReport(results));

  await prisma.$disconnect();

  const allPass = results.every((r) => r.pass);
  return allPass ? 0 : 1;
}

function cleanupFiles() {
  for (const base of ['./test-scenarios.db', './prisma/test-scenarios.db']) {
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      try { fs.unlinkSync(`${base}${suffix}`); } catch {}
    }
  }
}

main()
  .then((code) => {
    cleanupFiles();
    process.exit(code);
  })
  .catch((e) => {
    origLog('FATAL:', e);
    cleanupFiles();
    process.exit(1);
  });
