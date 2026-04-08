import { prisma } from './prisma';
import { downloadFromS3 } from './s3';
import { sendPlainEmail, sendReplyEmail, getMessageRfc822Id } from './gmail';
import { sendLSEmail } from './email-service';
import OpenAI from 'openai';
import { z } from 'zod';

const AUTO_GUI_HOST = process.env.AUTO_GUI_HOST || 'localhost';
const AUTO_GUI_PORT = process.env.AUTO_GUI_PORT || '8000';
const PRODUCTION_EMAIL = process.env.PRODUCTION_EMAIL || '';
const BRANCH_EMAIL = process.env.BRANCH_EMAIL || '';

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

  // Collect ALL reply PDFs (one per LS item)
  const attachments: Array<{ filename: string; content_base64: string }> = [];

  try {
    for (const item of salesOrder.items) {
      const repliedEmail = item.emails.find(
        (e) => e.status === 'replied' && e.replyPdfUrl
      );
      if (!repliedEmail || !repliedEmail.replyPdfUrl) {
        log(`[BatchSender] Item LS ${item.lsNumber} missing replyPdfUrl despite allReplied check — aborting`);
        return { success: false, logs };
      }
      log(`[BatchSender] Downloading PDF from R2 for LS ${item.lsNumber}: ${repliedEmail.replyPdfUrl}`);
      const pdfBuffer = await downloadFromS3(repliedEmail.replyPdfUrl);
      log(`[BatchSender] Downloaded PDF for LS ${item.lsNumber}: ${pdfBuffer.length} bytes`);
      attachments.push({
        filename: `${item.lsNumber}.pdf`,
        content_base64: pdfBuffer.toString('base64'),
      });
    }

    // Build instruction
    const instruction = `VPN is connected, SAP is logged in. Just execute ZLOAD3-B1 for the sales order ${salesOrder.soNumber}`;

    const totalBytes = attachments.reduce((sum, a) => sum + Buffer.from(a.content_base64, 'base64').length, 0);
    log(`[BatchSender] Sending to auto_gui2:`);
    log(`  - Instruction: ${instruction}`);
    log(`  - Attachments: ${attachments.length} PDF(s), total ${totalBytes} bytes`);
    for (const a of attachments) {
      const bytes = Buffer.from(a.content_base64, 'base64').length;
      log(`      • ${a.filename} (${bytes} bytes)`);
    }

    // Fire-and-forget: auto_gui2 will call back /backend/orders/aman/processing-data when done
    fetch(`http://${AUTO_GUI_HOST}:8000/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instruction,
        transaction_code: 'ZLOAD3-B1',
        so_number: salesOrder.soNumber,
        attachments,
        extraction_context:
          'For each file, extract the loaded quantity, invoice number, and invoice date',
      }),
    }).then((res) => {
      if (!res.ok) {
        console.error(`[BatchSender] auto_gui2 returned ${res.status} for SO ${salesOrder.soNumber}`);
      }
    }).catch((err) => {
      console.error(`[BatchSender] auto_gui2 unreachable for SO ${salesOrder.soNumber}: ${err instanceof Error ? err.message : String(err)}`);
    });

    log(`[BatchSender] Fired ZLOAD3-B1 to auto_gui2 for SO ${salesOrder.soNumber} with ${attachments.length} attachment(s) (fire-and-forget — status updates will happen when /processing-data callback arrives)`);
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
export async function updatePurchaseOrderStage(
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
        salesOrder: true,
        loadingSlipItem: true,
      },
    });

    if (!email) {
      log(`[BranchReply] Email not found: ${emailId}`);
      return { success: false, logs };
    }

    const soNumber = email.salesOrder!.soNumber;
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
      // Get stored materials (with batch + quantity) from visibility-data
      const storedMaterials: Array<{
        material_code: string;
        batch_number: string;
        order_quantity: number;
      }> = email.relatedMaterials ? JSON.parse(email.relatedMaterials) : [];

      // Map LLM result materials to stored data (merge batch/qty from visibility-data)
      const llmMaterials = result.materials || [];
      const materials: MaterialItemPayload[] = llmMaterials.map((m: any) => {
        // Try to find matching stored material for quantity
        const stored = storedMaterials.find(
          (s) => s.material_code === m.material_code || s.batch_number === m.batch
        );
        return {
          material_code: m.material_code,
          batch: m.batch || stored?.batch_number || '',
          quantity: stored?.order_quantity || m.quantity || 0,
        };
      });

      // Update SO status to stock_approved
      await prisma.salesOrder.update({
        where: { id: email.salesOrderId! },
        data: { status: 'stock_approved' },
      });
      log(`[BranchReply] SO ${soNumber} status updated to stock_approved`);

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
          salesOrderId: email.salesOrderId,
          loadingSlipItemId: email.loadingSlipItemId,
          gmailMessageId: sentResult.messageId,
          gmailThreadId: sentResult.threadId,
          recipientEmail: PRODUCTION_EMAIL,
          subject: emailPayload.subject,
          status: 'sent',
          emailType: 'production_inquiry',
          workflowState: 'awaiting_production_reply',
          // Carry forward full materials data (with batch + qty) for ZLOAD1 later
          // Filter stored materials to only include the missing ones
          relatedMaterials: (() => {
            const missingCodes: string[] = result.missing_materials || [];
            const allStored = email.relatedMaterials ? JSON.parse(email.relatedMaterials) : [];
            // If stored data has full objects, filter to missing ones
            if (allStored.length > 0 && typeof allStored[0] === 'object') {
              const filtered = allStored.filter((m: any) =>
                missingCodes.some((code) => m.material_code === code || code.includes(m.material_code))
              );
              return JSON.stringify(filtered.length > 0 ? filtered : allStored);
            }
            return JSON.stringify(missingCodes);
          })(),
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
    const cause = error instanceof Error && (error as any).cause ? ` | cause: ${String((error as any).cause)}` : '';
    log(
      `[BranchReply] Error: ${error instanceof Error ? error.message : String(error)}${cause} | endpoint: http://${AUTO_GUI_HOST}:${AUTO_GUI_PORT}/email/branch-reply`
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
        salesOrder: true,
        loadingSlipItem: true,
      },
    });

    if (!email) {
      log(`[ProductionReply] Email not found: ${emailId}`);
      return { success: false, logs };
    }

    const soNumber = email.salesOrder!.soNumber;
    const storedMaterials = email.relatedMaterials
      ? JSON.parse(email.relatedMaterials)
      : [];
    // Extract string codes for /email/* API (accepts string[])
    const materialCodes: string[] = storedMaterials.map((m: any) =>
      typeof m === 'string' ? m : m.material_code || ''
    );

    log(`[ProductionReply] Parsing production reply for SO ${soNumber}`);

    const response = await fetch(
      `http://${AUTO_GUI_HOST}:${AUTO_GUI_PORT}/email/production-reply`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          production_reply_html: replyHtml,
          sales_order: soNumber,
          materials: materialCodes,
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
        salesOrder: true,
        loadingSlipItem: true,
      },
    });

    if (!email) {
      log(`[ProductionConfirmation] Email not found: ${emailId}`);
      return { success: false, logs };
    }

    const soNumber = email.salesOrder!.soNumber;
    const storedMaterials = email.relatedMaterials
      ? JSON.parse(email.relatedMaterials)
      : [];
    // Extract string codes for /email/* API (accepts string[])
    const materialCodes: string[] = storedMaterials.map((m: any) =>
      typeof m === 'string' ? m : m.material_code || ''
    );

    log(`[ProductionConfirmation] Classifying confirmation for SO ${soNumber}`);

    const response = await fetch(
      `http://${AUTO_GUI_HOST}:${AUTO_GUI_PORT}/email/production-confirmation`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reply_html: replyHtml,
          sales_order: soNumber,
          materials: materialCodes,
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
      // Re-trigger ZSO-VISIBILITY to get fresh batch/material data
      // Pipeline: ZSO-VISIBILITY → Zmatana → Policy Run → Email to Branch → Branch decides
      await triggerZsoVisibility(soNumber);

      await prisma.email.update({
        where: { id: emailId },
        data: {
          status: 'replied',
          repliedAt: new Date(),
          replyHtml,
          workflowState: 'completed',
        },
      });

      log(`[ProductionConfirmation] Materials ready, ZSO-VISIBILITY re-triggered for SO ${soNumber}`);
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
 * Re-trigger ZSO-VISIBILITY so the pipeline re-checks fresh batch/material
 * data in SAP after production confirms materials are available.
 *
 * Flow: ZSO-VISIBILITY → Zmatana → Policy Run → Email to Branch → Branch decides
 */
async function triggerZsoVisibility(soNumber: string): Promise<void> {
  // Update CurrentSO singleton so visibility-data endpoint knows which SO
  await prisma.currentSO.deleteMany();
  await prisma.currentSO.create({ data: { soNumber } });

  // Trigger ZSO-VISIBILITY on auto_gui2
  const response = await fetch(`http://${AUTO_GUI_HOST}:8000/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instruction: `VPN is connected and SAP is logged in. Just go ahead and run the SAP Transaction ZSO-VISIBILITY for Sales order number ${soNumber}.`,
      transaction_code: 'ZSO-VISIBILITY',
      so_number: soNumber,
    }),
  });

  if (!response.ok) {
    throw new Error(`ZSO-VISIBILITY trigger failed: ${response.status} ${response.statusText}`);
  }

  const result = await response.json();
  console.log(`[ZSO-VISIBILITY] Re-triggered for SO ${soNumber}: success=${result.success}`);
}

/**
 * Trigger VTO1N-B (Create Shipment) transaction via auto_gui2 /chat endpoint
 *
 * Called after user provides LR number, LR date, and vehicle number from the frontend.
 * OBD number comes from the Invoice (set by processing-data).
 */
export async function triggerVto1n(
  soNumber: string,
  obdNumber: string,
  lrNumber: string,
  lrDate: Date,
  vehicleNumber: string
): Promise<void> {
  // Format lrDate as DD.MM.YYYY (SAP format) using UTC methods
  const dd = String(lrDate.getUTCDate()).padStart(2, '0');
  const mm = String(lrDate.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = lrDate.getUTCFullYear();
  const formattedDate = `${dd}.${mm}.${yyyy}`;

  // Set invoice status to 'shipment-triggered' as a double-trigger guard
  await prisma.invoice.updateMany({
    where: { obdNumber, status: 'created' },
    data: { status: 'shipment-triggered' },
  });

  try {
    const response = await fetch(`http://${AUTO_GUI_HOST}:8000/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instruction: `VPN is connected and SAP is logged in. Just go ahead and run the SAP Transaction VT01N. OBD number is ${obdNumber}, LR number is ${lrNumber}, LR date is ${formattedDate} and Vehicle number is ${vehicleNumber}`,
        transaction_code: 'VTO1N-B',
        so_number: soNumber,
        extraction_context: 'Extract the OBD number, LR number, LR date and Vehicle number',
      }),
    });

    if (!response.ok) {
      throw new Error(`VTO1N-B trigger failed: ${response.status} ${response.statusText}`);
    }

    const result = await response.json();
    console.log(`[VTO1N-B] Result for SO ${soNumber}: success=${result.success}`);
  } catch (error) {
    console.error(`[VTO1N-B] Failed for SO ${soNumber}:`, error);
    // Reset invoice status back to 'created' on failure
    await prisma.invoice.updateMany({
      where: { obdNumber, status: 'shipment-triggered' },
      data: { status: 'created' },
    });
    throw error;
  }
}

/**
 * Trigger ZLOAD1 transaction via auto_gui2 /chat endpoint
 *
 * ZLOAD1 expects per-material: material_code, batch, quantity (pick qty)
 * It creates a loading slip and sends it back via send_data
 */
async function triggerZload1(
  soNumber: string,
  materials: MaterialItemPayload[]
): Promise<void> {
  const materialsList = materials
    .map(
      (m) =>
        `- Material: ${m.material_code}, Batch: ${m.batch || 'N/A'}, Quantity: ${m.quantity || 0}`
    )
    .join('\n');

  const instruction = `VPN is connected, SAP is logged in. Execute ZLOAD1 for sales order ${soNumber}. Materials to dispatch:\n${materialsList}`;

  const response = await fetch(
    `http://${AUTO_GUI_HOST}:8000/chat`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instruction,
        transaction_code: 'ZLOAD1',
        so_number: soNumber,
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

/**
 * Handle reply to vehicle details email.
 * Uses OpenAI to extract vehicle number, driver mobile, container number.
 * If all 3 present → save to SO + trigger ZLOAD3-A.
 * If any missing → reply asking for complete details.
 */
export async function handleVehicleDetailsReply(
  emailId: string,
  replyHtml: string,
  salesOrderId: string
): Promise<{ success: boolean; logs: string[] }> {
  const logs: string[] = [];
  const log = (message: string) => {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}`;
    console.log(logMessage);
    logs.push(logMessage);
  };

  const email = await prisma.email.findUnique({
    where: { id: emailId },
    include: {
      salesOrder: true,
      loadingSlipItem: true,
    },
  });

  if (!email) {
    log(`[VehicleDetails] Email not found: ${emailId}`);
    return { success: false, logs };
  }

  const soNumber = email.salesOrder!.soNumber;
  log(`[VehicleDetails] Extracting vehicle details from reply for SO ${soNumber}`);

  // Strip HTML tags for cleaner text
  const replyText = replyHtml.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

  // Extract fields using OpenAI
  const VehicleDetailsSchema = z.object({
    vehicleNumber: z.string().describe('Vehicle registration number, e.g. GJ12AB1234'),
    driverMobile: z.string().describe('Driver mobile phone number, e.g. 9876543210'),
    containerNumber: z.string().describe('Container/shipment number'),
  });

  try {
    const openai = new OpenAI();
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: 'You extract vehicle/transport details from email replies. Return a JSON object with vehicleNumber, driverMobile, and containerNumber. If a field is not mentioned or unclear, set it to an empty string "".',
        },
        {
          role: 'user',
          content: `Extract vehicle details from this email reply:\n\n${replyText}`,
        },
      ],
    });

    const rawJson = completion.choices[0]?.message?.content;
    let vehicleNumber = '';
    let driverMobile = '';
    let containerNumber = '';

    if (rawJson) {
      try {
        const parsed = VehicleDetailsSchema.safeParse(JSON.parse(rawJson));
        if (parsed.success) {
          vehicleNumber = parsed.data.vehicleNumber;
          driverMobile = parsed.data.driverMobile;
          containerNumber = parsed.data.containerNumber;
        } else {
          log(`[VehicleDetails] Zod validation failed: ${parsed.error.message}`);
        }
      } catch (parseErr) {
        log(`[VehicleDetails] JSON parse failed: ${parseErr instanceof Error ? parseErr.message : parseErr}`);
      }
    } else {
      log(`[VehicleDetails] OpenAI returned empty response`);
    }
    log(`[VehicleDetails] Extracted: vehicle=${vehicleNumber}, driver=${driverMobile}, container=${containerNumber}`);

    // Check if all fields are present
    if (!vehicleNumber || !driverMobile || !containerNumber) {
      log(`[VehicleDetails] Missing fields, asking for complete details`);

      // Reply asking for complete details
      const missingFields: string[] = [];
      if (!vehicleNumber) missingFields.push('Vehicle Number');
      if (!driverMobile) missingFields.push('Driver Mobile Number');
      if (!containerNumber) missingFields.push('Container Number');

      const replyBody = [
        `Thank you for your reply regarding Sales Order ${soNumber}.`,
        '',
        `The following details are still missing: ${missingFields.join(', ')}`,
        '',
        'Please reply with the complete details:',
        '1. Vehicle Number (e.g., GJ12AB1234)',
        '2. Driver Mobile Number (e.g., 9876543210)',
        '3. Container Number',
      ].join('\n');

      try {
        const so = email.salesOrder!;
        let replyResult: { messageId: string; threadId: string };

        if (so.originalThreadId && so.originalMessageId) {
          try {
            const rfc822Id = await getMessageRfc822Id(so.originalMessageId);
            if (rfc822Id) {
              replyResult = await sendReplyEmail(BRANCH_EMAIL, `Re: Vehicle Details - SO ${soNumber}`, replyBody, so.originalThreadId, rfc822Id);
            } else {
              replyResult = await sendPlainEmail(BRANCH_EMAIL, `Vehicle Details Required - SO ${soNumber}`, replyBody);
            }
          } catch {
            replyResult = await sendPlainEmail(BRANCH_EMAIL, `Vehicle Details Required - SO ${soNumber}`, replyBody);
          }
        } else {
          replyResult = await sendPlainEmail(BRANCH_EMAIL, `Vehicle Details Required - SO ${soNumber}`, replyBody);
        }

        // Update email record to track the new message (keep status 'sent' for continued polling)
        await prisma.email.update({
          where: { id: emailId },
          data: {
            gmailMessageId: replyResult.messageId,
            gmailThreadId: replyResult.threadId,
            status: 'sent',
          },
        });

        log(`[VehicleDetails] Sent follow-up asking for missing fields: ${missingFields.join(', ')}`);
      } catch (sendErr) {
        log(`[VehicleDetails] Failed to send follow-up: ${sendErr instanceof Error ? sendErr.message : sendErr}`);
      }

      return { success: true, logs };
    }

    // All fields present — save to SalesOrder
    await prisma.salesOrder.update({
      where: { id: salesOrderId },
      data: { vehicleNumber, driverMobile, containerNumber },
    });
    log(`[VehicleDetails] Saved vehicle details to SO ${soNumber}`);

    // Mark email as completed
    await prisma.email.update({
      where: { id: emailId },
      data: { status: 'replied', repliedAt: new Date(), workflowState: 'completed' },
    });

    // Send stored LS PDF(s) directly to plant (skip ZLOAD3-A — file already in R2 from ZLOAD1)
    const lsItems = await prisma.loadingSlipItem.findMany({
      where: { salesOrderId, fileUrl: { not: null } },
    });

    if (lsItems.length === 0) {
      log(`[VehicleDetails] No LS files found for SO ${soNumber}, skipping plant email`);
    } else {
      for (const item of lsItems) {
        try {
          const pdfBuffer = await downloadFromS3(item.fileUrl!);
          const filename = item.fileUrl!.split('/').pop() || `${item.lsNumber}.pdf`;
          await sendLSEmail(
            item.id,
            salesOrderId,
            soNumber,
            item.lsNumber,
            pdfBuffer,
            { vehicleNumber, driverMobile, containerNumber },
            filename
          );
          log(`[VehicleDetails] Sent LS ${item.lsNumber} to plant for SO ${soNumber}`);
        } catch (sendErr) {
          log(`[VehicleDetails] Failed to send LS ${item.lsNumber} to plant: ${sendErr instanceof Error ? sendErr.message : sendErr}`);
        }
      }
    }

    return { success: true, logs };
  } catch (error) {
    log(`[VehicleDetails] Error: ${error instanceof Error ? error.message : error}`);
    return { success: false, logs };
  }
}
