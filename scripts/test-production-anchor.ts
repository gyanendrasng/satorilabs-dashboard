/**
 * Production reminders anchor per PO:
 *   - the first reminder captures one PoRecipientThread row (kind 'production'),
 *   - later reminders reuse it (first claim wins) — one conversation per PO.
 *
 *   npx tsx scripts/test-production-anchor.ts   (or: npm test)
 *
 * Exits 0/1; cleans up fixtures.
 */

import { prisma } from '../src/lib/prisma';
import {
  resolveRecipientThreadAnchor,
  captureRecipientThreadAnchor,
  productionThreadSubject,
} from '../src/lib/po-thread';

const RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';
let failed = false;
const pass = (m: string) => console.log(`${GREEN}✓ PASS${RESET} ${m}`);
const fail = (m: string) => { console.error(`${RED}✗ FAIL${RESET} ${m}`); failed = true; };
const check = (cond: boolean, m: string) => (cond ? pass(m) : fail(m));

async function main() {
  const uniq = `${Date.now()}`;
  const poNumber = `PROD-${uniq}`;
  const po = await prisma.purchaseOrder.create({
    data: { poNumber, customerName: 'Prod Co', weightage: 12 },
  });
  const production = `production-${uniq}@example.com`;
  const subject = productionThreadSubject(poNumber);

  try {
    check(await resolveRecipientThreadAnchor(po.id, production) === null, 'no production thread before first reminder');

    await captureRecipientThreadAnchor({
      purchaseOrderId: po.id, recipientEmail: production, kind: 'production',
      threadId: `THR-P-${uniq}`, rfc822MessageId: `<p-${uniq}@mail>`, subject,
    });
    const a = await resolveRecipientThreadAnchor(po.id, production);
    check(a?.threadId === `THR-P-${uniq}`, 'first reminder captured the production thread');
    check(a?.subject === subject, 'production subject is the per-PO umbrella subject');

    // Second reminder for the same PO must reuse the thread.
    await captureRecipientThreadAnchor({
      purchaseOrderId: po.id, recipientEmail: production, kind: 'production',
      threadId: `THR-P2-${uniq}`, rfc822MessageId: `<p2-${uniq}@mail>`, subject,
    });
    const aAgain = await resolveRecipientThreadAnchor(po.id, production);
    check(aAgain?.threadId === `THR-P-${uniq}`, 'second reminder reuses the original thread');
    const count = await prisma.poRecipientThread.count({ where: { purchaseOrderId: po.id } });
    check(count === 1, 'exactly one production thread row for the PO');
  } finally {
    await prisma.poRecipientThread.deleteMany({ where: { purchaseOrderId: po.id } });
    await prisma.purchaseOrder.deleteMany({ where: { id: po.id } });
    await prisma.$disconnect();
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
