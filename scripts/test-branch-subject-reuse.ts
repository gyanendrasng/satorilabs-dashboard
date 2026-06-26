/**
 * Branch single-subject reuse:
 *   - branchReplySubject() is idempotent and strips a single Re:/Fwd: prefix.
 *   - resolvePoThreadAnchor(po,'branch') returns `Re: <branchSubject>` as the
 *     shared subject when branchSubject is captured.
 *   - subject is undefined (caller falls back) when no subject is on file.
 *
 *   npx tsx scripts/test-branch-subject-reuse.ts   (or: npm test)
 *
 * Exits 0/1; cleans up fixtures.
 */

import { prisma } from '../src/lib/prisma';
import { resolvePoThreadAnchor, branchReplySubject } from '../src/lib/po-thread';

const RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';
let failed = false;
const pass = (m: string) => console.log(`${GREEN}✓ PASS${RESET} ${m}`);
const fail = (m: string) => { console.error(`${RED}✗ FAIL${RESET} ${m}`); failed = true; };
const check = (cond: boolean, m: string) => (cond ? pass(m) : fail(m));

async function main() {
  // Pure-function checks — no DB.
  check(branchReplySubject('New Order - 123') === 'Re: New Order - 123', 'adds Re: to a bare subject');
  check(branchReplySubject('Re: New Order - 123') === 'Re: New Order - 123', 'idempotent on existing Re:');
  check(branchReplySubject('RE:  New Order') === 'Re: New Order', 'collapses RE: + spacing');
  check(branchReplySubject('Fwd: Quote') === 'Re: Quote', 'rewrites Fwd: to Re:');

  const uniq = `${Date.now()}`;

  // PO with a captured branchSubject + anchor msg id → resolve returns Re:<subject>.
  const poWith = await prisma.purchaseOrder.create({
    data: {
      poNumber: `BSUB-${uniq}`,
      customerName: 'Subj Co',
      weightage: 12,
      branchThreadId: `THR-${uniq}`,
      branchAnchorMsgId: `<anchor-${uniq}@mail>`,
      branchSubject: `New Order - ${uniq}`,
    },
  });

  // PO with an anchor msg id but NO captured subject and no resolvable original
  // → subject undefined (caller falls back to its own per-step subject).
  const poNone = await prisma.purchaseOrder.create({
    data: {
      poNumber: `BSUB-NONE-${uniq}`,
      customerName: 'NoSubj Co',
      weightage: 12,
      branchThreadId: `THR-NONE-${uniq}`,
      branchAnchorMsgId: `<anchor-none-${uniq}@mail>`,
      branchSubject: null,
    },
  });
  // An SO with NO originalMessageId so the lazy Gmail subject fetch is skipped.
  const soNone = await prisma.salesOrder.create({
    data: { soNumber: `BSUB-NONE-${uniq}`.slice(0, 18), purchaseOrderId: poNone.id, plant: '7651' },
  });

  try {
    const aWith = await resolvePoThreadAnchor(poWith.id, 'branch');
    check(!!aWith, 'anchor resolves for PO with branchThreadId');
    check(aWith?.subject === `Re: New Order - ${uniq}`, 'subject is Re: <captured NEW ORDER subject>');
    check(aWith?.threadId === `THR-${uniq}`, 'anchor threadId is the branch thread');

    const aNone = await resolvePoThreadAnchor(poNone.id, 'branch');
    check(!!aNone, 'anchor resolves even without a captured subject');
    check(aNone?.subject === undefined, 'subject undefined when none on file (caller falls back)');
  } finally {
    await prisma.salesOrder.deleteMany({ where: { id: soNone.id } });
    await prisma.purchaseOrder.deleteMany({ where: { id: { in: [poWith.id, poNone.id] } } });
    await prisma.$disconnect();
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
