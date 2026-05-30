/**
 * Local test for the scenario-engine classifier outputs — focused on the new
 * 'modify' intent + the 6 modification labels (increase, decrease, delete,
 * inc_dec, inc_del, dec_del). No Gmail, no DB, no auto_gui2 — just the
 * classifier in isolation.
 *
 * Run:  npx tsx scripts/test-scenario-classifier.ts
 *
 * Requires OPENAI_API_KEY in .env (auto-loaded). Also verifies that the
 * SCENARIOS registry has a matching key for each expected output, exercising
 * the lookup table end-to-end.
 */
import 'dotenv/config';
import { classifyBranchReply } from '../src/lib/branch-reply-classifier';
import { resolveScenario, scenarioKey } from '../src/lib/dispatch-scenarios';

const ORIGINAL_EMAIL = `
Dear Sales Team,

Please find below the dispatch recommendation for Sales Order 3260614:

  - YE1ALIE370000PJP (Batch A-3): ordered 100 units, available 100
  - YOALDELT00000ZZP (Batch P):   ordered 100 units, available 100
  - YV7FIRM03AN00PJP (Batch CP-03): ordered 100 units, available 100

Please reply with your dispatch decision.
`.trim();

interface Case {
  name: string;
  reply: string;
  expectIntent: 'release_all' | 'release_part' | 'wait' | 'modify';
  expectModification?: 'increase' | 'decrease' | 'delete' | 'inc_dec' | 'inc_del' | 'dec_del';
  // Per-material operation expectations. Keys are material codes; value is
  // the expected `operation`. Materials not listed here are not asserted.
  expectOps?: Record<string, 'keep' | 'increase' | 'decrease' | 'delete'>;
  // Stage to use when probing the SCENARIOS registry lookup (engine derives
  // this from DB; the test just uses 'before_ls').
  stage?: 'before_ls' | 'after_ls_before_invoice' | 'after_invoice';
}

const CASES: Case[] = [
  // ---- legacy intents (regression coverage) ----
  {
    name: 'release_all — no modification',
    reply: 'release stock as available',
    expectIntent: 'release_all',
  },
  {
    name: 'release_part — accept subset',
    reply: 'release stock as available, skip YOALDELT00000ZZP',
    expectIntent: 'release_part',
  },
  {
    name: 'wait — hold',
    reply: 'please wait, materials not ready yet',
    expectIntent: 'wait',
  },

  // ---- new modify intents ----
  {
    name: 'modify increase — single line up',
    reply: 'please increase YE1ALIE370000PJP to 200 units',
    expectIntent: 'modify',
    expectModification: 'increase',
    expectOps: { YE1ALIE370000PJP: 'increase' },
  },
  {
    name: 'modify decrease — single line down',
    reply: 'reduce YV7FIRM03AN00PJP to 50 units',
    expectIntent: 'modify',
    expectModification: 'decrease',
    expectOps: { YV7FIRM03AN00PJP: 'decrease' },
  },
  {
    name: 'modify delete — remove a line',
    reply: 'remove YOALDELT00000ZZP entirely',
    expectIntent: 'modify',
    expectModification: 'delete',
    expectOps: { YOALDELT00000ZZP: 'delete' },
  },
  {
    name: 'modify inc_dec — one up, one down',
    reply: 'increase YE1ALIE370000PJP to 200 and reduce YV7FIRM03AN00PJP to 50',
    expectIntent: 'modify',
    expectModification: 'inc_dec',
    expectOps: { YE1ALIE370000PJP: 'increase', YV7FIRM03AN00PJP: 'decrease' },
  },
  {
    name: 'modify inc_del — one up, one removed',
    reply: 'increase YE1ALIE370000PJP to 200 and remove YOALDELT00000ZZP',
    expectIntent: 'modify',
    expectModification: 'inc_del',
    expectOps: { YE1ALIE370000PJP: 'increase', YOALDELT00000ZZP: 'delete' },
  },
  {
    name: 'modify dec_del — one down, one removed',
    reply: 'reduce YV7FIRM03AN00PJP to 50 and remove YOALDELT00000ZZP',
    expectIntent: 'modify',
    expectModification: 'dec_del',
    expectOps: { YV7FIRM03AN00PJP: 'decrease', YOALDELT00000ZZP: 'delete' },
  },
];

const RED = '\x1b[31m', GREEN = '\x1b[32m', YELLOW = '\x1b[33m', DIM = '\x1b[2m', RESET = '\x1b[0m';

async function runCase(c: Case): Promise<boolean> {
  process.stdout.write(`\n${YELLOW}[${c.name}]${RESET}\n`);
  process.stdout.write(`  ${DIM}reply=${JSON.stringify(c.reply)}${RESET}\n`);

  let result;
  try {
    result = await classifyBranchReply({
      originalEmailHtml: ORIGINAL_EMAIL,
      branchReplyHtml: c.reply,
      salesOrder: '3260614',
    });
  } catch (err) {
    process.stdout.write(`  ${RED}classifier error: ${err instanceof Error ? err.message : String(err)}${RESET}\n`);
    return false;
  }

  process.stdout.write(
    `  intent=${result.intent}${result.modification ? ` modification=${result.modification}` : ''}` +
      `  reasoning=${JSON.stringify(result.reasoning)}\n`
  );

  let ok = true;
  if (result.intent !== c.expectIntent) {
    process.stdout.write(`  ${RED}✗ expected intent=${c.expectIntent}${RESET}\n`);
    ok = false;
  }
  if (c.expectModification && result.modification !== c.expectModification) {
    process.stdout.write(`  ${RED}✗ expected modification=${c.expectModification}${RESET}\n`);
    ok = false;
  }

  // Per-material operation checks
  if (c.expectOps) {
    const opsByCode = new Map<string, string | undefined>();
    for (const m of result.materials) {
      opsByCode.set(m.material_code, m.operation);
    }
    for (const [code, expected] of Object.entries(c.expectOps)) {
      const got = opsByCode.get(code);
      const marker = got === expected ? GREEN + '✓' : RED + '✗';
      process.stdout.write(`  ${marker}${RESET} ${code}: op=${got ?? '—'} ${DIM}(expected ${expected})${RESET}\n`);
      if (got !== expected) ok = false;
    }
  }

  // Lookup-table coverage: assert SCENARIOS has a matching entry for the
  // (branch, stage, intent, modification) tuple. The engine will use exactly
  // this resolveScenario call at runtime.
  const stage = c.stage ?? 'before_ls';
  const scenario = resolveScenario('branch', stage, result.intent, result.modification);
  if (!scenario) {
    const key = scenarioKey('branch', stage, result.intent, result.modification);
    process.stdout.write(`  ${RED}✗ no scenario for key="${key}"${RESET}\n`);
    ok = false;
  } else {
    process.stdout.write(`  ${DIM}→ resolves to scenario "${scenario.key}" (${scenario.steps.length} step(s))${RESET}\n`);
  }

  return ok;
}

async function main() {
  let passed = 0;
  let total = 0;
  for (const c of CASES) {
    total++;
    if (await runCase(c)) passed++;
  }
  process.stdout.write(`\n${passed === total ? GREEN : RED}=== ${passed}/${total} cases passed ===${RESET}\n`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
