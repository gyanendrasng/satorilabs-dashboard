/**
 * Regression test for LONE-ZMATANA dedup collision + the resulting engine
 * deadlock (src/lib/auto-gui-trigger.ts triggerLoneZmatana + the lone_zmatana
 * step handler in src/lib/scenario-engine.ts).
 *
 *   DATABASE_URL="file:/tmp/x.db" npx prisma db push --skip-generate \
 *     && DATABASE_URL="file:/tmp/x.db" npx tsx scripts/test-lone-zmatana-dedup.ts
 *
 * Bug: the LONE-ZMATANA dedup key was (SO, materials) with no round. A surgical
 * increase re-emits lone_zmatana for the same (SO, material) each cycle, so it
 * collided with a PRIOR cycle's `done` row and was silently skipped — and the
 * step handler paused awaiting a callback that never came (deadlock; the prod
 * symptom was "lone_zmatana fired, response returned, nothing happened after").
 *
 * Fix: cycle-aware dedup key (round + per-material delta); triggerLoneZmatana
 * returns whether it enqueued; on a dedup the handler completes the segment and
 * re-plans inline instead of pausing.
 *
 * Exits 0/1; cleans up its fixtures.
 */

process.env.SCENARIO_ENGINE_ENABLED = 'true';
process.env.AUTO_GUI_HOST = '127.0.0.1';
process.env.AUTO_GUI_PORT = '59999'; // dead port — pump's fire-and-forget fetch fails silently

import { prisma } from '../src/lib/prisma';
import { triggerLoneZmatana } from '../src/lib/auto-gui-trigger';
import { executeScenario as engineExecute } from '../src/lib/scenario-engine';

const RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';
let failed = false;
const pass = (m: string) => console.log(`${GREEN}✓ PASS${RESET} ${m}`);
const fail = (m: string) => { console.error(`${RED}✗ FAIL${RESET} ${m}`); failed = true; };

const MAT = 'YO00000530000SOP';

const loneRows = (soId: string) =>
  prisma.workQueue.findMany({ where: { salesOrderId: soId, step: 'lone_zmatana' }, select: { payload: true, state: true } });

async function main() {
  // ── Part 1: triggerLoneZmatana — cross-cycle fires, same-cycle retry dedupes ──
  const po1 = await prisma.purchaseOrder.create({
    data: { poNumber: `LZ1-${Math.floor(Date.now() % 1e9)}`, customerName: 'LZ Co', weightage: 12, dispatchRound: 3 },
  });
  const so1 = await prisma.salesOrder.create({
    data: { soNumber: `${Math.floor(Date.now() % 1e7)}`, purchaseOrderId: po1.id, plant: '1101' },
  });
  await prisma.material.create({
    data: { salesOrderId: so1.id, material: MAT, batch: 'P', orderQuantity: 210, orderWeightKg: 1995, dispatchQuantity: 210 },
  });
  // A PRIOR cycle's done row, in the OLD payload shape (materials_key, NO
  // dedup_key) — exactly what predates this fix in prod. The new query keys on
  // dedup_key, so this must NOT block the new fetch.
  await prisma.workQueue.create({
    data: {
      salesOrderId: so1.id, step: 'lone_zmatana', state: 'done',
      payload: JSON.stringify({
        transaction_code: 'LONE-ZMATANA', so_number: so1.soNumber,
        meta: { so_number: so1.soNumber, materials: [MAT], materials_key: MAT },
      }),
    },
  });

  try {
    const fired1 = await triggerLoneZmatana(so1.soNumber, [{ material: MAT, delta: 10 }]);
    const rows = await loneRows(so1.id);
    const freshEnqueued = rows.some((r) => r.state !== 'done' && r.payload.includes('"dedup_key":"so:') && r.payload.includes('round:3'));

    if (fired1 === true) pass('fires despite a prior done row from another cycle (no cross-cycle collision)');
    else fail('triggerLoneZmatana returned false — collided with the prior-cycle done row (the deadlock cause)');

    if (freshEnqueued) pass('a fresh round-3 LONE-ZMATANA work row was enqueued');
    else fail(`no fresh round-3 work row enqueued; rows=${JSON.stringify(rows)}`);

    const fired2 = await triggerLoneZmatana(so1.soNumber, [{ material: MAT, delta: 10 }]);
    if (fired2 === false) pass('identical retry (same round + delta) is deduped → false');
    else fail('retry fired again — dedup not protecting against a true re-fire');
  } finally {
    await prisma.workQueue.deleteMany({ where: { salesOrderId: so1.id } });
    await prisma.material.deleteMany({ where: { salesOrderId: so1.id } });
    await prisma.salesOrder.deleteMany({ where: { id: so1.id } });
    await prisma.purchaseOrder.deleteMany({ where: { id: po1.id } });
  }

  // ── Part 2: engine handler does NOT deadlock when lone_zmatana dedupes ──
  const po2 = await prisma.purchaseOrder.create({
    data: { poNumber: `LZ2-${Math.floor(Date.now() % 1e9)}`, customerName: 'LZ Co', weightage: 12, dispatchRound: 1 },
  });
  const so2 = await prisma.salesOrder.create({
    data: { soNumber: `${Math.floor((Date.now() + 1) % 1e7)}`, purchaseOrderId: po2.id, plant: '1101' },
  });
  await prisma.material.create({
    data: { salesOrderId: so2.id, material: MAT, batch: 'P', orderQuantity: 210, orderWeightKg: 1995, dispatchQuantity: 210 },
  });
  // Seed a done row whose dedup_key EXACTLY matches what the handler's
  // triggerLoneZmatana call will compute (round 1, MAT/10) — forcing the dedup.
  const dedupKey = `so:${so2.soNumber}|round:1|mat:${MAT}/10`;
  await prisma.workQueue.create({
    data: {
      salesOrderId: so2.id, step: 'lone_zmatana', state: 'done',
      payload: JSON.stringify({
        transaction_code: 'LONE-ZMATANA', so_number: so2.soNumber,
        meta: { so_number: so2.soNumber, materials: [MAT], materials_key: MAT, dedup_key: dedupKey },
      }),
    },
  });
  // A one-step lone_zmatana plan with NO trigger email (so the inline re-plan
  // no-ops cleanly without invoking the LLM planner).
  const progress = await prisma.scenarioProgress.create({
    data: {
      salesOrderId: so2.id, scenarioKey: 'llm-planned', state: 'ready', classifierOutput: '{}',
      generatedSteps: JSON.stringify([{ kind: 'lone_zmatana', args: { materials: [{ code: MAT, delta: 10 }] }, rationale: 'test' }]),
      stopAfterIndex: 0, currentStepIndex: 0,
    },
  });

  try {
    await engineExecute({ salesOrderId: so2.id, log: () => {} });
    const after = await prisma.scenarioProgress.findUnique({ where: { id: progress.id }, select: { state: true } });

    if (after?.state === 'completed') pass('deduped lone_zmatana completes the segment (no awaiting_callback deadlock)');
    else fail(`scenario state = "${after?.state}", expected "completed" (pre-fix deadlocks at "awaiting_callback")`);
  } finally {
    await prisma.scenarioEvent.deleteMany({ where: { salesOrderId: so2.id } });
    await prisma.scenarioProgress.deleteMany({ where: { salesOrderId: so2.id } });
    await prisma.workQueue.deleteMany({ where: { salesOrderId: so2.id } });
    await prisma.material.deleteMany({ where: { salesOrderId: so2.id } });
    await prisma.salesOrder.deleteMany({ where: { id: so2.id } });
    await prisma.purchaseOrder.deleteMany({ where: { id: po2.id } });
    await prisma.$disconnect();
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
