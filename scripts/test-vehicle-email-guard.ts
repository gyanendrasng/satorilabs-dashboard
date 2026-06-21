/**
 * Regression test for the vehicle_details email staleness guard
 * (checkAndSendCombinedVehicleEmailForPo → sendCombinedVehicleDetailsEmailForPo
 * in src/lib/auto-gui-trigger.ts).
 *
 *   DATABASE_URL="file:/tmp/x.db" npx prisma db push --skip-generate \
 *     && DATABASE_URL="file:/tmp/x.db" npx tsx scripts/test-vehicle-email-guard.ts
 *
 * Bug: the guard treated an existing vehicle_details email as "still current"
 * unless a ZLOAD1 finished after it. A surgical same_bundle increase revises
 * the LS via ZLOAD2 (no ZLOAD1), so the guard wrongly SKIPPED → the branch was
 * never asked for vehicle details for the updated plan. Fix: the guard now
 * considers the latest done ZLOAD1 *or* ZLOAD2.
 *
 * We assert the guard DECISION via the returned logs ("skipping" vs "STALE …
 * Sending fresh email") — reaching an actual send needs full bundle/vehicle
 * fixtures; the decision is the behaviour the bug changed.
 *
 * Exits 0 on pass, 1 on fail. Cleans up its own fixtures.
 */

process.env.BRANCH_EMAIL = process.env.BRANCH_EMAIL || 'test-branch@example.com';

import { prisma } from '../src/lib/prisma';
import { checkAndSendCombinedVehicleEmailForPo } from '../src/lib/auto-gui-trigger';

const RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';
let failed = false;
const pass = (m: string) => console.log(`${GREEN}✓ PASS${RESET} ${m}`);
const fail = (m: string) => { console.error(`${RED}✗ FAIL${RESET} ${m}`); failed = true; };

const PO_NUMBER = `VEH-TEST-${Math.floor(Date.now() % 1e9)}`;
const SO_NUMBER = `${Math.floor(Date.now() % 1e7)}`;
const T0 = new Date('2026-06-20T10:00:00.000Z');
const T_AFTER = new Date('2026-06-20T10:10:00.000Z');
const T_BEFORE = new Date('2026-06-20T09:50:00.000Z');

let poId = '', soId = '';

/** Reset the work_queue + vehicle email to a clean baseline for each sub-case. */
async function reset() {
  await prisma.workQueue.deleteMany({ where: { salesOrderId: soId } });
  await prisma.email.deleteMany({ where: { purchaseOrderId: poId } });
  // A done ZLOAD1 at T0 so the outer gate (all zload1 done) passes.
  await prisma.workQueue.create({
    data: { step: 'zload1', state: 'done', salesOrderId: soId, finishedAt: T0, payload: '{}' },
  });
  // An existing vehicle_details email sent at T0. gmailMessageId is unique per
  // call so repeated resets don't collide on the unique constraint.
  const gid = `veh-${Math.floor(Date.now() % 1e9)}-${Math.random().toString(36).slice(2, 8)}`;
  await prisma.email.create({
    data: {
      purchaseOrderId: poId, emailType: 'vehicle_details', status: 'sent',
      sentAt: T0, recipientEmail: 'test-branch@example.com', subject: 'veh',
      gmailMessageId: gid, gmailThreadId: gid,
    },
  });
}

const skipped = (logs: string[]) => logs.some((l) => l.includes('already has a current vehicle_details email'));
const stale = (logs: string[]) => logs.some((l) => l.includes('STALE vehicle_details email'));

async function main() {
  const po = await prisma.purchaseOrder.create({
    data: { poNumber: PO_NUMBER, customerName: 'Veh Guard Co', weightage: 12 },
  });
  poId = po.id;
  const so = await prisma.salesOrder.create({
    data: { soNumber: SO_NUMBER, purchaseOrderId: po.id, plant: '1101' },
  });
  soId = so.id;

  try {
    // C1 — a ZLOAD1 finished AFTER the email → STALE → send fresh (regression).
    await reset();
    await prisma.workQueue.create({
      data: { step: 'zload1', state: 'done', salesOrderId: soId, finishedAt: T_AFTER, payload: '{}' },
    });
    const r1 = await checkAndSendCombinedVehicleEmailForPo(poId);
    if (stale(r1.logs) && !skipped(r1.logs)) pass('C1: ZLOAD1 after email → STALE, sends fresh (regression intact)');
    else fail(`C1: expected STALE; skipped=${skipped(r1.logs)} stale=${stale(r1.logs)}`);

    // C2 — a ZLOAD2 finished AFTER the email, NO new ZLOAD1 → must be STALE (THE BUG).
    await reset();
    await prisma.workQueue.create({
      data: { step: 'zload2', state: 'done', salesOrderId: soId, finishedAt: T_AFTER, payload: '{}' },
    });
    const r2 = await checkAndSendCombinedVehicleEmailForPo(poId);
    if (stale(r2.logs) && !skipped(r2.logs)) pass('C2: ZLOAD2 after email (no new ZLOAD1) → STALE, sends fresh (the bug)');
    else fail(`C2: expected STALE; skipped=${skipped(r2.logs)} stale=${stale(r2.logs)}`);

    // C3 — only mutations BEFORE the email → still current → SKIP (idempotency).
    await reset();
    await prisma.workQueue.create({
      data: { step: 'zload2', state: 'done', salesOrderId: soId, finishedAt: T_BEFORE, payload: '{}' },
    });
    const r3 = await checkAndSendCombinedVehicleEmailForPo(poId);
    if (skipped(r3.logs) && !stale(r3.logs)) pass('C3: mutations only before the email → SKIP (idempotency preserved)');
    else fail(`C3: expected SKIP; skipped=${skipped(r3.logs)} stale=${stale(r3.logs)}`);
  } finally {
    await prisma.workQueue.deleteMany({ where: { salesOrderId: soId } });
    await prisma.email.deleteMany({ where: { purchaseOrderId: poId } });
    await prisma.salesOrder.deleteMany({ where: { id: soId } });
    await prisma.purchaseOrder.deleteMany({ where: { id: poId } });
    await prisma.$disconnect();
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
