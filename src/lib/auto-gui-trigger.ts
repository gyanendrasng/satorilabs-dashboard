import { prisma } from './prisma';
import { downloadFromS3 } from './s3';

const AUTO_GUI_HOST = process.env.AUTO_GUI_HOST || 'localhost';

/**
 * Check if all LoadingSlipItems for a SalesOrder have replies with PDFs,
 * and send batch request to Aman's auto_gui2 backend if they do.
 */
export async function checkAndSendBatchToAman(
  salesOrderId: string
): Promise<{ success: boolean; logs: string[] }> {
  const logs: string[] = [];

  const log = (message: string) => {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}`;
    console.log(logMessage);
    logs.push(logMessage);
  };

  log(`[BatchSender] Checking if all replies received for SO ID: ${salesOrderId}`);

  // Get the sales order with all its loading slip items and emails
  const salesOrder = await prisma.salesOrder.findUnique({
    where: { id: salesOrderId },
    include: {
      items: {
        include: {
          emails: true,
        },
      },
      purchaseOrder: true,
    },
  });

  if (!salesOrder) {
    log(`[BatchSender] Sales order not found: ${salesOrderId}`);
    return { success: false, logs };
  }

  // Log status of each item's emails
  log(`[BatchSender] SO ${salesOrder.soNumber} has ${salesOrder.items.length} items:`);
  for (const item of salesOrder.items) {
    const repliedEmail = item.emails.find((e) => e.status === 'replied' && e.replyPdfUrl);
    const status = repliedEmail ? `replied (PDF: ${repliedEmail.replyPdfUrl})` : 'waiting';
    log(`  - LS ${item.lsNumber}: ${status}`);
  }

  // Check if ALL items have at least one email with status 'replied' and replyPdfUrl
  const allReplied = salesOrder.items.every((item) =>
    item.emails.some((email) => email.status === 'replied' && email.replyPdfUrl)
  );

  if (!allReplied) {
    const repliedCount = salesOrder.items.filter((item) =>
      item.emails.some((email) => email.status === 'replied' && email.replyPdfUrl)
    ).length;
    log(
      `[BatchSender] Not ready yet for SO ${salesOrder.soNumber}: ${repliedCount}/${salesOrder.items.length} items have replies`
    );
    return { success: false, logs };
  }

  log(`[BatchSender] All ${salesOrder.items.length} items have replies for SO ${salesOrder.soNumber}. Sending batch to auto_gui2...`);

  // Get FIRST reply PDF only (from first item with a replied email)
  const firstItem = salesOrder.items.find((item) =>
    item.emails.some((email) => email.status === 'replied' && email.replyPdfUrl)
  );

  if (!firstItem) {
    log(`[BatchSender] No item with reply PDF found for SO ${salesOrder.soNumber}`);
    return { success: false, logs };
  }

  const firstEmail = firstItem.emails.find(
    (e) => e.status === 'replied' && e.replyPdfUrl
  );

  if (!firstEmail || !firstEmail.replyPdfUrl) {
    log(`[BatchSender] No reply PDF URL found for SO ${salesOrder.soNumber}`);
    return { success: false, logs };
  }

  try {
    // Download the first PDF from R2
    log(`[BatchSender] Downloading PDF from R2: ${firstEmail.replyPdfUrl}`);
    const pdfBuffer = await downloadFromS3(firstEmail.replyPdfUrl);
    log(`[BatchSender] Downloaded PDF: ${pdfBuffer.length} bytes`);

    const attachment = {
      filename: `${firstItem.lsNumber}.pdf`,
      content_base64: pdfBuffer.toString('base64'),
    };

    // Build instruction with all LS numbers
    const lsNumbers = salesOrder.items.map((i) => i.lsNumber).join(', ');
    const instruction = `Run the SAP transaction ZLOAD3 for Sales Order ${salesOrder.soNumber}. Loading slips: ${lsNumbers}. Extract invoice data from the attached PDF.`;

    log(`[BatchSender] Sending to auto_gui2:`);
    log(`  - Instruction: ${instruction}`);
    log(`  - Attachment: ${attachment.filename} (${pdfBuffer.length} bytes)`);

    // Send to existing /chat endpoint with SINGLE PDF
    const response = await fetch(`http://${AUTO_GUI_HOST}:8000/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instruction,
        transaction_code: 'ZLOAD3',
        attachments: [attachment],
        extraction_context:
          'Extract the sales order number, loaded quantity, invoice number, and invoice date',
      }),
    });

    if (!response.ok) {
      throw new Error(`auto_gui2 request failed: ${response.statusText}`);
    }

    const responseData = await response.json();
    log(`[BatchSender] auto_gui2 response for SO ${salesOrder.soNumber}: ${JSON.stringify(responseData)}`);

    // Mark all emails with status 'replied' as 'processed'
    let processedCount = 0;
    for (const item of salesOrder.items) {
      for (const email of item.emails) {
        if (email.status === 'replied') {
          await prisma.email.update({
            where: { id: email.id },
            data: { status: 'processed' },
          });
          processedCount++;
        }
      }
    }
    log(`[BatchSender] Marked ${processedCount} emails as 'processed' for SO ${salesOrder.soNumber}`);

    // Update SalesOrder status to completed
    await prisma.salesOrder.update({
      where: { id: salesOrderId },
      data: { status: 'completed' },
    });
    log(`[BatchSender] SO ${salesOrder.soNumber} marked as 'completed'`);

    // Update purchase order stage if needed
    await updatePurchaseOrderStage(salesOrder.purchaseOrderId);

    log(`[BatchSender] Successfully processed SO ${salesOrder.soNumber} with ${salesOrder.items.length} LS items`);
    return { success: true, logs };
  } catch (error) {
    log(
      `[BatchSender] Failed to send batch to auto_gui2 for SO ${salesOrder.soNumber}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return { success: false, logs };
  }
}

/**
 * Update purchase order stage based on all sales orders status
 */
async function updatePurchaseOrderStage(
  purchaseOrderId: string
): Promise<void> {
  const purchaseOrder = await prisma.purchaseOrder.findUnique({
    where: { id: purchaseOrderId },
    include: {
      salesOrders: true,
    },
  });

  if (!purchaseOrder) {
    return;
  }

  // Check if all sales orders are completed
  const allCompleted = purchaseOrder.salesOrders.every(
    (so) => so.status === 'completed'
  );

  if (allCompleted) {
    // Move to next stage (current stage + 1, max 6)
    const nextStage = Math.min(purchaseOrder.stage + 1, 6);
    await prisma.purchaseOrder.update({
      where: { id: purchaseOrderId },
      data: {
        stage: nextStage,
        status: nextStage === 6 ? 'completed' : 'in-progress',
      },
    });
  }
}
