/**
 * Regression test for surfacing a received PDF attachment to the planner's
 * email-thread render (src/lib/email-thread.ts).
 *
 *   DATABASE_URL="file:/tmp/x.db" npx prisma db push --skip-generate \
 *     && DATABASE_URL="file:/tmp/x.db" npx tsx scripts/test-email-thread-pdf.ts
 *
 * Bug: a plant replied to a plant_ls email WITH an invoice PDF (Email.replyPdfUrl
 * was set), but the thread render the planner reads showed only the reply text.
 * The LLM concluded "no invoice attached" and looped on await_plant_invoice /
 * sent a wrong clarification. Fix: the render now tags inbound replies that
 * carried a PDF with "[PDF ATTACHMENT RECEIVED]".
 *
 * Exits 0/1; cleans up its fixtures.
 */

import { prisma } from '../src/lib/prisma';
import { renderEmailThreadForSO } from '../src/lib/email-thread';

const RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';
let failed = false;
const pass = (m: string) => console.log(`${GREEN}✓ PASS${RESET} ${m}`);
const fail = (m: string) => { console.error(`${RED}✗ FAIL${RESET} ${m}`); failed = true; };

const PO_NUMBER = `THRPDF-TEST-${Math.floor(Date.now() % 1e9)}`;
const SO_NUMBER = `${Math.floor(Date.now() % 1e7)}`;
const gid = () => `g-${Math.floor(Date.now() % 1e9)}-${Math.random().toString(36).slice(2, 8)}`;

async function main() {
  const po = await prisma.purchaseOrder.create({
    data: { poNumber: PO_NUMBER, customerName: 'Thread PDF Co', weightage: 12 },
  });
  const so = await prisma.salesOrder.create({
    data: { soNumber: SO_NUMBER, purchaseOrderId: po.id, plant: '1101' },
  });
  // A plant_ls email replied to WITH a PDF (invoice).
  await prisma.email.create({
    data: {
      salesOrderId: so.id, purchaseOrderId: po.id, emailType: 'plant_ls',
      gmailMessageId: gid(), gmailThreadId: gid(), recipientEmail: 'plantA@example.com',
      subject: 'Loading Slip 373463', status: 'replied',
      sentBody: 'Please find the loading slip attached.',
      replyHtml: '<p>Acknowledged. Please send the client invoice.</p>',
      replyPdfUrl: 'reply-pdfs/3382184/373463.pdf', // the invoice PDF
      sentAt: new Date('2026-06-21T10:00:00Z'), repliedAt: new Date('2026-06-21T10:05:00Z'),
    },
  });
  // A second plant_ls reply WITHOUT a PDF (control).
  await prisma.email.create({
    data: {
      salesOrderId: so.id, purchaseOrderId: po.id, emailType: 'plant_ls',
      gmailMessageId: gid(), gmailThreadId: gid(), recipientEmail: 'plantB@example.com',
      subject: 'Loading Slip 373499', status: 'replied',
      sentBody: 'Please find the loading slip attached.',
      replyHtml: '<p>Acknowledged, will send invoice shortly.</p>',
      sentAt: new Date('2026-06-21T10:01:00Z'), repliedAt: new Date('2026-06-21T10:06:00Z'),
    },
  });

  try {
    const thread = await renderEmailThreadForSO({ salesOrderId: so.id });
    const pdfCount = (thread.match(/\[PDF ATTACHMENT RECEIVED\]/g) ?? []).length;
    if (pdfCount === 1) pass('thread render tags exactly the one reply that carried a PDF');
    else fail(`expected 1 "[PDF ATTACHMENT RECEIVED]" marker, got ${pdfCount}\n${thread}`);

    // The marker must attach to the 373463 reply, not the no-PDF one.
    if (/373463[\s\S]*?\[PDF ATTACHMENT RECEIVED\]/.test(thread))
      pass('marker is on the LS-373463 reply (the one with the PDF)');
    else fail(`marker not associated with the 373463 reply:\n${thread}`);
  } finally {
    await prisma.email.deleteMany({ where: { purchaseOrderId: po.id } });
    await prisma.salesOrder.deleteMany({ where: { id: so.id } });
    await prisma.purchaseOrder.deleteMany({ where: { id: po.id } });
    await prisma.$disconnect();
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
