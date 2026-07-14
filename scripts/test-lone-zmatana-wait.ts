/**
 * Regression test: when a `lone_zmatana` SAP transaction is already RUNNING (its
 * work row is queued/firing), the engine WAITS for the response and does NOT
 * re-invoke the planner; when it's already DONE, the engine STOPS (no re-run, no
 * re-plan loop). Covers the lone_zmatana handler in src/lib/scenario-engine.ts.
 *
 *   DATABASE_URL="file:/tmp/x.db" npx prisma db push --skip-generate \
 *     && DATABASE_URL="file:/tmp/x.db" npx tsx scripts/test-lone-zmatana-wait.ts
 *
 * Bug: the handler used to inline-re-plan whenever lone_zmatana deduped — a tight
 * loop that re-generated the same step. Fix: running → markAwaitingCallback (wait);
 * done → advance_now (stop). Either way the planner is NOT re-invoked here.
 *
 * Exits 0/1; cleans up fixtures.
 */

process.env.SCENARIO_ENGINE_ENABLED = 'true';
process.env.AUTO_GUI_HOST = '127.0.0.1';
process.env.AUTO_GUI_PORT = '59999';

import { prisma } from '../src/lib/prisma';
import { executeScenario } from '../src/lib/scenario-engine';

const RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';
let failed = false;
const pass = (m: string) => console.log(`${GREEN}✓ PASS${RESET} ${m}`);
const fail = (m: string) => { console.error(`${RED}✗ FAIL${RESET} ${m}`); failed = true; };

const MAT = 'YO00000530000SOP';
const ROUND = 3;

// Set up an SO whose only active scenario is a one-step [lone_zmatana] plan, plus
// an existing lone_zmatana work row in `state` that matches the dedup key the
// handler will compute. Returns the progress id.
async function seed(state: 'firing' | 'done') {
  const soNumber = `${Math.floor(Date.now() % 1e7)}${state === 'firing' ? 1 : 2}`;
  const po = await prisma.purchaseOrder.create({
    data: { poNumber: `LZW-${state}-${Math.floor(Date.now() % 1e9)}`, customerName: 'LZ Wait Co', weightage: 12, dispatchRound: ROUND },
  });
  const so = await prisma.salesOrder.create({ data: { soNumber, purchaseOrderId: po.id, plant: '1101' } });
  const dedupKey = `so:${soNumber}|round:${ROUND}|mat:${MAT}/10`;
  await prisma.workQueue.create({
    data: {
      salesOrderId: so.id, step: 'lone_zmatana', state,
      payload: JSON.stringify({ transaction_code: 'LONE-ZMATANA', so_number: soNumber, meta: { dedup_key: dedupKey } }),
    },
  });
  const progress = await prisma.scenarioProgress.create({
    data: {
      salesOrderId: so.id, scenarioKey: 'llm-planned', state: 'ready', classifierOutput: '{}',
      generatedSteps: JSON.stringify([{ kind: 'lone_zmatana', args: { materials: [{ code: MAT, delta: 10 }] }, rationale: 'test' }]),
      stopAfterIndex: 0, currentStepIndex: 0,
    },
  });
  return { poId: po.id, soId: so.id, progressId: progress.id };
}

async function run(state: 'firing' | 'done', expectState: string, label: string) {
  const { poId, soId, progressId } = await seed(state);
  try {
    const before = await prisma.scenarioProgress.count({ where: { salesOrderId: soId } });
    let threw = false;
    try {
      await executeScenario({ salesOrderId: soId, log: () => {} });
    } catch {
      threw = true; // pre-fix: the inline re-plan calls the LLM planner and errors here
    }
    const after = await prisma.scenarioProgress.findUnique({ where: { id: progressId }, select: { state: true } });
    const count = await prisma.scenarioProgress.count({ where: { salesOrderId: soId } });

    if (!threw && after?.state === expectState) pass(`${label}: scenario state = "${expectState}"`);
    else fail(`${label}: state="${after?.state}" threw=${threw} (expected clean "${expectState}")`);

    if (count === before) pass(`${label}: planner NOT re-invoked (no new ScenarioProgress)`);
    else fail(`${label}: ${count - before} extra ScenarioProgress — planner was re-invoked (the loop)`);
  } finally {
    await prisma.scenarioEvent.deleteMany({ where: { salesOrderId: soId } });
    await prisma.scenarioProgress.deleteMany({ where: { salesOrderId: soId } });
    await prisma.workQueue.deleteMany({ where: { salesOrderId: soId } });
    await prisma.salesOrder.deleteMany({ where: { id: soId } });
    await prisma.purchaseOrder.deleteMany({ where: { id: poId } });
  }
}

async function main() {
  try {
    // RUNNING → wait for the response (awaiting_callback), don't re-plan.
    await run('firing', 'awaiting_callback', 'running → WAIT');
    // DONE → stop (segment completes), don't re-run or re-plan.
    await run('done', 'completed', 'done → STOP');
  } finally {
    await prisma.$disconnect();
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
