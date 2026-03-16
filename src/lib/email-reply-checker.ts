import { prisma } from './prisma';
import { getThreadMessages, extractPdfAttachments, getMessageBody, sendPlainEmail } from './gmail';
import {
  checkAndSendBatchToAman,
  handleBranchReply,
  handleProductionReply,
  handleProductionConfirmation,
} from './auto-gui-trigger';
import { uploadToS3 } from './s3';

const AUTO_GUI_HOST = process.env.AUTO_GUI_HOST || 'localhost';
const AUTO_GUI_PORT = process.env.AUTO_GUI_PORT || '8080';
const PRODUCTION_EMAIL = process.env.PRODUCTION_EMAIL || '';

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
      loadingSlipItem: {
        include: {
          salesOrder: true,
        },
      },
    },
  });

  log(`[EmailChecker] Found ${pendingEmails.length} pending emails to check`);

  if (pendingEmails.length === 0) {
    log('[EmailChecker] No pending emails, skipping check');
    return { processed: 0, errors: [], logs };
  }

  // Group by sales order for logging
  const emailsBySO = pendingEmails.reduce((acc, email) => {
    const soNumber = email.loadingSlipItem.salesOrder.soNumber;
    if (!acc[soNumber]) acc[soNumber] = [];
    acc[soNumber].push(email);
    return acc;
  }, {} as Record<string, typeof pendingEmails>);

  log(`[EmailChecker] Checking emails for ${Object.keys(emailsBySO).length} sales orders:`);
  for (const [soNumber, emails] of Object.entries(emailsBySO)) {
    log(`  - SO ${soNumber}: ${emails.length} pending emails`);
  }

  for (const email of pendingEmails) {
    const soNumber = email.loadingSlipItem.salesOrder.soNumber;
    const lsNumber = email.loadingSlipItem.lsNumber;

    try {
      log(`[EmailChecker] Checking thread ${email.gmailThreadId} for SO ${soNumber} / LS ${lsNumber}`);

      // Get all messages in the thread
      const messages = await getThreadMessages(email.gmailThreadId);

      // Find reply messages (messages that are not the original)
      const replyMessages = messages.filter(
        (msg) => msg.id !== email.gmailMessageId
      );

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

      // Default: null or 'ls_dispatch' — this is a branch reply
      // First, try the new workflow classification
      if (replyBodyHtml) {
        log(`[EmailChecker] Routing to handleBranchReply for SO ${soNumber} / LS ${lsNumber}`);
        // Fetch the original sent email body from Gmail
        const originalEmailHtml = await getMessageBody(email.gmailMessageId);
        const branchResult = await handleBranchReply(
          email.id,
          replyBodyHtml,
          originalEmailHtml,
          email.loadingSlipItem.salesOrderId
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
        const batchResult = await checkAndSendBatchToAman(email.loadingSlipItem.salesOrderId);
        logs.push(...batchResult.logs);
        continue;
      }

      // Get the first PDF attachment (invoice)
      const invoicePdf = attachments[0];
      const salesOrder = email.loadingSlipItem.salesOrder;

      log(`[EmailChecker] Found PDF attachment (${invoicePdf.filename}, ${invoicePdf.content.length} bytes) for SO ${soNumber} / LS ${lsNumber}`);

      // Store reply PDF to R2 instead of parsing immediately
      const s3Key = `reply-pdfs/${salesOrder.soNumber}/${email.loadingSlipItem.lsNumber}.pdf`;
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
      const batchResult = await checkAndSendBatchToAman(email.loadingSlipItem.salesOrderId);
      logs.push(...batchResult.logs);
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
      loadingSlipItem: {
        include: { salesOrder: true },
      },
    },
  });

  log(`[TimerCheck] Found ${timerEmails.length} emails with elapsed timers`);

  for (const email of timerEmails) {
    const soNumber = email.loadingSlipItem.salesOrder.soNumber;
    const materials: string[] = email.relatedMaterials
      ? JSON.parse(email.relatedMaterials)
      : [];

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
            materials,
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
