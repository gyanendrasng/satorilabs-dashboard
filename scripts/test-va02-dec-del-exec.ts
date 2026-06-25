/**
 * va02 executor must APPLY planner-emitted dec/del to the SO line in the no-LS
 * window. Pre-fix it only applied increases + flushed DB-pending dec/del, so a
 * planner decrease was mis-applied as an increase and a delete threw.
 *
 *   npx tsx scripts/test-va02-dec-del-exec.ts   (or: npm test)
 *
 *   A  decrease: Material 250 → planner va02 op:dec 150 → orderQuantity 150,
 *      orderWeightKg rescaled (kgPerUnit constant), dispatchQuantity 150.
 *   B  delete:   planner va02 op:del → Material row removed.
 *   C  flush:    a pending-dec on a material the planner did NOT name is still
 *      flushed on this va02 (regression guard for the existing flush path).
 *
 * Exits 0/1; cleans up fixtures.
 */

process.env.SCENARIO_ENGINE_ENABLED = 'true';
process.env.AUTO_GUI_HOST = '127.0.0.1';
process.env.AUTO_GUI_PORT = '59999'; // dead port — the fire-and-forget send is swallowed; reconciliation already ran
process.env.PLANT_EMAIL = process.env.PLANT_EMAIL || 'plant@example.com';

import { prisma } from '../src/lib/prisma';
import { executeScenario } from '../src/lib/scenario-engine';

const RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';
let failed = false;
const pass = (m: string) => console.log(`${GREEN}✓ PASS${RESET} ${m}`);
const fail = (m: string) => { console.error(`${RED}✗ FAIL${RESET} ${m}`); failed = true; };

let seq = 0;
async function seed(tag: string) {
  seq += 1;
  const uniq = `${Date.now()}${seq}`;
  const po = await prisma.purchaseOrder.create({
    data: { poNumber: `V2X-${tag}-${uniq}`, customerName: 'V2X', weightage: 12, dispatchRound: 1 },
  });
  const so = await prisma.salesOrder.create({
    data: { soNumber: `V2X-${tag}-${uniq}`.slice(0, 18), purchaseOrderId: po.id, plant: '1101' },
  });
  const trig = await prisma.email.create({
    data: {
      salesOrderId: so.id, gmailMessageId: `V2X-MSG-${uniq}`, gmailThreadId: `V2X-THR-${uniq}`,
      recipientEmail: 'branch@example.com', subject: 't', status: 'sent', emailType: 'ls_dispatch', replyHtml: '<p>x</p>',
    },
  });
  return { po, so, trig };
}

async function runVa02(soId: string, trigId: string, materials: unknown[]) {
  const step = [{ kind: 'va02', args: { materials }, rationale: 'test' }];
  await prisma.scenarioProgress.create({
    data: {
      salesOrderId: soId, scenarioKey: 'llm-planned', state: 'ready', classifierOutput: '{}',
      generatedSteps: JSON.stringify(step), stopAfterIndex: 0, currentStepIndex: 0, triggerEmailId: trigId,
    },
  });
  try { await executeScenario({ salesOrderId: soId, log: () => {} }); } catch { /* dead-port send swallowed; reconciliation already applied */ }
}

async function cleanup(soId: string, poId: string) {
  await prisma.scenarioEvent.deleteMany({ where: { salesOrderId: soId } });
  await prisma.scenarioProgress.deleteMany({ where: { salesOrderId: soId } });
  await prisma.workQueue.deleteMany({ where: { salesOrderId: soId } });
  await prisma.material.deleteMany({ where: { salesOrderId: soId } });
  await prisma.email.deleteMany({ where: { salesOrderId: soId } });
  await prisma.salesOrder.deleteMany({ where: { id: soId } });
  await prisma.purchaseOrder.deleteMany({ where: { id: poId } });
}

async function main() {
  try {
    // A — decrease 250 → 150 (kgPerUnit must stay 25.2; 6300/250).
    {
      const { po, so, trig } = await seed('dec');
      await prisma.material.create({
        data: { salesOrderId: so.id, material: 'MDEC', batch: 'B1', orderQuantity: 250, dispatchQuantity: 250, orderWeightKg: 6300 },
      });
      await runVa02(so.id, trig.id, [{ code: 'MDEC', op: 'dec', qty: 150 }]);
      const m = await prisma.material.findFirst({ where: { salesOrderId: so.id, material: 'MDEC' } });
      const kgpu = m?.orderWeightKg ? Number(m.orderWeightKg) / (m.orderQuantity ?? 1) : 0;
      if (m && m.orderQuantity === 150 && m.dispatchQuantity === 150 && Math.abs(kgpu - 25.2) < 1e-3)
        pass('decrease 250→150 → orderQty 150, dispatch 150, kgPerUnit 25.2 (weight rescaled)');
      else fail(`decrease → oq=${m?.orderQuantity} dq=${m?.dispatchQuantity} weight=${m?.orderWeightKg} kgpu=${kgpu}`);
      await cleanup(so.id, po.id);
    }

    // B — delete removes the SO line.
    {
      const { po, so, trig } = await seed('del');
      await prisma.material.create({
        data: { salesOrderId: so.id, material: 'MDEL', batch: 'B1', orderQuantity: 100, dispatchQuantity: 100, orderWeightKg: 1000 },
      });
      await runVa02(so.id, trig.id, [{ code: 'MDEL', op: 'del' }]);
      const m = await prisma.material.findFirst({ where: { salesOrderId: so.id, material: 'MDEL' } });
      if (!m) pass('delete → Material row removed');
      else fail(`delete → row still present: oq=${m.orderQuantity}`);
      await cleanup(so.id, po.id);
    }

    // C — pending-dec flush on a material the planner did NOT name still works.
    {
      const { po, so, trig } = await seed('flush');
      await prisma.material.create({
        data: { salesOrderId: so.id, material: 'MINC', batch: 'B1', orderQuantity: 200, dispatchQuantity: 200, orderWeightKg: 2000 },
      });
      await prisma.material.create({
        data: { salesOrderId: so.id, material: 'MPEND', batch: 'B1', orderQuantity: 80, dispatchQuantity: 80, orderWeightKg: 800, pendingSoOp: 'dec', pendingSoQty: 60 },
      });
      await runVa02(so.id, trig.id, [{ code: 'MINC', op: 'inc', qty: 220 }]);
      const inc = await prisma.material.findFirst({ where: { salesOrderId: so.id, material: 'MINC' } });
      const pend = await prisma.material.findFirst({ where: { salesOrderId: so.id, material: 'MPEND' } });
      const incOk = inc?.orderQuantity === 220;
      const pendOk = pend?.orderQuantity === 60 && pend?.pendingSoOp === null && pend?.pendingSoQty === null;
      if (incOk && pendOk) pass('increase applied AND unnamed pending-dec flushed to 60, flags cleared');
      else fail(`flush → MINC oq=${inc?.orderQuantity}; MPEND oq=${pend?.orderQuantity} op=${pend?.pendingSoOp} qty=${pend?.pendingSoQty}`);
      await cleanup(so.id, po.id);
    }
  } finally {
    await prisma.$disconnect();
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
