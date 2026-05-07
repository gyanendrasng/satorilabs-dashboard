#!/usr/bin/env node
/**
 * Reset visibility state for one SO and re-enqueue ZSO-VISIBILITY.
 *
 * Usage:
 *   node scripts/rerun-visibility.mjs <SO_NUMBER>
 *
 * What it does (for the given SO):
 *   1. Wipes the SO's existing materials, releasePlan, waitUntil
 *   2. Wipes any buffered ls_dispatch_buffered emails for that SO
 *   3. Wipes the PO's combined ls_dispatch email (so assembly can re-run)
 *   4. Wipes any existing dispatch_confirmation / vehicle_split_inquiry emails for the PO
 *   5. Resets SO.visibilityState='firing'
 *   6. Enqueues a fresh visibility WorkQueue row
 *
 * Then optionally fires it via /chat (set FIRE=1 env to actually pump).
 */

import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

const soNumber = process.argv[2];
if (!soNumber) {
  console.error('usage: node scripts/rerun-visibility.mjs <SO_NUMBER>');
  process.exit(1);
}

const so = await prisma.salesOrder.findFirst({
  where: { soNumber },
  include: { purchaseOrder: true },
});
if (!so) {
  console.error(`SO ${soNumber} not found`);
  process.exit(2);
}

console.log(`Resetting SO ${so.soNumber} (PO ${so.purchaseOrder.poNumber})…`);

// 1. wipe materials + plan state
await prisma.material.deleteMany({ where: { salesOrderId: so.id } });
console.log('  cleared Material rows');

// 2. wipe buffered emails for this SO
await prisma.email.deleteMany({
  where: { salesOrderId: so.id, emailType: 'ls_dispatch_buffered' },
});
console.log('  cleared ls_dispatch_buffered emails');

// 3+4. wipe PO-level outbound emails so assembly can re-run
await prisma.email.deleteMany({
  where: {
    purchaseOrderId: so.purchaseOrderId,
    emailType: { in: ['ls_dispatch', 'dispatch_confirmation', 'vehicle_split_inquiry'] },
  },
});
console.log('  cleared PO-level dispatch emails (combined / split / confirm)');

// 5. reset SO state
await prisma.salesOrder.update({
  where: { id: so.id },
  data: {
    visibilityState: 'firing',
    visibilityRetries: 0,
    releasePlan: null,
    waitUntil: null,
    waitRechecks: 0,
    status: 'pending',
  },
});
console.log('  reset SO.visibilityState=firing, releasePlan=null, status=pending');

// 6. enqueue
const wq = await prisma.workQueue.create({
  data: {
    salesOrderId: so.id,
    step: 'visibility',
    state: 'queued',
    payload: JSON.stringify({
      instruction: `VPN connected, SAP logged in. Run ZSO-VISIBILITY for SO ${so.soNumber}.`,
      transaction_code: 'ZSO-VISIBILITY',
      so_number: so.soNumber,
      meta: { so_number: so.soNumber },
    }),
  },
});
console.log(`  enqueued WorkQueue ${wq.id} (visibility)`);

// 7. optionally fire
if (process.env.FIRE === '1') {
  // Mimic pumpQueue
  const firing = await prisma.workQueue.findFirst({ where: { state: 'firing' } });
  if (firing) {
    console.log(`\nslot busy (firing ${firing.id}); skipping fire — re-run with FIRE=1 once it drains`);
  } else {
    await prisma.workQueue.update({
      where: { id: wq.id },
      data: { state: 'firing', startedAt: new Date() },
    });
    const payload = JSON.parse(wq.payload);
    const wireBody = { work_id: wq.id, ...payload, meta: { ...(payload.meta || {}), work_id: wq.id } };
    const url = `http://${process.env.AUTO_GUI_HOST || 'localhost'}:${process.env.AUTO_GUI_PORT || '8000'}/chat`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(wireBody),
    });
    console.log(`\nfired /chat → ${res.status}`);
  }
}

await prisma.$disconnect();
