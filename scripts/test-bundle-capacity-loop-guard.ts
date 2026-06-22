/**
 * Regression test: the bundle_capacity_assessment loop guard must be scoped to
 * ONE branch reply (triggerEmailId), not all-time.
 *
 *   npx tsx scripts/test-bundle-capacity-loop-guard.ts   (or: npm test)
 *
 * The guard exists to stop the LLM planner re-emitting the assessment over and
 * over WITHIN one reply (ignoring the verdicts). It must NOT fire when the
 * branch legitimately asks for changes across SEPARATE replies (increase A,
 * then later increase B) — each reply runs its own assessment and arrives on
 * its own trigger email.
 *
 * Case A — real loop: 3 prior assessment completions under the SAME trigger
 *          email → the guard trips (scenario failed, "loop guard tripped").
 * Case B — distinct cycles: 3 prior completions under a DIFFERENT trigger email,
 *          0 under this reply's → the guard must NOT trip. (Pre-fix, the
 *          all-time count saw 3 and tripped wrongly.) The trigger email has no
 *          replyHtml so the post-guard path can't re-enter the LLM.
 *
 * Exits 0/1; cleans up fixtures.
 */

process.env.SCENARIO_ENGINE_ENABLED = 'true';
process.env.AUTO_GUI_HOST = '127.0.0.1';
process.env.AUTO_GUI_PORT = '59999';
process.env.PLANT_EMAIL = process.env.PLANT_EMAIL || 'plant@example.com';

import { prisma } from '../src/lib/prisma';
import { executeScenario } from '../src/lib/scenario-engine';

const RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';
let failed = false;
const pass = (m: string) => console.log(`${GREEN}✓ PASS${RESET} ${m}`);
const fail = (m: string) => { console.error(`${RED}✗ FAIL${RESET} ${m}`); failed = true; };

const ASSESS_STEP = [
  { kind: 'bundle_capacity_assessment', args: { items: [{ material: 'YTESTMAT0000001P', deltaKg: 100 }], overflowMode: 'new_so' }, rationale: 'test' },
];

let seq = 0;
async function makeTrigger(soId: string, withReply: boolean) {
  seq += 1;
  return prisma.email.create({
    data: {
      salesOrderId: soId,
      gmailMessageId: `BCLG-MSG-${Date.now()}-${seq}`,
      gmailThreadId: `BCLG-THR-${Date.now()}-${seq}`,
      recipientEmail: 'branch@example.com',
      subject: 'trigger', status: 'sent', emailType: 'dispatch_confirmation',
      sentBody: '<p>plan</p>',
      ...(withReply ? { replyHtml: '<p>please increase</p>' } : {}),
    },
  });
}

async function seedPriorAssessments(soId: string, triggerEmailId: string, n: number) {
  for (let i = 0; i < n; i++) {
    const p = await prisma.scenarioProgress.create({
      data: {
        salesOrderId: soId, scenarioKey: 'llm-planned', state: 'completed', classifierOutput: '{}',
        generatedSteps: JSON.stringify(ASSESS_STEP), stopAfterIndex: 0, currentStepIndex: 1, triggerEmailId,
      },
    });
    await prisma.scenarioEvent.create({
      data: {
        salesOrderId: soId, scenarioProgressId: p.id, type: 'step_completed',
        payload: JSON.stringify({ kind: 'bundle_capacity_assessment', verdicts: [] }),
      },
    });
  }
}

async function setup(tag: string) {
  const po = await prisma.purchaseOrder.create({
    data: { poNumber: `BCLG-${tag}-${Math.floor(Date.now() % 1e9)}`, customerName: 'BCLG', weightage: 12, dispatchRound: 3 },
  });
  const so = await prisma.salesOrder.create({
    data: { soNumber: `BCLG-${tag}-${Math.floor(Date.now() % 1e7)}`, purchaseOrderId: po.id, plant: '1101' },
  });
  return { poId: po.id, soId: so.id };
}

async function runCurrent(soId: string, triggerEmailId: string) {
  const cur = await prisma.scenarioProgress.create({
    data: {
      salesOrderId: soId, scenarioKey: 'llm-planned', state: 'ready', classifierOutput: '{}',
      generatedSteps: JSON.stringify(ASSESS_STEP), stopAfterIndex: 0, currentStepIndex: 0, triggerEmailId,
    },
  });
  try { await executeScenario({ salesOrderId: soId, log: () => {} }); } catch { /* helper throw is caught inside; ignore stray */ }
  return prisma.scenarioProgress.findUnique({ where: { id: cur.id }, select: { state: true, error: true } });
}

async function cleanup(soId: string, poId: string) {
  await prisma.scenarioEvent.deleteMany({ where: { salesOrderId: soId } });
  await prisma.scenarioProgress.deleteMany({ where: { salesOrderId: soId } });
  await prisma.email.deleteMany({ where: { salesOrderId: soId } });
  await prisma.salesOrder.deleteMany({ where: { id: soId } });
  await prisma.purchaseOrder.deleteMany({ where: { id: poId } });
}

async function main() {
  try {
    // Case A — 3 prior assessments under the SAME trigger email → must trip.
    {
      const { poId, soId } = await setup('A');
      try {
        const trig = await makeTrigger(soId, true);
        await seedPriorAssessments(soId, trig.id, 3);
        const after = await runCurrent(soId, trig.id);
        const tripped = after?.state === 'failed' && (after?.error ?? '').includes('loop guard tripped');
        if (tripped) pass('same-reply loop (3 assessments, one triggerEmailId) → guard trips');
        else fail(`same-reply loop did NOT trip: state="${after?.state}" error="${after?.error ?? ''}"`);
      } finally { await cleanup(soId, poId); }
    }

    // Case B — 3 prior assessments under a DIFFERENT trigger email; this reply
    // has 0 → must NOT trip. (Pre-fix the all-time count tripped here.)
    {
      const { poId, soId } = await setup('B');
      try {
        const otherTrig = await makeTrigger(soId, false);   // a previous branch reply's cycle
        await seedPriorAssessments(soId, otherTrig.id, 3);
        const thisTrig = await makeTrigger(soId, false);     // this reply (no replyHtml → no LLM re-entry)
        const after = await runCurrent(soId, thisTrig.id);
        const trippedWrongly = after?.state === 'failed' && (after?.error ?? '').includes('loop guard tripped');
        if (!trippedWrongly) pass('distinct branch replies do NOT accumulate → guard does not trip');
        else fail(`guard tripped across distinct cycles (the bug): error="${after?.error ?? ''}"`);
      } finally { await cleanup(soId, poId); }
    }
  } finally {
    await prisma.$disconnect();
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
