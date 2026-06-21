/**
 * Regression test for surfacing a received PDF in the planner's audit trail
 * (src/lib/audit-trail.ts email_received rendering + the email_received event
 * payload written by handleReplyV2).
 *
 *   DATABASE_URL="file:/tmp/x.db" npx prisma db push --skip-generate \
 *     && DATABASE_URL="file:/tmp/x.db" npx tsx scripts/test-audit-pdf-flag.ts
 *
 * Bug companion to test-email-thread-pdf: the audit trail the planner reads
 * also omitted the PDF flag. Fix: email_received events carry hasPdfAttachment,
 * and the audit render appends "[HAS PDF ATTACHMENT]".
 *
 * Exits 0/1; cleans up its fixtures.
 */

import { prisma } from '../src/lib/prisma';
import { emitEvent } from '../src/lib/scenario-events';
import { renderAuditTrailForSO } from '../src/lib/audit-trail';

const RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';
let failed = false;
const pass = (m: string) => console.log(`${GREEN}✓ PASS${RESET} ${m}`);
const fail = (m: string) => { console.error(`${RED}✗ FAIL${RESET} ${m}`); failed = true; };

const PO_NUMBER = `AUDPDF-TEST-${Math.floor(Date.now() % 1e9)}`;
const SO_NUMBER = `${Math.floor(Date.now() % 1e7)}`;

async function main() {
  const po = await prisma.purchaseOrder.create({
    data: { poNumber: PO_NUMBER, customerName: 'Audit PDF Co', weightage: 12 },
  });
  const so = await prisma.salesOrder.create({
    data: { soNumber: SO_NUMBER, purchaseOrderId: po.id, plant: '1101' },
  });

  try {
    // A plant reply WITH a PDF.
    await emitEvent({
      salesOrderId: so.id,
      type: 'email_received',
      payload: {
        emailType: 'plant_ls', sender: 'plant', subject: 'Loading Slip 373463',
        body_excerpt: 'Acknowledged. Please send the client invoice.',
        hasPdfAttachment: true,
      },
    });
    // A plant reply WITHOUT a PDF (control).
    await emitEvent({
      salesOrderId: so.id,
      type: 'email_received',
      payload: {
        emailType: 'plant_ls', sender: 'plant', subject: 'Loading Slip 373499',
        body_excerpt: 'Acknowledged, invoice to follow.',
        hasPdfAttachment: false,
      },
    });

    const trail = await renderAuditTrailForSO({ salesOrderId: so.id });
    const count = (trail.match(/\[HAS PDF ATTACHMENT\]/g) ?? []).length;
    if (count === 1) pass('audit trail tags exactly the email_received that had a PDF');
    else fail(`expected 1 "[HAS PDF ATTACHMENT]", got ${count}\n${trail}`);
  } finally {
    await prisma.scenarioEvent.deleteMany({ where: { salesOrderId: so.id } });
    await prisma.salesOrder.deleteMany({ where: { id: so.id } });
    await prisma.purchaseOrder.deleteMany({ where: { id: po.id } });
    await prisma.$disconnect();
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
