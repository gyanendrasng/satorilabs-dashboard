import { prisma } from './prisma';
import { downloadFromS3 } from './s3';
import { sendPlainEmail, sendReplyEmail, sendHtmlEmail, sendHtmlReplyEmail, getMessageRfc822Id } from './gmail';
import { buildDispatchApprovalHtml, substituteSourcePlant, type DispatchSoSection } from './dispatch-email-template';
import { enqueueWork, pumpQueue } from './work-queue';
import { computeBundlesForPo } from './bundler';
import { sendLSEmail } from './email-service';

const AUTO_GUI_HOST = process.env.AUTO_GUI_HOST || 'localhost';
const AUTO_GUI_PORT = process.env.AUTO_GUI_PORT || '8000';
const PRODUCTION_EMAIL = process.env.PRODUCTION_EMAIL || '';
const BRANCH_EMAIL = process.env.BRANCH_EMAIL || '';

/**
 * Check if all LoadingSlipItems in a (Bundle, SO) pair have plant invoice
 * replies with PDFs, and fire ZLOAD3-B1 for that pair if they do.
 *
 * When `bundleId` is omitted (legacy callers / non-bundle SOs), the scope
 * widens to every LSI of the SO — same behaviour as before.
 *
 * Each (Bundle, SO) pair fires its own ZLOAD3-B1. A bundle that contains
 * 2 SOs → 2 fires (one per SO in the bundle). An SO that spans 2 bundles
 * → 2 fires (one per bundle for the SO). Single SO + single bundle → 1 fire.
 */
export async function checkAndSendBatchToAman(
  salesOrderId: string,
  bundleId?: string | null
): Promise<{ success: boolean; logs: string[] }> {
  const logs: string[] = [];

  const log = (message: string) => {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}`;
    console.log(logMessage);
    logs.push(logMessage);
  };

  const scopeLabel = bundleId ? `(Bundle ${bundleId.slice(-6)}, SO ${salesOrderId})` : `SO ${salesOrderId}`;
  log(`[BatchSender] Checking if all replies received for ${scopeLabel}`);

  // Load the LoadingSlips for this (SO, bundle) pair. Each LS has a plant_ls
  // email; the reply PDF lives on that Email row (replyPdfUrl, R2 key). When
  // bundleId is unspecified, take every LS on this SO.
  const salesOrder = await prisma.salesOrder.findUnique({
    where: { id: salesOrderId },
    include: {
      loadingSlips: {
        where: bundleId ? { bundleId } : undefined,
        include: { emails: true },
      },
      purchaseOrder: true,
    },
  });

  if (!salesOrder) {
    log(`[BatchSender] Sales order not found: ${salesOrderId}`);
    return { success: false, logs };
  }

  // Resolve bundleNumber once (for log/instruction/meta).
  let bundleNumber: number | null = null;
  if (bundleId) {
    const b = await prisma.bundle.findUnique({
      where: { id: bundleId },
      select: { bundleNumber: true },
    });
    bundleNumber = b?.bundleNumber ?? null;
  }

  // Idempotency: if a ZLOAD3-B1 work item for this exact (Bundle, SO) pair
  // is already in flight or done, skip. JSON substring match on payload is
  // crude but sufficient on SQLite without a dedicated index.
  if (bundleId) {
    const existing = await prisma.workQueue.findFirst({
      where: {
        salesOrderId,
        step: 'zload3b1',
        state: { in: ['queued', 'firing', 'done'] },
        payload: { contains: `"bundle_id":"${bundleId}"` },
      },
      select: { id: true, state: true },
    });
    if (existing) {
      log(`[BatchSender] ZLOAD3-B1 for ${scopeLabel} already exists in WorkQueue (${existing.state}) — skipping`);
      return { success: true, logs };
    }
  }

  const loadingSlips = salesOrder.loadingSlips;

  log(`[BatchSender] ${scopeLabel} has ${loadingSlips.length} loading slip(s):`);
  for (const ls of loadingSlips) {
    const repliedEmail = ls.emails.find((e) => e.status === 'replied' && e.replyPdfUrl);
    const status = repliedEmail ? `replied (PDF: ${repliedEmail.replyPdfUrl})` : 'waiting';
    log(`  - LS ${ls.lsNumber}: ${status}`);
  }

  if (loadingSlips.length === 0) {
    log(`[BatchSender] No loading slips in scope for ${scopeLabel} — nothing to fire`);
    return { success: false, logs };
  }

  const allReplied = loadingSlips.every((ls) =>
    ls.emails.some((email) => email.status === 'replied' && email.replyPdfUrl)
  );

  if (!allReplied) {
    const repliedCount = loadingSlips.filter((ls) =>
      ls.emails.some((email) => email.status === 'replied' && email.replyPdfUrl)
    ).length;
    log(
      `[BatchSender] Not ready yet for ${scopeLabel}: ${repliedCount}/${loadingSlips.length} LS(s) have replies`
    );
    return { success: false, logs };
  }

  log(`[BatchSender] All ${loadingSlips.length} LS(s) replied for ${scopeLabel}. Enqueueing ZLOAD3-B1...`);

  const attachments: Array<{ filename: string; content_base64: string }> = [];

  try {
    for (const ls of loadingSlips) {
      const repliedEmail = ls.emails.find(
        (e) => e.status === 'replied' && e.replyPdfUrl
      );
      if (!repliedEmail || !repliedEmail.replyPdfUrl) {
        log(`[BatchSender] LS ${ls.lsNumber} missing replyPdfUrl despite allReplied check — aborting`);
        return { success: false, logs };
      }
      log(`[BatchSender] Downloading PDF from R2 for LS ${ls.lsNumber}: ${repliedEmail.replyPdfUrl}`);
      const pdfBuffer = await downloadFromS3(repliedEmail.replyPdfUrl);
      log(`[BatchSender] Downloaded PDF for LS ${ls.lsNumber}: ${pdfBuffer.length} bytes`);
      attachments.push({
        filename: `${ls.lsNumber}.pdf`,
        content_base64: pdfBuffer.toString('base64'),
      });
    }

    const bundleSuffix = bundleNumber ? ` (Bundle ${bundleNumber})` : '';
    const instruction = `VPN is connected, SAP is logged in. Just execute ZLOAD3-B1 for sales order ${salesOrder.soNumber}${bundleSuffix}`;

    const totalBytes = attachments.reduce((sum, a) => sum + Buffer.from(a.content_base64, 'base64').length, 0);
    log(`[BatchSender] Sending to auto_gui2:`);
    log(`  - Instruction: ${instruction}`);
    log(`  - Attachments: ${attachments.length} PDF(s), total ${totalBytes} bytes`);
    for (const a of attachments) {
      const bytes = Buffer.from(a.content_base64, 'base64').length;
      log(`      • ${a.filename} (${bytes} bytes)`);
    }

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
        meta: {
          so_number: salesOrder.soNumber,
          ...(bundleId ? { bundle_id: bundleId } : {}),
          ...(bundleNumber ? { bundle_number: bundleNumber } : {}),
        },
      },
    });
    await pumpQueue();

    log(`[BatchSender] Enqueued ZLOAD3-B1 for ${scopeLabel} with ${attachments.length} attachment(s)`);

    // Advance any active scenario past 'await_plant_invoice'. Safe no-op when
    // engine is disabled or no scenario is in flight.
    try {
      const { maybeAdvanceScenario } = await import('./scenario-engine');
      await maybeAdvanceScenario(salesOrderId, 'zload3b1');
    } catch (advErr) {
      log(`[BatchSender] maybeAdvanceScenario warning: ${advErr instanceof Error ? advErr.message : advErr}`);
    }

    return { success: true, logs };
  } catch (error) {
    log(
      `[BatchSender] Failed to enqueue batch for ${scopeLabel}: ${
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
 * Handle a branch reply by classifying intent locally (branch-reply-classifier)
 * and acting accordingly (release materials or schedule a wait recheck)
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

export interface SoReleasePlan {
  soNumber: string;
  salesOrderId: string;
  items: ReleaseItem[];
  totalWeightKg: number;
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
  const vehicleCount = capacityTonnes > 0 ? Math.max(2, Math.ceil(totalTonnes / capacityTonnes)) : 2;
  const vehicleWord = (n: number) => {
    const words = ['', '', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE', 'TEN'];
    return words[n] ?? String(n);
  };

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
    `At least ${vehicleCount} vehicles (${vehicleWord(vehicleCount)}) will be required to ship the full load. Reply "yes" to split into ${vehicleCount} vehicles, or "no" to revise the dispatch.`,
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
 * Send a vehicle-details email to BRANCH_EMAIL for ONE Bundle (one truck).
 * Saves email row keyed to bundleId so the reply lands on the right bundle.
 * Idempotent: skips if a 'sent' vehicle_details email already exists for the bundle.
 */
export async function sendVehicleDetailsForBundle(
  bundleId: string
): Promise<{ sent: boolean; logs: string[] }> {
  const logs: string[] = [];
  const log = (m: string) => {
    const t = `[${new Date().toISOString()}] ${m}`;
    console.log(t);
    logs.push(t);
  };

  if (!BRANCH_EMAIL) {
    log(`[VehicleDetails] BRANCH_EMAIL not configured`);
    return { sent: false, logs };
  }

  const bundle = await prisma.bundle.findUnique({
    where: { id: bundleId },
    include: {
      purchaseOrder: true,
      loadingSlips: {
        include: {
          items: true,
          salesOrder: { select: { id: true, soNumber: true, originalThreadId: true, originalMessageId: true } },
        },
      },
      materials: {
        include: { salesOrder: { select: { id: true, soNumber: true, originalThreadId: true, originalMessageId: true } } },
      },
    },
  });
  if (!bundle) {
    log(`[VehicleDetails] Bundle ${bundleId} not found`);
    return { sent: false, logs };
  }

  // Idempotency — match both `sent` and `replied` so a branch reply on
  // the vehicle_details email doesn't reset us into "no email yet, send one".
  const existing = await prisma.email.findFirst({
    where: { bundleId, emailType: 'vehicle_details', status: { in: ['sent', 'replied'] } },
    select: { id: true },
  });
  if (existing) {
    log(`[VehicleDetails] Bundle ${bundle.bundleNumber} already has vehicle_details email — skipping`);
    return { sent: false, logs };
  }

  // Flatten LSIs across all LSs in the bundle (a bundle can hold ≥1 LS
  // when its SKUs come from multiple plants). Fall back to Material rows
  // when ZLOAD1 hasn't fired yet.
  // One line per (SO, LS, material) — collapse the per-batch LSI rows of a
  // multi-batch material into a single line. Batch is intentionally NOT shown
  // in the vehicle-details email, so two LSIs that differ only by batch would
  // otherwise render as duplicate lines.
  const seenMatLines = new Set<string>();
  const lsiLines = bundle.loadingSlips.flatMap((ls) =>
    ls.items
      .map((it) => `  - SO ${ls.salesOrder.soNumber} / LS ${ls.lsNumber} / Material ${it.material}`)
      .filter((line) => {
        if (seenMatLines.has(line)) return false;
        seenMatLines.add(line);
        return true;
      })
  );
  const lsLines = lsiLines.length > 0
    ? lsiLines.join('\n')
    : bundle.materials
        .map((m) => `  - SO ${m.salesOrder.soNumber} / Material ${m.material} (Batch ${m.batch}, ${m.dispatchQuantity ?? m.orderQuantity} units)`)
        .join('\n');
  const totalT = (Number(bundle.totalWeightKg) / 1000).toFixed(2).replace(/\.00$/, '');

  const subject = `Vehicle Details Required - PO ${bundle.purchaseOrder.poNumber} / Bundle ${bundle.bundleNumber}`;
  const body = [
    `Dear Branch Team,`,
    ``,
    `Bundle ${bundle.bundleNumber} of Purchase Order ${bundle.purchaseOrder.poNumber} (~${totalT} t) covers the following items:`,
    ``,
    lsLines,
    ``,
    `Please reply with the following vehicle/transport details for this bundle:`,
    `  1. Vehicle Number (e.g., GJ12AB1234)`,
    `  2. Driver Mobile Number (e.g., 9876543210)`,
    `  3. Container Number`,
    ``,
    `Best regards,`,
    `Sales Order Dispatch Co-ordinator`,
  ].join('\n');

  // Reply in the original NEW ORDER thread of any SO in this bundle, when possible.
  const lsAnchor = bundle.loadingSlips.find((ls) => ls.salesOrder.originalThreadId && ls.salesOrder.originalMessageId)?.salesOrder;
  const matAnchor = bundle.materials.find((m) => m.salesOrder.originalThreadId && m.salesOrder.originalMessageId)?.salesOrder;
  const anchor = lsAnchor ?? matAnchor;
  let sent: { messageId: string; threadId: string };
  try {
    if (anchor && anchor.originalThreadId && anchor.originalMessageId) {
      const rfc822Id = await getMessageRfc822Id(anchor.originalMessageId);
      if (rfc822Id) {
        sent = await sendReplyEmail(BRANCH_EMAIL, subject, body, anchor.originalThreadId, rfc822Id);
      } else {
        sent = await sendPlainEmail(BRANCH_EMAIL, subject, body);
      }
    } else {
      sent = await sendPlainEmail(BRANCH_EMAIL, subject, body);
    }
  } catch (err) {
    log(`[VehicleDetails] reply-in-thread failed: ${err instanceof Error ? err.message : err}`);
    sent = await sendPlainEmail(BRANCH_EMAIL, subject, body);
  }

  const leadSoIdForBundle = bundle.loadingSlips[0]?.salesOrderId ?? bundle.materials[0]?.salesOrderId;
  await prisma.email.create({
    data: {
      bundleId,
      purchaseOrderId: bundle.purchaseOrderId,
      // also link to the lead SO so existing reply-checker SO logging stays sane
      salesOrderId: leadSoIdForBundle,
      gmailMessageId: sent.messageId,
      gmailThreadId: sent.threadId,
      recipientEmail: BRANCH_EMAIL,
      subject,
      status: 'sent',
      emailType: 'vehicle_details',
      workflowState: 'awaiting_reply',
      sentBody: body,
    },
  });

  // Audit-trail event for the LLM planner — keyed to the bundle's lead SO.
  if (leadSoIdForBundle) {
    try {
      const { emitEvent } = await import('./scenario-events');
      await emitEvent({
        salesOrderId: leadSoIdForBundle,
        type: 'email_sent',
        payload: {
          emailType: 'vehicle_details',
          recipient: BRANCH_EMAIL,
          subject,
          bundle_number: bundle.bundleNumber,
          gmailMessageId: sent.messageId,
        },
      });
    } catch {
      // Audit emission must never break the primary flow.
    }
  }

  log(`[VehicleDetails] Sent vehicle-details email for Bundle ${bundle.bundleNumber} (PO ${bundle.purchaseOrder.poNumber})`);
  return { sent: true, logs };
}

/**
 * Send ONE combined vehicle-details email for a whole PO, listing every
 * bundle. Called only after every ZLOAD1 work row for the PO is `done`.
 *
 * Idempotent — if a `vehicle_details` email already exists for this PO,
 * skip. The combined email is parsed by the existing handleVehicleDetailsReply,
 * which already knows how to extract per-bundle vehicle sets.
 */
export async function sendCombinedVehicleDetailsEmailForPo(
  purchaseOrderId: string
): Promise<{ sent: boolean; logs: string[] }> {
  const logs: string[] = [];
  const log = (m: string) => {
    const t = `[${new Date().toISOString()}] ${m}`;
    console.log(t);
    logs.push(t);
  };

  if (!BRANCH_EMAIL) {
    log(`[VehicleDetails] BRANCH_EMAIL not configured`);
    return { sent: false, logs };
  }

  // Idempotency — one combined email per PO, BUT only while it still
  // describes the current set of LSs. After a pre-plant_ls modify cycle
  // (ZLOADING_CLOSE all → … → fresh ZLOAD1) the LSs from the prior round
  // are gone in SAP and a new wave has just landed. The prior
  // vehicle_details email referenced LSs that no longer exist, so we must
  // send a fresh one.
  //
  // Rule: an existing vehicle_details email is considered "still current"
  // ONLY if its sentAt is newer than the latest done zload1 work_queue row
  // on this PO. If a ZLOAD1 has completed AFTER the email was sent, the
  // email is stale and we send a new one.
  const existing = await prisma.email.findFirst({
    where: { purchaseOrderId, emailType: 'vehicle_details', status: { in: ['sent', 'replied'] } },
    orderBy: { sentAt: 'desc' },
    select: { id: true, sentAt: true },
  });
  if (existing) {
    // Find the most recent done ZLOAD1 work on any SO of this PO. If it's
    // newer than the email, the email is stale → fall through and send.
    const latestZload1 = await prisma.workQueue.findFirst({
      where: {
        step: 'zload1',
        state: 'done',
        salesOrder: { purchaseOrderId },
      },
      orderBy: { finishedAt: 'desc' },
      select: { finishedAt: true, id: true },
    });

    const emailSentAt = existing.sentAt.getTime();
    const lastZload1At = latestZload1?.finishedAt?.getTime() ?? 0;

    if (lastZload1At <= emailSentAt) {
      log(
        `[VehicleDetails] PO ${purchaseOrderId} already has a current vehicle_details email ` +
          `(sentAt=${existing.sentAt.toISOString()}, latest ZLOAD1 finishedAt=${latestZload1?.finishedAt?.toISOString() ?? 'none'}) — skipping`,
      );
      return { sent: false, logs };
    }

    log(
      `[VehicleDetails] PO ${purchaseOrderId} has a STALE vehicle_details email ` +
        `(sentAt=${existing.sentAt.toISOString()}, but ZLOAD1 ${latestZload1?.id} finished at ` +
        `${latestZload1?.finishedAt?.toISOString()} after that — likely a pre-plant_ls modify cycle just completed). Sending fresh email.`,
    );
  }

  const po = await prisma.purchaseOrder.findUnique({
    where: { id: purchaseOrderId },
    include: {
      bundles: {
        orderBy: { bundleNumber: 'asc' },
        include: {
          loadingSlips: {
            include: {
              items: true,
              salesOrder: { select: { id: true, soNumber: true, originalThreadId: true, originalMessageId: true } },
            },
          },
          materials: {
            include: { salesOrder: { select: { id: true, soNumber: true, originalThreadId: true, originalMessageId: true } } },
          },
        },
      },
    },
  });
  if (!po) {
    log(`[VehicleDetails] PO ${purchaseOrderId} not found`);
    return { sent: false, logs };
  }
  if (po.bundles.length === 0) {
    log(`[VehicleDetails] PO ${po.poNumber} has no bundles — skipping`);
    return { sent: false, logs };
  }

  // Build one section per bundle. Each bundle has ≥1 LSs (one per plant);
  // each LS has its SKU lines.
  const bundleBlocks: string[] = [];
  for (const bundle of po.bundles) {
    const totalT = (Number(bundle.totalWeightKg) / 1000).toFixed(2).replace(/\.00$/, '');
    // One line per (SO, LS, material) — collapse the per-batch LSI rows of a
    // multi-batch material (batch is not shown in the vehicle-details email).
    const seenMatLines = new Set<string>();
    const lsiLines = bundle.loadingSlips.flatMap((ls) =>
      ls.items
        .map((it) => `  - SO ${ls.salesOrder.soNumber} / LS ${ls.lsNumber} / Material ${it.material}`)
        .filter((line) => {
          if (seenMatLines.has(line)) return false;
          seenMatLines.add(line);
          return true;
        })
    );
    const lsLines = lsiLines.length > 0
      ? lsiLines.join('\n')
      : bundle.materials
          .map((m) => `  - SO ${m.salesOrder.soNumber} / Material ${m.material} (Batch ${m.batch}, ${m.dispatchQuantity ?? m.orderQuantity} units)`)
          .join('\n');
    bundleBlocks.push(
      [
        `Bundle ${bundle.bundleNumber} (~${totalT} t):`,
        lsLines,
      ].join('\n')
    );
  }

  const subject = `Vehicle Details Required - PO ${po.poNumber} (${po.bundles.length} bundle${po.bundles.length === 1 ? '' : 's'})`;
  const body = [
    `Dear Branch Team,`,
    ``,
    `Loading slips for Purchase Order ${po.poNumber} are now ready in SAP. The PO is split into ${po.bundles.length} bundle${po.bundles.length === 1 ? '' : 's'}:`,
    ``,
    ...bundleBlocks.map((b) => b + '\n'),
    `Please reply with vehicle/transport details for each bundle in the format below:`,
    ...po.bundles.map(
      (b) =>
        `  Bundle ${b.bundleNumber}: <Vehicle Number>, <Driver Mobile>, <Container Number>`
    ),
    ``,
    `Best regards,`,
    `Sales Order Dispatch Co-ordinator`,
  ].join('\n');

  // Anchor on the per-PO branch thread.
  const { resolvePoThreadAnchor, capturePoThreadAnchor } = await import('./po-thread');
  const anchor = await resolvePoThreadAnchor(purchaseOrderId, 'branch');
  let sent: { messageId: string; threadId: string };
  try {
    if (anchor) {
      sent = await sendReplyEmail(BRANCH_EMAIL, subject, body, anchor.threadId, anchor.rfc822MessageId);
    } else {
      sent = await sendPlainEmail(BRANCH_EMAIL, subject, body);
    }
  } catch (err) {
    log(`[VehicleDetails] reply-in-thread failed: ${err instanceof Error ? err.message : err}`);
    sent = await sendPlainEmail(BRANCH_EMAIL, subject, body);
  }
  if (!anchor) {
    const rfc822 = await getMessageRfc822Id(sent.messageId);
    if (rfc822) await capturePoThreadAnchor(purchaseOrderId, 'branch', sent.threadId, rfc822);
  }

  // Use lead SO for legacy `salesOrderId` linkage so reply-checker keeps logs sane.
  const leadSoId =
    po.bundles[0]?.loadingSlips[0]?.salesOrderId ?? po.bundles[0]?.materials[0]?.salesOrderId;

  await prisma.email.create({
    data: {
      purchaseOrderId,
      salesOrderId: leadSoId,
      gmailMessageId: sent.messageId,
      gmailThreadId: sent.threadId,
      recipientEmail: BRANCH_EMAIL,
      subject,
      status: 'sent',
      emailType: 'vehicle_details',
      workflowState: 'awaiting_reply',
      sentBody: body,
    },
  });

  // Audit-trail event per SO in the PO so the LLM planner sees this milestone
  // for every SO that lands a reply on this thread.
  try {
    const { emitEvent } = await import('./scenario-events');
    const soIdsInPo = new Set<string>();
    for (const b of po.bundles) {
      for (const ls of b.loadingSlips) if (ls.salesOrderId) soIdsInPo.add(ls.salesOrderId);
      for (const m of b.materials) if (m.salesOrderId) soIdsInPo.add(m.salesOrderId);
    }
    for (const sid of soIdsInPo) {
      await emitEvent({
        salesOrderId: sid,
        type: 'email_sent',
        payload: {
          emailType: 'vehicle_details',
          recipient: BRANCH_EMAIL,
          subject,
          bundle_count: po.bundles.length,
          gmailMessageId: sent.messageId,
        },
      });
    }
  } catch {
    // Audit emission must never break the primary flow.
  }

  log(`[VehicleDetails] Sent combined vehicle-details email for PO ${po.poNumber} (${po.bundles.length} bundle(s))`);
  return { sent: true, logs };
}

/**
 * Gate function — call after every /zload1-data callback. Sends the combined
 * vehicle-details email if every ZLOAD1 work row for the PO's SOs is `done`.
 * Strict: any `failed` or `firing` row blocks the email (operator handles
 * failed rows from the dashboard).
 */
export async function checkAndSendCombinedVehicleEmailForPo(
  purchaseOrderId: string
): Promise<{ sent: boolean; logs: string[] }> {
  const logs: string[] = [];
  const log = (m: string) => {
    const t = `[${new Date().toISOString()}] ${m}`;
    console.log(t);
    logs.push(t);
  };

  const sos = await prisma.salesOrder.findMany({
    where: { purchaseOrderId },
    select: { id: true, soNumber: true },
  });
  if (sos.length === 0) {
    log(`[VehicleDetails] Gate: PO ${purchaseOrderId} has no SOs`);
    return { sent: false, logs };
  }

  const zload1Rows = await prisma.workQueue.findMany({
    where: {
      step: 'zload1',
      salesOrderId: { in: sos.map((s) => s.id) },
    },
    select: { id: true, state: true, salesOrderId: true },
  });

  if (zload1Rows.length === 0) {
    log(`[VehicleDetails] Gate: PO ${purchaseOrderId} has no ZLOAD1 rows yet`);
    return { sent: false, logs };
  }

  const notDone = zload1Rows.filter((r) => r.state !== 'done');
  if (notDone.length > 0) {
    log(
      `[VehicleDetails] Gate: PO ${purchaseOrderId} not ready — ${notDone.length}/${zload1Rows.length} ZLOAD1 row(s) still ${[...new Set(notDone.map((r) => r.state))].join('/')}`
    );
    return { sent: false, logs };
  }

  log(`[VehicleDetails] Gate: PO ${purchaseOrderId} all ${zload1Rows.length} ZLOAD1 row(s) done — sending combined email`);
  const result = await sendCombinedVehicleDetailsEmailForPo(purchaseOrderId);
  logs.push(...result.logs);
  return result;
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

/**
 * Persist proposed dispatch quantities onto Material rows for a single SO.
 * dispatchQuantity:
 *   null  = not yet decided (default)
 *   0     = excluded
 *   >0    = include with that qty
 */
async function persistDispatchPlan(plan: SoReleasePlan): Promise<void> {
  // First reset all Material rows for this SO to 0 (excluded), then bump
  // each plan item up to its decided qty. Anything not in the plan stays 0.
  // releasedAt is stamped only on rows we actually commit to ship (qty > 0)
  // — that's the signal the FCFS reactivator subtracts from inflow.
  await prisma.material.updateMany({
    where: { salesOrderId: plan.salesOrderId },
    data: { dispatchQuantity: 0 },
  });
  const now = new Date();
  for (const item of plan.items) {
    await prisma.material.updateMany({
      where: {
        salesOrderId: plan.salesOrderId,
        material: item.material_code,
        batch: item.batch,
      },
      data: { dispatchQuantity: item.quantity, releasedAt: now },
    });
  }
}

/**
 * Compose the prose dispatch-confirmation email body, grouped TRUCK-WISE
 * (per Bundle), with each item annotated with its source SO. Weights are
 * rendered to 3 decimals (kg precision) so the totals don't drift from
 * rounding.
 */
type BundleForEmail = {
  bundleNumber: number;
  totalWeightKg: import('@prisma/client').Prisma.Decimal | number;
  materials: Array<{
    material: string;
    batch: string;
    dispatchQuantity: number | null;
    orderQuantity: number;
    orderWeightKg: import('@prisma/client').Prisma.Decimal | number | null;
    salesOrder: { soNumber: string; plant: string | null };
  }>;
};

function renderDispatchConfirmationBody(args: {
  poNumber: string;
  customerName: string;
  twoVehicles: boolean;
  totalTonnes: number;
  capacityTonnes: number;
  bundles: BundleForEmail[];
  /** Optional per-material diff from previewBundlesForPo. Rendered as a
   *  "Changes since last plan" section above the bundle list when present.
   *  Used on post-modification dispatch_confirmation sends so the branch sees
   *  exactly which lines / bundles shifted vs the previously-confirmed plan. */
  diff?: import('./bundler').BundleDiffLine[];
  /** True when the diff is non-empty AND every line stays in its current
   *  bundle (only qty deltas, no migration). Drives a clearer label. */
  pureQtyChange?: boolean;
}): string {
  const { poNumber, customerName, twoVehicles, totalTonnes, capacityTonnes, bundles, diff, pureQtyChange } = args;

  const fmtT = (n: number) => n.toFixed(3);
  const totalStr = fmtT(totalTonnes);
  const vehicleCount = bundles.length;
  const intro = twoVehicles
    ? `Vehicle split confirmed for Purchase Order ${poNumber} (${customerName}). Total dispatch ${totalStr} t across ${vehicleCount} vehicles (capacity ${capacityTonnes} t each).`
    : `Dispatch plan ready for Purchase Order ${poNumber} (${customerName}). Total ${totalStr} t — fits in 1 vehicle (capacity ${capacityTonnes} t).`;

  // Build the diff block when present and non-empty.
  let diffBlock = '';
  if (diff && diff.length > 0) {
    const heading = pureQtyChange
      ? 'Changes since last plan (quantity adjustments only — loading slips will be updated):'
      : 'Changes since last plan (composition shift — bundles will be re-organised):';
    const diffLines = diff.map((d) => {
      const label = `${d.material} (Batch ${d.batch})`;
      if (d.currentQty === 0 && d.proposedQty > 0) {
        return `  + ${label}: NEW LINE → ${d.proposedQty} units in Bundle ${d.proposedBundleNumber}`;
      }
      if (d.proposedQty === 0 && d.currentQty > 0) {
        return `  - ${label}: REMOVED (was ${d.currentQty} units in Bundle ${d.currentBundleNumber ?? '?'})`;
      }
      const bundleNote =
        d.currentBundleNumber !== null && d.currentBundleNumber !== d.proposedBundleNumber
          ? ` (moved from Bundle ${d.currentBundleNumber} → Bundle ${d.proposedBundleNumber})`
          : '';
      return `  • ${label}: ${d.currentQty} → ${d.proposedQty} units${bundleNote}`;
    });
    diffBlock = [heading, '', ...diffLines, ''].join('\n');
  }

  const sections = bundles
    .map((b) => {
      const bundleT = fmtT(Number(b.totalWeightKg) / 1000);
      const lines = b.materials.map((m) => {
        const dispatchQty = m.dispatchQuantity ?? 0;
        const orderedQty = m.orderQuantity || 0;
        const fullWeightKg = m.orderWeightKg ? Number(m.orderWeightKg) : 0;
        const itemKg = orderedQty > 0 ? (dispatchQty / orderedQty) * fullWeightKg : 0;
        // Append "(sourced from plant X)" for materials whose product-db plant
        // differs from the SO's own plant — i.e. cross-plant substitutions
        // chosen by stock_precheck. Branch sees explicitly which lines aren't
        // coming from their usual plant.
        const subPlant = substituteSourcePlant(m.material, m.salesOrder.plant);
        const subSuffix = subPlant ? ` (sourced from plant ${subPlant})` : '';
        return `  - SO ${m.salesOrder.soNumber} / ${m.material} (Batch ${m.batch}): ${dispatchQty} units, ${fmtT(itemKg / 1000)} t${subSuffix}`;
      });
      return `Bundle ${b.bundleNumber} — ${bundleT} t (of ${capacityTonnes} t capacity):\n${lines.join('\n')}`;
    })
    .join('\n\n');

  // When we have a diff (post-modification cycle), the closing call-to-action
  // changes slightly: confirming means we'll RUN the modification (ZLOAD2),
  // not create LSs from scratch.
  const closingLines = diff && diff.length > 0
    ? [
        'Please reply with:',
        '  - "yes" / "confirm" to apply the above changes (we will update the existing loading slips and send the revised slips to the plant), or',
        '  - any further adjustments you want to make.',
        '',
        'Once confirmed we will update the loading slips and re-share them with the plant.',
      ]
    : [
        'Please reply with:',
        '  - "yes" / "confirm" to proceed with the above plan, or',
        '  - the changes you want (e.g. "skip OOWJ on SO 1234567", "send only 15 of OP7WJ").',
        '',
        'Once confirmed we will create the loading slips.',
      ];

  return [
    'Dear Branch Team,',
    '',
    intro,
    '',
    ...(diffBlock ? [diffBlock] : []),
    'Proposed dispatch (grouped by bundle):',
    '',
    sections,
    '',
    ...closingLines,
    '',
    'Best regards,',
    'Sales Order Dispatch Co-ordinator',
  ].join('\n');
}

/**
 * After the weight gate clears (under capacity, or 2-vehicle confirmed):
 *  1. Persist proposed dispatch quantities onto Material rows.
 *  2. Send a prose confirmation email to the branch.
 *  3. Create the awaiting_dispatch_confirmation Email row so the cron picks
 *     up the reply via handleDispatchConfirmation.
 *
 * Does NOT fire ZLOAD1 — that happens after the branch confirms.
 */
export async function sendDispatchConfirmationEmail(args: {
  purchaseOrderId: string;
  plans: SoReleasePlan[];
  twoVehicles: boolean;
  totalTonnes: number;
  capacityTonnes: number;
  log: (msg: string) => void;
}): Promise<void> {
  const { purchaseOrderId, plans, twoVehicles, totalTonnes, capacityTonnes, log } = args;

  if (!BRANCH_EMAIL) {
    log(`[DispatchConfirm] BRANCH_EMAIL not configured`);
    return;
  }

  // 1) Persist the per-Material dispatch quantities.
  for (const plan of plans) {
    await persistDispatchPlan(plan);
  }

  // 2) Compute bundles now (FFD bin-pack into trucks of po.weightage*1000 kg)
  //    so the email can list items truck-by-truck.
  //
  // Two modes:
  //  - INITIAL dispatch_confirmation (no LSs exist for this PO yet) → run the
  //    destructive computeBundlesForPo so Bundle rows are written; ZLOAD1's
  //    fan-out later groups by these bundle rows.
  //  - MODIFICATION dispatch_confirmation (LSs already exist, but plant_ls
  //    NOT yet sent — Rule 9/10b flow) → run previewBundlesForPo: compute
  //    the proposed plan + structured diff in memory ONLY. Do NOT wipe LSs
  //    here; ZLOAD2 (Rule 10b path b) will update them in-place after the
  //    branch confirms this email. Wiping pre-zload2 would destroy the LSs
  //    zload2 is meant to update.
  //  - When po.weightage is null, the bundler throws — surface clearly and
  //    skip the email; cron retries once weightage lands.
  const existingLsCount = await prisma.loadingSlip.count({
    where: { salesOrder: { purchaseOrderId } },
  });
  let bundleResult: { bundleCount: number; totalKg: number; capacityKg: number };
  let previewDiff: import('./bundler').BundleDiffLine[] = [];
  let previewPureQtyChange = false;
  let previewUnchanged = false;
  try {
    if (existingLsCount > 0) {
      const { previewBundlesForPo } = await import('./bundler');
      const preview = await previewBundlesForPo(purchaseOrderId);
      bundleResult = {
        bundleCount: preview.bundleCount,
        totalKg: preview.totalKg,
        capacityKg: preview.capacityKg,
      };
      previewDiff = preview.diff;
      previewPureQtyChange = preview.pureQtyChange;
      previewUnchanged = preview.unchanged;
      log(
        `[DispatchConfirm] Preview mode (${existingLsCount} LS(s) already exist): ` +
          `${preview.bundleCount} bundle(s), unchanged=${preview.unchanged}, pureQtyChange=${preview.pureQtyChange}, diff=${preview.diff.length} line(s)`,
      );
    } else {
      bundleResult = await computeBundlesForPo(purchaseOrderId);
    }
  } catch (err) {
    const { BundlerWeightageMissingError } = await import('./bundler');
    if (err instanceof BundlerWeightageMissingError) {
      log(`[DispatchConfirm] ${err.message} — skipping dispatch_confirmation, will retry once branch replies with tonnage.`);
      return;
    }
    throw err;
  }
  log(`[DispatchConfirm] Pre-email bundling: ${bundleResult.bundleCount} bundle(s), total ${(bundleResult.totalKg / 1000).toFixed(3)} t / ${bundleResult.capacityKg / 1000} t per truck`);

  const bundlesForEmail = await prisma.bundle.findMany({
    where: { purchaseOrderId },
    orderBy: { bundleNumber: 'asc' },
    include: {
      materials: {
        where: { dispatchQuantity: { gt: 0 } },
        // `plant` is needed alongside soNumber so renderDispatchConfirmationBody
        // can detect cross-plant substituted materials and surface them in the
        // body (see substituteSourcePlant in dispatch-email-template.ts).
        include: { salesOrder: { select: { soNumber: true, plant: true } } },
        orderBy: [{ material: 'asc' }],
      },
    },
  });

  // 3) Compose body.
  const po = await prisma.purchaseOrder.findUnique({
    where: { id: purchaseOrderId },
    include: { customer: true },
  });
  if (!po) {
    log(`[DispatchConfirm] PO ${purchaseOrderId} not found`);
    return;
  }
  const body = renderDispatchConfirmationBody({
    poNumber: po.poNumber,
    customerName: po.customer?.name ?? po.customerName,
    twoVehicles,
    totalTonnes,
    capacityTonnes,
    bundles: bundlesForEmail,
    // Only surface the diff section when we ran preview mode AND there are
    // real differences. previewUnchanged is true when nothing changed since
    // the last saved plan — in that case skip the diff block; the email is
    // just a re-confirmation request and the bundle list speaks for itself.
    diff: existingLsCount > 0 && !previewUnchanged ? previewDiff : undefined,
    pureQtyChange: existingLsCount > 0 ? previewPureQtyChange : undefined,
  });
  const subject = `Dispatch Confirmation - PO ${po.poNumber}`;

  // 3) Send (reply in the canonical per-PO branch thread).
  const { resolvePoThreadAnchor, capturePoThreadAnchor } = await import('./po-thread');
  const anchor = await resolvePoThreadAnchor(purchaseOrderId, 'branch');
  let sent: { messageId: string; threadId: string };
  try {
    if (anchor) {
      sent = await sendReplyEmail(BRANCH_EMAIL, subject, body, anchor.threadId, anchor.rfc822MessageId);
    } else {
      sent = await sendPlainEmail(BRANCH_EMAIL, subject, body);
    }
  } catch (err) {
    log(`[DispatchConfirm] reply-in-thread failed: ${err instanceof Error ? err.message : err}`);
    sent = await sendPlainEmail(BRANCH_EMAIL, subject, body);
  }

  if (!anchor) {
    const rfc822 = await getMessageRfc822Id(sent.messageId);
    if (rfc822) await capturePoThreadAnchor(purchaseOrderId, 'branch', sent.threadId, rfc822);
  }

  // 4) Track the Email row for reply detection. Stamp with the PO's current
  // dispatchRound so the engine's round-scoped idempotency guard in
  // `email_confirm_bundle_details` can distinguish this round's confirmation
  // from prior rounds (post-VA02 re-cycle scenarios).
  await prisma.email.create({
    data: {
      purchaseOrderId,
      salesOrderId: plans[0]?.salesOrderId,
      gmailMessageId: sent.messageId,
      gmailThreadId: sent.threadId,
      recipientEmail: BRANCH_EMAIL,
      subject,
      status: 'sent',
      emailType: 'dispatch_confirmation',
      workflowState: 'awaiting_dispatch_confirmation',
      sentBody: body,
      relatedMaterials: JSON.stringify({ version: 'dispatch-v1', plans, twoVehicles, totalTonnes, capacityTonnes }),
      dispatchRound: po.dispatchRound,
    },
  });

  // Audit-trail event for the LLM planner — one per SO in the plan.
  try {
    const { emitEvent } = await import('./scenario-events');
    for (const plan of plans) {
      await emitEvent({
        salesOrderId: plan.salesOrderId,
        type: 'email_sent',
        payload: {
          emailType: 'dispatch_confirmation',
          recipient: BRANCH_EMAIL,
          subject,
          body_excerpt: body.slice(0, 200),
          gmailMessageId: sent.messageId,
          dispatchRound: po.dispatchRound,
          total_tonnes: totalTonnes,
        },
      });
    }
  } catch {
    // Audit emission must never break the primary flow.
  }

  log(`[DispatchConfirm] Confirmation email sent to ${BRANCH_EMAIL} for PO ${po.poNumber} (${plans.length} SO(s), ${totalTonnes.toFixed(2)} t)`);
}

/**
 * Post-plant_ls modify-increase variant of `sendDispatchConfirmationEmail`.
 *
 * Renders a dispatch_confirmation email that describes the EXISTING bundle plan
 * (loading slips already with the plant) annotated with the UPCOMING ZLOAD2 /
 * ZLOAD1-append changes resolved from a `bundle_capacity_assessment` verdict.
 * Reused upcoming-changes shape: `Allocation` from `bundle-capacity.ts`, tagged
 * with the material the allocation belongs to.
 *
 * NEVER calls the bundler (`computeBundlesForPo` / `previewBundlesForPo`) — both
 * throw `BundlesFrozenError` once any LS is `sent_to_plant`. Existing rows are
 * the source of truth.
 *
 * Reuses (carefully):
 *   - `renderDispatchConfirmationBody` with its existing `diff` parameter to
 *     surface the upcoming changes as a "Changes since last plan" block. The
 *     diff lines synthesise from allocations (no bundler involvement).
 *   - The per-PO branch thread anchor (`resolvePoThreadAnchor(po, 'branch')`).
 *   - The standard Email row write + audit-trail emission so the planner and
 *     the dashboard timeline see this email exactly like a normal
 *     dispatch_confirmation.
 *
 * Does NOT touch `Material.dispatchQuantity` or any other DB write outside the
 * Email row + audit event — Phase 3's ZLOAD2 / ZLOAD1-append callbacks write
 * LSI rows themselves.
 */
export async function sendDispatchConfirmationWithUpcomingChanges(args: {
  purchaseOrderId: string;
  salesOrderId: string;
  /**
   * One row per (material, allocation leg) from the latest
   * bundle_capacity_assessment verdict. Same shape as `Allocation` but tagged
   * with the material code, since the verdict groups by material.
   */
  allocations: Array<{
    material: string;
    kind: 'same_bundle' | 'other_bundle';
    bundleId: string;
    kg: number;
  }>;
  /** Per-material overflow legs that will be sent to a new SO. Optional. */
  overflowItems?: Array<{ material: string; overflowKg: number }>;
  log: (msg: string) => void;
}): Promise<void> {
  const { purchaseOrderId, salesOrderId, allocations, overflowItems, log } = args;

  if (!BRANCH_EMAIL) {
    log('[DispatchConfirm:upcoming] BRANCH_EMAIL not configured');
    return;
  }
  if (allocations.length === 0) {
    log('[DispatchConfirm:upcoming] no allocations — nothing to confirm; caller should have routed to email_branch_request_new_so');
    return;
  }

  const po = await prisma.purchaseOrder.findUnique({
    where: { id: purchaseOrderId },
    include: { customer: true },
  });
  if (!po) {
    log(`[DispatchConfirm:upcoming] PO ${purchaseOrderId} not found`);
    return;
  }

  // Load the existing bundle plan EXACTLY as `sendDispatchConfirmationEmail`
  // loads it for the renderer — same shape, same select set, same ordering.
  // No bundler call.
  const bundlesForEmail = await prisma.bundle.findMany({
    where: { purchaseOrderId },
    orderBy: { bundleNumber: 'asc' },
    include: {
      materials: {
        where: { dispatchQuantity: { gt: 0 } },
        include: { salesOrder: { select: { soNumber: true, plant: true } } },
        orderBy: [{ material: 'asc' }],
      },
    },
  });

  // Look up Material rows for the placed-portion materials so we can convert
  // each allocation's kg into a unit count (qty) for the diff row. lone_zmatana
  // populates `orderWeightKg` on the relevant Material rows in Phase 2.5 — by
  // the time we render here, those rows are fresh.
  const materialCodes = [...new Set(allocations.map((a) => a.material))];
  const materialRows = await prisma.material.findMany({
    where: { salesOrderId, material: { in: materialCodes } },
    select: { material: true, batch: true, orderQuantity: true, orderWeightKg: true },
  });
  const materialByCode = new Map<string, { batch: string; kgPerUnit: number }>();
  for (const m of materialRows) {
    const fullWeight = m.orderWeightKg ? Number(m.orderWeightKg) : 0;
    const ordered = m.orderQuantity || 0;
    const kgPerUnit = ordered > 0 && fullWeight > 0 ? fullWeight / ordered : 0;
    materialByCode.set(m.material, { batch: m.batch ?? '', kgPerUnit });
  }

  // Bundle number lookup keyed by id, so the diff block can name bundles by
  // their human-readable number ("Bundle 2") rather than cuid.
  const bundleNumberById = new Map<string, number>();
  for (const b of bundlesForEmail) {
    bundleNumberById.set(b.id, b.bundleNumber);
  }

  // Build the diff: one row per allocation. Reuses BundleDiffLine shape so we
  // can hand it straight to renderDispatchConfirmationBody — that function
  // already knows how to format these.
  type BundleDiffLine = import('./bundler').BundleDiffLine;
  const diff: BundleDiffLine[] = [];
  for (const a of allocations) {
    const md = materialByCode.get(a.material);
    const batch = md?.batch ?? '';
    const kgPerUnit = md?.kgPerUnit ?? 0;
    const addedUnits = kgPerUnit > 0 ? Math.round(a.kg / kgPerUnit) : 0;
    const targetBundleNumber = bundleNumberById.get(a.bundleId) ?? 0;

    if (a.kind === 'same_bundle') {
      // The existing LS on this bundle (which already carries `material`) will
      // be ZLOAD2'd to a new total. Render the diff as a qty bump on the same
      // bundle.
      const existingForMaterial = bundlesForEmail
        .find((b) => b.id === a.bundleId)?.materials
        .find((m) => m.material === a.material);
      const currentQty = existingForMaterial?.dispatchQuantity ?? 0;
      diff.push({
        material: a.material,
        batch,
        currentQty,
        proposedQty: currentQty + addedUnits,
        currentBundleNumber: targetBundleNumber,
        proposedBundleNumber: targetBundleNumber,
      });
    } else {
      // ZLOAD1-append: a NEW LS will be created on `bundleId` carrying
      // `addedUnits` of `material`. Render as a NEW LINE landing on the target
      // bundle.
      diff.push({
        material: a.material,
        batch,
        currentQty: 0,
        proposedQty: addedUnits,
        currentBundleNumber: null,
        proposedBundleNumber: targetBundleNumber,
      });
    }
  }

  // Totals for the email intro line. Same formula `sendDispatchConfirmationEmail`
  // uses: sum of per-material itemKg derived from dispatchQuantity / orderQty
  // * orderWeightKg, across every bundle's materials.
  let totalKg = 0;
  for (const b of bundlesForEmail) {
    for (const m of b.materials) {
      const dispatchQty = m.dispatchQuantity ?? 0;
      const orderedQty = m.orderQuantity || 0;
      const fullWeight = m.orderWeightKg ? Number(m.orderWeightKg) : 0;
      if (orderedQty > 0 && dispatchQty > 0 && fullWeight > 0) {
        totalKg += (dispatchQty / orderedQty) * fullWeight;
      }
    }
  }
  // Plus the upcoming additions — these aren't on Material.dispatchQuantity yet
  // (Phase 3 will set that via the ZLOAD callbacks), so add them in for the
  // header total.
  for (const a of allocations) totalKg += a.kg;

  const totalTonnes = totalKg / 1000;
  const capacityTonnes = po.weightage ? Number(po.weightage) : 0;
  const twoVehicles = bundlesForEmail.length > 1;

  // pureQtyChange = every allocation stays on the bundle the material already
  // belongs to. When any leg is `other_bundle`, a new LS lands on a different
  // bundle → composition shift → false. Mirrors the preview-bundler convention.
  const pureQtyChange = allocations.every((a) => a.kind === 'same_bundle');

  const body = renderDispatchConfirmationBody({
    poNumber: po.poNumber,
    customerName: po.customer?.name ?? po.customerName,
    twoVehicles,
    totalTonnes,
    capacityTonnes,
    bundles: bundlesForEmail,
    diff,
    pureQtyChange,
  });

  // Optional overflow footer — branch sees the placed plan AND knows a new SO
  // request is coming separately for the spill. Doesn't replace
  // email_branch_request_new_so; just heads off "wait, where's the rest?"
  // confusion in this email.
  const overflowFooter = overflowItems && overflowItems.length > 0
    ? '\n\nNote: ' + overflowItems
        .map((o) => `${o.material} has an additional ${Math.round(o.overflowKg)} kg that cannot be accommodated in the current vehicle plan; a separate request for a new SO will follow.`)
        .join(' ')
    : '';
  const finalBody = body + overflowFooter;

  const subject = `Dispatch Confirmation - PO ${po.poNumber}`;

  // Send in the per-PO branch thread (same anchoring rules as the original
  // function).
  const { resolvePoThreadAnchor, capturePoThreadAnchor } = await import('./po-thread');
  const anchor = await resolvePoThreadAnchor(purchaseOrderId, 'branch');
  let sent: { messageId: string; threadId: string };
  try {
    if (anchor) {
      sent = await sendReplyEmail(BRANCH_EMAIL, subject, finalBody, anchor.threadId, anchor.rfc822MessageId);
    } else {
      sent = await sendPlainEmail(BRANCH_EMAIL, subject, finalBody);
    }
  } catch (err) {
    log(`[DispatchConfirm:upcoming] reply-in-thread failed: ${err instanceof Error ? err.message : err}`);
    sent = await sendPlainEmail(BRANCH_EMAIL, subject, finalBody);
  }
  if (!anchor) {
    const rfc822 = await getMessageRfc822Id(sent.messageId);
    if (rfc822) await capturePoThreadAnchor(purchaseOrderId, 'branch', sent.threadId, rfc822);
  }

  // Email row + audit event identical to the original function's, including
  // dispatchRound stamping so reply-detection / round guards work the same way.
  await prisma.email.create({
    data: {
      purchaseOrderId,
      salesOrderId,
      gmailMessageId: sent.messageId,
      gmailThreadId: sent.threadId,
      recipientEmail: BRANCH_EMAIL,
      subject,
      status: 'sent',
      emailType: 'dispatch_confirmation',
      workflowState: 'awaiting_dispatch_confirmation',
      sentBody: finalBody,
      relatedMaterials: JSON.stringify({
        version: 'dispatch-upcoming-v1',
        allocations,
        overflowItems: overflowItems ?? [],
      }),
      dispatchRound: po.dispatchRound,
    },
  });

  try {
    const { emitEvent } = await import('./scenario-events');
    await emitEvent({
      salesOrderId,
      type: 'email_sent',
      payload: {
        emailType: 'dispatch_confirmation',
        recipient: BRANCH_EMAIL,
        subject,
        body_excerpt: finalBody.slice(0, 200),
        gmailMessageId: sent.messageId,
        dispatchRound: po.dispatchRound,
        total_tonnes: totalTonnes,
        flow: 'upcoming_changes',
      },
    });
  } catch {
    // Audit emission must never break the primary flow.
  }

  log(
    `[DispatchConfirm:upcoming] Sent to ${BRANCH_EMAIL} for PO ${po.poNumber} ` +
      `(${allocations.length} allocation(s), overflow=${overflowItems?.length ?? 0}, total ${totalTonnes.toFixed(2)} t)`,
  );
}

/**
 * Follow-up update to an existing dispatch_confirmation for the same round.
 * When the round guard would have skipped a re-send but the plan has actually
 * changed (e.g. quantity revision after the original confirmation went out),
 * we send a short diff reply IN THE SAME thread instead of a fresh full form.
 *
 * Returns `{ skipped: true }` when there's no prior dispatch_confirmation for
 * the round, when the prior has no usable plans snapshot, or when the new
 * plan is identical to the prior (no diff to communicate).
 */
export async function sendDispatchConfirmationUpdate(args: {
  purchaseOrderId: string;
  currentRound: number;
  plans: SoReleasePlan[];
  totalTonnes: number;
  log: (msg: string) => void;
}): Promise<{ sent: boolean; skipped?: boolean; reason?: string }> {
  const { purchaseOrderId, currentRound, plans, totalTonnes, log } = args;

  if (!BRANCH_EMAIL) {
    log(`[DispatchConfirm:update] BRANCH_EMAIL not configured`);
    return { sent: false, skipped: true, reason: 'no_branch_email' };
  }

  // The prior dispatch_confirmation is normally `replied` by the time we
  // reach the diff path (the reply is what triggered the re-plan), so we
  // must match both `sent` and `replied`.
  const prior = await prisma.email.findFirst({
    where: {
      purchaseOrderId,
      emailType: 'dispatch_confirmation',
      status: { in: ['sent', 'replied'] },
      dispatchRound: currentRound,
    },
    orderBy: { sentAt: 'desc' },
    select: { id: true, gmailThreadId: true, gmailMessageId: true, relatedMaterials: true },
  });
  if (!prior) {
    return { sent: false, skipped: true, reason: 'no_prior_for_round' };
  }

  // Pull the per-(soNumber, material, batch) quantity from the prior plan
  // snapshot so we can compute the diff.
  type PriorItem = { material_code: string; batch: string; quantity: number };
  const priorByKey = new Map<string, number>();
  try {
    const parsed = prior.relatedMaterials ? JSON.parse(prior.relatedMaterials) : null;
    const priorPlans: Array<{ soNumber: string; items: PriorItem[] }> = parsed?.plans ?? [];
    for (const p of priorPlans) {
      for (const it of p.items ?? []) {
        priorByKey.set(`${p.soNumber}|${it.material_code}|${it.batch}`, it.quantity);
      }
    }
  } catch {
    log(`[DispatchConfirm:update] prior email ${prior.id} has unparseable relatedMaterials — skipping diff`);
    return { sent: false, skipped: true, reason: 'prior_unparseable' };
  }

  type DiffRow = { soNumber: string; material: string; batch: string; was: number; now: number };
  const diffs: DiffRow[] = [];
  for (const plan of plans) {
    for (const it of plan.items) {
      const key = `${plan.soNumber}|${it.material_code}|${it.batch}`;
      const was = priorByKey.get(key);
      if (was === undefined) {
        diffs.push({ soNumber: plan.soNumber, material: it.material_code, batch: it.batch, was: 0, now: it.quantity });
        continue;
      }
      if (was !== it.quantity) {
        diffs.push({ soNumber: plan.soNumber, material: it.material_code, batch: it.batch, was, now: it.quantity });
      }
      priorByKey.delete(key);
    }
  }
  for (const [key, was] of priorByKey.entries()) {
    const [soNumber, material, batch] = key.split('|');
    diffs.push({ soNumber, material, batch, was, now: 0 });
  }

  if (diffs.length === 0) {
    log(`[DispatchConfirm:update] no diff vs prior email ${prior.id} — skipping`);
    return { sent: false, skipped: true, reason: 'no_diff' };
  }

  const lines = diffs.map(
    (d) => `  - SO ${d.soNumber} / ${d.material} (Batch ${d.batch}): ${d.was} → ${d.now}`,
  );
  const body = [
    `Hi,`,
    ``,
    `Update to the dispatch plan we shared earlier on this thread:`,
    ``,
    ...lines,
    ``,
    `Revised total: ${totalTonnes.toFixed(2)} t.`,
    ``,
    `Please confirm.`,
    ``,
    `Thanks.`,
  ].join('\n');
  const subject = `Re: Dispatch Plan Update`;

  // Reply on the prior dispatch_confirmation's exact message so Gmail stitches
  // it tightly. Fall back to the per-PO branch anchor if that lookup fails.
  let sent: { messageId: string; threadId: string };
  try {
    const rfc822 = await getMessageRfc822Id(prior.gmailMessageId);
    if (rfc822) {
      sent = await sendReplyEmail(BRANCH_EMAIL, subject, body, prior.gmailThreadId, rfc822);
    } else {
      const { resolvePoThreadAnchor } = await import('./po-thread');
      const anchor = await resolvePoThreadAnchor(purchaseOrderId, 'branch');
      sent = anchor
        ? await sendReplyEmail(BRANCH_EMAIL, subject, body, anchor.threadId, anchor.rfc822MessageId)
        : await sendPlainEmail(BRANCH_EMAIL, subject, body);
    }
  } catch (err) {
    log(`[DispatchConfirm:update] send failed (${err instanceof Error ? err.message : err}); falling back to fresh email`);
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
      emailType: 'dispatch_confirmation_update',
      workflowState: 'awaiting_dispatch_confirmation',
      sentBody: body,
      relatedMaterials: JSON.stringify({ version: 'dispatch-update-v1', plans, totalTonnes, diff: diffs }),
      dispatchRound: currentRound,
    },
  });

  try {
    const { emitEvent } = await import('./scenario-events');
    for (const plan of plans) {
      await emitEvent({
        salesOrderId: plan.salesOrderId,
        type: 'email_sent',
        payload: {
          emailType: 'dispatch_confirmation_update',
          recipient: BRANCH_EMAIL,
          subject,
          body_excerpt: body.slice(0, 200),
          gmailMessageId: sent.messageId,
          dispatchRound: currentRound,
          diff_count: diffs.length,
        },
      });
    }
  } catch {
    // Audit emission must never break the primary flow.
  }

  log(`[DispatchConfirm:update] Sent diff update for PO ${purchaseOrderId} round ${currentRound} (${diffs.length} change(s)) replying to prior ${prior.id}`);
  return { sent: true };
}

/**
 * Compute bundles for a PO (idempotent) and fire ZLOAD1 once per (Bundle, SO)
 * pair using each Material's saved dispatchQuantity. Flips touched SOs to
 * `stock_approved`. Two callers: handleDispatchConfirmation when the branch
 * confirms the dispatch plan, and the scenario engine when its `zload1` step
 * is reached on a modification scenario.
 */
export async function fanOutZload1ForPo(
  purchaseOrderId: string,
  log: (msg: string) => void,
): Promise<{ fired: number; bundleCount: number }> {
  let bundleResult;
  try {
    bundleResult = await computeBundlesForPo(purchaseOrderId);
  } catch (err) {
    const { BundlerWeightageMissingError } = await import('./bundler');
    if (err instanceof BundlerWeightageMissingError) {
      log(`[ZLOAD1-Fanout] ${err.message} — cannot fire ZLOAD1 yet.`);
      return { fired: 0, bundleCount: 0 };
    }
    throw err;
  }
  log(`[ZLOAD1-Fanout] Computed ${bundleResult.bundleCount} bundle(s) for PO (${(bundleResult.totalKg / 1000).toFixed(2)} t / ${(bundleResult.capacityKg / 1000)} t)`);

  // Fire ZLOAD1 once per (Bundle, SO) pair — only the materials of that SO
  // that live in that bundle. An SO that spans bundles gets multiple fires;
  // a bundle that holds multiple SOs also gets multiple fires. The global
  // WorkQueue serializes everything; we just control enqueue order:
  // bundleNumber asc, then SO createdAt asc within a bundle.
  const bundlesWithMaterials = await prisma.bundle.findMany({
    where: { purchaseOrderId },
    orderBy: { bundleNumber: 'asc' },
    include: {
      materials: {
        where: { dispatchQuantity: { gt: 0 } },
        include: {
          salesOrder: { select: { id: true, soNumber: true, createdAt: true } },
        },
      },
    },
  });

  let fired = 0;
  const stockApprovedSoIds = new Set<string>();

  for (const bundle of bundlesWithMaterials) {
    type Slot = { soNumber: string; salesOrderId: string; createdAt: Date; items: MaterialItemPayload[] };
    const bySo = new Map<string, Slot>();
    for (const m of bundle.materials) {
      const slot = bySo.get(m.salesOrderId) ?? {
        soNumber: m.salesOrder.soNumber,
        salesOrderId: m.salesOrderId,
        createdAt: m.salesOrder.createdAt,
        items: [],
      };
      slot.items.push({
        material_code: m.material,
        batch: m.batch,
        quantity: m.dispatchQuantity!,
      });
      bySo.set(m.salesOrderId, slot);
    }

    const slots = Array.from(bySo.values()).sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
    );

    for (const slot of slots) {
      if (!stockApprovedSoIds.has(slot.salesOrderId)) {
        await prisma.salesOrder.update({
          where: { id: slot.salesOrderId },
          data: { status: 'stock_approved', releasePlan: null },
        });
        stockApprovedSoIds.add(slot.salesOrderId);
      }
      await triggerZload1(slot.soNumber, slot.items, bundle.id, bundle.bundleNumber);
      fired++;
      log(`[ZLOAD1-Fanout] Fired ZLOAD1 for SO ${slot.soNumber} / Bundle ${bundle.bundleNumber}: ${slot.items.length} item(s)`);
    }
  }

  return { fired, bundleCount: bundleResult.bundleCount };
}

/**
 * Append-mode ZLOAD1 fan-out for the post-plant-intimation flow.
 *
 * Used when `bundle_capacity_assessment` returns `fits_other_bundle`: the
 * branch added/increased a material that fits in a sibling bundle on the
 * same PO, but the existing LSs on the current bundle can't absorb it. We
 * issue a NEW loading slip onto the target bundle for just the appended
 * materials — bypassing computeBundlesForPo entirely (which would throw
 * BundlesFrozenError post-plant). The zload1-data callback reads the
 * `append_to_bundle_id` from the WorkQueue meta and links the new LS to
 * that bundle directly, then bumps Bundle.totalWeightKg.
 *
 * Refuses on dispatched bundles — once a truck has rolled, no appends.
 */
export async function fanOutZload1AppendToBundle(args: {
  salesOrderId: string;
  appendToBundleId: string;
  materials: Array<{ material_code: string; batch?: string; quantity: number }>;
  log: (msg: string) => void;
}): Promise<{ fired: number }> {
  const { salesOrderId, appendToBundleId, materials, log } = args;
  const so = await prisma.salesOrder.findUnique({
    where: { id: salesOrderId },
    select: { soNumber: true, purchaseOrderId: true },
  });
  if (!so) {
    throw new Error(`fanOutZload1AppendToBundle: SO ${salesOrderId} not found`);
  }
  const bundle = await prisma.bundle.findUnique({
    where: { id: appendToBundleId },
    select: { id: true, bundleNumber: true, status: true, purchaseOrderId: true },
  });
  if (!bundle) {
    throw new Error(`fanOutZload1AppendToBundle: Bundle ${appendToBundleId} not found`);
  }
  if (bundle.purchaseOrderId !== so.purchaseOrderId) {
    throw new Error(
      `fanOutZload1AppendToBundle: Bundle ${appendToBundleId} (PO ${bundle.purchaseOrderId}) does not belong to SO's PO (${so.purchaseOrderId})`,
    );
  }
  if (bundle.status === 'dispatched') {
    throw new Error(
      `fanOutZload1AppendToBundle: Bundle ${appendToBundleId} is dispatched — no appends permitted`,
    );
  }

  const payloadItems: MaterialItemPayload[] = materials.map((m) => ({
    material_code: m.material_code,
    batch: m.batch ?? '',
    quantity: m.quantity,
  }));

  await triggerZload1(so.soNumber, payloadItems, bundle.id, bundle.bundleNumber, true);
  log(
    `[ZLOAD1-Append] Fired append-mode ZLOAD1 for SO ${so.soNumber} onto Bundle ${bundle.bundleNumber} (id=${bundle.id}): ${payloadItems.length} material(s)`,
  );
  return { fired: 1 };
}

/**
 * Branch replied to the dispatch confirmation email.
 * Light parsing: 'yes/confirm/proceed' → fire ZLOAD1 per SO from the saved
 * Material.dispatchQuantity values. Anything else (changes, 'no') is left
 * for the operator to handle on the dashboard.
 */
/**
 * Test-only thin wrapper. The production path runs the planner directly via
 * `handleReplyV2`; this wrapper exists for `scripts/e2e-chains.ts` which
 * simulates a dispatch_confirmation reply by importing this function. The
 * `preClassified` argument is now ignored — the planner reads the reply
 * itself from the email thread.
 */
export async function handleDispatchConfirmation(
  emailId: string,
  replyHtml: string,
  _preClassified?: { decision: 'yes' | 'no' | 'ambiguous' },
): Promise<{ success: boolean; logs: string[] }> {
  const { handleReplyV2 } = await import('./scenario-engine');
  const r = await handleReplyV2({
    emailId,
    replyHtml,
    originalEmailHtml: '',
    sourceEmailType: 'branch',
  });
  return { success: r.success, logs: r.logs };
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
      meta: {
        so_number: soNumber,
      },
    },
  });
  await pumpQueue();
  console.log(`[ZSO-VISIBILITY] Enqueued for SO ${soNumber}`);
}

/**
 * Run ZMatana standalone for one or more material codes on the current SO.
 *
 * Used after `stock_precheck` substitutes a short material with a cross-plant
 * equivalent: VA02 has swapped the SO line to the new material code, and we
 * need ZMatana to fetch its batch + per-SO availability so downstream steps
 * (ls_dispatch, bundling) can ship it. We can't re-run ZSO_Visibility because
 * that re-syncs the entire SO and would reset state we've intentionally
 * changed.
 *
 * Enqueues ONE WorkQueue row carrying the full material list. The auto_gui2
 * endpoint for the `LONE-ZMATANA` transaction runs the SO + materials in a
 * single pass and POSTs back to /backend/orders/aman/zmatana-data with a
 * `materials[]` array (batch + available_stock_for_so per material), mirroring
 * the ZSO-VISIBILITY response shape.
 */
export async function triggerLoneZmatana(
  soNumber: string,
  materialCodes: string[],
): Promise<void> {
  if (materialCodes.length === 0) {
    console.log(`[LONE-ZMATANA] No materials provided for SO ${soNumber} — skipping`);
    return;
  }
  // Sort so the dedup key is stable regardless of caller ordering.
  const normalized = Array.from(new Set(materialCodes)).sort();
  const so = await prisma.salesOrder.findFirst({ where: { soNumber }, select: { id: true } });

  // Dedup on (soNumber, sorted-material-set) — calling triggerLoneZmatana twice
  // within a single flow for the same SO + materials is a no-op for an
  // already-queued / in-flight / done row.
  const materialsKey = normalized.join(',');
  const existing = await prisma.workQueue.findFirst({
    where: {
      step: 'lone_zmatana',
      state: { in: ['queued', 'firing', 'done'] },
      AND: [
        { payload: { contains: `"transaction_code":"LONE-ZMATANA"` } },
        { payload: { contains: `"so_number":"${soNumber}"` } },
        { payload: { contains: `"materials_key":"${materialsKey}"` } },
      ],
    },
    select: { id: true, state: true },
  });
  if (existing) {
    console.log(`[LONE-ZMATANA] Already exists for SO ${soNumber} materials [${materialsKey}] (${existing.state}) — skipping`);
    return;
  }

  const materialList = normalized.join(', ');
  await enqueueWork({
    salesOrderId: so?.id ?? null,
    step: 'lone_zmatana',
    payload: {
      instruction:
        `VPN is connected and SAP is logged in. Just go ahead and run the SAP ` +
        `Transaction LONE-ZMATANA for Sales Order number ${soNumber} for material ${materialList}.`,
      transaction_code: 'LONE-ZMATANA',
      meta: {
        so_number: soNumber,
        materials: normalized,
        materials_key: materialsKey,
      },
    },
  });
  await pumpQueue();
  console.log(`[LONE-ZMATANA] Enqueued for SO ${soNumber} (${normalized.length} material(s): ${materialList})`);
}

/**
 * Trigger ZLOADING_CLOSE for one or more materials on a sales order.
 *
 * Builds an instruction of the form:
 *   "VPN is connected and SAP is logged in. Just go ahead and run the SAP
 *    Transaction ZLOADING_CLOSE for Sales Order number <soNumber>.
 *    Close material X, Close material Y."
 *
 * Idempotent: dedups on (soNumber + sorted materials) by scanning WorkQueue
 * for an existing zloading_close row in queued/firing/done state with the
 * same materials_key in the payload.
 */
export async function triggerZloadingClose(
  lsNumber: string,
  materials: string[]
): Promise<void> {
  if (materials.length === 0) {
    console.log(`[ZLOADING_CLOSE] No materials provided for LS ${lsNumber} — skipping`);
    return;
  }

  const normalized = Array.from(new Set(materials)).sort();
  const materialsKey = JSON.stringify(normalized);

  // Dedup on (lsNumber, materials). Two close requests for the same materials
  // on the same LS are a no-op.
  const existing = await prisma.workQueue.findFirst({
    where: {
      step: 'zloading_close',
      state: { in: ['queued', 'firing', 'done'] },
      AND: [
        { payload: { contains: `"transaction_code":"ZLOADING_CLOSE"` } },
        { payload: { contains: `"ls_number":"${lsNumber}"` } },
        { payload: { contains: `"materials_key":${JSON.stringify(materialsKey)}` } },
      ],
    },
    select: { id: true, state: true },
  });
  if (existing) {
    console.log(
      `[ZLOADING_CLOSE] Already exists for LS ${lsNumber} materials=${materialsKey} (${existing.state}) — skipping`
    );
    return;
  }

  const closeClauses = normalized.map((m) => `close material ${m}`).join(', ');
  const instruction =
    `VPN is connected and SAP is logged in. Just go ahead and run the SAP ` +
    `Transaction ZLOADING_CLOSE for Loading Slip number ${lsNumber}: ${closeClauses}.`;

  // Find any LSI on this LS to link the WorkQueue row to its SalesOrder.
  const lsi = await prisma.loadingSlipItem.findFirst({
    where: { lsNumber },
    select: { salesOrderId: true },
  });

  await enqueueWork({
    salesOrderId: lsi?.salesOrderId ?? null,
    step: 'zloading_close',
    payload: {
      instruction,
      transaction_code: 'ZLOADING_CLOSE',
      meta: {
        ls_number: lsNumber,
        materials: normalized,
        materials_key: materialsKey,
      },
    },
  });
  await pumpQueue();
  console.log(
    `[ZLOADING_CLOSE] Enqueued for LS ${lsNumber} (${normalized.length} material(s): ${normalized.join(', ')})`
  );
}

/**
 * Trigger VA02 to set order quantities on one or more materials of a sales order.
 *
 * Builds an instruction like:
 *   "...VA02 for Sales Order number <soNumber>. For material X set the order
 *    quantity to N, for material Y set the order quantity to M"
 *
 * Idempotent on the full payload: dedups against existing queued/firing/done
 * va02 rows with the exact same SO + sorted material→quantity map. A later
 * call with different quantities fires normally — supports legitimate
 * sequential edits.
 */
export async function triggerVa02(
  soNumber: string,
  materials: Array<{ material: string; orderQuantity: number }>
): Promise<void> {
  if (materials.length === 0) {
    console.log(`[VA02] No materials provided for SO ${soNumber} — skipping`);
    return;
  }

  const byMaterial = new Map<string, number>();
  for (const m of materials) byMaterial.set(m.material, m.orderQuantity);
  const normalized = Array.from(byMaterial.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([material, orderQuantity]) => ({ material, orderQuantity }));
  const payloadKey = JSON.stringify({ soNumber, materials: normalized });

  // Dedup is scoped to VA02 via both `step` and a payload substring match on
  // `"transaction_code":"VA02"` — prevents any cross-transaction collision.
  const existing = await prisma.workQueue.findFirst({
    where: {
      step: 'va02',
      state: { in: ['queued', 'firing', 'done'] },
      AND: [
        { payload: { contains: `"transaction_code":"VA02"` } },
        { payload: { contains: `"payload_key":${JSON.stringify(payloadKey)}` } },
      ],
    },
    select: { id: true, state: true },
  });
  if (existing) {
    console.log(
      `[VA02] Already exists for SO ${soNumber} payload_key=${payloadKey} (${existing.state}) — skipping`
    );
    return;
  }

  const clauses = normalized
    .map((m) => `for material ${m.material} set the order quantity to ${m.orderQuantity}`)
    .join(', ');
  const clausesSentence = clauses.charAt(0).toUpperCase() + clauses.slice(1);
  const instruction =
    `VPN is connected and SAP is logged in. Just go ahead and run the SAP ` +
    `Transaction VA02 for Sales Order number ${soNumber}. ${clausesSentence}`;

  const so = await prisma.salesOrder.findFirst({
    where: { soNumber },
    select: { id: true },
  });

  await enqueueWork({
    salesOrderId: so?.id ?? null,
    step: 'va02',
    payload: {
      instruction,
      transaction_code: 'VA02',
      so_number: soNumber,
      meta: {
        so_number: soNumber,
        materials: normalized,
        payload_key: payloadKey,
      },
    },
  });
  await pumpQueue();
  console.log(`[VA02] Enqueued for SO ${soNumber} (${normalized.length} material(s))`);
}

/**
 * Trigger ZLOAD2 for a loading slip with per-material batch + quantity.
 *
 * Builds an instruction like:
 *   "...ZLOAD2 for Loading Slip number <lsNumber>. For material X batch <B>
 *    order quantity is N, for material Y batch <B2> order quantity is M"
 *
 * Resolves salesOrderId from a LoadingSlipItem with the given lsNumber so the
 * WorkQueue row is linked to the SO.
 *
 * Idempotent on the full payload: dedups against existing queued/firing/done
 * zload2 rows with the exact same LS + sorted (material, batch, quantity).
 */
export async function triggerZload2(
  lsNumber: string,
  materials: Array<{ material: string; batch: string; orderQuantity: number }>
): Promise<void> {
  if (materials.length === 0) {
    console.log(`[ZLOAD2] No materials provided for LS ${lsNumber} — skipping`);
    return;
  }

  const missingBatch = materials.find((m) => !m.batch);
  if (missingBatch) {
    throw new Error(
      `[ZLOAD2] Material ${missingBatch.material} has no batch — batch is required for ZLOAD2`
    );
  }

  const byKey = new Map<string, { material: string; batch: string; orderQuantity: number }>();
  for (const m of materials) byKey.set(`${m.material}|${m.batch}`, { ...m });
  const normalized = Array.from(byKey.values()).sort((a, b) =>
    a.material === b.material ? a.batch.localeCompare(b.batch) : a.material.localeCompare(b.material)
  );
  const payloadKey = JSON.stringify({ lsNumber, materials: normalized });

  // Dedup is scoped to ZLOAD2 via both `step` and a payload substring match on
  // `"transaction_code":"ZLOAD2"` — prevents any cross-transaction collision.
  const existing = await prisma.workQueue.findFirst({
    where: {
      step: 'zload2',
      state: { in: ['queued', 'firing', 'done'] },
      AND: [
        { payload: { contains: `"transaction_code":"ZLOAD2"` } },
        { payload: { contains: `"payload_key":${JSON.stringify(payloadKey)}` } },
      ],
    },
    select: { id: true, state: true },
  });
  if (existing) {
    console.log(
      `[ZLOAD2] Already exists for LS ${lsNumber} payload_key=${payloadKey} (${existing.state}) — skipping`
    );
    return;
  }

  const clauses = normalized
    .map((m) => `for material ${m.material} batch ${m.batch} order quantity is ${m.orderQuantity}`)
    .join(', ');
  const clausesSentence = clauses.charAt(0).toUpperCase() + clauses.slice(1);
  const instruction =
    `VPN is connected and SAP is logged in. Just go ahead and run the SAP ` +
    `Transaction ZLOAD2 for Loading Slip number ${lsNumber}. ${clausesSentence}`;

  // Any item for this lsNumber works — all items of a single LS share the same SO.
  const lsi = await prisma.loadingSlipItem.findFirst({
    where: { lsNumber },
    select: { salesOrderId: true },
  });

  await enqueueWork({
    salesOrderId: lsi?.salesOrderId ?? null,
    step: 'zload2',
    payload: {
      instruction,
      transaction_code: 'ZLOAD2',
      meta: {
        ls_number: lsNumber,
        materials: normalized,
        payload_key: payloadKey,
      },
    },
  });
  await pumpQueue();
  console.log(`[ZLOAD2] Enqueued for LS ${lsNumber} (${normalized.length} material(s))`);
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

  // Round-scoped idempotency guard. After a VA02 modification, `email_2nd_release`
  // bumps `PurchaseOrder.dispatchRound`; the next visibility callback should
  // send a FRESH ls_dispatch tagged with the new round. We only short-circuit
  // when the current round's ls_dispatch is already out.
  //
  // Match BOTH `sent` and `replied` — once branch replies on the ls_dispatch
  // the row flips to `replied`, and a `sent`-only filter would miss it and
  // let a duplicate Dispatch Approval Request go out on the next sweep.
  const poRound = await prisma.purchaseOrder.findUnique({
    where: { id: purchaseOrderId },
    select: { dispatchRound: true },
  });
  const currentRound = poRound?.dispatchRound ?? 1;

  const existing = await prisma.email.findFirst({
    where: {
      purchaseOrderId,
      emailType: 'ls_dispatch',
      status: { in: ['sent', 'replied'] },
      dispatchRound: currentRound,
    },
  });
  if (existing) {
    log(`[CombinedEmail] PO ${purchaseOrderId} round ${currentRound} already has ls_dispatch ${existing.id} — skipping`);
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
    // Used by `proseLineFor` / `substituteSourcePlant` to flag cross-plant
    // substituted materials (their `plant_code` in product-db differs from
    // the SO's own plant) so the body explicitly notes the source plant.
    soPlant: so.plant,
    materials: so.materials.map((m) => ({
      material: m.material,
      materialDescription: m.materialDescription,
      batch: m.batch,
      orderQuantity: m.orderQuantity,
      availableStock: m.availableStock,
      orderWeightKg: m.orderWeightKg ? Number(m.orderWeightKg) : null,
    })),
  }));
  const capacityTonnes = purchaseOrder.weightage
    ? Number(purchaseOrder.weightage)
    : 0;
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

  // If any SO in the PO had a recently-resolved MaterialShortage, this is a
  // reactivation triggered by the daily MB51 FCFS check — flag it in the
  // subject so the branch knows fresh stock is now available.
  const recentResolveCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recentlyResolved = await prisma.materialShortage.findFirst({
    where: {
      salesOrderId: { in: includedSOs.map((so) => so.id) },
      resolvedAt: { gte: recentResolveCutoff },
    },
  });
  const subjectPrefix = recentlyResolved ? 'Stock Available — ' : '';
  const subject = `${subjectPrefix}Dispatch Approval Request - PO ${purchaseOrder.poNumber}`;
  const leadSO = includedSOs[0];
  const failureNote = failedSOs.length > 0
    ? ` (visibility failed for: ${failedSOs.map((so) => so.soNumber).join(', ')})`
    : '';

  log(`[CombinedEmail] Sending combined HTML email for PO ${purchaseOrder.poNumber} (${includedSOs.length} SOs${failureNote})`);

  // Anchor on the per-PO branch thread.
  const { resolvePoThreadAnchor, capturePoThreadAnchor } = await import('./po-thread');
  const anchor = await resolvePoThreadAnchor(purchaseOrderId, 'branch');
  let messageId: string;
  let threadId: string;
  try {
    let sent: { messageId: string; threadId: string };
    if (anchor) {
      try {
        sent = await sendHtmlReplyEmail(BRANCH_EMAIL, subject, combinedBody, anchor.threadId, anchor.rfc822MessageId);
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
  if (!anchor) {
    const rfc822 = await getMessageRfc822Id(messageId);
    if (rfc822) await capturePoThreadAnchor(purchaseOrderId, 'branch', threadId, rfc822);
  }

  // Create the FINAL Email row keyed to lead SO + PO. Stamp with the PO's
  // current dispatchRound so the round-scoped guards above (and the engine
  // step handlers) can distinguish this round's ls_dispatch from prior ones.
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
      dispatchRound: currentRound,
    },
  });

  // Audit-trail event so the LLM planner sees the ls_dispatch milestone
  // when reasoning about the next inbound reply. Emit one per included SO
  // (multi-SO PO emails are joint outbound but per-SO downstream flow).
  try {
    const { emitEvent } = await import('./scenario-events');
    for (const so of includedSOs) {
      await emitEvent({
        salesOrderId: so.id,
        type: 'email_sent',
        payload: {
          emailType: 'ls_dispatch',
          recipient: BRANCH_EMAIL,
          subject,
          body_excerpt: combinedBody.slice(0, 200),
          gmailMessageId: messageId,
          dispatchRound: currentRound,
        },
      });
    }
  } catch {
    // Audit emission must never break the primary flow.
  }

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
 * Trigger VTO1N-B (Create Shipment) for ONE Shipment row.
 *
 * Each (Bundle, SO) pair has its own Shipment with its own OBD; this fires
 * VT01N once per Shipment using the bundle's vehicle details and the SO's
 * LR fields.
 *
 * Idempotent on the Shipment side: flips status `created` → `shipment-triggered`
 * before enqueueing, and rolls back to `created` if the enqueue itself throws.
 *
 * The legacy signature (positional args) is preserved as a thin overload via
 * `triggerVto1nLegacy` — UI/PATCH callers can migrate when convenient.
 */
export async function triggerVto1n(shipmentId: string): Promise<void> {
  const shipment = await prisma.shipment.findUnique({
    where: { id: shipmentId },
    include: {
      bundle: true,
      salesOrder: true,
    },
  });
  if (!shipment) throw new Error(`Shipment ${shipmentId} not found`);
  if (!shipment.obdNumber) throw new Error(`Shipment ${shipmentId} has no obdNumber yet`);

  const so = shipment.salesOrder;
  const bundle = shipment.bundle;
  const lrNumber = shipment.lrNumber ?? so.lrNumber;
  const lrDate = shipment.lrDate ?? so.lrDate;
  const vehicleNumber = bundle.vehicleNumber ?? so.vehicleNumber;

  if (!lrNumber || !lrDate) throw new Error(`Shipment ${shipmentId} cannot fire VT01N: missing LR number / date on SO ${so.soNumber}`);
  if (!vehicleNumber) throw new Error(`Shipment ${shipmentId} cannot fire VT01N: no vehicle number on Bundle or SO`);

  const dd = String(lrDate.getUTCDate()).padStart(2, '0');
  const mm = String(lrDate.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = lrDate.getUTCFullYear();
  const formattedDate = `${dd}.${mm}.${yyyy}`;

  // Double-trigger guard: only flip if currently 'created'.
  const flipped = await prisma.shipment.updateMany({
    where: { id: shipmentId, status: 'created' },
    data: { status: 'shipment-triggered', shipmentTriggeredAt: new Date() },
  });
  if (flipped.count === 0) {
    console.log(`[VTO1N-B] Shipment ${shipmentId} not in 'created' state — skipping`);
    return;
  }

  // Mirror status onto the legacy Invoice row keyed by obdNumber for back-compat.
  await prisma.invoice.updateMany({
    where: { obdNumber: shipment.obdNumber, status: 'created' },
    data: { status: 'shipment-triggered' },
  });

  try {
    await enqueueWork({
      salesOrderId: so.id,
      step: 'vto1n',
      payload: {
        instruction: `VPN is connected and SAP is logged in. Just go ahead and run the SAP Transaction VT01N. OBD number is ${shipment.obdNumber}, LR number is ${lrNumber}, LR date is ${formattedDate} and Vehicle number is ${vehicleNumber}`,
        transaction_code: 'VTO1N-B',
        so_number: so.soNumber,
        extraction_context: 'Extract the OBD number, LR number, LR date and Vehicle number',
        meta: {
          so_number: so.soNumber,
          shipment_id: shipmentId,
          bundle_id: bundle.id,
          bundle_number: bundle.bundleNumber,
          obd_number: shipment.obdNumber,
        },
      },
    });
    await pumpQueue();
    console.log(`[VTO1N-B] Enqueued for Shipment ${shipmentId} (SO ${so.soNumber}, Bundle ${bundle.bundleNumber})`);

    // Advance any active scenario past 'await_vt01n'. Safe no-op when engine
    // is disabled or no scenario is in flight.
    try {
      const { maybeAdvanceScenario } = await import('./scenario-engine');
      await maybeAdvanceScenario(so.id, 'vto1n');
    } catch (advErr) {
      console.error('[VTO1N-B] maybeAdvanceScenario warning:', advErr);
    }
  } catch (error) {
    console.error(`[VTO1N-B] Enqueue failed for Shipment ${shipmentId}:`, error);
    await prisma.shipment.updateMany({
      where: { id: shipmentId, status: 'shipment-triggered' },
      data: { status: 'created', shipmentTriggeredAt: null },
    });
    await prisma.invoice.updateMany({
      where: { obdNumber: shipment.obdNumber, status: 'shipment-triggered' },
      data: { status: 'created' },
    });
    throw error;
  }
}

/**
 * @deprecated Pre-Shipment legacy signature. Resolves to a Shipment by OBD
 * and forwards. New callers should pass `shipmentId` directly.
 */
export async function triggerVto1nLegacy(
  soNumber: string,
  obdNumber: string,
  lrNumber: string,
  lrDate: Date,
  vehicleNumber: string
): Promise<void> {
  void lrNumber;
  void lrDate;
  void vehicleNumber;
  const shipment = await prisma.shipment.findFirst({
    where: { obdNumber, salesOrder: { soNumber } },
    select: { id: true },
  });
  if (shipment) {
    return triggerVto1n(shipment.id);
  }
  // Fall back to the pre-Shipment path for very old data: just enqueue with whatever was passed.
  console.warn(`[VTO1N-B] No Shipment found for OBD ${obdNumber} / SO ${soNumber} — using legacy enqueue`);
  const dd = String(lrDate.getUTCDate()).padStart(2, '0');
  const mm = String(lrDate.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = lrDate.getUTCFullYear();
  const formattedDate = `${dd}.${mm}.${yyyy}`;
  await prisma.invoice.updateMany({
    where: { obdNumber, status: 'created' },
    data: { status: 'shipment-triggered' },
  });
  const so = await prisma.salesOrder.findFirst({ where: { soNumber }, select: { id: true } });
  await enqueueWork({
    salesOrderId: so?.id ?? null,
    step: 'vto1n',
    payload: {
      instruction: `VPN is connected and SAP is logged in. Just go ahead and run the SAP Transaction VT01N. OBD number is ${obdNumber}, LR number is ${lrNumber}, LR date is ${formattedDate} and Vehicle number is ${vehicleNumber}`,
      transaction_code: 'VTO1N-B',
      so_number: soNumber,
      extraction_context: 'Extract the OBD number, LR number, LR date and Vehicle number',
      meta: { so_number: soNumber, obd_number: obdNumber },
    },
  });
  await pumpQueue();
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
  materials: MaterialItemPayload[],
  bundleId?: string,
  bundleNumber?: number,
  /**
   * True when the planner asked for an APPEND-mode ZLOAD1: the resulting LS
   * attaches to an EXISTING bundle and the zload1-data callback must skip
   * the compute-bundles path. Surfaces as `meta.append_to_bundle_id` on the
   * WorkQueue row.
   */
  appendMode?: boolean,
): Promise<void> {
  const materialsList = materials
    .map(
      (m) =>
        `- Material: ${m.material_code}, Batch: ${m.batch || 'N/A'}, Quantity: ${m.quantity || 0}`
    )
    .join('\n');

  const bundleSuffix = bundleNumber ? ` (Bundle ${bundleNumber})` : '';
  const instruction = `VPN is connected, SAP is logged in. Execute ZLOAD1 for sales order ${soNumber}${bundleSuffix}. Materials to dispatch:\n${materialsList}`;

  // Idempotency: ZLOAD1's natural key is (SO, bundleNumber). The bundle
  // cuid changes when computeBundlesForPo re-plans, but bundleNumber is
  // stable within a PO. If a queued/firing/done row already exists for
  // this (SO, bundleNumber), skip — re-firing produces duplicate LSs in
  // SAP and orphaned work_queue rows after a re-plan.
  //
  // When bundleNumber is absent (legacy callers / single-bundle pre-refactor
  // path) we fall back to dedup on (SO + sorted materials). This is the
  // same shape triggerZload2/triggerZloadingClose use.
  const sortedMaterials = [...materials].sort((a, b) =>
    a.material_code === b.material_code
      ? (a.batch || '').localeCompare(b.batch || '')
      : a.material_code.localeCompare(b.material_code)
  );
  const dedupKey = bundleNumber
    ? `so:${soNumber}|bundle:${bundleNumber}`
    : `so:${soNumber}|materials:${JSON.stringify(sortedMaterials.map((m) => `${m.material_code}/${m.batch}/${m.quantity}`))}`;

  const existing = await prisma.workQueue.findFirst({
    where: {
      step: 'zload1',
      state: { in: ['queued', 'firing', 'done'] },
      AND: [
        { payload: { contains: `"transaction_code":"ZLOAD1"` } },
        { payload: { contains: `"dedup_key":${JSON.stringify(dedupKey)}` } },
      ],
    },
    select: { id: true, state: true },
  });
  if (existing) {
    console.log(
      `[ZLOAD1] Skipping duplicate for SO ${soNumber}${bundleSuffix} — existing row ${existing.id} (${existing.state})`
    );
    return;
  }

  const so = await prisma.salesOrder.findFirst({ where: { soNumber }, select: { id: true } });

  await enqueueWork({
    salesOrderId: so?.id ?? null,
    step: 'zload1',
    payload: {
      instruction,
      transaction_code: 'ZLOAD1',
      so_number: soNumber,
      meta: {
        so_number: soNumber,
        ...(bundleId ? { bundle_id: bundleId } : {}),
        ...(bundleNumber ? { bundle_number: bundleNumber } : {}),
        ...(appendMode && bundleId ? { append_to_bundle_id: bundleId } : {}),
        dedup_key: dedupKey,
      },
    },
  });
  await pumpQueue();
  console.log(`[ZLOAD1] Enqueued for SO ${soNumber}${bundleSuffix}${appendMode ? ' (APPEND mode)' : ''} (${materials.length} material(s))`);
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
  salesOrderId: string,
  /**
   * Vehicle details extracted by the LLM planner (passed verbatim on the
   * `email_to_plant` step's `args.vehicles`). The planner reads the email
   * thread, fills these in, and the handler trusts them — no second LLM
   * extractor runs here.
   */
  preExtracted: {
    vehicles: Array<{
      bundleNumber?: number;
      vehicleNumber: string;
      driverMobile: string;
      containerNumber: string;
    }>;
  },
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

  // In planner-driven mode this function runs as the deterministic worker
  // for the `email_to_plant` step. The planner has already extracted the
  // vehicles from the email thread and supplied them on `preExtracted`. Job
  // here is strictly: save vehicle details onto the Bundle, then forward
  // the LS PDFs to the plant. No LLM extractor, no reclassification.
  log(`[VehicleDetails] using ${preExtracted.vehicles.length} pre-extracted vehicle set(s) for SO ${soNumber}`);

  // Bundle lookup table used by the per-vehicle dispatch below to resolve
  // each extracted set onto a Bundle row by its bundleNumber. PO-scoped:
  // a vehicle reply on a multi-PO truck plan still applies per-PO.
  const poBundles = email.purchaseOrderId
    ? await prisma.bundle.findMany({
        where: { purchaseOrderId: email.purchaseOrderId },
        select: { id: true, bundleNumber: true, totalWeightKg: true },
        orderBy: { bundleNumber: 'asc' },
      })
    : [];

  try {
    const extractedSets: Array<{ bundleNumber?: number | null; vehicleNumber: string; driverMobile: string; containerNumber: string }> =
      preExtracted.vehicles.map((v) => ({
        bundleNumber: v.bundleNumber ?? null,
        vehicleNumber: v.vehicleNumber,
        driverMobile: v.driverMobile,
        containerNumber: v.containerNumber,
      }));
    log(`[VehicleDetails] Extracted ${extractedSets.length} vehicle set(s) for PO ${email.purchaseOrderId ?? '(legacy)'}`);

    // Apply each extracted set: resolve which Bundle it belongs to, save
    // when complete, follow up if missing fields.
    type Saved = { bundleId: string; bundleNumber: number };
    const saved: Saved[] = [];
    const incomplete: Array<{ label: string; missing: string[] }> = [];

    for (let i = 0; i < extractedSets.length; i++) {
      const v = extractedSets[i];
      // Resolve target bundle.
      let targetBundleId: string | null = null;
      let targetBundleNumber: number | null = null;
      if (v.bundleNumber != null && email.purchaseOrderId) {
        const match = poBundles.find((b) => b.bundleNumber === v.bundleNumber);
        if (match) {
          targetBundleId = match.id;
          targetBundleNumber = match.bundleNumber;
        }
      }
      // Fallback 1: PO has only one bundle → use it.
      if (!targetBundleId && poBundles.length === 1) {
        targetBundleId = poBundles[0].id;
        targetBundleNumber = poBundles[0].bundleNumber;
      }
      // Fallback 2: this email was scoped to a bundle and there's only one set.
      if (!targetBundleId && email.bundleId && extractedSets.length === 1) {
        targetBundleId = email.bundleId;
        const found = poBundles.find((b) => b.id === email.bundleId);
        targetBundleNumber = found?.bundleNumber ?? null;
      }

      const label = targetBundleNumber ? `Bundle ${targetBundleNumber}` : `set #${i + 1}`;
      const missing: string[] = [];
      if (!v.vehicleNumber) missing.push('Vehicle Number');
      if (!v.driverMobile) missing.push('Driver Mobile Number');
      if (!v.containerNumber) missing.push('Container Number');

      if (missing.length > 0) {
        incomplete.push({ label, missing });
        log(`[VehicleDetails] ${label}: incomplete — missing ${missing.join(', ')}`);
        continue;
      }

      if (targetBundleId) {
        await prisma.bundle.update({
          where: { id: targetBundleId },
          data: {
            vehicleNumber: v.vehicleNumber,
            driverMobile: v.driverMobile,
            containerNumber: v.containerNumber,
          },
        });
        saved.push({ bundleId: targetBundleId, bundleNumber: targetBundleNumber ?? -1 });
        log(`[VehicleDetails] Saved on ${label}: vehicle=${v.vehicleNumber}, driver=${v.driverMobile}, container=${v.containerNumber}`);
      } else if (!email.bundleId) {
        // Legacy per-SO path (no bundle context at all).
        await prisma.salesOrder.update({
          where: { id: salesOrderId },
          data: {
            vehicleNumber: v.vehicleNumber,
            driverMobile: v.driverMobile,
            containerNumber: v.containerNumber,
          },
        });
        log(`[VehicleDetails] Saved vehicle details to SO ${soNumber} (legacy per-SO path)`);
      } else {
        log(`[VehicleDetails] Could not resolve a bundle for ${label}; skipping (operator review)`);
      }
    }

    // If any set was incomplete, send a single follow-up email naming each.
    if (incomplete.length > 0) {
      const lines = incomplete.map((i) => `  - ${i.label}: missing ${i.missing.join(', ')}`);
      const replyBody = [
        `Thank you for your reply.`,
        '',
        `The following vehicle detail(s) are still incomplete:`,
        ...lines,
        '',
        'Please reply with the complete details for each truck:',
        '  1. Vehicle Number (e.g., GJ12AB1234)',
        '  2. Driver Mobile Number (e.g., 9876543210)',
        '  3. Container Number',
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
        await prisma.email.update({
          where: { id: emailId },
          data: {
            gmailMessageId: replyResult.messageId,
            gmailThreadId: replyResult.threadId,
            status: 'sent',
          },
        });
        log(`[VehicleDetails] Sent follow-up for ${incomplete.length} incomplete bundle(s)`);
      } catch (sendErr) {
        log(`[VehicleDetails] Failed to send follow-up: ${sendErr instanceof Error ? sendErr.message : sendErr}`);
      }

      // If NOTHING was saved, leave the email open and return.
      if (saved.length === 0) return { success: true, logs };
    } else {
      // Everything saved cleanly — close the email.
      await prisma.email.update({
        where: { id: emailId },
        data: { status: 'replied', repliedAt: new Date(), workflowState: 'completed' },
      });
    }

    // Send LS PDFs to plant for every bundle that just got complete details.
    // One plant_ls email per LoadingSlip; each LS belongs to exactly one
    // bundle so the bundle's vehicle info is the right one to attach.
    const completedBundleIds = saved.map((s) => s.bundleId);
    const loadingSlipsForPlant = completedBundleIds.length > 0
      ? await prisma.loadingSlip.findMany({
          where: { bundleId: { in: completedBundleIds }, fileUrl: { not: null } },
          include: {
            bundle: {
              select: { id: true, vehicleNumber: true, driverMobile: true, containerNumber: true },
            },
          },
        })
      : email.bundleId
        ? await prisma.loadingSlip.findMany({
            where: { bundleId: email.bundleId, fileUrl: { not: null } },
            include: {
              bundle: {
                select: { id: true, vehicleNumber: true, driverMobile: true, containerNumber: true },
              },
            },
          })
        : (await prisma.loadingSlip.findMany({
            where: { salesOrderId, fileUrl: { not: null } },
          })).map((ls) => ({ ...ls, bundle: null as null | { id: string; vehicleNumber: string | null; driverMobile: string | null; containerNumber: string | null } }));

    if (loadingSlipsForPlant.length === 0) {
      log(`[VehicleDetails] No LS files found, skipping plant email`);
    } else {
      for (const ls of loadingSlipsForPlant) {
        try {
          const pdfBuffer = await downloadFromS3(ls.fileUrl!);
          const filename = ls.fileUrl!.split('/').pop() || `${ls.lsNumber}.pdf`;
          const lsSo = await prisma.salesOrder.findUnique({
            where: { id: ls.salesOrderId },
            select: { soNumber: true },
          });
          const lsSoNumber = lsSo?.soNumber ?? soNumber;
          const lsBundle = (ls as { bundle?: { vehicleNumber: string | null; driverMobile: string | null; containerNumber: string | null } | null }).bundle;
          let vehicleForEmail: { vehicleNumber: string | null; driverMobile: string | null; containerNumber: string | null };
          if (lsBundle) {
            vehicleForEmail = {
              vehicleNumber: lsBundle.vehicleNumber,
              driverMobile: lsBundle.driverMobile,
              containerNumber: lsBundle.containerNumber,
            };
          } else {
            const soRow = await prisma.salesOrder.findUnique({
              where: { id: ls.salesOrderId },
              select: { vehicleNumber: true, driverMobile: true, containerNumber: true },
            });
            vehicleForEmail = {
              vehicleNumber: soRow?.vehicleNumber ?? null,
              driverMobile: soRow?.driverMobile ?? null,
              containerNumber: soRow?.containerNumber ?? null,
            };
          }
          // sendLSEmail historically takes an LSI id as its first arg; pick
          // any LSI on this LS for that legacy linkage (one of them works —
          // they're all under the same LS).
          const anchorLsi = await prisma.loadingSlipItem.findFirst({
            where: { loadingSlipId: ls.id },
            select: { id: true },
          });
          if (!anchorLsi) {
            log(`[VehicleDetails] LS ${ls.lsNumber} has no LSI rows — skipping plant email`);
            continue;
          }
          await sendLSEmail(
            anchorLsi.id,
            ls.salesOrderId,
            lsSoNumber,
            ls.lsNumber,
            pdfBuffer,
            vehicleForEmail,
            filename
          );
          log(`[VehicleDetails] Sent LS ${ls.lsNumber} to plant for SO ${lsSoNumber} (vehicle ${vehicleForEmail.vehicleNumber ?? 'n/a'})`);
        } catch (sendErr) {
          log(`[VehicleDetails] Failed to send LS ${ls.lsNumber} to plant: ${sendErr instanceof Error ? sendErr.message : sendErr}`);
        }
      }
    }

    return { success: true, logs };
  } catch (error) {
    log(`[VehicleDetails] Error: ${error instanceof Error ? error.message : error}`);
    return { success: false, logs };
  }
}
