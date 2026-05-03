/**
 * Local test for the branch-reply classifier — focused on per-material
 * quantity extraction (PR #5: Honor classifier-extracted per-material
 * quantity in branch reply).
 *
 * Run:  npx tsx scripts/test-branch-reply-classifier.ts
 *
 * Requires OPENAI_API_KEY in .env (auto-loaded below). No Gmail, no DB,
 * no auto_gui2 — just the classifier in isolation. After calling the
 * classifier we apply the same Math.min logic the planner uses so the
 * "shipped quantity" column reflects what would actually go out.
 */
import 'dotenv/config';
import { classifyBranchReply } from '../src/lib/branch-reply-classifier';

// Synthetic combined dispatch email — one PO, two SOs, three materials each.
// Mirrors the shape of a real ls_dispatch email closely enough for the
// classifier to extract material codes + quantities from it.
const ORIGINAL_EMAIL = `
Dear Sales Team,

Please find below the dispatch recommendation for Purchase Order
AUTO-TEST-001 covering 2 sales order(s):

Sales Order 3260614:
  - YE1ALIE370000PJP (Batch A-3): ordered 100 units, available 100, ~2.640 t
  - YOALDELT00000ZZP (Batch P):  ordered 100 units, available 100, ~1.110 t
  - YV7FIRM03AN00PJP (Batch CP-03): ordered 100 units, available 100, ~2.730 t

Sales Order 3260615:
  - YA4BASS02000043P (Batch 50): ordered 100 units, available 100, ~2.650 t
  - YT2LEBL000000D5P (Batch P):  ordered 100 units, available 100, ~1.330 t
  - YV7DIPE000000PJP (Batch CP-02): ordered 100 units, available 100, ~2.730 t

Please reply with your dispatch decision.
`.trim();

// Reduced shape of what's stored on Material rows — the planner reads
// orderQuantity/availableStock from DB; we hardcode them per case here.
type MatRow = { material: string; batch: string; orderQuantity: number; availableStock: number };
const SO_614_MATS: MatRow[] = [
  { material: 'YE1ALIE370000PJP', batch: 'A-3',   orderQuantity: 100, availableStock: 100 },
  { material: 'YOALDELT00000ZZP', batch: 'P',     orderQuantity: 100, availableStock: 100 },
  { material: 'YV7FIRM03AN00PJP', batch: 'CP-03', orderQuantity: 100, availableStock: 100 },
];
const SO_615_MATS: MatRow[] = [
  { material: 'YA4BASS02000043P', batch: '50',    orderQuantity: 100, availableStock: 100 },
  { material: 'YT2LEBL000000D5P', batch: 'P',     orderQuantity: 100, availableStock: 100 },
  { material: 'YV7DIPE000000PJP', batch: 'CP-02', orderQuantity: 100, availableStock: 100 },
];

const CASES: Array<{
  name: string;
  reply: string;
  targetSo: string;
  mats: MatRow[];
  expect: { intent?: string; perItem?: Record<string, number | 'EXCLUDED'> };
}> = [
  {
    name: 'plain release_all — every line ships full',
    reply: 'release stock as available',
    targetSo: '3260614',
    mats: SO_614_MATS,
    expect: { intent: 'release_all', perItem: {
      'YE1ALIE370000PJP': 100, 'YOALDELT00000ZZP': 100, 'YV7FIRM03AN00PJP': 100,
    } },
  },
  {
    name: 'partial qty — "send only 30 of YE1ALIE…"',
    reply: 'release stock as available, but send only 30 units of YE1ALIE370000PJP, full qty for everything else',
    targetSo: '3260614',
    mats: SO_614_MATS,
    expect: { intent: 'release_part', perItem: {
      'YE1ALIE370000PJP': 30, 'YOALDELT00000ZZP': 100, 'YV7FIRM03AN00PJP': 100,
    } },
  },
  {
    name: 'partial qty by name — "send 50 of FIRMIN"',
    reply: 'send 50 of FIRMIN, full qty for the rest',
    targetSo: '3260614',
    mats: SO_614_MATS,
    expect: { intent: 'release_part', perItem: {
      'YV7FIRM03AN00PJP': 50,
    } },
  },
  {
    name: 'inflate attempt — "send 200 of YE1ALIE… (ordered 100)" → must clamp to 100',
    reply: 'send 200 units of YE1ALIE370000PJP, full qty for the rest',
    targetSo: '3260614',
    mats: SO_614_MATS,
    expect: { intent: 'release_part', perItem: {
      'YE1ALIE370000PJP': 100,  // clamped at orderQuantity even if classifier returns 200
    } },
  },
  {
    name: 'exclude one item — "skip YOALDELT…"',
    reply: 'release everything except YOALDELT00000ZZP — skip that one',
    targetSo: '3260614',
    mats: SO_614_MATS,
    expect: { intent: 'release_part', perItem: {
      'YOALDELT00000ZZP': 'EXCLUDED', 'YE1ALIE370000PJP': 100, 'YV7FIRM03AN00PJP': 100,
    } },
  },
  {
    name: 'multi-SO email, target SO 3260615 — only 615 materials honored',
    reply: 'send only 25 of YA4BASS02000043P for SO 3260615, rest full',
    targetSo: '3260615',
    mats: SO_615_MATS,
    expect: { intent: 'release_part', perItem: {
      'YA4BASS02000043P': 25, 'YT2LEBL000000D5P': 100, 'YV7DIPE000000PJP': 100,
    } },
  },
  {
    name: 'wait — empty materials, no quantities',
    reply: 'please wait, materials not ready yet on our end',
    targetSo: '3260614',
    mats: SO_614_MATS,
    expect: { intent: 'wait', perItem: {} },
  },
];

const RED = '\x1b[31m', GREEN = '\x1b[32m', YELLOW = '\x1b[33m', DIM = '\x1b[2m', RESET = '\x1b[0m';

function plannerShipQty(orderQty: number, availStock: number, classifierQty?: number): number {
  // Mirrors the post-PR-#5 logic in classifyAndPlanForSo (auto-gui-trigger.ts).
  const branchRequested = typeof classifierQty === 'number' && classifierQty > 0
    ? Math.min(classifierQty, orderQty)
    : orderQty;
  return Math.min(branchRequested, Math.max(availStock, 0));
}

async function runCase(c: typeof CASES[number]): Promise<boolean> {
  process.stdout.write(`\n${YELLOW}[${c.name}]${RESET}\n`);
  process.stdout.write(`  ${DIM}reply=${JSON.stringify(c.reply)}${RESET}\n`);

  let result;
  try {
    result = await classifyBranchReply({
      originalEmailHtml: ORIGINAL_EMAIL,
      branchReplyHtml: c.reply,
      salesOrder: c.targetSo,
    });
  } catch (err) {
    process.stdout.write(`  ${RED}classifier error: ${err instanceof Error ? err.message : String(err)}${RESET}\n`);
    return false;
  }

  process.stdout.write(`  intent=${result.intent}  reasoning=${JSON.stringify(result.reasoning)}\n`);
  if (c.expect.intent && result.intent !== c.expect.intent) {
    process.stdout.write(`  ${RED}✗ expected intent=${c.expect.intent}${RESET}\n`);
  }

  // Build classifier-quantity lookup, then derive shipped quantity per row.
  const classifierByCode = new Map<string, number>();
  for (const r of result.materials ?? []) {
    if (r.material_code) classifierByCode.set(r.material_code, r.quantity ?? 0);
  }

  let allOk = c.expect.intent ? result.intent === c.expect.intent : true;
  process.stdout.write(`  ${DIM}per-item (ordered/classifierAsked → shipped):${RESET}\n`);
  for (const m of c.mats) {
    const classifierQty = classifierByCode.get(m.material);
    const inList = classifierByCode.has(m.material);
    const expected = c.expect.perItem?.[m.material];
    let shipped: number | 'EXCLUDED';
    if (c.expect.intent === 'wait' || result.intent === 'wait') {
      shipped = 'EXCLUDED';
    } else if (!inList && classifierByCode.size > 0) {
      shipped = 'EXCLUDED';
    } else {
      shipped = plannerShipQty(m.orderQuantity, m.availableStock, classifierQty);
    }

    const marker = expected === undefined
      ? ' '
      : shipped === expected ? GREEN + '✓' + RESET : RED + '✗' + RESET;
    if (expected !== undefined && shipped !== expected) allOk = false;

    process.stdout.write(
      `    ${marker} ${m.material} (Batch ${m.batch}): ordered=${m.orderQuantity}, classifier=${classifierQty ?? '—'}, shipped=${shipped}` +
      (expected !== undefined ? `  ${DIM}(expected ${expected})${RESET}` : '') +
      `\n`
    );
  }

  return allOk;
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
