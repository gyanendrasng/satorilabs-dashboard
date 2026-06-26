/**
 * Plant threads are per (PO, plant):
 *   - two different plant emails on ONE PO → two PoRecipientThread rows with
 *     distinct threads,
 *   - the umbrella subject is stable per plant,
 *   - a second send to the same plant reuses the row (first claim wins).
 *
 *   npx tsx scripts/test-plant-thread-per-plant.ts   (or: npm test)
 *
 * Exits 0/1; cleans up fixtures.
 */

import { prisma } from '../src/lib/prisma';
import {
  resolveRecipientThreadAnchor,
  captureRecipientThreadAnchor,
  plantThreadSubject,
} from '../src/lib/po-thread';

const RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';
let failed = false;
const pass = (m: string) => console.log(`${GREEN}✓ PASS${RESET} ${m}`);
const fail = (m: string) => { console.error(`${RED}✗ FAIL${RESET} ${m}`); failed = true; };
const check = (cond: boolean, m: string) => (cond ? pass(m) : fail(m));

async function main() {
  const uniq = `${Date.now()}`;
  const poNumber = `PLT-${uniq}`;
  const po = await prisma.purchaseOrder.create({
    data: { poNumber, customerName: 'Plant Co', weightage: 12 },
  });

  const plantA = `plant-a-${uniq}@example.com`;
  const plantB = `plant-b-${uniq}@example.com`;
  const subject = plantThreadSubject(poNumber);

  try {
    // First send to each plant captures a distinct thread under the same
    // deterministic umbrella subject.
    await captureRecipientThreadAnchor({
      purchaseOrderId: po.id, recipientEmail: plantA, kind: 'plant',
      threadId: `THR-A-${uniq}`, rfc822MessageId: `<a-${uniq}@mail>`, subject,
    });
    await captureRecipientThreadAnchor({
      purchaseOrderId: po.id, recipientEmail: plantB, kind: 'plant',
      threadId: `THR-B-${uniq}`, rfc822MessageId: `<b-${uniq}@mail>`, subject,
    });

    const a = await resolveRecipientThreadAnchor(po.id, plantA);
    const b = await resolveRecipientThreadAnchor(po.id, plantB);
    check(a?.threadId === `THR-A-${uniq}`, 'plant A resolves to its own thread');
    check(b?.threadId === `THR-B-${uniq}`, 'plant B resolves to its own thread');
    check(a?.threadId !== b?.threadId, 'two plants on one PO get DISTINCT threads');
    check(a?.subject === subject && b?.subject === subject, 'both share the umbrella plant subject');

    const count1 = await prisma.poRecipientThread.count({ where: { purchaseOrderId: po.id } });
    check(count1 === 2, 'exactly two PoRecipientThread rows for the PO');

    // A later send to plant A must NOT change its thread (first claim wins).
    await captureRecipientThreadAnchor({
      purchaseOrderId: po.id, recipientEmail: plantA, kind: 'plant',
      threadId: `THR-A2-${uniq}`, rfc822MessageId: `<a2-${uniq}@mail>`, subject,
    });
    const aAgain = await resolveRecipientThreadAnchor(po.id, plantA);
    check(aAgain?.threadId === `THR-A-${uniq}`, 'second send to plant A keeps the original thread');
    const count2 = await prisma.poRecipientThread.count({ where: { purchaseOrderId: po.id } });
    check(count2 === 2, 'no extra row created on re-send');
  } finally {
    await prisma.poRecipientThread.deleteMany({ where: { purchaseOrderId: po.id } });
    await prisma.purchaseOrder.deleteMany({ where: { id: po.id } });
    await prisma.$disconnect();
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
