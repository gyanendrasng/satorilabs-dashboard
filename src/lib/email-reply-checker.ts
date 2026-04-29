import { prisma } from './prisma';
import { getThreadMessages, extractPdfAttachments, getMessageBody, sendPlainEmail, listMessages, getMessageSubject } from './gmail';
import {
  checkAndSendBatchToAman,
  handleBranchReply,
  handleProductionReply,
  handleProductionConfirmation,
  handleVehicleDetailsReply,
  handleVehicleSplitConfirmation,
  triggerZsoVisibility,
  assembleAndSendCombinedEmail,
} from './auto-gui-trigger';
import { uploadToS3 } from './s3';
import { extractOrderInfoWithAI, extractOrderInfoFallback } from './so-extractor';
import { markFailed, pumpQueue } from './work-queue';

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

  // Get all emails that are still in "sent" status and not yet completed
  // by a workflow handler (handleBranchReply marks workflowState='completed'
  // after firing ZLOAD1 fire-and-forget — those should not be reprocessed).
  // NOTE: workflowState is NULL for legacy/plant_ls emails, so we must
  // explicitly include NULL — `{ not: 'completed' }` alone excludes NULL
  // due to standard SQL three-valued logic.
  const pendingEmails = await prisma.email.findMany({
    where: {
      status: 'sent',
      OR: [
        { workflowState: null },
        { workflowState: { not: 'completed' } },
      ],
    },
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

      if (emailType === 'vehicle_split_inquiry') {
        log(`[EmailChecker] Routing to handleVehicleSplitConfirmation for PO email ${email.id}`);
        const splitResult = await handleVehicleSplitConfirmation(email.id, replyBodyHtml);
        logs.push(...splitResult.logs);
        processed++;
        continue;
      }

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

        // Branch replies are fully owned by handleBranchReply (ZLOAD1 result
        // arrives via the zload1-data callback). Do NOT fall through to the
        // legacy ZLOAD3-B1 PDF/BatchSender flow.
        processed++;
        continue;
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
      typeof m === 'string' ? m : (m.material ?? m.material_code ?? '')
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

        // Get the email body — may contain 1–4 SO numbers
        const body = await getMessageBody(msg.id);
        if (!body) {
          log(`[NewEmail] Empty body for message ${msg.id}, skipping`);
          continue;
        }

        const stripped = body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

        // Extract customer_id + SO numbers via AI; fall back to regex on failure.
        let customerId: string | null = null;
        let soNumbers: string[] = [];
        try {
          const extracted = await extractOrderInfoWithAI(stripped);
          customerId = extracted.customerId;
          soNumbers = extracted.soNumbers;
          log(`[NewEmail] AI extracted from ${msg.id}: customerId=${customerId ?? '(none)'}, soNumbers=${soNumbers.join(', ')}`);
        } catch (aiErr) {
          log(`[NewEmail] AI extraction failed (${aiErr instanceof Error ? aiErr.message : String(aiErr)}), falling back to regex`);
          const fb = extractOrderInfoFallback(stripped);
          customerId = fb.customerId;
          soNumbers = fb.soNumbers;
          if (soNumbers.length > 0) {
            log(`[NewEmail] Fallback regex extracted: customerId=${customerId ?? '(none)'}, soNumbers=${soNumbers.join(', ')}`);
          }
        }

        if (soNumbers.length === 0) {
          log(`[NewEmail] No SO numbers found in message ${msg.id}: "${stripped.substring(0, 80)}"`);
          continue;
        }

        // Upsert Customer if we extracted an id; auto-create with generic name + default 31t capacity.
        let customer: { id: string; name: string } | null = null;
        if (customerId) {
          const existing = await prisma.customer.findUnique({ where: { id: customerId } });
          if (existing) {
            customer = { id: existing.id, name: existing.name };
          } else {
            const count = await prisma.customer.count();
            const created = await prisma.customer.create({
              data: { id: customerId, name: `Customer ${count + 1}` },
            });
            customer = { id: created.id, name: created.name };
            log(`[NewEmail] Created new Customer ${customerId} ("${created.name}", default 31 tonne capacity)`);
          }
        }

        // Update the processed email record with the CSV list
        await prisma.processedEmail.update({
          where: { gmailMessageId: msg.id },
          data: { soNumbers: soNumbers.join(',') },
        });

        // Create or reuse the PO (one PO per NEW ORDER email; keyed by Gmail message ID)
        const poNumber = `AUTO-${msg.id}`;
        const subject = await getMessageSubject(msg.id);
        const purchaseOrder = await prisma.purchaseOrder.upsert({
          where: { poNumber },
          update: customer ? { customerId: customer.id } : {},
          create: {
            poNumber,
            customerName: customer?.name || subject || `Branch Order (${soNumbers.length} SOs)`,
            customerId: customer?.id,
            status: 'in-progress',
            stage: 1,
          },
        });

        // Create or backfill SOs (skip ones that already exist for this PO)
        const createdSoNumbers: string[] = [];
        for (const soNumber of soNumbers) {
          const existing = await prisma.salesOrder.findFirst({ where: { soNumber, purchaseOrderId: purchaseOrder.id } });
          if (existing) {
            if (!existing.originalThreadId) {
              await prisma.salesOrder.update({
                where: { id: existing.id },
                data: {
                  originalThreadId: msg.threadId,
                  originalMessageId: msg.id,
                  visibilityState: existing.visibilityState ?? 'queued',
                },
              });
            }
            continue;
          }
          await prisma.salesOrder.create({
            data: {
              purchaseOrderId: purchaseOrder.id,
              soNumber,
              status: 'pending',
              originalThreadId: msg.threadId,
              originalMessageId: msg.id,
              visibilityState: 'queued',
            },
          });
          createdSoNumbers.push(soNumber);
        }
        log(`[NewEmail] PO ${poNumber}: ${createdSoNumbers.length} new SO(s), ${soNumbers.length - createdSoNumbers.length} already existed (total ${soNumbers.length})`);

        // Enqueue ZSO-VISIBILITY for every queued SO of this PO. The global
        // WorkQueue ensures only one fires at a time across the whole system,
        // even when multiple POs land at once.
        const queuedSOs = await prisma.salesOrder.findMany({
          where: { purchaseOrderId: purchaseOrder.id, visibilityState: 'queued' },
          orderBy: { createdAt: 'asc' },
        });

        if (queuedSOs.length === 0) {
          log(`[NewEmail] No queued SOs for PO ${poNumber} (already in progress?), skipping`);
          triggered++;
          continue;
        }

        for (const so of queuedSOs) {
          await prisma.salesOrder.update({
            where: { id: so.id },
            data: { visibilityState: 'firing' }, // marks "in pipeline"; queue controls ordering
          });
          try {
            await triggerZsoVisibility(so.soNumber);
          } catch (fetchError) {
            log(`[NewEmail] enqueue ZSO-VISIBILITY failed for SO ${so.soNumber}: ${fetchError instanceof Error ? fetchError.message : String(fetchError)}`);
            errors.push(`enqueue ZSO-VISIBILITY failed for SO ${so.soNumber}`);
          }
        }
        log(`[NewEmail] PO ${poNumber}: enqueued ZSO-VISIBILITY for ${queuedSOs.length} SO(s)`);

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

/**
 * Recover the multi-SO serial pipeline when an SO is stuck in `visibilityState='firing'`
 * past the stale threshold (e.g. auto_gui2 crashed before it could call /visibility-data).
 *
 * Strategy:
 *   - For each stale firing SO: re-fire ZSO-VISIBILITY up to MAX_VISIBILITY_RETRIES,
 *     then mark it 'failed' and let the PO settle with the SOs that did succeed.
 *   - For each PO whose every SO is in {received, failed} but with no sent ls_dispatch
 *     email yet, call assembleAndSendCombinedEmail (idempotent).
 */
export async function checkStaleVisibility(): Promise<{
  recovered: number;
  combinedSent: number;
  errors: string[];
  logs: string[];
}> {
  const errors: string[] = [];
  const logs: string[] = [];
  let recovered = 0;
  let combinedSent = 0;

  const log = (message: string) => {
    const m = `[${new Date().toISOString()}] ${message}`;
    console.log(m);
    logs.push(m);
  };

  const staleMinutes = parseInt(process.env.STALE_VISIBILITY_MINUTES || '15', 10);
  const cutoff = new Date(Date.now() - staleMinutes * 60_000);

  // Step 1: any WorkQueue row stuck `firing` past the cutoff is treated as
  // abandoned by auto_gui2 (no /step-status callback ever arrived). Mark it
  // failed and pump the queue so the next item fires.
  const stuckWork = await prisma.workQueue.findMany({
    where: { state: 'firing', startedAt: { lt: cutoff } },
    orderBy: { startedAt: 'asc' },
  });

  if (stuckWork.length > 0) {
    log(`[StaleVisibility] Found ${stuckWork.length} WorkQueue row(s) stuck in 'firing' beyond ${staleMinutes}min`);
  }

  for (const wq of stuckWork) {
    try {
      const ok = await markFailed(wq.id, `auto_gui2 timeout (no /step-status callback for ${staleMinutes}min)`);
      if (ok) {
        recovered++;
        log(`[StaleVisibility] Marked work ${wq.id} (${wq.step}) as failed`);
        // If this work was a visibility step, also flip the SO row.
        if (wq.step === 'visibility' && wq.salesOrderId) {
          await prisma.salesOrder.update({
            where: { id: wq.salesOrderId },
            data: { visibilityState: 'failed' },
          });
        }
      }
    } catch (err) {
      const errMsg = `Stale work ${wq.id} error: ${err instanceof Error ? err.message : String(err)}`;
      log(`[StaleVisibility] ${errMsg}`);
      errors.push(errMsg);
    }
  }

  // After failing stuck work, pump once to fire the next queued item (if any).
  if (stuckWork.length > 0) {
    await pumpQueue();
  }

  // Step 3: sweep POs whose every SO is in {received, failed} but no sent ls_dispatch yet
  const candidatePOs = await prisma.purchaseOrder.findMany({
    where: {
      salesOrders: {
        some: { visibilityState: { in: ['received', 'failed'] } },
        every: { visibilityState: { in: ['received', 'failed'] } },
      },
    },
    include: {
      emails: {
        where: { emailType: 'ls_dispatch', status: 'sent' },
        take: 1,
      },
    },
  });

  for (const po of candidatePOs) {
    if (po.emails.length > 0) continue; // already sent
    try {
      const result = await assembleAndSendCombinedEmail(po.id);
      logs.push(...result.logs);
      if (result.success && !result.alreadySent) {
        combinedSent++;
      }
    } catch (err) {
      const errMsg = `Assemble error for PO ${po.poNumber}: ${err instanceof Error ? err.message : String(err)}`;
      log(`[StaleVisibility] ${errMsg}`);
      errors.push(errMsg);
    }
  }

  log(`[StaleVisibility] Complete. Recovered: ${recovered}, Combined emails sent: ${combinedSent}, Errors: ${errors.length}`);
  return { recovered, combinedSent, errors, logs };
}
