/**
 * buildPlannerPrompt must render ONE self-contained system prompt from
 * ManagerV3.0.txt:
 *   - every {{TOKEN}} placeholder filled (none left over),
 *   - the `=== SYSTEM ===` / `=== USER ===` markers and the `#` change-log header
 *     stripped,
 *   - the STATIC sections present (AVAILABLE STEP KINDS, OUTPUT FORMAT, SECTION 4
 *     rules), AND
 *   - the DYNAMIC DB sections substituted (sender, SO state + materials, audit,
 *     thread).
 *
 *   npx tsx scripts/test-planner-prompt-single-system.ts   (or: npm test)
 *
 * Exits 0/1; cleans up fixtures.
 */

process.env.AUTO_GUI_HOST = '127.0.0.1';
process.env.AUTO_GUI_PORT = '59999';

import { prisma } from '../src/lib/prisma';
import { buildPlannerPrompt } from '../src/lib/llm-planner';

const RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';
let failed = false;
const pass = (m: string) => console.log(`${GREEN}✓ PASS${RESET} ${m}`);
const fail = (m: string) => { console.error(`${RED}✗ FAIL${RESET} ${m}`); failed = true; };
const check = (cond: boolean, m: string) => (cond ? pass(m) : fail(m));

async function main() {
  const uniq = `${Date.now()}`;
  const po = await prisma.purchaseOrder.create({
    data: { poNumber: `PPS-${uniq}`, customerName: 'PPS Co', weightage: 12, dispatchRound: 1 },
  });
  const so = await prisma.salesOrder.create({
    data: { soNumber: `PPS-${uniq}`.slice(0, 18), purchaseOrderId: po.id, plant: '1101' },
  });
  await prisma.material.create({
    data: { salesOrderId: so.id, material: 'MZZZUNIQUE01P', batch: 'BZZ', orderQuantity: 200, dispatchQuantity: 200, orderWeightKg: 2000, availableStock: 200 },
  });
  const trig = await prisma.email.create({
    data: {
      salesOrderId: so.id, gmailMessageId: `PPS-MSG-${uniq}`, gmailThreadId: `PPS-THR-${uniq}`,
      recipientEmail: 'branch@example.com', subject: 'subj', status: 'sent', emailType: 'ls_dispatch', replyHtml: '<p>hello</p>',
    },
  });
  try {
    const prompt = await buildPlannerPrompt({ salesOrderId: so.id, triggerEmailId: trig.id, sender: 'branch' });

    check(!/\{\{[A-Z_]+\}\}/.test(prompt), 'no leftover {{TOKEN}} placeholders');
    check(!prompt.includes('=== SYSTEM ==='), 'no === SYSTEM === marker');
    check(!prompt.includes('=== USER ==='), 'no === USER === marker');
    check(!prompt.includes('LLM PLANNER PROMPT — V3.0'), 'no leading # change-log header');
    check(prompt.includes('AVAILABLE STEP KINDS'), 'contains AVAILABLE STEP KINDS (injected on the fly)');
    check(prompt.includes('op: "inc"|"dec"|"del"'), 'va02 argsSchema injected with op:inc/dec/del');
    check(prompt.includes('DECREASES / DELETES'), 'va02 enriched (V3.0) description injected');
    check(prompt.includes('OUTPUT FORMAT'), 'contains OUTPUT FORMAT (static)');
    check(prompt.includes('PO TONNAGE GATE'), 'contains SECTION 4 rules (static)');
    check(prompt.includes('SENDER OF LATEST EMAIL: branch'), 'SENDER token filled');
    check(prompt.includes('CURRENT SO STATE:') && prompt.includes('MZZZUNIQUE01P'), 'SO_STATE token filled (materials rendered)');
    check(prompt.includes('vehicle details received:'), 'SO state carries the vehicle-details line');
    check(prompt.includes('PRIOR ACTIONS ON THIS SO'), 'AUDIT_TRAIL section present');
    check(prompt.includes('EMAIL THREAD'), 'EMAIL_THREAD section present');
  } finally {
    await prisma.email.deleteMany({ where: { salesOrderId: so.id } });
    await prisma.material.deleteMany({ where: { salesOrderId: so.id } });
    await prisma.salesOrder.deleteMany({ where: { id: so.id } });
    await prisma.purchaseOrder.deleteMany({ where: { id: po.id } });
    await prisma.$disconnect();
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
