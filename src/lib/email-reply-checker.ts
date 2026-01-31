import { prisma } from './prisma';
import { getThreadMessages, extractPdfAttachments } from './gmail';
import { checkAndTriggerZLOAD3 } from './auto-gui-trigger';

const AUTO_GUI_HOST = process.env.AUTO_GUI_HOST || 'localhost';

interface ParsedInvoiceData {
  plantInvoiceNumber?: string;
  plantInvoiceDate?: string;
  invoiceQuantity?: number;
  invoiceWeight?: number;
}

/**
 * Parse invoice PDF using auto_gui2 email_parser_service
 */
async function parseInvoicePdf(pdfBuffer: Buffer): Promise<ParsedInvoiceData> {
  const formData = new FormData();
  // Convert Buffer to Uint8Array for Blob compatibility
  const uint8Array = new Uint8Array(pdfBuffer);
  formData.append(
    'file',
    new Blob([uint8Array], { type: 'application/pdf' }),
    'invoice.pdf'
  );

  const response = await fetch(`http://${AUTO_GUI_HOST}:8000/parse-invoice`, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`Failed to parse invoice PDF: ${response.statusText}`);
  }

  return response.json();
}

/**
 * Check for email replies and process them
 */
export async function checkForReplies(): Promise<{
  processed: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let processed = 0;

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

  for (const email of pendingEmails) {
    try {
      // Get all messages in the thread
      const messages = await getThreadMessages(email.gmailThreadId);

      // Find reply messages (messages that are not the original)
      const replyMessages = messages.filter(
        (msg) => msg.id !== email.gmailMessageId
      );

      if (replyMessages.length === 0) {
        continue; // No reply yet
      }

      // Get the latest reply
      const latestReply = replyMessages[replyMessages.length - 1];
      if (!latestReply.id) {
        continue;
      }

      // Extract PDF attachments from the reply
      const attachments = await extractPdfAttachments(latestReply.id);

      if (attachments.length === 0) {
        // Reply received but no PDF attachment
        await prisma.email.update({
          where: { id: email.id },
          data: {
            status: 'replied',
            repliedAt: new Date(),
          },
        });
        continue;
      }

      // Parse the first PDF attachment (invoice)
      const invoicePdf = attachments[0];
      const parsedData = await parseInvoicePdf(invoicePdf.content);

      // Update LoadingSlipItem with parsed invoice data
      await prisma.loadingSlipItem.update({
        where: { id: email.loadingSlipItemId },
        data: {
          plantInvoiceNumber: parsedData.plantInvoiceNumber || null,
          plantInvoiceDate: parsedData.plantInvoiceDate
            ? new Date(parsedData.plantInvoiceDate)
            : null,
          invoiceQuantity: parsedData.invoiceQuantity || null,
          invoiceWeight: parsedData.invoiceWeight || null,
          status: 'completed',
        },
      });

      // Update Email status
      await prisma.email.update({
        where: { id: email.id },
        data: {
          status: 'processed',
          repliedAt: new Date(),
        },
      });

      processed++;

      // Check if all emails for this SO are now processed
      await checkAndTriggerZLOAD3(email.loadingSlipItem.salesOrderId);
    } catch (error) {
      const errorMsg = `Error processing email ${email.id}: ${
        error instanceof Error ? error.message : String(error)
      }`;
      console.error(errorMsg);
      errors.push(errorMsg);
    }
  }

  return { processed, errors };
}
