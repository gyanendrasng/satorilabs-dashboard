import { prisma } from './prisma';
import { downloadFromS3 } from './s3';
import { sendPlainEmail } from './gmail';

const AUTO_GUI_HOST = process.env.AUTO_GUI_HOST || 'localhost';
const AUTO_GUI_PORT = process.env.AUTO_GUI_PORT || '8080';
const PRODUCTION_EMAIL = process.env.PRODUCTION_EMAIL || '';

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

    // Build instruction
    const instruction = `VPN is connected, SAP is logged in. Just execute ZLOAD3-B for the sales order ${salesOrder.soNumber}`;

    log(`[BatchSender] Sending to auto_gui2:`);
    log(`  - Instruction: ${instruction}`);
    log(`  - Attachment: ${attachment.filename} (${pdfBuffer.length} bytes)`);

    // Send to existing /chat endpoint with SINGLE PDF
    const response = await fetch(`http://${AUTO_GUI_HOST}:8000/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instruction,
        transaction_code: 'ZLOAD3-B',
        attachments: [attachment],
        extraction_context:
          'Extract the loaded quantity, invoice number, and invoice date',
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

// ==============================================================================
// Email Workflow Handlers
// ==============================================================================

interface MaterialItemPayload {
  material_code: string;
  batch: string;
  quantity: number;
}

/**
 * Handle a branch reply by classifying intent via /email/branch-reply
 * and acting accordingly (release materials or start production inquiry loop)
 */
export async function handleBranchReply(
  emailId: string,
  replyHtml: string,
  originalEmailHtml: string,
  salesOrderId: string
): Promise<{ success: boolean; logs: string[] }> {
  const logs: string[] = [];
  const log = (msg: string) => {
    const logMsg = `[${new Date().toISOString()}] ${msg}`;
    console.log(logMsg);
    logs.push(logMsg);
  };

  try {
    // Get email with related data
    const email = await prisma.email.findUnique({
      where: { id: emailId },
      include: {
        loadingSlipItem: {
          include: { salesOrder: true },
        },
      },
    });

    if (!email) {
      log(`[BranchReply] Email not found: ${emailId}`);
      return { success: false, logs };
    }

    const soNumber = email.loadingSlipItem.salesOrder.soNumber;
    log(`[BranchReply] Classifying branch reply for SO ${soNumber}`);

    // Call auto_gui2 /email/branch-reply
    const response = await fetch(
      `http://${AUTO_GUI_HOST}:${AUTO_GUI_PORT}/email/branch-reply`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          original_email_html: originalEmailHtml,
          branch_reply_html: replyHtml,
          sales_order: soNumber,
        }),
      }
    );

    const result = await response.json();
    log(`[BranchReply] Classification result: intent=${result.intent}`);

    if (!result.success) {
      log(`[BranchReply] Classification failed: ${result.error}`);
      return { success: false, logs };
    }

    if (result.intent === 'release_all' || result.intent === 'release_part') {
      // Trigger ZLOAD1 with the materials
      const materials: MaterialItemPayload[] = result.materials || [];
      log(`[BranchReply] Triggering ZLOAD1 for ${materials.length} materials`);
      await triggerZload1(soNumber, materials);

      // Update email workflow state
      await prisma.email.update({
        where: { id: emailId },
        data: { workflowState: 'completed' },
      });
    } else if (result.intent === 'wait') {
      // Send inquiry to production team
      if (!PRODUCTION_EMAIL) {
        log(`[BranchReply] PRODUCTION_EMAIL not configured, cannot send inquiry`);
        return { success: false, logs };
      }

      const emailPayload = result.email_payload;
      if (!emailPayload) {
        log(`[BranchReply] No email_payload in wait response`);
        return { success: false, logs };
      }

      log(`[BranchReply] Sending production inquiry to ${PRODUCTION_EMAIL}`);
      const sentResult = await sendPlainEmail(
        PRODUCTION_EMAIL,
        emailPayload.subject,
        emailPayload.body
      );

      // Create a new Email record for the production inquiry
      await prisma.email.create({
        data: {
          loadingSlipItemId: email.loadingSlipItemId,
          gmailMessageId: sentResult.messageId,
          gmailThreadId: sentResult.threadId,
          recipientEmail: PRODUCTION_EMAIL,
          subject: emailPayload.subject,
          status: 'sent',
          emailType: 'production_inquiry',
          workflowState: 'awaiting_production_reply',
          relatedMaterials: JSON.stringify(result.missing_materials || []),
        },
      });

      // Mark original branch email as completed
      await prisma.email.update({
        where: { id: emailId },
        data: { workflowState: 'completed' },
      });

      log(`[BranchReply] Production inquiry sent, message ID: ${sentResult.messageId}`);
    }

    return { success: true, logs };
  } catch (error) {
    log(
      `[BranchReply] Error: ${error instanceof Error ? error.message : String(error)}`
    );
    return { success: false, logs };
  }
}

/**
 * Handle production team's reply — extract days and set wait timer
 */
export async function handleProductionReply(
  emailId: string,
  replyHtml: string
): Promise<{ success: boolean; logs: string[] }> {
  const logs: string[] = [];
  const log = (msg: string) => {
    const logMsg = `[${new Date().toISOString()}] ${msg}`;
    console.log(logMsg);
    logs.push(logMsg);
  };

  try {
    const email = await prisma.email.findUnique({
      where: { id: emailId },
      include: {
        loadingSlipItem: {
          include: { salesOrder: true },
        },
      },
    });

    if (!email) {
      log(`[ProductionReply] Email not found: ${emailId}`);
      return { success: false, logs };
    }

    const soNumber = email.loadingSlipItem.salesOrder.soNumber;
    const materials: string[] = email.relatedMaterials
      ? JSON.parse(email.relatedMaterials)
      : [];

    log(`[ProductionReply] Parsing production reply for SO ${soNumber}`);

    const response = await fetch(
      `http://${AUTO_GUI_HOST}:${AUTO_GUI_PORT}/email/production-reply`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          production_reply_html: replyHtml,
          sales_order: soNumber,
          materials,
        }),
      }
    );

    const result = await response.json();
    log(`[ProductionReply] Extracted days: ${result.days}`);

    if (!result.success || result.days <= 0) {
      log(`[ProductionReply] Failed to extract days: ${result.error}`);
      return { success: false, logs };
    }

    // Set wait timer
    const waitUntil = new Date(Date.now() + result.days * 86400000);
    await prisma.email.update({
      where: { id: emailId },
      data: {
        status: 'replied',
        repliedAt: new Date(),
        replyHtml,
        workflowState: 'waiting_timer',
        waitUntil,
      },
    });

    log(
      `[ProductionReply] Timer set: wait until ${waitUntil.toISOString()} (${result.days} days)`
    );
    return { success: true, logs };
  } catch (error) {
    log(
      `[ProductionReply] Error: ${error instanceof Error ? error.message : String(error)}`
    );
    return { success: false, logs };
  }
}

/**
 * Handle production confirmation reply — ready or wait_more
 */
export async function handleProductionConfirmation(
  emailId: string,
  replyHtml: string
): Promise<{ success: boolean; logs: string[] }> {
  const logs: string[] = [];
  const log = (msg: string) => {
    const logMsg = `[${new Date().toISOString()}] ${msg}`;
    console.log(logMsg);
    logs.push(logMsg);
  };

  try {
    const email = await prisma.email.findUnique({
      where: { id: emailId },
      include: {
        loadingSlipItem: {
          include: { salesOrder: true },
        },
      },
    });

    if (!email) {
      log(`[ProductionConfirmation] Email not found: ${emailId}`);
      return { success: false, logs };
    }

    const soNumber = email.loadingSlipItem.salesOrder.soNumber;
    const materials: string[] = email.relatedMaterials
      ? JSON.parse(email.relatedMaterials)
      : [];

    log(`[ProductionConfirmation] Classifying confirmation for SO ${soNumber}`);

    const response = await fetch(
      `http://${AUTO_GUI_HOST}:${AUTO_GUI_PORT}/email/production-confirmation`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reply_html: replyHtml,
          sales_order: soNumber,
          materials,
          context: 'production_confirmation',
        }),
      }
    );

    const result = await response.json();
    log(`[ProductionConfirmation] Status: ${result.status}`);

    if (!result.success) {
      log(`[ProductionConfirmation] Classification failed: ${result.error}`);
      return { success: false, logs };
    }

    if (result.status === 'ready') {
      // Trigger ZLOAD1
      const materialItems: MaterialItemPayload[] = materials.map((m) => ({
        material_code: m,
        batch: '',
        quantity: 0,
      }));
      await triggerZload1(soNumber, materialItems);

      await prisma.email.update({
        where: { id: emailId },
        data: {
          status: 'replied',
          repliedAt: new Date(),
          replyHtml,
          workflowState: 'completed',
        },
      });

      log(`[ProductionConfirmation] Materials ready, ZLOAD1 triggered`);
    } else if (result.status === 'wait_more') {
      const additionalDays = result.additional_days || 3;
      const waitUntil = new Date(Date.now() + additionalDays * 86400000);

      await prisma.email.update({
        where: { id: emailId },
        data: {
          status: 'replied',
          repliedAt: new Date(),
          replyHtml,
          workflowState: 'waiting_timer',
          waitUntil,
        },
      });

      log(
        `[ProductionConfirmation] Wait more: ${additionalDays} days until ${waitUntil.toISOString()}`
      );
    }

    return { success: true, logs };
  } catch (error) {
    log(
      `[ProductionConfirmation] Error: ${error instanceof Error ? error.message : String(error)}`
    );
    return { success: false, logs };
  }
}

/**
 * Trigger ZLOAD1 transaction via auto_gui2 /chat endpoint
 */
async function triggerZload1(
  soNumber: string,
  materials: MaterialItemPayload[]
): Promise<void> {
  const materialsList = materials
    .map((m) => `- ${m.material_code}${m.batch ? ` (batch: ${m.batch})` : ''}`)
    .join('\n');

  const instruction = `VPN is connected, SAP is logged in. Execute ZLOAD1 for sales order ${soNumber}. Materials to dispatch:\n${materialsList}`;

  const response = await fetch(
    `http://${AUTO_GUI_HOST}:${AUTO_GUI_PORT}/chat`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instruction,
        transaction_code: 'ZLOAD1',
      }),
    }
  );

  if (!response.ok) {
    throw new Error(
      `ZLOAD1 trigger failed: ${response.status} ${response.statusText}`
    );
  }

  const result = await response.json();
  console.log(`[ZLOAD1] Result for SO ${soNumber}: success=${result.success}`);
}
