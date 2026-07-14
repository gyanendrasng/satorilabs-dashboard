/**
 * The CURRENT SO STATE block must surface a "vehicle details received" signal for
 * the VEHICLE GATE (Rule V): yes once any Bundle on the PO has a vehicleNumber
 * (or plant_ls has been sent), no otherwise. Pre-fix the line was absent.
 *
 *   npx tsx scripts/test-so-state-vehicle-received.ts   (or: npm test)
 *
 * Renders via buildPlannerPrompt (the {{SO_STATE}} token is filled by
 * renderSoState) and inspects the rendered line. Exits 0/1; cleans up.
 */

process.env.AUTO_GUI_HOST = '127.0.0.1';
process.env.AUTO_GUI_PORT = '59999';

import { prisma } from '../src/lib/prisma';
import { buildPlannerPrompt } from '../src/lib/llm-planner';

const RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';
let failed = false;
const pass = (m: string) => console.log(`${GREEN}✓ PASS${RESET} ${m}`);
const fail = (m: string) => { console.error(`${RED}✗ FAIL${RESET} ${m}`); failed = true; };

const vehicleLine = (prompt: string): string | null => {
  const m = /- vehicle details received: (yes|no)/.exec(prompt);
  return m ? m[1] : null;
};

let seq = 0;
async function seed(tag: string) {
  seq += 1;
  const uniq = `${Date.now()}${seq}`;
  const po = await prisma.purchaseOrder.create({
    data: { poNumber: `VDR-${tag}-${uniq}`, customerName: 'VDR', weightage: 12, dispatchRound: 1 },
  });
  const so = await prisma.salesOrder.create({
    data: { soNumber: `VDR-${tag}-${uniq}`.slice(0, 18), purchaseOrderId: po.id, plant: '1101' },
  });
  const trig = await prisma.email.create({
    data: {
      salesOrderId: so.id, gmailMessageId: `VDR-MSG-${uniq}`, gmailThreadId: `VDR-THR-${uniq}`,
      recipientEmail: 'branch@example.com', subject: 't', status: 'sent', emailType: 'ls_dispatch',
    },
  });
  return { po, so, trig };
}

async function cleanup(soId: string, poId: string) {
  await prisma.bundle.deleteMany({ where: { purchaseOrderId: poId } });
  await prisma.email.deleteMany({ where: { salesOrderId: soId } });
  await prisma.salesOrder.deleteMany({ where: { id: soId } });
  await prisma.purchaseOrder.deleteMany({ where: { id: poId } });
}

async function main() {
  try {
    // A — no bundle vehicle, no plant_ls → "no".
    {
      const { po, so, trig } = await seed('none');
      const prompt = await buildPlannerPrompt({ salesOrderId: so.id, triggerEmailId: trig.id, sender: 'branch' });
      const line = vehicleLine(prompt);
      if (line === 'no') pass('no vehicle bundle, no plant_ls → "vehicle details received: no"');
      else fail(`expected "no", got ${JSON.stringify(line)}`);
      await cleanup(so.id, po.id);
    }

    // B — a bundle carrying a vehicleNumber → "yes".
    {
      const { po, so, trig } = await seed('veh');
      await prisma.bundle.create({
        data: {
          purchaseOrderId: po.id, bundleNumber: 1, totalWeightKg: 0, status: 'planned',
          vehicleNumber: 'MH12AB1234', driverMobile: '9999999999',
        },
      });
      const prompt = await buildPlannerPrompt({ salesOrderId: so.id, triggerEmailId: trig.id, sender: 'branch' });
      const line = vehicleLine(prompt);
      if (line === 'yes') pass('bundle with vehicleNumber → "vehicle details received: yes"');
      else fail(`expected "yes", got ${JSON.stringify(line)}`);
      await cleanup(so.id, po.id);
    }
  } finally {
    await prisma.$disconnect();
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
