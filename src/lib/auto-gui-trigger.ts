import { prisma } from './prisma';
import { downloadFromS3 } from './s3';
import { sendPlainEmail, sendReplyEmail, sendHtmlEmail, sendHtmlReplyEmail, getMessageRfc822Id } from './gmail';
import { buildDispatchApprovalHtml, type DispatchSoSection } from './dispatch-email-template';
import { enqueueWork, pumpQueue } from './work-queue';
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

    // Enqueue on the global work queue. auto_gui2 will call /processing-data
    // (data) AND /step-status (done/failed) when the SAP run finishes.
    await enqueueWork({
      salesOrderId: salesOrder.id,
      step: 'zload3b1',
      payload: {
        instruction,
        transaction_code: 'ZLOAD3-B1',
        so_number: salesOrder.soNumber,
        attachments,
        extraction_context:
          'For each file, extract the loading slip number, loaded quantity, invoice number, and invoice date',
      },
    });
    await pumpQueue();

    log(`[BatchSender] Enqueued ZLOAD3-B1 for SO ${salesOrder.soNumber} with ${attachments.length} attachment(s)`);
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
type StoredMaterial = {
  // New shape (current auto_gui2 payload)
  material?: string;
  material_description?: string | null;
  batch?: string;
  order_quantity: number;
  available_stock_for_so?: number | null;
  order_weight_kg?: number | null;
  // Legacy shape (older auto_gui2 payload) — kept for back-compat with rows already in DB
  material_code?: string;
  batch_number?: string;
};

// Normalize either shape to the canonical fields used downstream.
function materialCodeOf(m: StoredMaterial): string {
  return m.material ?? m.material_code ?? '';
}
function batchOf(m: StoredMaterial): string {
  return m.batch ?? m.batch_number ?? '';
}

type PerSoMaterials = {
  version: 2;
  perSO: Array<{
    soNumber: string;
    salesOrderId: string;
    materials: StoredMaterial[];
  }>;
};

function isPerSoMaterials(parsed: unknown): parsed is PerSoMaterials {
  return (
    typeof parsed === 'object' &&
    parsed !== null &&
    (parsed as { version?: number }).version === 2 &&
    Array.isArray((parsed as { perSO?: unknown }).perSO)
  );
}

interface ReleaseItem {
  material_code: string;
  batch: string;
  quantity: number;
  weight_kg: number;
}

interface SoReleasePlan {
  soNumber: string;
  salesOrderId: string;
  items: ReleaseItem[];
  totalWeightKg: number;
}

/**
 * Classify a single SO's branch reply and (for release intents) compute the
 * release plan from the persisted Material rows. Does NOT fire ZLOAD1 yet —
 * that decision lives outside, after summing weights across the whole PO.
 *
 * For 'wait' intent, sends the production inquiry email immediately
 * (production replies are scoped per SO and don't go through the weight gate).
 */
async function classifyAndPlanForSo(args: {
  parentLoadingSlipItemId: string | null;
  soNumber: string;
  salesOrderId: string;
  originalEmailHtml: string;
  replyHtml: string;
  log: (msg: string) => void;
}): Promise<
  | { success: true; intent: 'release_all' | 'release_part'; plan: SoReleasePlan }
  | { success: true; intent: 'wait' }
  | { success: false; intent?: string }
> {
  const {
    parentLoadingSlipItemId,
    soNumber,
    salesOrderId,
    originalEmailHtml,
    replyHtml,
    log,
  } = args;

  log(`[BranchReply] Classifying for SO ${soNumber}`);

  let result: any;
  try {
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
    result = await response.json();
  } catch (err) {
    log(`[BranchReply] /email/branch-reply call failed for SO ${soNumber}: ${err instanceof Error ? err.message : String(err)}`);
    return { success: false };
  }

  log(`[BranchReply] SO ${soNumber} intent=${result.intent}`);

  if (!result.success) {
    log(`[BranchReply] SO ${soNumber} classification failed: ${result.error}`);
    return { success: false };
  }

  if (result.intent === 'release_all' || result.intent === 'release_part') {
    // Source release plan from the canonical Material rows (fresh DB read)
    // rather than echoing back the LLM's parsed list — Material has the
    // weight per row needed for the truck-capacity gate.
    const materials = await prisma.material.findMany({
      where: { salesOrderId },
      orderBy: { createdAt: 'asc' },
    });

    const items: ReleaseItem[] = [];
    let totalWeightKg = 0;
    for (const m of materials) {
      const requested = m.orderQuantity;
      const available = m.availableStock ?? requested;
      // release_all → full requested qty; release_part → cap at availability
      const qty = result.intent === 'release_all'
        ? requested
        : Math.min(requested, Math.max(available, 0));
      if (qty <= 0) continue;
      const fullWeight = m.orderWeightKg ? Number(m.orderWeightKg) : 0;
      const perUnit = requested > 0 ? fullWeight / requested : 0;
      const itemWeight = perUnit * qty;
      items.push({
        material_code: m.material,
        batch: m.batch,
        quantity: qty,
        weight_kg: itemWeight,
      });
      totalWeightKg += itemWeight;
    }

    log(`[BranchReply] SO ${soNumber} plan: ${items.length} item(s), ${(totalWeightKg / 1000).toFixed(2)} t`);

    return {
      success: true,
      intent: result.intent,
      plan: { soNumber, salesOrderId, items, totalWeightKg },
    };
  }

  if (result.intent === 'wait') {
    // Simplified flow: branch wants us to wait a few days and re-check
    // stock availability. No production team contact — just schedule a
    // recheck. The cron will re-fire ZSO-VISIBILITY when waitUntil elapses.
    const waitDays = parseInt(process.env.WAIT_RECHECK_DAYS || '3', 10);
    const waitUntil = new Date(Date.now() + waitDays * 86400000);

    await prisma.salesOrder.update({
      where: { id: salesOrderId },
      data: {
        waitUntil,
        waitRechecks: { increment: 1 },
      },
    });

    log(`[BranchReply] SO ${soNumber} 'wait' → recheck scheduled at ${waitUntil.toISOString()} (${waitDays} day${waitDays === 1 ? '' : 's'})`);
    return { success: true, intent: 'wait' };
  }

  log(`[BranchReply] SO ${soNumber}: unknown intent "${result.intent}"`);
  return { success: false, intent: result.intent };
}

/**
 * Email the branch asking whether to split a multi-vehicle dispatch.
 * Plain prose body with a per-SO breakdown of what would be released and
 * the total tonnage vs. truck capacity. Branch replies in plain text;
 * `handleVehicleSplitConfirmation` parses the reply.
 */
async function sendVehicleSplitInquiry(args: {
  purchaseOrderId: string;
  plans: SoReleasePlan[];
  totalTonnes: number;
  capacityTonnes: number;
  originalCombinedEmail: { gmailThreadId: string; gmailMessageId: string };
  log: (msg: string) => void;
}): Promise<void> {
  const { purchaseOrderId, plans, totalTonnes, capacityTonnes, originalCombinedEmail, log } = args;

  if (!BRANCH_EMAIL) {
    log(`[VehicleSplit] BRANCH_EMAIL not configured, cannot send inquiry`);
    return;
  }

  const po = await prisma.purchaseOrder.findUnique({ where: { id: purchaseOrderId } });
  if (!po) {
    log(`[VehicleSplit] PO ${purchaseOrderId} not found`);
    return;
  }

  const overBy = (totalTonnes - capacityTonnes).toFixed(2).replace(/\.00$/, '');
  const totalStr = totalTonnes.toFixed(2).replace(/\.00$/, '');

  const breakdown = plans
    .map((p) => {
      const t = (p.totalWeightKg / 1000).toFixed(2).replace(/\.00$/, '');
      return `  • SO ${p.soNumber}: ${p.items.length} item(s), ${t} t`;
    })
    .join('\n');

  const subject = `Vehicle Split Confirmation Required - PO ${po.poNumber}`;
  const body = [
    `Dear Branch Team,`,
    ``,
    `The total weight of the approved dispatch for Purchase Order ${po.poNumber} is ${totalStr} tonnes, which exceeds the truck capacity of ${capacityTonnes} tonnes by ${overBy} tonnes.`,
    ``,
    `Per-SO breakdown:`,
    breakdown,
    ``,
    `Please confirm whether to proceed with TWO vehicles. Reply "yes" to split into 2 vehicles, or "no" to revise the dispatch.`,
    ``,
    `Best regards,`,
    `Sales Order Dispatch Co-ordinator`,
  ].join('\n');

  let sent: { messageId: string; threadId: string };
  try {
    const rfc822Id = await getMessageRfc822Id(originalCombinedEmail.gmailMessageId);
    if (rfc822Id) {
      sent = await sendReplyEmail(BRANCH_EMAIL, subject, body, originalCombinedEmail.gmailThreadId, rfc822Id);
    } else {
      sent = await sendPlainEmail(BRANCH_EMAIL, subject, body);
    }
  } catch (err) {
    log(`[VehicleSplit] reply-in-thread failed: ${err instanceof Error ? err.message : err}`);
    sent = await sendPlainEmail(BRANCH_EMAIL, subject, body);
  }

  await prisma.email.create({
    data: {
      purchaseOrderId,
      salesOrderId: plans[0]?.salesOrderId,
      gmailMessageId: sent.messageId,
      gmailThreadId: sent.threadId,
      recipientEmail: BRANCH_EMAIL,
      subject,
      status: 'sent',
      emailType: 'vehicle_split_inquiry',
      workflowState: 'awaiting_split_confirmation',
      sentBody: body,
      relatedMaterials: JSON.stringify({ version: 'split-v1', plans, totalTonnes, capacityTonnes }),
    },
  });

  log(`[VehicleSplit] Inquiry sent to ${BRANCH_EMAIL} for PO ${po.poNumber} (messageId=${sent.messageId})`);
}

/**
 * Handle branch's reply to the vehicle-split inquiry.
 * Reads each SO's stored releasePlan and fires ZLOAD1 if confirmed.
 */
export async function handleVehicleSplitConfirmation(
  emailId: string,
  replyHtml: string
): Promise<{ success: boolean; logs: string[] }> {
  const logs: string[] = [];
  const log = (msg: string) => {
    const m = `[${new Date().toISOString()}] ${msg}`;
    console.log(m);
    logs.push(m);
  };

  try {
    const email = await prisma.email.findUnique({ where: { id: emailId } });
    if (!email || !email.purchaseOrderId) {
      log(`[VehicleSplit] Email or purchaseOrderId missing on ${emailId}`);
      return { success: false, logs };
    }

    // Light-weight yes/no detection. Reply text is short and structured here.
    const replyText = replyHtml.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    const isYes = /\b(yes|yep|yeah|confirm|approve|ok|okay|proceed|split|go ahead|two\s*vehicles?|2\s*vehicles?)\b/.test(
      replyText
    );
    const isNo = /\b(no|nope|don'?t|do not|cancel|hold|wait|revise)\b/.test(replyText);

    log(`[VehicleSplit] Reply intent: yes=${isYes} no=${isNo} text="${replyText.slice(0, 80)}"`);

    if (isYes && !isNo) {
      // Confirmed: load each SO's stored plan and fire ZLOAD1.
      const sos = await prisma.salesOrder.findMany({
        where: { purchaseOrderId: email.purchaseOrderId, releasePlan: { not: null } },
      });
      log(`[VehicleSplit] Confirmed split — firing ZLOAD1 for ${sos.length} SO(s)`);
      for (const so of sos) {
        if (!so.releasePlan) continue;
        try {
          const plan = JSON.parse(so.releasePlan) as SoReleasePlan;
          await fireZload1FromPlan(plan, log);
        } catch (err) {
          log(`[VehicleSplit] failed to fire SO ${so.soNumber}: ${err instanceof Error ? err.message : err}`);
        }
      }
      await prisma.email.update({
        where: { id: emailId },
        data: { status: 'replied', repliedAt: new Date(), workflowState: 'completed', replyHtml },
      });
      return { success: true, logs };
    }

    if (isNo) {
      log(`[VehicleSplit] Branch declined split — keeping plans on hold`);
      await prisma.email.update({
        where: { id: emailId },
        data: { status: 'replied', repliedAt: new Date(), workflowState: 'completed', replyHtml },
      });
      return { success: true, logs };
    }

    log(`[VehicleSplit] Reply ambiguous — leaving in 'awaiting_split_confirmation'`);
    return { success: false, logs };
  } catch (err) {
    log(`[VehicleSplit] error: ${err instanceof Error ? err.message : err}`);
    return { success: false, logs };
  }
}

async function fireZload1FromPlan(plan: SoReleasePlan, log: (msg: string) => void): Promise<void> {
  await prisma.salesOrder.update({
    where: { id: plan.salesOrderId },
    data: { status: 'stock_approved', releasePlan: null },
  });
  const materials: MaterialItemPayload[] = plan.items.map((i) => ({
    material_code: i.material_code,
    batch: i.batch,
    quantity: i.quantity,
  }));
  log(`[BranchReply] Firing ZLOAD1 for SO ${plan.soNumber}: ${materials.length} item(s)`);
  await triggerZload1(plan.soNumber, materials);
}

export async function handleBranchReply(
  emailId: string,
  replyHtml: string,
  originalEmailHtml: string,
  _salesOrderId: string
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
      log(`[BranchReply] Email not found: ${emailId}`);
      return { success: false, logs };
    }

    const parsedMaterials: unknown = email.relatedMaterials
      ? JSON.parse(email.relatedMaterials)
      : null;

    // Multi-SO mode: combined dispatch email keyed to a PO with v2 materials shape
    if (email.purchaseOrderId && isPerSoMaterials(parsedMaterials)) {
      log(`[BranchReply] Multi-SO mode for PO email ${emailId}: ${parsedMaterials.perSO.length} SO(s)`);

      const plans: SoReleasePlan[] = [];
      let anyFailure = false;

      // Phase 1: classify each SO and either build a release plan OR
      // dispatch a per-SO production inquiry ('wait' intent).
      for (const entry of parsedMaterials.perSO) {
        const r = await classifyAndPlanForSo({
          parentLoadingSlipItemId: email.loadingSlipItemId,
          soNumber: entry.soNumber,
          salesOrderId: entry.salesOrderId,
          originalEmailHtml,
          replyHtml,
          log,
        });
        if (!r.success) {
          anyFailure = true;
          continue;
        }
        if (r.intent === 'release_all' || r.intent === 'release_part') {
          plans.push(r.plan);
        }
        // 'wait' SOs are already handled inside classifyAndPlanForSo
      }

      // Phase 2: weight gate. Sum across all release plans for this PO.
      // If the total exceeds the customer's truck capacity, pause and ask
      // for 2-vehicle confirmation before firing any ZLOAD1.
      if (plans.length > 0) {
        const totalKg = plans.reduce((s, p) => s + p.totalWeightKg, 0);
        const totalTonnes = totalKg / 1000;

        const po = await prisma.purchaseOrder.findUnique({
          where: { id: email.purchaseOrderId },
          include: { customer: true },
        });
        const capacityTonnes = po?.customer?.weightage
          ? Number(po.customer.weightage)
          : 31;

        log(`[BranchReply] PO ${po?.poNumber}: total release weight ${totalTonnes.toFixed(2)} t (capacity ${capacityTonnes} t)`);

        if (totalTonnes > capacityTonnes) {
          log(`[BranchReply] Over capacity by ${(totalTonnes - capacityTonnes).toFixed(2)} t — sending vehicle-split inquiry`);

          // Persist plans on each SO so the split-confirmation reply can fire ZLOAD1.
          for (const plan of plans) {
            await prisma.salesOrder.update({
              where: { id: plan.salesOrderId },
              data: { releasePlan: JSON.stringify(plan) },
            });
          }

          await sendVehicleSplitInquiry({
            purchaseOrderId: email.purchaseOrderId,
            plans,
            totalTonnes,
            capacityTonnes,
            originalCombinedEmail: email,
            log,
          });
        } else {
          // Under capacity — fire ZLOAD1 per SO using each plan.
          for (const plan of plans) {
            await fireZload1FromPlan(plan, log);
          }
        }
      }

      await prisma.email.update({
        where: { id: emailId },
        data: { workflowState: 'completed' },
      });

      return { success: !anyFailure, logs };
    }

    // Legacy single-SO path. Treat the same way: classify, plan, weight-gate
    // against the (optional) customer capacity if linked.
    const soNumber = email.salesOrder!.soNumber;
    const r = await classifyAndPlanForSo({
      parentLoadingSlipItemId: email.loadingSlipItemId,
      soNumber,
      salesOrderId: email.salesOrderId!,
      originalEmailHtml,
      replyHtml,
      log,
    });

    if (r.success && (r.intent === 'release_all' || r.intent === 'release_part')) {
      const totalTonnes = r.plan.totalWeightKg / 1000;
      const so = await prisma.salesOrder.findUnique({
        where: { id: r.plan.salesOrderId },
        include: { purchaseOrder: { include: { customer: true } } },
      });
      const capacityTonnes = so?.purchaseOrder.customer?.weightage
        ? Number(so.purchaseOrder.customer.weightage)
        : 31;

      if (totalTonnes > capacityTonnes) {
        log(`[BranchReply] Single-SO over capacity (${totalTonnes.toFixed(2)} t > ${capacityTonnes} t) — sending split inquiry`);
        await prisma.salesOrder.update({
          where: { id: r.plan.salesOrderId },
          data: { releasePlan: JSON.stringify(r.plan) },
        });
        await sendVehicleSplitInquiry({
          purchaseOrderId: so!.purchaseOrderId,
          plans: [r.plan],
          totalTonnes,
          capacityTonnes,
          originalCombinedEmail: email,
          log,
        });
      } else {
        await fireZload1FromPlan(r.plan, log);
      }
    }

    await prisma.email.update({
      where: { id: emailId },
      data: { workflowState: 'completed' },
    });

    return { success: r.success, logs };
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
      typeof m === 'string' ? m : (m.material ?? m.material_code ?? '')
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
      typeof m === 'string' ? m : (m.material ?? m.material_code ?? '')
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
export async function triggerZsoVisibility(soNumber: string): Promise<void> {
  // Update CurrentSO singleton so visibility-data endpoint knows which SO
  await prisma.currentSO.deleteMany();
  await prisma.currentSO.create({ data: { soNumber } });

  // Look up the SO to attach to the WorkQueue row.
  const so = await prisma.salesOrder.findFirst({ where: { soNumber }, select: { id: true } });

  await enqueueWork({
    salesOrderId: so?.id ?? null,
    step: 'visibility',
    payload: {
      instruction: `VPN is connected and SAP is logged in. Just go ahead and run the SAP Transaction ZSO-VISIBILITY for Sales order number ${soNumber}.`,
      transaction_code: 'ZSO-VISIBILITY',
      so_number: soNumber,
    },
  });
  await pumpQueue();
  console.log(`[ZSO-VISIBILITY] Enqueued for SO ${soNumber}`);
}

/**
 * Aggregated dispatch email for a multi-SO PurchaseOrder.
 *
 * Each SO's `/visibility-data` callback buffers a per-SO Email row
 * (status='queued', emailType='ls_dispatch_buffered'). Once every SO in the PO
 * has its visibility result (`visibilityState` in {'received','failed'}), this
 * function assembles ONE email with one section per SO and sends it in the
 * original NEW ORDER thread.
 *
 * Idempotent: short-circuits if a sent ls_dispatch email already exists for the PO.
 */
export async function assembleAndSendCombinedEmail(
  purchaseOrderId: string
): Promise<{ success: boolean; logs: string[]; alreadySent?: boolean }> {
  const logs: string[] = [];
  const log = (msg: string) => {
    const m = `[${new Date().toISOString()}] ${msg}`;
    console.log(m);
    logs.push(m);
  };

  // Idempotency guard
  const existing = await prisma.email.findFirst({
    where: {
      purchaseOrderId,
      emailType: 'ls_dispatch',
      status: 'sent',
    },
  });
  if (existing) {
    log(`[CombinedEmail] PO ${purchaseOrderId} already has sent ls_dispatch email ${existing.id} — skipping`);
    return { success: true, logs, alreadySent: true };
  }

  const purchaseOrder = await prisma.purchaseOrder.findUnique({
    where: { id: purchaseOrderId },
    include: {
      customer: true,
      salesOrders: {
        orderBy: { createdAt: 'asc' },
        include: {
          materials: { orderBy: { createdAt: 'asc' } },
        },
      },
    },
  });

  if (!purchaseOrder) {
    log(`[CombinedEmail] PO ${purchaseOrderId} not found`);
    return { success: false, logs };
  }

  const includedSOs = purchaseOrder.salesOrders.filter(
    (so) => so.visibilityState === 'received' && so.materials.length > 0
  );
  const failedSOs = purchaseOrder.salesOrders.filter((so) => so.visibilityState === 'failed');

  if (includedSOs.length === 0) {
    log(`[CombinedEmail] PO ${purchaseOrder.poNumber} has no SOs with received visibility + materials — cannot assemble`);
    return { success: false, logs };
  }

  if (!BRANCH_EMAIL) {
    log(`[CombinedEmail] BRANCH_EMAIL not configured`);
    return { success: false, logs };
  }

  // Build the HTML body (we now compose it ourselves; no longer rely on auto_gui2's email_body)
  const sections: DispatchSoSection[] = includedSOs.map((so) => ({
    soNumber: so.soNumber,
    materials: so.materials.map((m) => ({
      material: m.material,
      materialDescription: m.materialDescription,
      batch: m.batch,
      orderQuantity: m.orderQuantity,
      availableStock: m.availableStock,
      orderWeightKg: m.orderWeightKg ? Number(m.orderWeightKg) : null,
    })),
  }));
  const capacityTonnes = purchaseOrder.customer?.weightage
    ? Number(purchaseOrder.customer.weightage)
    : 31;
  const combinedBody = buildDispatchApprovalHtml(purchaseOrder.poNumber, sections, capacityTonnes);

  // Aggregated v2 materials JSON (used by handleBranchReply to reconstruct per-SO context)
  const aggregated = {
    version: 2 as const,
    perSO: includedSOs.map((so) => ({
      soNumber: so.soNumber,
      salesOrderId: so.id,
      materials: so.materials.map((m) => ({
        material: m.material,
        material_description: m.materialDescription,
        batch: m.batch,
        order_quantity: m.orderQuantity,
        available_stock_for_so: m.availableStock,
        order_weight_kg: m.orderWeightKg ? Number(m.orderWeightKg) : null,
      })),
    })),
  };

  const subject = `Dispatch Approval Request - PO ${purchaseOrder.poNumber}`;
  const leadSO = includedSOs[0];
  const failureNote = failedSOs.length > 0
    ? ` (visibility failed for: ${failedSOs.map((so) => so.soNumber).join(', ')})`
    : '';

  log(`[CombinedEmail] Sending combined HTML email for PO ${purchaseOrder.poNumber} (${includedSOs.length} SOs${failureNote})`);

  let messageId: string;
  let threadId: string;
  try {
    let sent: { messageId: string; threadId: string };
    if (leadSO.originalThreadId && leadSO.originalMessageId) {
      try {
        const rfc822Id = await getMessageRfc822Id(leadSO.originalMessageId);
        if (rfc822Id) {
          sent = await sendHtmlReplyEmail(BRANCH_EMAIL, subject, combinedBody, leadSO.originalThreadId, rfc822Id);
        } else {
          sent = await sendHtmlEmail(BRANCH_EMAIL, subject, combinedBody);
        }
      } catch (replyErr) {
        log(`[CombinedEmail] Reply-in-thread failed (${replyErr instanceof Error ? replyErr.message : replyErr}); sending as new email`);
        sent = await sendHtmlEmail(BRANCH_EMAIL, subject, combinedBody);
      }
    } else {
      sent = await sendHtmlEmail(BRANCH_EMAIL, subject, combinedBody);
    }
    messageId = sent.messageId;
    threadId = sent.threadId;
  } catch (sendErr) {
    log(`[CombinedEmail] Failed to send combined email for PO ${purchaseOrder.poNumber}: ${sendErr instanceof Error ? sendErr.message : sendErr}`);
    return { success: false, logs };
  }

  // Create the FINAL Email row keyed to lead SO + PO
  await prisma.email.create({
    data: {
      salesOrderId: leadSO.id,
      purchaseOrderId,
      gmailMessageId: messageId,
      gmailThreadId: threadId,
      recipientEmail: BRANCH_EMAIL,
      subject,
      status: 'sent',
      emailType: 'ls_dispatch',
      workflowState: 'awaiting_reply',
      relatedMaterials: JSON.stringify(aggregated),
      sentBody: combinedBody,
    },
  });

  // Mark all buffered rows for this PO as consumed
  await prisma.email.updateMany({
    where: {
      purchaseOrderId,
      emailType: 'ls_dispatch_buffered',
      status: 'queued',
    },
    data: { status: 'consumed' },
  });

  log(`[CombinedEmail] Sent combined email ${messageId} for PO ${purchaseOrder.poNumber}; ${includedSOs.length} buffered row(s) consumed`);
  return { success: true, logs };
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
    const so = await prisma.salesOrder.findFirst({ where: { soNumber }, select: { id: true } });
    await enqueueWork({
      salesOrderId: so?.id ?? null,
      step: 'vto1n',
      payload: {
        instruction: `VPN is connected and SAP is logged in. Just go ahead and run the SAP Transaction VT01N. OBD number is ${obdNumber}, LR number is ${lrNumber}, LR date is ${formattedDate} and Vehicle number is ${vehicleNumber}`,
        transaction_code: 'VTO1N-B',
        so_number: soNumber,
        extraction_context: 'Extract the OBD number, LR number, LR date and Vehicle number',
      },
    });
    await pumpQueue();
    console.log(`[VTO1N-B] Enqueued for SO ${soNumber}`);
  } catch (error) {
    console.error(`[VTO1N-B] Enqueue failed for SO ${soNumber}:`, error);
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
 * It creates a loading slip and sends it back asynchronously via the
 * /backend/orders/aman/zload1-data callback API — so this is fire-and-forget.
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

  const so = await prisma.salesOrder.findFirst({ where: { soNumber }, select: { id: true } });

  await enqueueWork({
    salesOrderId: so?.id ?? null,
    step: 'zload1',
    payload: {
      instruction,
      transaction_code: 'ZLOAD1',
      so_number: soNumber,
    },
  });
  await pumpQueue();
  console.log(`[ZLOAD1] Enqueued for SO ${soNumber} (${materials.length} material(s))`);
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
