import { prisma } from './prisma';
import { getThreadMessages, extractPdfAttachments, getMessageBody, sendPlainEmail, listMessages, getMessageSubject } from './gmail';
import {
  checkAndSendBatchToAman,
  handleBranchReply,
  handleProductionReply,
  handleProductionConfirmation,
  handleVehicleDetailsReply,
} from './auto-gui-trigger';
import { uploadToS3 } from './s3';

const AUTO_GUI_HOST = process.env.AUTO_GUI_HOST || 'localhost';
const AUTO_GUI_PORT = process.env.AUTO_GUI_PORT || '8000';
const PRODUCTION_EMAIL = process.env.PRODUCTION_EMAIL || '';
const BRANCH_EMAIL = process.env.BRANCH_EMAIL || '';

/**
 * Check for email replies and process them
 * New flow: Store PDF to R2, mark as 'replied', then check if all replies are in
 */
export async function checkForReplies(): Promise<{
  processed: number;
  errors: string[];
  logs: string[];
}> {
  const errors: string[] = [];
  const logs: string[] = [];
  let processed = 0;

  const log = (message: string) => {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}`;
    console.log(logMessage);
    logs.push(logMessage);
  };

  // Get all emails that are still in "sent" status
  const pendingEmails = await prisma.email.findMany({
    where: { status: 'sent' },
    include: {
      salesOrder: true,
      loadingSlipItem: true,
    },
  });

  log(`[EmailChecker] Found ${pendingEmails.length} pending emails to check`);

  if (pendingEmails.length === 0) {
    log('[EmailChecker] No pending emails, skipping check');
    return { processed: 0, errors: [], logs };
  }

  // Group by sales order for logging
  const emailsBySO = pendingEmails.reduce((acc, email) => {
    const soNumber = email.salesOrder?.soNumber || 'unknown';
    if (!acc[soNumber]) acc[soNumber] = [];
    acc[soNumber].push(email);
    return acc;
  }, {} as Record<string, typeof pendingEmails>);

  log(`[EmailChecker] Checking emails for ${Object.keys(emailsBySO).length} sales orders:`);
  for (const [soNumber, emails] of Object.entries(emailsBySO)) {
    log(`  - SO ${soNumber}: ${emails.length} pending emails`);
  }

  for (const email of pendingEmails) {
    const soNumber = email.salesOrder?.soNumber || 'unknown';
    const lsNumber = email.loadingSlipItem?.lsNumber || 'N/A';

    try {
      log(`[EmailChecker] Checking thread ${email.gmailThreadId} for SO ${soNumber} / LS ${lsNumber}`);

      // Get all messages in the thread
      const messages = await getThreadMessages(email.gmailThreadId);

      // Find reply messages (only messages AFTER our dispatch email in the thread)
      const dispatchIdx = messages.findIndex(
        (msg) => msg.id === email.gmailMessageId
      );
      const replyMessages = dispatchIdx >= 0
        ? messages.slice(dispatchIdx + 1)
        : messages.filter((msg) => msg.id !== email.gmailMessageId);

      if (replyMessages.length === 0) {
        log(`[EmailChecker] No reply yet for SO ${soNumber} / LS ${lsNumber}`);
        continue;
      }

      log(`[EmailChecker] Found ${replyMessages.length} reply(s) for SO ${soNumber} / LS ${lsNumber}`);

      // Get the latest reply
      const latestReply = replyMessages[replyMessages.length - 1];
      if (!latestReply.id) {
        continue;
      }

      // Get reply HTML body for workflow classification
      const replyBodyHtml = await getMessageBody(latestReply.id);

      // Store replyHtml on the email record
      await prisma.email.update({
        where: { id: email.id },
        data: { replyHtml: replyBodyHtml },
      });

      // Route based on emailType
      const emailType = (email as any).emailType as string | null;

      if (emailType === 'production_inquiry') {
        // Production team replied to our inquiry — extract days
        log(`[EmailChecker] Routing to handleProductionReply for SO ${soNumber}`);
        const prodResult = await handleProductionReply(email.id, replyBodyHtml);
        logs.push(...prodResult.logs);
        processed++;
        continue;
      }

      if (emailType === 'production_reminder') {
        // Production team replied to our reminder — classify confirmation
        log(`[EmailChecker] Routing to handleProductionConfirmation for SO ${soNumber}`);
        const confResult = await handleProductionConfirmation(email.id, replyBodyHtml);
        logs.push(...confResult.logs);
        processed++;
        continue;
      }

      if (emailType === 'vehicle_details') {
        // Branch replied with vehicle details
        log(`[EmailChecker] Routing to handleVehicleDetailsReply for SO ${soNumber}`);
        const vdResult = await handleVehicleDetailsReply(email.id, replyBodyHtml || '', email.salesOrderId!);
        logs.push(...vdResult.logs);
        processed++;
        continue;
      }

      if (emailType === 'plant_ls') {
        // Plant replied to LS email — only care about PDF attachment (invoice)
        log(`[EmailChecker] Plant reply for SO ${soNumber} / LS ${lsNumber}`);
        // Fall through to PDF extraction below (skip handleBranchReply)
      } else if (replyBodyHtml) {
        // Default: null or 'ls_dispatch' — this is a branch reply
        log(`[EmailChecker] Routing to handleBranchReply for SO ${soNumber} / LS ${lsNumber}`);
        // Fetch the original sent email body from Gmail
        const originalEmailHtml = await getMessageBody(email.gmailMessageId);
        const branchResult = await handleBranchReply(
          email.id,
          replyBodyHtml,
          originalEmailHtml,
          email.salesOrderId!
        );
        logs.push(...branchResult.logs);
      }

      // Also continue with existing PDF flow (legacy ZLOAD3-B path)
      // Extract PDF attachments from the reply
      const attachments = await extractPdfAttachments(latestReply.id);

      if (attachments.length === 0) {
        log(`[EmailChecker] Reply has no PDF attachment for SO ${soNumber} / LS ${lsNumber}`);
        // Reply received but no PDF attachment
        await prisma.email.update({
          where: { id: email.id },
          data: {
            status: 'replied',
            repliedAt: new Date(),
          },
        });

        // Check if all emails for this SO now have replies
        if (email.salesOrderId) {
          const batchResult = await checkAndSendBatchToAman(email.salesOrderId);
          logs.push(...batchResult.logs);
        }
        continue;
      }

      // Get the first PDF attachment (invoice)
      const invoicePdf = attachments[0];

      log(`[EmailChecker] Found PDF attachment (${invoicePdf.filename}, ${invoicePdf.content.length} bytes) for SO ${soNumber} / LS ${lsNumber}`);

      // Store reply PDF to R2 instead of parsing immediately
      const s3Key = `reply-pdfs/${soNumber}/${lsNumber}.pdf`;
      await uploadToS3(s3Key, invoicePdf.content, 'application/pdf');

      log(`[EmailChecker] Uploaded PDF to R2: ${s3Key}`);

      // Update Email status to 'replied' with the PDF URL
      await prisma.email.update({
        where: { id: email.id },
        data: {
          status: 'replied',
          repliedAt: new Date(),
          replyPdfUrl: s3Key,
        },
      });

      log(`[EmailChecker] Marked email as 'replied' for SO ${soNumber} / LS ${lsNumber}`);

      processed++;

      // Check if all emails for this SO now have replies
      if (email.salesOrderId) {
        const batchResult = await checkAndSendBatchToAman(email.salesOrderId);
        logs.push(...batchResult.logs);
      }
    } catch (error) {
      const errorMsg = `Error processing email ${email.id} (SO ${soNumber} / LS ${lsNumber}): ${
        error instanceof Error ? error.message : String(error)
      }`;
      log(`[EmailChecker] ${errorMsg}`);
      errors.push(errorMsg);
    }
  }

  log(`[EmailChecker] Check complete. Processed: ${processed}, Errors: ${errors.length}`);

  return { processed, errors, logs };
}

/**
 * Check for workflow timers that have elapsed and send reminders
 */
export async function checkWorkflowTimers(): Promise<{
  reminders_sent: number;
  errors: string[];
  logs: string[];
}> {
  const errors: string[] = [];
  const logs: string[] = [];
  let reminders_sent = 0;

  const log = (message: string) => {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}`;
    console.log(logMessage);
    logs.push(logMessage);
  };

  // Find emails where timer has elapsed
  const timerEmails = await prisma.email.findMany({
    where: {
      workflowState: 'waiting_timer',
      waitUntil: { lte: new Date() },
    },
    include: {
      salesOrder: true,
      loadingSlipItem: true,
    },
  });

  log(`[TimerCheck] Found ${timerEmails.length} emails with elapsed timers`);

  for (const email of timerEmails) {
    const soNumber = email.salesOrder?.soNumber || 'unknown';
    const storedMaterials = email.relatedMaterials
      ? JSON.parse(email.relatedMaterials)
      : [];
    // Extract string codes for /email/reminder API (accepts string[])
    const materialCodes: string[] = storedMaterials.map((m: any) =>
      typeof m === 'string' ? m : m.material_code || ''
    );

    try {
      log(`[TimerCheck] Processing timer for SO ${soNumber}`);

      // Calculate original days from when the email was sent to waitUntil
      const sentTime = email.sentAt.getTime();
      const waitTime = email.waitUntil!.getTime();
      const originalDays = Math.round((waitTime - sentTime) / 86400000);

      // Call /email/reminder on auto_gui2
      const response = await fetch(
        `http://${AUTO_GUI_HOST}:${AUTO_GUI_PORT}/email/reminder`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sales_order: soNumber,
            materials: materialCodes,
            original_days: originalDays > 0 ? originalDays : 7,
          }),
        }
      );

      const result = await response.json();

      if (!result.success || !result.email_payload) {
        log(`[TimerCheck] Reminder generation failed for SO ${soNumber}: ${result.error}`);
        errors.push(`Reminder failed for SO ${soNumber}: ${result.error}`);
        continue;
      }

      if (!PRODUCTION_EMAIL) {
        log(`[TimerCheck] PRODUCTION_EMAIL not configured`);
        errors.push('PRODUCTION_EMAIL not configured');
        continue;
      }

      // Send reminder to production
      const sentResult = await sendPlainEmail(
        PRODUCTION_EMAIL,
        result.email_payload.subject,
        result.email_payload.body
      );

      log(`[TimerCheck] Reminder sent to ${PRODUCTION_EMAIL} for SO ${soNumber}`);

      // Create new Email record for the reminder
      await prisma.email.create({
        data: {
          salesOrderId: email.salesOrderId,
          loadingSlipItemId: email.loadingSlipItemId,
          gmailMessageId: sentResult.messageId,
          gmailThreadId: sentResult.threadId,
          recipientEmail: PRODUCTION_EMAIL,
          subject: result.email_payload.subject,
          status: 'sent',
          emailType: 'production_reminder',
          workflowState: 'awaiting_confirmation',
          relatedMaterials: email.relatedMaterials,
        },
      });

      // Mark the original timer email as completed
      await prisma.email.update({
        where: { id: email.id },
        data: { workflowState: 'completed' },
      });

      reminders_sent++;
    } catch (error) {
      const errorMsg = `Timer processing error for SO ${soNumber}: ${
        error instanceof Error ? error.message : String(error)
      }`;
      log(`[TimerCheck] ${errorMsg}`);
      errors.push(errorMsg);
    }
  }

  log(`[TimerCheck] Complete. Reminders sent: ${reminders_sent}, Errors: ${errors.length}`);
  return { reminders_sent, errors, logs };
}

/**
 * Check for new incoming emails (not replies) from branch.
 * Extracts SO number from body, triggers ZSO-VISIBILITY on auto_gui2.
 */
export async function checkForNewEmails(): Promise<{
  triggered: number;
  errors: string[];
  logs: string[];
}> {
  const errors: string[] = [];
  const logs: string[] = [];
  let triggered = 0;

  const log = (message: string) => {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}`;
    console.log(logMessage);
    logs.push(logMessage);
  };

  try {
    // Search for recent emails with subject "NEW ORDER" (last 1 day, unread) from any sender
    const query = BRANCH_EMAIL
      ? `from:${BRANCH_EMAIL} subject:"NEW ORDER" newer_than:1d is:unread`
      : `subject:"NEW ORDER" newer_than:1d is:unread`;
    const messages = await listMessages(query, 10);

    log(`[NewEmail] Found ${messages.length} recent unread messages matching "NEW ORDER"`);

    if (messages.length === 0) {
      return { triggered: 0, errors: [], logs };
    }

    // Get already-processed message IDs from ProcessedEmail table
    const processedEmails = await prisma.processedEmail.findMany({
      select: { gmailMessageId: true, gmailThreadId: true },
    });
    const processedMessageIds = new Set(processedEmails.map((e) => e.gmailMessageId));
    const processedThreadIds = new Set(processedEmails.map((e) => e.gmailThreadId));

    for (const msg of messages) {
      // Skip if already processed
      if (processedMessageIds.has(msg.id) || processedThreadIds.has(msg.threadId)) {
        log(`[NewEmail] Skipping message ${msg.id} — already processed (thread: ${msg.threadId})`);
        continue;
      }

      try {
        // Track this email immediately so it won't be reprocessed even if later steps fail
        await prisma.processedEmail.create({
          data: {
            gmailMessageId: msg.id,
            gmailThreadId: msg.threadId,
          },
        });

        // Get the email body — should just contain SO number
        const body = await getMessageBody(msg.id);
        if (!body) {
          log(`[NewEmail] Empty body for message ${msg.id}, skipping`);
          continue;
        }

        // Extract SO number — trim whitespace, strip HTML tags, get the number
        const stripped = body.replace(/<[^>]*>/g, '').trim();
        const soMatch = stripped.match(/\d{7,}/); // SO numbers are 7+ digits
        if (!soMatch) {
          log(`[NewEmail] No SO number found in message ${msg.id}: "${stripped.substring(0, 50)}"`);
          continue;
        }

        const soNumber = soMatch[0].trim();
        log(`[NewEmail] Extracted SO number: ${soNumber} from message ${msg.id}`);

        // Update the processed email record with the SO number
        await prisma.processedEmail.update({
          where: { gmailMessageId: msg.id },
          data: { soNumber },
        });

        // Create PO + SO in DB so it shows on dashboard
        let salesOrder = await prisma.salesOrder.findFirst({ where: { soNumber } });
        if (!salesOrder) {
          const subject = await getMessageSubject(msg.id);
          const purchaseOrder = await prisma.purchaseOrder.create({
            data: {
              poNumber: `AUTO-${soNumber}`,
              customerName: subject || `Branch Order ${soNumber}`,
              status: 'in-progress',
              stage: 1,
            },
          });
          salesOrder = await prisma.salesOrder.create({
            data: {
              purchaseOrderId: purchaseOrder.id,
              soNumber,
              status: 'pending',
              originalThreadId: msg.threadId,
              originalMessageId: msg.id,
            },
          });
          log(`[NewEmail] Created PO ${purchaseOrder.poNumber} + SO ${soNumber} in dashboard`);
        } else if (!salesOrder.originalThreadId) {
          // SO already exists but missing thread info — backfill
          await prisma.salesOrder.update({
            where: { id: salesOrder.id },
            data: {
              originalThreadId: msg.threadId,
              originalMessageId: msg.id,
            },
          });
        }

        // Save to CurrentSO so visibility-data endpoint knows which SO
        await prisma.currentSO.deleteMany();
        await prisma.currentSO.create({ data: { soNumber } });

        // Trigger ZSO-VISIBILITY on auto_gui2
        try {
          const response = await fetch(
            `http://${AUTO_GUI_HOST}:8000/chat`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                instruction: `VPN is connected and SAP is logged in. Just go ahead and run the SAP Transaction ZSO-VISIBILITY for Sales order number ${soNumber}.`,
                transaction_code: 'ZSO-VISIBILITY',
                so_number: soNumber,
              }),
            }
          );

          if (!response.ok) {
            log(`[NewEmail] ZSO-VISIBILITY trigger failed for SO ${soNumber}: ${response.statusText}`);
            errors.push(`ZSO-VISIBILITY failed for SO ${soNumber}`);
          } else {
            log(`[NewEmail] ZSO-VISIBILITY triggered for SO ${soNumber}`);
          }
        } catch (fetchError) {
          log(`[NewEmail] ZSO-VISIBILITY call failed for SO ${soNumber} (will not retry): ${fetchError instanceof Error ? fetchError.message : String(fetchError)}`);
          errors.push(`ZSO-VISIBILITY unreachable for SO ${soNumber}`);
        }

        triggered++;
      } catch (error) {
        const cause = error instanceof Error && (error as any).cause ? ` cause: ${String((error as any).cause)}` : '';
        const errorMsg = `Error processing message ${msg.id}: ${
          error instanceof Error ? error.message : String(error)
        }${cause}`;
        log(`[NewEmail] ${errorMsg}`);
        errors.push(errorMsg);
      }
    }
  } catch (error) {
    const errorDetail = error instanceof Error ? `${error.message} ${error.stack?.split('\n')[1] || ''}` : String(error);
    const errorMsg = `Error checking new emails: ${errorDetail}`;
    log(`[NewEmail] ${errorMsg}`);
    errors.push(errorMsg);
  }

  log(`[NewEmail] Complete. Triggered: ${triggered}, Errors: ${errors.length}`);
  return { triggered, errors, logs };
}
