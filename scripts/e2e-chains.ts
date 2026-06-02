/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Full SAP-aware lifecycle chain driver.
 *
 * Each chain starts from a synthetic "NEW ORDER" email landed in the Gmail
 * stub inbox and walks the *real production cron path* through to VT01N:
 *
 *   inbox push → checkForNewEmails() → ZSO-VISIBILITY → /visibility-data
 *   → ls_dispatch outbound → branch reply (varies per chain) → engine
 *   scenario walk (VA02 / 2nd_release / re-visibility as applicable)
 *   → dispatch_confirmation (driver fills engine no-op gap) → ZLOAD1 fan-out
 *   → /zload1-data → vehicle_details outbound → branch vehicle reply
 *   → plant_ls outbound → plant invoice reply → ZLOAD3-B1
 *   → /processing-data → triggerVto1n → /step-status → SO completed.
 *
 * The chain spec declares the sequence of *driver actions* (inject this
 * reply, wait for this email, trigger VT01N, etc.). The engine, route
 * handlers, work_queue, and dummy auto_gui2 do the rest — the same code
 * the production cron drives.
 *
 * Output: one history file per chain in test_artifacts/lifecycle-reports/
 * showing SAP transactions (WorkQueue rows + dummy callback effects),
 * scenario events, email thread, and final DB state. Plus index.md with
 * aggregate PASS/FAIL.
 *
 * Usage:
 *   DATABASE_URL="file:./test-e2e.db" npx tsx scripts/e2e-chains.ts
 *   FILTER=modify_increase npx tsx scripts/e2e-chains.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  GMAIL_INBOX,
  HTTP_LOG,
  PLENTY_STOCK,
  STOCKED_MATERIALS,
  inboxPushNewOrder,
  loadEngine,
  seedInventory,
  startBridge,
  startDummy,
  stopBridge,
  stopDummy,
  wipeAll,
} from './e2e-shared';
import type { Env } from './e2e-shared';

// -----------------------------------------------------------------------------
// Chain action types
// -----------------------------------------------------------------------------

type ChainAction =
  /**
   * Push a NEW ORDER message into the Gmail stub inbox + invoke the
   * production `checkForNewEmails()` cron entry. This creates the SO/PO
   * rows, fires ZSO-VISIBILITY, and (after the /visibility-data callback)
   * sends the ls_dispatch email — all via the real code path.
   */
  | { kind: 'new_order_inbound'; soNumber: string; customerId: string }
  /**
   * Inject a reply on an existing sent email. Calls `handleReplyV2` via
   * the production reply-checker path. `emailType` selects which sent
   * email to target ("the most recent sent email with this type").
   */
  | { kind: 'inbound_reply'; emailType: string; replyText: string; sender: 'branch' | 'plant' }
  /**
   * Targets a sent `dispatch_confirmation` email and routes through the
   * legacy `handleDispatchConfirmation` with a pre-classified yes intent.
   */
  | { kind: 'dispatch_confirmation_reply'; replyText: string }
  /**
   * Branch sends vehicle/driver/LR/container details on the most recent
   * `vehicle_details` email. Routes through `handleVehicleDetailsReply`
   * with pre-extracted vehicles. Also persists LR fields on SO so
   * triggerVto1n later succeeds.
   */
  | {
      kind: 'vehicle_details_reply';
      vehicleNumber: string;
      driverMobile: string;
      lrNumber: string;
      lrDateIso: string;
      containerNumber?: string;
    }
  /**
   * Plant sends invoice PDF reply. Marks every sent `plant_ls` email
   * (one per LSI) as replied with a synthetic R2 key, then calls
   * `checkAndSendBatchToAman` to fire ZLOAD3-B1. The dummy's
   * /processing-data callback creates the Invoice + Shipment rows.
   */
  | { kind: 'plant_invoice_reply'; invoiceNumber: string; obdNumber: string }
  /** Operator step: triggerVto1n on the Shipment. Fires VTO1N-B. */
  | { kind: 'trigger_vt01n' }
  /** Manually pump the work queue (rarely needed; reply paths pump). */
  | { kind: 'pump_queue' }
  /**
   * Workaround for an engine gap: the engine's `email_confirm_bundle_details`
   * step handler is a no-op stub. With UNIFIED_CLASSIFIER on, nothing
   * else calls sendDispatchConfirmationEmail. The chain driver fills the
   * gap; the report makes the workaround visible.
   */
  | { kind: 'synthesise_dispatch_confirmation' }
  | { kind: 'wait_for_email'; emailType: string; timeoutMs?: number }
  | { kind: 'wait_for_lsi_count'; minCount: number; withFileUrl?: boolean; timeoutMs?: number }
  | { kind: 'wait_for_invoice'; timeoutMs?: number }
  | { kind: 'wait_for_shipment'; timeoutMs?: number }
  | { kind: 'wait_for_so_status'; status: string; timeoutMs?: number };

interface ChainStep {
  description: string;
  action: ChainAction;
}

/**
 * Per-SO visibility fixture — what the dummy auto_gui2 returns on the
 * /visibility-data callback. Written to
 * scripts/dummy-auto-gui2/fixtures/visibility/<soNumber>.json at chain
 * start so the dummy can pick it up.
 */
interface VisibilityFixtureItem {
  material: string;
  material_description: string;
  batch: string;
  order_quantity: number;
  available_stock_for_so: number;
  order_weight_kg: number;
}

interface ChainSpec {
  id: string;
  description: string;
  /** Stable SO number per chain so the visibility fixture stays consistent. */
  soNumber: string;
  /** Customer id extracted from the NEW ORDER email body. */
  customerId: string;
  /** Materials returned by /visibility-data for this SO. */
  visibilityFixture: VisibilityFixtureItem[];
  /** Inventory snapshot rows (drives stock_precheck for modify_increase). */
  inventory: Array<{ material: string; freeStock: number }>;
  steps: ChainStep[];
  finalVerifications: {
    soStatus: string;
    minLsiCount?: number;
    minLsiWithSapMatDoc?: number;
    invoiceNumberPresent?: boolean;
    shipmentPresent?: boolean;
    /** Expect at least this many WorkQueue rows in state=done. */
    minSapTransactions?: number;
  };
}

interface SapTransaction {
  workId: string;
  step: string;
  transactionCode: string;
  state: string;
  startedAtMs: number;
  completedAtMs: number | null;
  /** Brief callback effect summary (e.g. "3 Material rows upserted"). */
  callbackEffect?: string;
}

interface StepResult {
  step: ChainStep;
  ok: boolean;
  newEvents: Array<{ deltaMs: number; type: string; summary: string }>;
  newEmails: Array<{
    deltaMs: number;
    direction: 'OUTBOUND' | 'INBOUND';
    emailType: string;
    recipient: string;
  }>;
  newSapTransactions: SapTransaction[];
  notes: string[];
  startedAt: number;
  finishedAt: number;
}

interface ChainResult {
  spec: ChainSpec;
  soId: string;
  soNumber: string;
  poId: string;
  scenarioKey: string | null;
  startedAt: number;
  finishedAt: number;
  stepResults: StepResult[];
  pass: boolean;
  failReasons: string[];
  finalDbState: {
    soStatus: string | null;
    scenarioProgressState: string | null;
    lsiCount: number;
    lsiWithSapMatDoc: number;
    invoiceNumber: string | null;
    obdNumber: string | null;
    shipmentStatus: string | null;
    scenarioEventCount: number;
    sapTransactionCount: number;
  };
  /** Every WorkQueue row created during the chain, ordered by createdAt. */
  allSapTransactions: SapTransaction[];
}

// -----------------------------------------------------------------------------
// Shared step builders
// -----------------------------------------------------------------------------

/**
 * The "release_all" path from the moment the LS-creation reply lands on
 * ls_dispatch through to VT01N → completed. Used as Phase A in C1, C2,
 * C9, C10, C11 (each chain customises only the initial reply text on
 * ls_dispatch and the post-vehicle_details divergence point).
 */
function releaseAllTail(): ChainStep[] {
  return [
    {
      description: 'Wait for dispatch_confirmation outbound email (sent by engine)',
      action: { kind: 'wait_for_email', emailType: 'dispatch_confirmation', timeoutMs: 15000 },
    },
    {
      description: 'Branch confirms the dispatch plan → fan out ZLOAD1',
      action: {
        kind: 'dispatch_confirmation_reply',
        replyText: 'Yes, please proceed with the dispatch plan as confirmed. Go ahead.',
      },
    },
    {
      description: 'Wait for ZLOAD1 to complete → vehicle_details email lands',
      action: { kind: 'wait_for_email', emailType: 'vehicle_details', timeoutMs: 20000 },
    },
  ];
}

function vehicleToVt01nTail(): ChainStep[] {
  return [
    {
      description: 'Branch replies with vehicle / driver / LR — sends plant_ls per LSI',
      action: {
        kind: 'vehicle_details_reply',
        vehicleNumber: 'GJ12-XY1234',
        driverMobile: '9876543210',
        lrNumber: 'LR-9988',
        lrDateIso: '2026-05-30',
      },
    },
    {
      description: 'Wait for plant_ls outbound email(s)',
      action: { kind: 'wait_for_email', emailType: 'plant_ls', timeoutMs: 15000 },
    },
    {
      description: 'Plant replies with invoice PDF → ZLOAD3-B1 fires',
      action: {
        kind: 'plant_invoice_reply',
        invoiceNumber: '7682614520',
        obdNumber: '85817679',
      },
    },
    {
      description: 'Wait for Shipment row from /processing-data callback',
      action: { kind: 'wait_for_shipment', timeoutMs: 20000 },
    },
    {
      description: 'Operator triggers VT01N for the Shipment',
      action: { kind: 'trigger_vt01n' },
    },
    {
      description: 'Wait for SO status = completed',
      action: { kind: 'wait_for_so_status', status: 'completed', timeoutMs: 20000 },
    },
  ];
}

// -----------------------------------------------------------------------------
// Fixture helpers
// -----------------------------------------------------------------------------

const M_A = {
  material: 'YE1EDWO00001APJP',
  material_description: 'Material A — APJP',
  batch: 'A-26',
};
const M_B = {
  material: 'YV6FRYENE0000PJP',
  material_description: 'Material B — PJP',
  batch: '30-07-2025',
};
const M_C = {
  material: 'YA4COWOCR000043P',
  material_description: 'Material C — 43P',
  batch: '20',
};

/** Default 3-material fixture, all in stock. */
function fixtureAllInStock(): VisibilityFixtureItem[] {
  return [
    { ...M_A, order_quantity: 50, available_stock_for_so: 50, order_weight_kg: 1320 },
    { ...M_B, order_quantity: 100, available_stock_for_so: 100, order_weight_kg: 2720 },
    { ...M_C, order_quantity: 250, available_stock_for_so: 250, order_weight_kg: 6625 },
  ];
}

/** M-C has 0 stock — partial-release path. */
function fixturePartialStock(): VisibilityFixtureItem[] {
  return [
    { ...M_A, order_quantity: 50, available_stock_for_so: 50, order_weight_kg: 1320 },
    { ...M_B, order_quantity: 100, available_stock_for_so: 100, order_weight_kg: 2720 },
    { ...M_C, order_quantity: 250, available_stock_for_so: 0, order_weight_kg: 6625 },
  ];
}

const PLENTY_INVENTORY = [
  { material: M_A.material, freeStock: 500 },
  { material: M_B.material, freeStock: 500 },
  { material: M_C.material, freeStock: 500 },
];

/**
 * Write a per-SO visibility fixture so the dummy server returns these
 * materials when the /chat for ZSO-VISIBILITY fires. Idempotent.
 */
function writeVisibilityFixture(soNumber: string, materials: VisibilityFixtureItem[]) {
  const dir = path.join(process.cwd(), 'scripts/dummy-auto-gui2/fixtures/visibility');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${soNumber}.json`), JSON.stringify({ materials }, null, 2));
}

// -----------------------------------------------------------------------------
// SAP transaction helpers
// -----------------------------------------------------------------------------

async function snapshotWorkQueueIds(prisma: any, soId: string, poId: string): Promise<Set<string>> {
  const rows = await prisma.workQueue.findMany({
    where: { OR: [{ salesOrderId: soId }, { salesOrderId: { in: await soIdsForPo(prisma, poId) } }] },
    select: { id: true },
  });
  return new Set(rows.map((r: any) => r.id));
}

async function soIdsForPo(prisma: any, poId: string): Promise<string[]> {
  if (!poId) return [];
  const sos = await prisma.salesOrder.findMany({
    where: { purchaseOrderId: poId },
    select: { id: true },
  });
  return sos.map((s: any) => s.id);
}

async function loadSapTransactions(
  prisma: any,
  soId: string,
  poId: string,
  chainStartMs: number,
  excludeIds?: Set<string>,
): Promise<SapTransaction[]> {
  const soIds = poId ? await soIdsForPo(prisma, poId) : [soId];
  const where: any = { salesOrderId: { in: Array.from(new Set([soId, ...soIds])) } };
  if (excludeIds && excludeIds.size > 0) where.id = { notIn: Array.from(excludeIds) };
  const rows = await prisma.workQueue.findMany({
    where,
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((r: any) => {
    let txCode = r.step;
    try {
      const p = JSON.parse(r.payload ?? '{}');
      if (p.transaction_code) txCode = p.transaction_code;
    } catch {}
    const startedMs = (r.startedAt ?? r.createdAt).getTime() - chainStartMs;
    // WorkQueue uses `finishedAt`, not `completedAt`.
    const completedMs = r.finishedAt ? r.finishedAt.getTime() - chainStartMs : null;
    return {
      workId: r.id,
      step: r.step,
      transactionCode: txCode,
      state: r.state,
      startedAtMs: startedMs,
      completedAtMs: completedMs,
    };
  });
}

/**
 * For a single WorkQueue row, render the DB-visible effect of the dummy's
 * callback (Material rows for visibility, LSIs for zload1, Invoice+Shipment
 * for zload3b1, Shipment status flip for vto1n).
 */
async function describeCallbackEffect(prisma: any, soId: string, tx: SapTransaction): Promise<string> {
  switch (tx.step) {
    case 'visibility': {
      const mats = await prisma.material.count({ where: { salesOrderId: soId } });
      return `Material rows upserted (count now ${mats})`;
    }
    case 'zload1': {
      const lsis = await prisma.loadingSlipItem.count({
        where: { salesOrderId: soId, fileUrl: { not: null } },
      });
      return `LoadingSlipItem rows with fileUrl (count now ${lsis})`;
    }
    case 'va02':
      return `VA02 completed (real SAP would have updated quantities; dummy returns success only)`;
    case 'zload2':
      return `ZLOAD2 completed (LS adjustments applied in real SAP)`;
    case 'zload3b1': {
      const inv = await prisma.invoice.findFirst({ where: { salesOrderId: soId } });
      const sh = await prisma.shipment.findFirst({ where: { salesOrderId: soId } });
      const parts: string[] = [];
      if (inv) parts.push(`Invoice ${inv.invoiceNumber}/${inv.obdNumber}`);
      if (sh) parts.push(`Shipment status=${sh.status}`);
      return parts.length > 0 ? parts.join(', ') : 'callback applied';
    }
    case 'vto1n': {
      const sh = await prisma.shipment.findFirst({
        where: { salesOrderId: soId },
        orderBy: { createdAt: 'desc' },
      });
      return sh ? `Shipment status=${sh.status}` : 'callback applied';
    }
    default:
      return tx.state === 'done' ? 'callback applied' : '(no callback yet)';
  }
}

// -----------------------------------------------------------------------------
// Engine event / email diff helpers
// -----------------------------------------------------------------------------

async function snapshotEventCount(prisma: any, soId: string): Promise<number> {
  return prisma.scenarioEvent.count({ where: { salesOrderId: soId } });
}

async function snapshotEmailCount(prisma: any, soId: string, poId: string): Promise<number> {
  return prisma.email.count({
    where: {
      OR: [{ salesOrderId: soId }, ...(poId ? [{ purchaseOrderId: poId }] : [])],
    },
  });
}

async function getNewEvents(
  prisma: any,
  soId: string,
  sinceCount: number,
  chainStart: number,
): Promise<Array<{ deltaMs: number; type: string; summary: string }>> {
  const events = await prisma.scenarioEvent.findMany({
    where: { salesOrderId: soId },
    orderBy: { createdAt: 'asc' },
    skip: sinceCount,
  });
  return events.map((e: any) => ({
    deltaMs: e.createdAt.getTime() - chainStart,
    type: e.type,
    summary: summariseEvent(e.type, JSON.parse(e.payload ?? '{}')),
  }));
}

async function getNewEmails(
  prisma: any,
  soId: string,
  poId: string,
  sinceCount: number,
  chainStart: number,
): Promise<
  Array<{ deltaMs: number; direction: 'OUTBOUND' | 'INBOUND'; emailType: string; recipient: string }>
> {
  const rows = await prisma.email.findMany({
    where: {
      OR: [{ salesOrderId: soId }, ...(poId ? [{ purchaseOrderId: poId }] : [])],
    },
    orderBy: { sentAt: 'asc' },
    skip: sinceCount,
  });
  const entries: Array<{
    deltaMs: number;
    direction: 'OUTBOUND' | 'INBOUND';
    emailType: string;
    recipient: string;
  }> = [];
  for (const r of rows) {
    entries.push({
      deltaMs: r.sentAt.getTime() - chainStart,
      direction: 'OUTBOUND',
      emailType: r.emailType ?? 'unknown',
      recipient: r.recipientEmail,
    });
    if (r.replyHtml && r.repliedAt) {
      entries.push({
        deltaMs: r.repliedAt.getTime() - chainStart,
        direction: 'INBOUND',
        emailType: r.emailType ?? 'unknown',
        recipient: r.recipientEmail,
      });
    }
  }
  return entries;
}

function summariseEvent(type: string, p: Record<string, unknown>): string {
  switch (type) {
    case 'email_received':
      return `${p.emailType ?? '?'} from ${p.sender ?? p.from ?? '?'}`;
    case 'classifier_decision': {
      const key = p.scenario_key ?? p.augmentedIntent ?? null;
      if (key) return String(key);
      if (p.action) return `action=${p.action}`;
      return '(no classification)';
    }
    case 'scenario_started':
      return String(p.scenario_key ?? '?');
    case 'step_fired':
    case 'step_completed':
      return String(p.kind ?? p.stepName ?? '?') + (type === 'step_completed' ? ' ✓' : '');
    case 'email_sent':
      return `${p.emailType ?? '?'} to ${p.recipient ?? p.to ?? '?'}`;
    case 'scenario_completed':
      return String(p.scenario_key ?? 'completed');
    case 'scenario_aborted':
      return `aborted: ${p.reason ?? p.error ?? ''}`;
    case 'email_escalated':
      return `escalated: ${p.description ?? ''}`;
    default:
      return JSON.stringify(p).slice(0, 80);
  }
}

function formatDelta(ms: number): string {
  if (ms < 0) ms = 0;
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `[T+${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}]`;
}

async function findEmailByType(prisma: any, soId: string, poId: string, emailType: string) {
  return prisma.email.findFirst({
    where: {
      OR: [
        { salesOrderId: soId, emailType },
        ...(poId ? [{ purchaseOrderId: poId, emailType }] : []),
      ],
      status: 'sent',
    },
    orderBy: { sentAt: 'desc' },
  });
}

// -----------------------------------------------------------------------------
// Step executor
// -----------------------------------------------------------------------------

async function executeAction(
  env: Env,
  state: { soId: string; poId: string; chainStartMs: number; triggerEmailId: string },
  action: ChainAction,
  notes: string[],
): Promise<void> {
  const { prisma } = env;
  const { soId, poId } = state;

  switch (action.kind) {
    case 'new_order_inbound': {
      // 1. Drop a NEW ORDER message into the Gmail stub inbox.
      const msg = inboxPushNewOrder({ soNumber: action.soNumber, customerId: action.customerId });
      notes.push(`Inbox pushed: ${msg.id} subject="${msg.subject}"`);

      // 2. Drive the production cron: classifies, creates SO + PO,
      //    fires ZSO-VISIBILITY via triggerZsoVisibility → enqueueWork → pumpQueue.
      const r = await env.checkForNewEmails();
      notes.push(`checkForNewEmails returned triggered=${r.triggered} errors=${r.errors.length}`);

      // 3. Wait for the SO row to exist (and capture its id into state)
      //    and for the ls_dispatch email to land via /visibility-data callback.
      const waitStart = Date.now();
      let so: any = null;
      while (Date.now() - waitStart < 20000) {
        so = await prisma.salesOrder.findFirst({ where: { soNumber: action.soNumber } });
        if (so) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      if (!so) throw new Error(`SO ${action.soNumber} not created by checkForNewEmails`);
      state.soId = so.id;
      state.poId = so.purchaseOrderId ?? '';
      notes.push(`SO created: id=${so.id} poId=${so.purchaseOrderId}`);

      // 4. Wait for ls_dispatch to land (visibility callback path).
      let ls = null as any;
      while (Date.now() - waitStart < 20000) {
        ls = await findEmailByType(prisma, state.soId, state.poId, 'ls_dispatch');
        if (ls) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      if (!ls) throw new Error('ls_dispatch email not sent within 20s after NEW ORDER');
      state.triggerEmailId = ls.id;
      notes.push(`ls_dispatch landed: emailId=${ls.id}`);
      return;
    }

    case 'inbound_reply': {
      const target = await findEmailByType(prisma, soId, poId, action.emailType);
      const emailId = target?.id ?? state.triggerEmailId;
      notes.push(`Injecting inbound_reply to email ${emailId} (type=${action.emailType})`);
      const r = await env.handleReplyV2({
        emailId,
        replyHtml: action.replyText,
        originalEmailHtml: target?.sentBody ?? '',
        sourceEmailType: action.sender,
      });
      notes.push(`handleReplyV2 returned matched=${r.matched}`);
      return;
    }

    case 'dispatch_confirmation_reply': {
      const target = await findEmailByType(prisma, soId, poId, 'dispatch_confirmation');
      if (!target) throw new Error('dispatch_confirmation email missing');
      await prisma.email.update({
        where: { id: target.id },
        data: { replyHtml: action.replyText, repliedAt: new Date() },
      });
      const r = await env.handleDispatchConfirmation(target.id, action.replyText, { decision: 'yes' });
      notes.push(`handleDispatchConfirmation success=${r.success}`);
      return;
    }

    case 'vehicle_details_reply': {
      const target = await findEmailByType(prisma, soId, poId, 'vehicle_details');
      if (!target) throw new Error('vehicle_details email missing');
      // Persist LR/vehicle on the SO so triggerVto1n later has the data.
      await prisma.salesOrder.update({
        where: { id: soId },
        data: {
          lrNumber: action.lrNumber,
          lrDate: new Date(action.lrDateIso),
          vehicleNumber: action.vehicleNumber,
          driverMobile: action.driverMobile,
        },
      });
      const bundles = await prisma.bundle.findMany({ where: { purchaseOrderId: poId } });
      for (const b of bundles) {
        await prisma.bundle.update({
          where: { id: b.id },
          data: { vehicleNumber: action.vehicleNumber, driverMobile: action.driverMobile },
        });
      }
      const container = action.containerNumber ?? 'CONT-TEST-001';
      const replyText = `Vehicle ${action.vehicleNumber}, driver mobile ${action.driverMobile}, container ${container}, LR ${action.lrNumber} dated ${action.lrDateIso}.`;
      await prisma.email.update({
        where: { id: target.id },
        data: { replyHtml: replyText, repliedAt: new Date() },
      });
      const r = await env.handleVehicleDetailsReply(target.id, replyText, soId, {
        vehicles: [
          {
            bundleNumber: bundles[0]?.bundleNumber,
            vehicleNumber: action.vehicleNumber,
            driverMobile: action.driverMobile,
            containerNumber: container,
          },
        ],
      });
      notes.push(`handleVehicleDetailsReply success=${r.success}`);
      return;
    }

    case 'plant_invoice_reply': {
      const plantEmails = await prisma.email.findMany({
        where: {
          OR: [
            { salesOrderId: soId, emailType: 'plant_ls', status: 'sent' },
            ...(poId ? [{ purchaseOrderId: poId, emailType: 'plant_ls', status: 'sent' }] : []),
          ],
        },
        include: {
          loadingSlip: { select: { bundleId: true } },
          loadingSlipItem: {
            include: { loadingSlip: { select: { bundleId: true } } },
          },
        },
      });
      if (plantEmails.length === 0) throw new Error('plant_ls email missing');
      let bundleId: string | null = null;
      for (const e of plantEmails) {
        const candidate =
          e.loadingSlip?.bundleId ??
          e.loadingSlipItem?.loadingSlip?.bundleId ??
          null;
        if (candidate) {
          bundleId = candidate;
          break;
        }
      }
      if (!bundleId) {
        const ls = await prisma.loadingSlip.findFirst({
          where: { salesOrderId: soId },
          select: { bundleId: true },
        });
        bundleId = ls?.bundleId ?? null;
      }
      const replyText = `Plant invoice attached. Invoice ${action.invoiceNumber}, OBD ${action.obdNumber}.`;
      for (const e of plantEmails) {
        await prisma.email.update({
          where: { id: e.id },
          data: {
            status: 'replied',
            repliedAt: new Date(),
            replyHtml: replyText,
            replyPdfUrl: `mock-r2/reply-pdfs/${soId}/${e.loadingSlipItem?.lsNumber ?? 'unknown'}.pdf`,
          },
        });
      }
      notes.push(`Marked ${plantEmails.length} plant_ls email(s) replied; firing checkAndSendBatchToAman`);
      const r = await env.checkAndSendBatchToAman(soId, bundleId);
      notes.push(`checkAndSendBatchToAman success=${r.success}`);
      return;
    }

    case 'trigger_vt01n': {
      const shipment = await prisma.shipment.findFirst({ where: { salesOrderId: soId } });
      if (!shipment) throw new Error('Shipment row missing');
      notes.push(`Firing triggerVto1n on Shipment ${shipment.id}`);
      await env.triggerVto1n(shipment.id);
      await env.pumpQueue();
      return;
    }

    case 'pump_queue':
      await env.pumpQueue();
      notes.push('pumpQueue() called');
      return;

    case 'synthesise_dispatch_confirmation': {
      notes.push('SYNTHESISED — engine email_confirm_bundle_details handler is a no-op stub');
      const so = await prisma.salesOrder.findUnique({
        where: { id: soId },
        select: { soNumber: true, purchaseOrderId: true },
      });
      if (!so) throw new Error('SO not found');
      // Pull all materials with available stock > 0. In production
      // `persistDispatchPlan` (legacy `handleBranchReply` path) would have
      // set Material.dispatchQuantity from the classifier output; with
      // UNIFIED on that doesn't happen, so we approximate the plan as
      // "release what's available" via the visibility data the dashboard
      // already has on Material rows.
      const allMaterials = await prisma.material.findMany({
        where: { salesOrderId: soId },
      });
      const materials = allMaterials.filter((m: any) => {
        const qty = m.dispatchQuantity && m.dispatchQuantity > 0 ? m.dispatchQuantity : Math.min(m.orderQuantity ?? 0, m.availableStock ?? 0);
        return qty > 0;
      });
      if (materials.length === 0) {
        notes.push('no materials with available stock — skipping');
        return;
      }
      // Persist dispatchQuantity onto Material rows so downstream
      // bundling (`computeBundlesForPo`) picks them up correctly.
      for (const m of materials) {
        const qty = m.dispatchQuantity && m.dispatchQuantity > 0
          ? m.dispatchQuantity
          : Math.min(m.orderQuantity ?? 0, m.availableStock ?? 0);
        if (m.dispatchQuantity !== qty) {
          await prisma.material.update({
            where: { id: m.id },
            data: { dispatchQuantity: qty },
          });
        }
      }
      const items = materials.map((m: any) => {
        const qty = m.dispatchQuantity && m.dispatchQuantity > 0
          ? m.dispatchQuantity
          : Math.min(m.orderQuantity ?? 0, m.availableStock ?? 0);
        return {
          material_code: m.material,
          material_name: m.materialDescription ?? m.material,
          batch: m.batch ?? '',
          quantity: qty,
          weight_kg: m.orderWeightKg ? Number(m.orderWeightKg) : 0,
        };
      });
      const totalKg = items.reduce((s: number, it: any) => s + it.weight_kg, 0);
      const plan = {
        soNumber: so.soNumber,
        salesOrderId: soId,
        items,
        totalWeightKg: totalKg,
      };
      const trigger = await prisma.email.findUnique({
        where: { id: state.triggerEmailId },
        select: { gmailThreadId: true, gmailMessageId: true },
      });
      await env.sendDispatchConfirmationEmail({
        purchaseOrderId: poId,
        plans: [plan],
        twoVehicles: false,
        totalTonnes: totalKg / 1000,
        capacityTonnes: 45,
        threadAnchor: {
          gmailThreadId: trigger?.gmailThreadId ?? '',
          gmailMessageId: trigger?.gmailMessageId ?? '',
        },
        log: (m: string) => notes.push(m),
      });
      notes.push(`dispatch_confirmation sent (${items.length} item(s), ${(totalKg / 1000).toFixed(2)}t)`);
      return;
    }

    case 'wait_for_email': {
      const timeoutMs = action.timeoutMs ?? 15000;
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const email = await findEmailByType(prisma, soId, poId, action.emailType);
        if (email) {
          notes.push(`${action.emailType} email found after ${Date.now() - start}ms`);
          return;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error(`Timeout waiting for ${action.emailType} email`);
    }

    case 'wait_for_lsi_count': {
      const timeoutMs = action.timeoutMs ?? 15000;
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const where: any = { salesOrderId: soId };
        if (action.withFileUrl) where.fileUrl = { not: null };
        const count = await prisma.loadingSlipItem.count({ where });
        if (count >= action.minCount) return;
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error(`Timeout waiting for LSI count ≥ ${action.minCount}`);
    }

    case 'wait_for_invoice': {
      const timeoutMs = action.timeoutMs ?? 15000;
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const inv = await prisma.invoice.findFirst({
          where: { salesOrderId: soId, invoiceNumber: { not: 'PENDING' } },
        });
        if (inv) return;
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error('Timeout waiting for Invoice row');
    }

    case 'wait_for_shipment': {
      const timeoutMs = action.timeoutMs ?? 15000;
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const sh = await prisma.shipment.findFirst({ where: { salesOrderId: soId } });
        if (sh) {
          notes.push(`Shipment found id=${sh.id} status=${sh.status} obd=${sh.obdNumber}`);
          return;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error('Timeout waiting for Shipment row');
    }

    case 'wait_for_so_status': {
      const timeoutMs = action.timeoutMs ?? 15000;
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const so = await prisma.salesOrder.findUnique({
          where: { id: soId },
          select: { status: true },
        });
        if (so?.status === action.status) {
          notes.push(`SO.status=${action.status}`);
          return;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error(`Timeout waiting for SO.status=${action.status}`);
    }
  }
}

// -----------------------------------------------------------------------------
// Chain runner
// -----------------------------------------------------------------------------

async function runChain(env: Env, spec: ChainSpec): Promise<ChainResult> {
  const { prisma } = env;
  const chainStart = Date.now();
  console.log(`\n══════════════════════════════════════════════════════════════════════`);
  console.log(`▶ Chain ${spec.id} — ${spec.description}`);
  console.log(`══════════════════════════════════════════════════════════════════════`);

  await wipeAll(prisma);

  // Pre-create Customer so checkForNewEmails sees a real row.
  await prisma.customer.upsert({
    where: { id: spec.customerId },
    create: { id: spec.customerId, name: `Chain ${spec.id}` },
    update: {},
  });

  // Write per-SO visibility fixture for the dummy.
  writeVisibilityFixture(spec.soNumber, spec.visibilityFixture);

  // Pre-populate InventorySnapshot so stock_precheck has data to compare.
  await seedInventory(prisma, process.env.SAP_DEFAULT_PLANT!, spec.inventory);

  const state = {
    soId: '',
    poId: '',
    chainStartMs: chainStart,
    triggerEmailId: '',
  };

  const stepResults: StepResult[] = [];
  const failReasons: string[] = [];

  let i = 0;
  for (const step of spec.steps) {
    i += 1;
    const stepStart = Date.now();
    const eventsBefore = state.soId ? await snapshotEventCount(prisma, state.soId) : 0;
    const emailsBefore = state.soId ? await snapshotEmailCount(prisma, state.soId, state.poId) : 0;
    const wqIdsBefore = state.soId ? await snapshotWorkQueueIds(prisma, state.soId, state.poId) : new Set<string>();

    console.log(`\n──── Step ${i}/${spec.steps.length}: ${step.description}`);
    const notes: string[] = [];
    let ok = false;
    try {
      await executeAction(env, state, step.action, notes);
      ok = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notes.push(`ERROR: ${msg}`);
      failReasons.push(`Step ${i} (${step.description}): ${msg}`);
      console.log(`   ✗ ${msg}`);
    }

    // Allow async effects (callbacks, event emits) to settle.
    await new Promise((r) => setTimeout(r, 250));

    const newEvents = state.soId ? await getNewEvents(prisma, state.soId, eventsBefore, chainStart) : [];
    const newEmails = state.soId
      ? await getNewEmails(prisma, state.soId, state.poId, emailsBefore, chainStart)
      : [];
    const allNewSap = state.soId
      ? await loadSapTransactions(prisma, state.soId, state.poId, chainStart, wqIdsBefore)
      : [];

    // For each new SAP transaction, attach a brief callback effect.
    for (const tx of allNewSap) {
      try {
        tx.callbackEffect = await describeCallbackEffect(prisma, state.soId, tx);
      } catch {}
    }

    const finishedAt = Date.now();
    console.log(
      `   ${ok ? '✓' : '✗'} step done (${finishedAt - stepStart}ms, +${newEvents.length} events, +${newEmails.length} emails, +${allNewSap.length} SAP txns)`,
    );
    for (const n of notes) console.log(`     · ${n}`);

    stepResults.push({
      step,
      ok,
      newEvents,
      newEmails,
      newSapTransactions: allNewSap,
      notes,
      startedAt: stepStart,
      finishedAt,
    });

    if (!ok) break;
  }

  // Final DB state + verifications.
  const soId = state.soId;
  const poId = state.poId;

  const finalSO = soId
    ? await prisma.salesOrder.findUnique({ where: { id: soId }, select: { status: true } })
    : null;
  const finalProgress = soId
    ? await prisma.scenarioProgress.findFirst({
        where: { salesOrderId: soId },
        orderBy: { createdAt: 'desc' },
      })
    : null;
  const lsiList = soId
    ? await prisma.loadingSlipItem.findMany({
        where: { salesOrderId: soId },
        select: { id: true, sapMaterialDoc: true },
      })
    : [];
  const lsiWithMatDoc = lsiList.filter((l: any) => l.sapMaterialDoc).length;
  const invoice = soId
    ? await prisma.invoice.findFirst({ where: { salesOrderId: soId }, orderBy: { createdAt: 'desc' } })
    : null;
  const shipment = soId
    ? await prisma.shipment.findFirst({ where: { salesOrderId: soId }, orderBy: { createdAt: 'desc' } })
    : null;
  const scenarioEventCount = soId ? await prisma.scenarioEvent.count({ where: { salesOrderId: soId } }) : 0;
  const allSapTransactions = soId ? await loadSapTransactions(prisma, soId, poId, chainStart) : [];
  for (const tx of allSapTransactions) {
    try {
      tx.callbackEffect = await describeCallbackEffect(prisma, soId, tx);
    } catch {}
  }

  const v = spec.finalVerifications;
  if (finalSO?.status !== v.soStatus) {
    failReasons.push(`SO.status=${finalSO?.status} (expected ${v.soStatus})`);
  }
  if (v.minLsiCount !== undefined && lsiList.length < v.minLsiCount) {
    failReasons.push(`LSI count ${lsiList.length} < ${v.minLsiCount}`);
  }
  if (v.minLsiWithSapMatDoc !== undefined && lsiWithMatDoc < v.minLsiWithSapMatDoc) {
    failReasons.push(`LSI with sapMaterialDoc ${lsiWithMatDoc} < ${v.minLsiWithSapMatDoc}`);
  }
  if (v.invoiceNumberPresent && !(invoice?.invoiceNumber && invoice.invoiceNumber !== 'PENDING')) {
    failReasons.push('Invoice number missing or PENDING');
  }
  if (v.shipmentPresent && !shipment) {
    failReasons.push('Shipment row missing');
  }
  if (v.minSapTransactions !== undefined && allSapTransactions.length < v.minSapTransactions) {
    failReasons.push(`SAP transactions ${allSapTransactions.length} < ${v.minSapTransactions}`);
  }

  const pass = failReasons.length === 0;
  const finishedAt = Date.now();

  console.log(`\n${pass ? '✅' : '❌'} Chain ${spec.id} — ${pass ? 'PASS' : 'FAIL'} (${finishedAt - chainStart}ms)`);
  if (!pass) {
    for (const r of failReasons) console.log(`   ✗ ${r}`);
  }

  return {
    spec,
    soId,
    poId,
    soNumber: spec.soNumber,
    scenarioKey: finalProgress?.scenarioKey ?? null,
    startedAt: chainStart,
    finishedAt,
    stepResults,
    pass,
    failReasons,
    finalDbState: {
      soStatus: finalSO?.status ?? null,
      scenarioProgressState: finalProgress?.state ?? null,
      lsiCount: lsiList.length,
      lsiWithSapMatDoc: lsiWithMatDoc,
      invoiceNumber: invoice?.invoiceNumber ?? null,
      obdNumber: invoice?.obdNumber ?? null,
      shipmentStatus: shipment?.status ?? null,
      scenarioEventCount,
      sapTransactionCount: allSapTransactions.length,
    },
    allSapTransactions,
  };
}

// -----------------------------------------------------------------------------
// History file writer
// -----------------------------------------------------------------------------

async function writeHistoryFile(env: Env, result: ChainResult, outDir: string) {
  const lines: string[] = [];
  const { spec } = result;
  lines.push(`# Chain: ${spec.id}`);
  lines.push('');
  lines.push(`**Description**: ${spec.description}`);
  lines.push(`**SO Number**: ${result.soNumber}`);
  lines.push(`**Customer**: ${spec.customerId}`);
  lines.push(`**Scenario Key**: ${result.scenarioKey ?? '(none — legacy handlers only)'}`);
  lines.push(`**Started**: ${new Date(result.startedAt).toISOString()}`);
  lines.push(`**Finished**: ${new Date(result.finishedAt).toISOString()} (duration: ${result.finishedAt - result.startedAt}ms)`);
  lines.push(`**Result**: ${result.pass ? '✅ PASS' : '❌ FAIL'}`);
  if (!result.pass) {
    lines.push('');
    lines.push('## Fail reasons');
    for (const r of result.failReasons) lines.push(`- ${r}`);
  }
  lines.push('');

  // ── SAP transaction summary table ─────────────────────────────────────
  lines.push('## SAP transaction summary');
  lines.push('');
  if (result.allSapTransactions.length === 0) {
    lines.push('_No SAP transactions fired._');
  } else {
    lines.push('| # | Transaction | Step | Work ID (suffix) | Started | Completed | State | Callback effect |');
    lines.push('|---|---|---|---|---|---|---|---|');
    result.allSapTransactions.forEach((tx, idx) => {
      lines.push(
        `| ${idx + 1} | \`${tx.transactionCode}\` | \`${tx.step}\` | …${tx.workId.slice(-6)} | ${formatDelta(tx.startedAtMs)} | ${tx.completedAtMs != null ? formatDelta(tx.completedAtMs) : '—'} | ${tx.state} | ${tx.callbackEffect ?? ''} |`,
      );
    });
  }
  lines.push('');

  // ── Step-by-step execution ────────────────────────────────────────────
  lines.push('## Step-by-step execution');
  lines.push('');
  let idx = 0;
  for (const sr of result.stepResults) {
    idx += 1;
    lines.push(`### Step ${idx} — ${sr.step.description}`);
    lines.push('');
    lines.push(`**Action**: \`${sr.step.action.kind}\``);
    if (sr.step.action.kind === 'new_order_inbound') {
      lines.push(`**SO Number**: ${sr.step.action.soNumber}, **Customer ID**: ${sr.step.action.customerId}`);
    }
    if (sr.step.action.kind === 'synthesise_dispatch_confirmation') {
      lines.push(`**Note**: synthesised by driver — fills a known engine gap`);
      lines.push(`(engine \`email_confirm_bundle_details\` step is a no-op stub)`);
    }
    if ('replyText' in sr.step.action) {
      lines.push(`**Reply text**: "${sr.step.action.replyText}"`);
    }
    if ('emailType' in sr.step.action) {
      lines.push(`**Email type**: \`${sr.step.action.emailType}\``);
    }
    lines.push(`**Duration**: ${sr.finishedAt - sr.startedAt}ms`);
    lines.push(`**Outcome**: ${sr.ok ? '✓ pass' : '✗ fail'}`);

    if (sr.newSapTransactions.length > 0) {
      lines.push('');
      lines.push('**SAP transactions this step**:');
      lines.push('```');
      for (const tx of sr.newSapTransactions) {
        const completed = tx.completedAtMs != null ? `→ ✓ done at ${formatDelta(tx.completedAtMs)}` : '→ (firing)';
        lines.push(`  ${formatDelta(tx.startedAtMs)} ${tx.transactionCode.padEnd(16)} work=…${tx.workId.slice(-6)} state=${tx.state.padEnd(7)} ${completed}`);
        if (tx.callbackEffect) {
          lines.push(`              callback: ${tx.callbackEffect}`);
        }
      }
      lines.push('```');
    }

    if (sr.newEvents.length > 0) {
      lines.push('');
      lines.push('**New scenario events**:');
      lines.push('```');
      for (const e of sr.newEvents) {
        lines.push(`  ${formatDelta(e.deltaMs)} ${e.type.padEnd(22)} ${e.summary}`);
      }
      lines.push('```');
    }
    if (sr.newEmails.length > 0) {
      lines.push('');
      lines.push('**New emails this step**:');
      lines.push('```');
      for (const em of sr.newEmails) {
        const arrow = em.direction === 'OUTBOUND' ? '→' : '←';
        lines.push(`  ${formatDelta(em.deltaMs)} ${arrow} ${em.direction.padEnd(8)} ${em.emailType.padEnd(22)} ${em.recipient}`);
      }
      lines.push('```');
    }
    if (sr.notes.length > 0) {
      lines.push('');
      lines.push('**Driver notes**:');
      for (const n of sr.notes) lines.push(`- ${n}`);
    }
    lines.push('');
  }

  // ── Final DB state ────────────────────────────────────────────────────
  lines.push('## Final DB state');
  lines.push('');
  const db = result.finalDbState;
  lines.push('| Field | Value |');
  lines.push('|---|---|');
  lines.push(`| SO.status | \`${db.soStatus}\` |`);
  lines.push(`| ScenarioProgress.state | \`${db.scenarioProgressState ?? '(none)'}\` |`);
  lines.push(`| LoadingSlipItem count | ${db.lsiCount} |`);
  lines.push(`| LSI with sapMaterialDoc | ${db.lsiWithSapMatDoc} |`);
  lines.push(`| Invoice.invoiceNumber | \`${db.invoiceNumber ?? '(none)'}\` |`);
  lines.push(`| Invoice.obdNumber | \`${db.obdNumber ?? '(none)'}\` |`);
  lines.push(`| Shipment.status | \`${db.shipmentStatus ?? '(none)'}\` |`);
  lines.push(`| ScenarioEvent count | ${db.scenarioEventCount} |`);
  lines.push(`| SAP transactions fired | ${db.sapTransactionCount} |`);
  lines.push('');

  // ── Full audit trail ──────────────────────────────────────────────────
  if (result.soId) {
    lines.push('## Complete audit trail (chronological)');
    lines.push('');
    lines.push('```');
    const audit = await env.renderAuditTrailForSO({ salesOrderId: result.soId, maxEvents: 200 });
    lines.push(audit);
    lines.push('```');
    lines.push('');

    lines.push('## Complete email thread (chronological)');
    lines.push('');
    lines.push('```');
    const thread = await env.renderEmailThreadForSO({ salesOrderId: result.soId, maxMessages: 50 });
    lines.push(thread);
    lines.push('```');
    lines.push('');
  }

  // ── Verifications ─────────────────────────────────────────────────────
  lines.push('## Verifications');
  lines.push('');
  const v = spec.finalVerifications;
  const tick = (ok: boolean) => (ok ? '✓' : '✗');
  lines.push(`- ${tick(db.soStatus === v.soStatus)} SO.status === \`${v.soStatus}\` (actual: \`${db.soStatus}\`)`);
  if (v.minLsiCount !== undefined) {
    lines.push(`- ${tick(db.lsiCount >= v.minLsiCount)} LSI count ≥ ${v.minLsiCount} (actual: ${db.lsiCount})`);
  }
  if (v.minLsiWithSapMatDoc !== undefined) {
    lines.push(
      `- ${tick(db.lsiWithSapMatDoc >= v.minLsiWithSapMatDoc)} LSI with sapMaterialDoc ≥ ${v.minLsiWithSapMatDoc} (actual: ${db.lsiWithSapMatDoc})`,
    );
  }
  if (v.invoiceNumberPresent) {
    const ok = !!(db.invoiceNumber && db.invoiceNumber !== 'PENDING');
    lines.push(`- ${tick(ok)} Invoice number present (actual: \`${db.invoiceNumber}\`)`);
  }
  if (v.shipmentPresent) {
    lines.push(`- ${tick(!!db.shipmentStatus)} Shipment row exists (actual status: \`${db.shipmentStatus}\`)`);
  }
  if (v.minSapTransactions !== undefined) {
    lines.push(
      `- ${tick(db.sapTransactionCount >= v.minSapTransactions)} SAP transactions ≥ ${v.minSapTransactions} (actual: ${db.sapTransactionCount})`,
    );
  }
  lines.push('');

  fs.writeFileSync(path.join(outDir, `${spec.id}.history.md`), lines.join('\n'));
}

async function writeIndexFile(results: ChainResult[], outDir: string) {
  const lines: string[] = [];
  lines.push('# Lifecycle chain reports — index');
  lines.push('');
  lines.push(`**Generated**: ${new Date().toISOString()}`);
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  lines.push(`**Aggregate**: ${passed} PASS / ${failed} FAIL / ${results.length} total`);
  lines.push('');
  lines.push('| Chain | Result | SO | Duration | Steps | Events | SAP txns | Final SO |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    const passedSteps = r.stepResults.filter((s) => s.ok).length;
    lines.push(
      `| [${r.spec.id}](${r.spec.id}.history.md) | ${r.pass ? '✅ PASS' : '❌ FAIL'} | ${r.soNumber} | ${
        r.finishedAt - r.startedAt
      }ms | ${passedSteps}/${r.stepResults.length} | ${r.finalDbState.scenarioEventCount} | ${r.finalDbState.sapTransactionCount} | \`${r.finalDbState.soStatus}\` |`,
    );
  }
  lines.push('');
  if (failed > 0) {
    lines.push('## Fail details');
    lines.push('');
    for (const r of results.filter((x) => !x.pass)) {
      lines.push(`### ${r.spec.id}`);
      for (const f of r.failReasons) lines.push(`- ${f}`);
      lines.push('');
    }
  }
  fs.writeFileSync(path.join(outDir, 'index.md'), lines.join('\n'));
}

// -----------------------------------------------------------------------------
// Chain specs (C1–C11) — all start with new_order_inbound + ls_dispatch wait
// -----------------------------------------------------------------------------

/** Chains that walk the full happy path then end at VT01N. */
function buildChainSpecs(): ChainSpec[] {
  // ─── C1 release_all ──────────────────────────────────────────────────
  const c1: ChainSpec = {
    id: 'release_all',
    description: 'Happy path — NEW ORDER → ls_dispatch → release_all → VT01N',
    soNumber: '3290001',
    customerId: 'TEST-CUST-RELALL',
    visibilityFixture: fixtureAllInStock(),
    inventory: PLENTY_INVENTORY,
    steps: [
      {
        description: 'NEW ORDER inbound from branch → ZSO-VISIBILITY → ls_dispatch lands',
        action: { kind: 'new_order_inbound', soNumber: '3290001', customerId: 'TEST-CUST-RELALL' },
      },
      {
        description: 'Branch replies "release everything" to ls_dispatch',
        action: {
          kind: 'inbound_reply',
          emailType: 'ls_dispatch',
          sender: 'branch',
          replyText: 'Please release everything as available. All quantities approved, go ahead and dispatch.',
        },
      },
      ...releaseAllTail(),
      ...vehicleToVt01nTail(),
    ],
    finalVerifications: {
      soStatus: 'completed',
      minLsiCount: 3,
      minLsiWithSapMatDoc: 3,
      invoiceNumberPresent: true,
      shipmentPresent: true,
      minSapTransactions: 4, // ZSO-VISIBILITY + ZLOAD1 + ZLOAD3-B1 + VTO1N-B
    },
  };

  // ─── C2 release_part ─────────────────────────────────────────────────
  const c2: ChainSpec = {
    id: 'release_part',
    description: 'Partial release — NEW ORDER → ls_dispatch → release_part (skip M-C 0 stock) → VT01N',
    soNumber: '3290002',
    customerId: 'TEST-CUST-RELPART',
    visibilityFixture: fixturePartialStock(),
    inventory: [
      { material: M_A.material, freeStock: 500 },
      { material: M_B.material, freeStock: 500 },
      { material: M_C.material, freeStock: 0 },
    ],
    steps: [
      {
        description: 'NEW ORDER inbound from branch (M-C has 0 stock)',
        action: { kind: 'new_order_inbound', soNumber: '3290002', customerId: 'TEST-CUST-RELPART' },
      },
      {
        description: 'Branch replies "release available, skip zero-stock"',
        action: {
          kind: 'inbound_reply',
          emailType: 'ls_dispatch',
          sender: 'branch',
          replyText: 'Release the materials you have available, skip the ones with zero stock.',
        },
      },
      ...releaseAllTail(),
      ...vehicleToVt01nTail(),
    ],
    finalVerifications: {
      soStatus: 'completed',
      minLsiCount: 2,
      invoiceNumberPresent: true,
      shipmentPresent: true,
      minSapTransactions: 4,
    },
  };

  // ─── modify_* family (C3–C8) ─────────────────────────────────────────
  // Pre-LS modify path: stock_precheck → VA02 → 2nd_release → branch
  // confirms → re-visibility → ls_dispatch (again) → branch confirms →
  // dispatch_confirmation → ZLOAD1 → tail. The driver injects the
  // initial modify reply on ls_dispatch, then the 2nd_release confirm,
  // then a release_all on the re-sent ls_dispatch, then the rest of the
  // standard release_all tail.
  // Two flavours of pre-LS modify:
  //
  //   1. WithVA02 (increase / inc_dec / inc_del) — sheet path is
  //      stock_precheck → VA02 → email_2nd_release → branch confirms →
  //      zso_visibility (re-run) → email_confirm_product_details →
  //      email_confirm_bundle_details → ZLOAD1 → tail.
  //      Driver inserts the modify reply, waits for 2nd_release, confirms
  //      it, waits for the re-sent ls_dispatch, then proceeds as release_all.
  //
  //   2. NoVA02 (decrease / delete / dec_del) — sheet path skips VA02 and
  //      2nd_release entirely; the engine goes straight to
  //      email_confirm_bundle_details. Driver inserts the modify reply
  //      then proceeds as release_all (synthesise dispatch_confirmation +
  //      confirm + zload1 + tail).
  function makeModifyChainWithVA02(
    id: string,
    soNumber: string,
    custIdSuffix: string,
    modifyReplyText: string,
    expectedLsi: number,
  ): ChainSpec {
    return {
      id,
      description: `Pre-LS modify (with VA02) — NEW ORDER → ls_dispatch → ${id} reply → stock_precheck → VA02 → 2nd_release → re-visibility → release_all path → VT01N`,
      soNumber,
      customerId: `TEST-CUST-${custIdSuffix}`,
      visibilityFixture: fixtureAllInStock(),
      inventory: PLENTY_INVENTORY,
      steps: [
        {
          description: 'NEW ORDER inbound from branch',
          action: { kind: 'new_order_inbound', soNumber, customerId: `TEST-CUST-${custIdSuffix}` },
        },
        {
          description: `Branch reply on ls_dispatch — ${id}`,
          action: { kind: 'inbound_reply', emailType: 'ls_dispatch', sender: 'branch', replyText: modifyReplyText },
        },
        {
          description: 'Wait for 2nd_release email (engine asks branch to confirm revised plan after VA02)',
          action: { kind: 'wait_for_email', emailType: '2nd_release', timeoutMs: 30000 },
        },
        {
          description: 'Branch confirms the revised release plan',
          action: {
            kind: 'inbound_reply',
            emailType: '2nd_release',
            sender: 'branch',
            replyText: 'Yes, the revised release plan is acceptable. Please proceed with the updated quantities.',
          },
        },
        {
          description: 'Wait for re-sent ls_dispatch after re-visibility (engine fires zso_visibility again)',
          action: { kind: 'wait_for_email', emailType: 'ls_dispatch', timeoutMs: 30000 },
        },
        {
          description: 'Branch confirms revised plan on re-sent ls_dispatch (release_all)',
          action: {
            kind: 'inbound_reply',
            emailType: 'ls_dispatch',
            sender: 'branch',
            replyText: 'Please release everything as available. All quantities approved, go ahead and dispatch.',
          },
        },
        ...releaseAllTail(),
        ...vehicleToVt01nTail(),
      ],
      finalVerifications: {
        soStatus: 'completed',
        minLsiCount: expectedLsi,
        invoiceNumberPresent: true,
        shipmentPresent: true,
        minSapTransactions: 5, // ZSO-VIS ×2 + VA02 + ZLOAD1 + ZLOAD3-B1 + VTO1N-B
      },
    };
  }

  function makeModifyChainNoVA02(
    id: string,
    soNumber: string,
    custIdSuffix: string,
    modifyReplyText: string,
    expectedLsi: number,
  ): ChainSpec {
    return {
      id,
      description: `Pre-LS modify (no VA02) — NEW ORDER → ls_dispatch → ${id} reply → dispatch_confirmation → ZLOAD1 → tail`,
      soNumber,
      customerId: `TEST-CUST-${custIdSuffix}`,
      visibilityFixture: fixtureAllInStock(),
      inventory: PLENTY_INVENTORY,
      steps: [
        {
          description: 'NEW ORDER inbound from branch',
          action: { kind: 'new_order_inbound', soNumber, customerId: `TEST-CUST-${custIdSuffix}` },
        },
        {
          description: `Branch reply on ls_dispatch — ${id}`,
          action: { kind: 'inbound_reply', emailType: 'ls_dispatch', sender: 'branch', replyText: modifyReplyText },
        },
        ...releaseAllTail(),
        ...vehicleToVt01nTail(),
      ],
      finalVerifications: {
        soStatus: 'completed',
        minLsiCount: expectedLsi,
        invoiceNumberPresent: true,
        shipmentPresent: true,
        minSapTransactions: 4, // ZSO-VIS + ZLOAD1 + ZLOAD3-B1 + VTO1N-B
      },
    };
  }

  const c3 = makeModifyChainWithVA02(
    'modify_increase',
    '3290003',
    'MODINC',
    `Please increase material ${M_A.material} from 50 to 80 units.`,
    3,
  );
  const c4 = makeModifyChainNoVA02(
    'modify_decrease',
    '3290004',
    'MODDEC',
    `Please reduce material ${M_A.material} from 50 to 30 units. No deletions, no increases.`,
    3,
  );
  const c5 = makeModifyChainNoVA02(
    'modify_delete',
    '3290005',
    'MODDEL',
    `Please delete material ${M_C.material} from the order. No quantity changes elsewhere.`,
    2,
  );
  const c6 = makeModifyChainWithVA02(
    'modify_inc_dec',
    '3290006',
    'MODID',
    `Increase ${M_A.material} from 50 to 80 and decrease ${M_B.material} from 100 to 50.`,
    3,
  );
  const c7 = makeModifyChainWithVA02(
    'modify_inc_del',
    '3290007',
    'MODIDL',
    `Increase ${M_A.material} from 50 to 80 and delete ${M_C.material} entirely from the order.`,
    2,
  );
  const c8 = makeModifyChainNoVA02(
    'modify_dec_del',
    '3290008',
    'MODDD',
    `Reduce ${M_A.material} from 50 to 30 and delete ${M_C.material} entirely from the order.`,
    2,
  );

  // ─── C9 / C10 — after-LS modify variants (Phase A release_all, then Phase B post-LS modify) ───
  function makeAfterLsModifyChain(
    id: string,
    soNumber: string,
    custIdSuffix: string,
    modifyReplyText: string,
    expectedLsi: number,
  ): ChainSpec {
    return {
      id,
      description: `Phase A NEW ORDER → release_all → ZLOAD1 → vehicle_details email. Phase B branch replies on vehicle_details with ${id} → ZLOAD2 → tail`,
      soNumber,
      customerId: `TEST-CUST-${custIdSuffix}`,
      visibilityFixture: fixtureAllInStock(),
      inventory: PLENTY_INVENTORY,
      steps: [
        {
          description: 'NEW ORDER inbound from branch',
          action: { kind: 'new_order_inbound', soNumber, customerId: `TEST-CUST-${custIdSuffix}` },
        },
        {
          description: 'Branch replies release_all on ls_dispatch',
          action: {
            kind: 'inbound_reply',
            emailType: 'ls_dispatch',
            sender: 'branch',
            replyText: 'Please release everything as available. All quantities approved, go ahead and dispatch.',
          },
        },
        ...releaseAllTail(),
        // ─ Phase B begins here ─ branch's "vehicle_details" reply is a modification.
        {
          description: `Branch reply on vehicle_details — ${id} (post-LS modify)`,
          action: { kind: 'inbound_reply', emailType: 'vehicle_details', sender: 'branch', replyText: modifyReplyText },
        },
        {
          description: 'Wait for new vehicle_details email after ZLOAD2 (engine re-asks branch for vehicle)',
          action: { kind: 'wait_for_email', emailType: 'vehicle_details', timeoutMs: 30000 },
        },
        ...vehicleToVt01nTail(),
      ],
      finalVerifications: {
        soStatus: 'completed',
        minLsiCount: expectedLsi,
        invoiceNumberPresent: true,
        shipmentPresent: true,
        minSapTransactions: 5, // ZSO-VIS + ZLOAD1 + ZLOAD2 + ZLOAD3-B1 + VTO1N-B (≥5)
      },
    };
  }

  const c9 = makeAfterLsModifyChain(
    'after_ls_modify_decrease',
    '3290009',
    'AFTERLSDEC',
    `Please reduce ${M_A.material} from 50 to 30 on the LS. No deletions, no increases.`,
    3,
  );
  const c10 = makeAfterLsModifyChain(
    'after_ls_modify_delete',
    '3290010',
    'AFTERLSDEL',
    `Please remove ${M_C.material} from the LS entirely. No quantity changes elsewhere.`,
    2,
  );

  // ─── C11 plant_invoice_arrival — full Phase A then plant invoice reply ───
  const c11: ChainSpec = {
    id: 'plant_invoice_arrival',
    description: 'Phase A NEW ORDER → release_all → ZLOAD1 → vehicle_details → plant_ls. Phase B plant replies with invoice → ZLOAD3-B1 → VT01N',
    soNumber: '3290011',
    customerId: 'TEST-CUST-PLANTINV',
    visibilityFixture: fixtureAllInStock(),
    inventory: PLENTY_INVENTORY,
    steps: [
      {
        description: 'NEW ORDER inbound from branch',
        action: { kind: 'new_order_inbound', soNumber: '3290011', customerId: 'TEST-CUST-PLANTINV' },
      },
      {
        description: 'Branch replies release_all on ls_dispatch',
        action: {
          kind: 'inbound_reply',
          emailType: 'ls_dispatch',
          sender: 'branch',
          replyText: 'Please release everything as available. All quantities approved, go ahead and dispatch.',
        },
      },
      ...releaseAllTail(),
      {
        description: 'Branch replies with vehicle/driver/LR → sends plant_ls per LSI',
        action: {
          kind: 'vehicle_details_reply',
          vehicleNumber: 'GJ12-XY1234',
          driverMobile: '9876543210',
          lrNumber: 'LR-9988',
          lrDateIso: '2026-05-30',
        },
      },
      {
        description: 'Wait for plant_ls outbound email(s)',
        action: { kind: 'wait_for_email', emailType: 'plant_ls', timeoutMs: 15000 },
      },
      // ─ Phase B: plant invoice path ─
      {
        description: 'Plant replies with invoice PDF on plant_ls thread → ZLOAD3-B1',
        action: { kind: 'plant_invoice_reply', invoiceNumber: '7682614520', obdNumber: '85817679' },
      },
      {
        description: 'Wait for Shipment row from /processing-data callback',
        action: { kind: 'wait_for_shipment', timeoutMs: 20000 },
      },
      {
        description: 'Operator triggers VT01N for the Shipment',
        action: { kind: 'trigger_vt01n' },
      },
      {
        description: 'Wait for SO status = completed',
        action: { kind: 'wait_for_so_status', status: 'completed', timeoutMs: 20000 },
      },
    ],
    finalVerifications: {
      soStatus: 'completed',
      minLsiCount: 3,
      minLsiWithSapMatDoc: 3,
      invoiceNumberPresent: true,
      shipmentPresent: true,
      minSapTransactions: 4, // ZSO-VIS + ZLOAD1 + ZLOAD3-B1 + VTO1N-B
    },
  };

  return [c1, c2, c3, c4, c5, c6, c7, c8, c9, c10, c11];
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

async function main() {
  const filter = (process.env.FILTER ?? '').trim();
  const filterSet = filter ? new Set(filter.split(',').map((s) => s.trim())) : null;

  const CHAIN_SPECS = buildChainSpecs();
  const chainsToRun = filterSet ? CHAIN_SPECS.filter((c) => filterSet.has(c.id)) : CHAIN_SPECS;

  if (chainsToRun.length === 0) {
    console.error(`No chains match filter "${filter}". Available: ${CHAIN_SPECS.map((c) => c.id).join(', ')}`);
    process.exit(1);
  }

  console.log(`\n══════════════════════════════════════════════════════════════════════`);
  console.log(`E2E Lifecycle Chain Driver — SAP-aware reports`);
  console.log(`DATABASE_URL=${process.env.DATABASE_URL}`);
  console.log(`AUTO_GUI=${process.env.AUTO_GUI_HOST}:${process.env.AUTO_GUI_PORT}`);
  console.log(`Chains to run: ${chainsToRun.map((c) => c.id).join(', ')}`);
  console.log(`══════════════════════════════════════════════════════════════════════\n`);

  fs.writeFileSync('/tmp/dummy-e2e.log', '');
  const outDir = path.join(process.cwd(), 'test_artifacts/lifecycle-reports');
  fs.mkdirSync(outDir, { recursive: true });

  await startBridge();
  await startDummy();
  console.log(`✓ dummy auto_gui2 started`);

  const env = await loadEngine();
  console.log(`✓ engine modules loaded\n`);

  const results: ChainResult[] = [];
  try {
    for (const spec of chainsToRun) {
      const result = await runChain(env, spec);
      results.push(result);
      await writeHistoryFile(env, result, outDir);
    }
  } finally {
    stopDummy();
    stopBridge();
  }

  await writeIndexFile(results, outDir);

  console.log(`\n══════════════════════════════════════════════════════════════════════`);
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log(`CHAIN RESULTS (${results.length} chains, ${passed} PASS / ${failed} FAIL)`);
  console.log(`══════════════════════════════════════════════════════════════════════`);
  for (const r of results) {
    const ms = r.finishedAt - r.startedAt;
    const tag = r.pass ? '✓' : '✗';
    console.log(
      `  ${tag} ${r.spec.id.padEnd(28)} SAP_txns=${String(r.finalDbState.sapTransactionCount).padEnd(3)} ${(ms + 'ms').padEnd(8)} SO=${r.finalDbState.soStatus}`,
    );
  }
  console.log(`\nReports written to ${outDir}`);
  console.log(`Index: ${path.join(outDir, 'index.md')}`);
  console.log(`\n(HTTP_LOG last 20):`);
  for (const h of HTTP_LOG.slice(-20)) {
    console.log(`  ${h.method.padEnd(5)} ${h.url}  → ${h.status ?? '?'}`);
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('FATAL:', err);
  stopDummy();
  process.exit(2);
});
