import { prisma } from './prisma';
import { getThreadMessages, extractPdfAttachments } from './gmail';
import { checkAndSendBatchToAman } from './auto-gui-trigger';
import { uploadToS3 } from './s3';

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
