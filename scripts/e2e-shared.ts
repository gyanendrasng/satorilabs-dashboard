/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Shared infrastructure for the e2e drivers (scripts/e2e-via-dummy.ts and
 * scripts/e2e-chains.ts).
 *
 * Provides:
 *   - Env defaults (DATABASE_URL, DUMMY_URL, DASHBOARD_URL, etc.)
 *   - Gmail stub installed via Node Module.prototype.require hook
 *     (RECORDED_EMAILS captures every send)
 *   - fetch interceptor that routes /backend/* calls to in-process route
 *     handlers (HTTP_LOG captures every call)
 *   - Inbound HTTP bridge — receives TCP requests from the dummy server
 *     (child process) and routes them into the in-process route handlers
 *   - Dummy auto_gui2 server lifecycle (spawn / kill)
 *   - DB seeding helpers: seedSO, wipeAll, seedInventory, TEST_MATERIALS,
 *     STOCKED_MATERIALS, PLENTY_STOCK
 *   - waitFor predicate helper
 *   - loadEngine — dynamic-imports engine modules AFTER stubs are installed
 *
 * IMPORTANT: this module installs the Gmail require-hook and fetch interceptor
 * at import time. Any test driver that imports this file must NOT import
 * engine modules (src/lib/...) statically — they must be loaded via
 * `loadEngine()` (or `await import(...)` after this module's side effects
 * have run). Static imports of engine code would bind to the real Gmail
 * module before the stub is installed.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import http from 'node:http';
import type { IncomingMessage } from 'node:http';

// -----------------------------------------------------------------------------
// Env defaults
// -----------------------------------------------------------------------------

if (!process.env.DATABASE_URL) process.env.DATABASE_URL = 'file:./test-e2e.db';
if (!process.env.AUTO_GUI_HOST) process.env.AUTO_GUI_HOST = 'localhost';
if (!process.env.AUTO_GUI_PORT) process.env.AUTO_GUI_PORT = '8001';
if (!process.env.DASHBOARD_URL) process.env.DASHBOARD_URL = 'http://localhost:3001';
if (!process.env.DUMMY_URL) process.env.DUMMY_URL = 'http://localhost:8001';
if (!process.env.BRANCH_EMAIL) process.env.BRANCH_EMAIL = 'test-branch@example.com';
if (!process.env.PLANT_EMAIL) process.env.PLANT_EMAIL = 'test-plant@example.com';
if (!process.env.SAP_DEFAULT_PLANT) process.env.SAP_DEFAULT_PLANT = '7581';
if (!process.env.SUPERVISOR_EMAIL) process.env.SUPERVISOR_EMAIL = 'amanrai369@gmail.com';
// Segmented execution is the only supported mode for these tests.
process.env.SCENARIO_ENGINE_ENABLED = 'true';
process.env.UNIFIED_CLASSIFIER_ENABLED = 'true';
process.env.SEGMENTED_EXECUTION_ENABLED = 'true';

// -----------------------------------------------------------------------------
// Gmail stub via require hook (installed BEFORE engine imports)
// -----------------------------------------------------------------------------

export interface RecordedEmail {
  fn: string;
  args: unknown[];
  ts: number;
}

export const RECORDED_EMAILS: RecordedEmail[] = [];

/**
 * Mutable Gmail inbox used by the chain driver to seed NEW ORDER messages
 * so that `checkForNewEmails()` (the production cron path) sees them.
 *
 * `listMessages` returns a copy of this array as `{ id, threadId }[]`.
 * `getMessageBody` / `getMessageSubject` look up by `id`. Drivers push via
 * `inboxPushNewOrder(...)` before invoking `checkForNewEmails()`.
 */
export interface GmailInboxMessage {
  id: string;
  threadId: string;
  subject: string;
  body: string;
}
export const GMAIL_INBOX: GmailInboxMessage[] = [];

export function inboxPushNewOrder(args: {
  soNumber: string;
  customerId: string;
  body?: string;
}): GmailInboxMessage {
  const stamp = Date.now() + GMAIL_INBOX.length;
  const subject = `NEW ORDER ${args.soNumber}`;
  const body =
    args.body ??
    `Hi team,\n\nPlease create the following sales order:\n\n` +
      `Customer ID: ${args.customerId}\n` +
      `SO Number: ${args.soNumber}\n` +
      `Vehicle Tonnage: 35 t\n\n` +
      `Regards,\nBranch`;
  const msg: GmailInboxMessage = {
    id: `MOCK-NEWORDER-${stamp}`,
    threadId: `MOCK-THR-NEWORDER-${stamp}`,
    subject,
    body,
  };
  GMAIL_INBOX.push(msg);
  return msg;
}

let gmailSeq = 0;
const nextGmailIds = () => {
  gmailSeq += 1;
  return { messageId: `MOCK-MSG-${gmailSeq}`, threadId: `MOCK-THR-${gmailSeq}` };
};

const GMAIL_STUBS: Record<string, any> = {
  // Outbound senders — capture in RECORDED_EMAILS, return synthetic ids.
  sendPlainEmail: async (...args: unknown[]) => {
    RECORDED_EMAILS.push({ fn: 'sendPlainEmail', args, ts: Date.now() });
    return nextGmailIds();
  },
  sendReplyEmail: async (...args: unknown[]) => {
    RECORDED_EMAILS.push({ fn: 'sendReplyEmail', args, ts: Date.now() });
    return nextGmailIds();
  },
  sendHtmlEmail: async (...args: unknown[]) => {
    RECORDED_EMAILS.push({ fn: 'sendHtmlEmail', args, ts: Date.now() });
    return nextGmailIds();
  },
  sendHtmlReplyEmail: async (...args: unknown[]) => {
    RECORDED_EMAILS.push({ fn: 'sendHtmlReplyEmail', args, ts: Date.now() });
    return nextGmailIds();
  },
  sendEmail: async (...args: unknown[]) => {
    RECORDED_EMAILS.push({ fn: 'sendEmail', args, ts: Date.now() });
    return nextGmailIds();
  },
  // RFC822 id stub — always returns a synthetic id so reply-in-thread works.
  getMessageRfc822Id: async (messageId: string) => {
    RECORDED_EMAILS.push({ fn: 'getMessageRfc822Id', args: [messageId], ts: Date.now() });
    return `<rfc822-${messageId}@mock>`;
  },
  // Inbox-backed read APIs — drive the NEW ORDER cron path.
  listMessages: async (query: string, maxResults: number = 20) => {
    RECORDED_EMAILS.push({ fn: 'listMessages', args: [query, maxResults], ts: Date.now() });
    // We don't filter by query — the chain driver only ever pushes NEW ORDER
    // messages, and the production cron strips `is:unread` after first read
    // via the ProcessedEmail table. Return up to maxResults entries.
    return GMAIL_INBOX.slice(0, maxResults).map((m) => ({ id: m.id, threadId: m.threadId }));
  },
  getMessageBody: async (messageId: string) => {
    RECORDED_EMAILS.push({ fn: 'getMessageBody', args: [messageId], ts: Date.now() });
    const hit = GMAIL_INBOX.find((m) => m.id === messageId);
    return hit?.body ?? '';
  },
  getMessageSubject: async (messageId: string) => {
    RECORDED_EMAILS.push({ fn: 'getMessageSubject', args: [messageId], ts: Date.now() });
    const hit = GMAIL_INBOX.find((m) => m.id === messageId);
    return hit?.subject ?? '';
  },
};

// -----------------------------------------------------------------------------
// S3/R2 stub via require hook — keeps test off real R2 (no env vars needed).
// downloadFromS3 returns a tiny synthetic PDF; uploadToS3 is a no-op. Used by
// the chain driver to simulate plant-invoice PDFs that flow through
// checkAndSendBatchToAman → ZLOAD3-B1.
// -----------------------------------------------------------------------------

const SYNTHETIC_PDF = Buffer.from('%PDF-1.4\n%mock-e2e-pdf\n', 'utf-8');

export const RECORDED_S3: Array<{ fn: string; key: string; bytes?: number; ts: number }> = [];

const S3_STUBS: Record<string, any> = {
  uploadToS3: async (key: string, content: Buffer | Uint8Array, _contentType?: string) => {
    RECORDED_S3.push({ fn: 'uploadToS3', key, bytes: (content as Buffer).length ?? 0, ts: Date.now() });
    return undefined;
  },
  downloadFromS3: async (key: string) => {
    RECORDED_S3.push({ fn: 'downloadFromS3', key, ts: Date.now() });
    return SYNTHETIC_PDF;
  },
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Module = require('node:module');
const origRequire = Module.prototype.require;
Module.prototype.require = function (id: string) {
  const exp = origRequire.call(this, id);
  if (typeof id === 'string' && (id.endsWith('/gmail') || id.endsWith('\\gmail'))) {
    return new Proxy(exp, {
      get(target, key) {
        if (typeof key === 'string' && key in GMAIL_STUBS) return GMAIL_STUBS[key];
        return (target as any)[key];
      },
    });
  }
  if (typeof id === 'string' && (id.endsWith('/s3') || id.endsWith('\\s3'))) {
    return new Proxy(exp, {
      get(target, key) {
        if (typeof key === 'string' && key in S3_STUBS) return S3_STUBS[key];
        return (target as any)[key];
      },
    });
  }
  return exp;
};

// -----------------------------------------------------------------------------
// fetch interceptor — route /backend/* calls into in-process route handlers
// -----------------------------------------------------------------------------

export interface HttpLogEntry {
  url: string;
  method: string;
  ts: number;
  status?: number;
}

export const HTTP_LOG: HttpLogEntry[] = [];

export const origFetch = globalThis.fetch;
export const dashboardUrl = process.env.DASHBOARD_URL!.replace(/\/$/, '');

export async function invokeDashboardRoute(
  url: string,
  method: string,
  headers: Headers,
  body: BodyInit | null | undefined,
) {
  const u = new URL(url);
  const apiPath = u.pathname;
  const fsPath = path.join(process.cwd(), 'src/app', apiPath.replace(/\/+$/, ''), 'route.ts');
  if (!fs.existsSync(fsPath)) {
    return new Response(JSON.stringify({ error: `dashboard route not found: ${apiPath}` }), { status: 404 });
  }
  const mod = await import(fsPath);
  const fn = mod[method] || mod[method.toUpperCase()] || mod.default;
  if (typeof fn !== 'function') {
    return new Response(JSON.stringify({ error: `method ${method} not exported by ${apiPath}` }), { status: 405 });
  }
  const reqInit: RequestInit = { method, headers, body: body as any };
  const req = new Request(url, reqInit);
  return await fn(req);
}

globalThis.fetch = async (input: any, init?: any) => {
  const urlStr = typeof input === 'string' ? input : input?.url ?? String(input);
  const method = (init?.method ?? input?.method ?? 'GET').toUpperCase();
  HTTP_LOG.push({ url: urlStr, method, ts: Date.now() });
  if (urlStr.startsWith(dashboardUrl + '/backend/')) {
    const headers = new Headers(init?.headers ?? input?.headers);
    const res = await invokeDashboardRoute(urlStr, method, headers, init?.body);
    HTTP_LOG[HTTP_LOG.length - 1].status = res.status;
    return res;
  }
  const res = await origFetch(input as any, init);
  HTTP_LOG[HTTP_LOG.length - 1].status = res.status;
  return res;
};

// -----------------------------------------------------------------------------
// Inbound HTTP bridge — receives real TCP requests from the dummy server
// (child process) and routes them into the in-process Next.js route handlers.
// -----------------------------------------------------------------------------

let bridgeServer: http.Server | null = null;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function startBridge(): Promise<void> {
  const port = parseInt(new URL(dashboardUrl).port || '3001', 10);
  return new Promise((resolve, reject) => {
    bridgeServer = http.createServer(async (req, res) => {
      try {
        const url = `${dashboardUrl}${req.url}`;
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) {
          if (typeof v === 'string') headers.set(k, v);
          else if (Array.isArray(v)) headers.set(k, v.join(','));
        }
        const bodyBuf =
          req.method && req.method !== 'GET' && req.method !== 'HEAD' ? await readBody(req) : undefined;
        const bodyForFetch: BodyInit | undefined = bodyBuf
          ? (new Uint8Array(bodyBuf) as unknown as BodyInit)
          : undefined;
        const response = await invokeDashboardRoute(url, req.method ?? 'GET', headers, bodyForFetch);
        res.statusCode = response.status;
        response.headers.forEach((value: string, key: string) => res.setHeader(key, value));
        const buf = Buffer.from(await response.arrayBuffer());
        res.end(buf);
      } catch (err) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
    });
    bridgeServer.listen(port, () => {
      console.log(`✓ dashboard bridge listening on ${dashboardUrl}`);
      resolve();
    });
    bridgeServer.on('error', reject);
  });
}

export function stopBridge() {
  if (bridgeServer) {
    bridgeServer.close();
    bridgeServer = null;
  }
}

// -----------------------------------------------------------------------------
// Dummy server lifecycle
// -----------------------------------------------------------------------------

let dummyProc: ChildProcess | null = null;

export async function startDummy(): Promise<void> {
  return new Promise((resolve, reject) => {
    dummyProc = spawn('node', ['scripts/dummy-auto-gui2/server.mjs'], {
      env: {
        ...process.env,
        PORT: process.env.AUTO_GUI_PORT,
        DASHBOARD_URL: dashboardUrl,
        DUMMY_DELAY_MS: '200',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let started = false;
    dummyProc.stdout!.on('data', (buf) => {
      const s = buf.toString();
      fs.appendFileSync('/tmp/dummy-e2e.log', s);
      if (!started && /listening on/i.test(s)) {
        started = true;
        resolve();
      }
    });
    dummyProc.stderr!.on('data', (buf) => fs.appendFileSync('/tmp/dummy-e2e.log', buf.toString()));
    dummyProc.on('error', reject);
    setTimeout(async () => {
      if (started) return;
      try {
        const r = await origFetch(`${process.env.DUMMY_URL}/health`);
        if (r.ok) {
          started = true;
          resolve();
        }
      } catch {}
    }, 1500);
    setTimeout(() => {
      if (!started) reject(new Error('dummy server did not start within 5s'));
    }, 5000);
  });
}

export function stopDummy() {
  if (dummyProc && !dummyProc.killed) {
    dummyProc.kill('SIGTERM');
    dummyProc = null;
  }
}

// -----------------------------------------------------------------------------
// DB seeding helpers
// -----------------------------------------------------------------------------

export type SeedStage =
  | 'before_ls'
  | 'after_ls_before_invoice'
  | 'after_vehicle_placement'
  | 'after_email_to_plant'
  | 'after_plant_invoice';

export interface SeedOptions {
  soNumber: string;
  materials: Array<{ material: string; batch: string; ordered: number; available: number; weight: number }>;
  stage?: SeedStage;
  triggerEmailType?: string;
  triggerEmailRecipient?: 'branch' | 'plant';
}

export async function wipeAll(prisma: any) {
  // Also reset the Gmail inbox + recorded sends so chains start clean.
  GMAIL_INBOX.length = 0;
  RECORDED_EMAILS.length = 0;
  await prisma.scenarioEvent.deleteMany({});
  await prisma.scenarioProgress.deleteMany({});
  await prisma.workQueue.deleteMany({});
  await prisma.shipment.deleteMany({});
  await prisma.invoice.deleteMany({});
  await prisma.email.deleteMany({});
  await prisma.loadingSlipItem.deleteMany({});
  await prisma.material.deleteMany({});
  await prisma.bundle.deleteMany({});
  await prisma.salesOrder.deleteMany({});
  await prisma.purchaseOrder.deleteMany({});
  await prisma.customer.deleteMany({});
  await prisma.processedEmail.deleteMany({});
  await prisma.inventorySnapshot.deleteMany({});
  await prisma.currentSO.deleteMany({});
}

export async function seedSO(prisma: any, opts: SeedOptions) {
  const stamp = Date.now();
  const cust = await prisma.customer.create({
    data: { id: `CUST-${stamp}`, name: 'Test' },
  });
  const po = await prisma.purchaseOrder.create({
    data: {
      poNumber: `PO-${stamp}`,
      customerId: cust.id,
      customerName: 'Test',
      stage: 3,
      weightage: 45,
    },
  });
  const so = await prisma.salesOrder.create({
    data: {
      soNumber: opts.soNumber,
      purchaseOrderId: po.id,
      status: opts.stage === 'before_ls' || !opts.stage ? 'pending' : 'ls_created',
      requiresInput: false,
      visibilityState: 'received',
      originalThreadId: `MOCK-THR-${stamp}`,
      originalMessageId: `MOCK-MSG-${stamp}`,
    },
  });
  for (const m of opts.materials) {
    await prisma.material.create({
      data: {
        salesOrderId: so.id,
        material: m.material,
        batch: m.batch,
        orderQuantity: m.ordered,
        availableStock: m.available,
        orderWeightKg: m.weight,
        dispatchQuantity: m.ordered,
      },
    });
  }
  let bundle = null;
  const postLsStages: SeedStage[] = [
    'after_ls_before_invoice',
    'after_vehicle_placement',
    'after_email_to_plant',
    'after_plant_invoice',
  ];
  if (opts.stage && postLsStages.includes(opts.stage)) {
    const hasVehicle =
      opts.stage === 'after_vehicle_placement' ||
      opts.stage === 'after_email_to_plant' ||
      opts.stage === 'after_plant_invoice';
    bundle = await prisma.bundle.create({
      data: {
        purchaseOrderId: po.id,
        bundleNumber: 1,
        totalWeightKg: opts.materials.reduce((s, m) => s + m.weight, 0),
        status: 'planned',
        ...(hasVehicle ? { vehicleNumber: 'GJ12-MOCK', driverMobile: '9876543210' } : {}),
      },
    });
    await prisma.material.updateMany({
      where: { salesOrderId: so.id },
      data: { bundleId: bundle.id },
    });
    for (const m of opts.materials) {
      await prisma.loadingSlipItem.create({
        data: {
          salesOrderId: so.id,
          bundleId: bundle.id,
          lsNumber: `PRE-${m.material}`,
          material: m.material,
          orderQuantity: m.ordered,
          status: 'pending',
          fileUrl: `mock-r2/${m.material}.pdf`,
        },
      });
    }

    if (opts.stage === 'after_email_to_plant' || opts.stage === 'after_plant_invoice') {
      await prisma.email.create({
        data: {
          salesOrderId: so.id,
          purchaseOrderId: po.id,
          gmailMessageId: `MOCK-PLANT-LS-${stamp}`,
          gmailThreadId: `MOCK-THR-PLANT-${stamp}`,
          recipientEmail: process.env.PLANT_EMAIL!,
          subject: `LS forward for SO ${opts.soNumber}`,
          status: 'sent',
          emailType: 'plant_ls',
          sentBody: `<p>LS for SO ${opts.soNumber}</p>`,
        },
      });
    }

    if (opts.stage === 'after_plant_invoice') {
      await prisma.invoice.create({
        data: {
          salesOrderId: so.id,
          invoiceNumber: 'PRE-EXISTING',
          obdNumber: 'PRE-OBD',
          status: 'created',
        },
      });
    }
  }
  const triggerType = opts.triggerEmailType ?? 'ls_dispatch';
  const recipient =
    (opts.triggerEmailRecipient ?? 'branch') === 'plant'
      ? process.env.PLANT_EMAIL!
      : process.env.BRANCH_EMAIL!;
  const trigger = await prisma.email.create({
    data: {
      salesOrderId: so.id,
      purchaseOrderId: po.id,
      gmailMessageId: `MOCK-TRIG-${stamp}`,
      gmailThreadId: `MOCK-THR-T-${stamp}`,
      recipientEmail: recipient,
      subject: `Trigger ${triggerType}`,
      status: 'sent',
      emailType: triggerType,
      sentBody: `<p>Original ${triggerType} for SO ${opts.soNumber}</p>`,
    },
  });
  return { cust, po, so, bundle, trigger };
}

export async function seedInventory(
  prisma: any,
  plant: string,
  rows: Array<{ material: string; freeStock: number }>,
) {
  for (const r of rows) {
    await prisma.inventorySnapshot.upsert({
      where: { material_plant: { material: r.material, plant } },
      create: { material: r.material, plant, freeStock: r.freeStock, syncedAt: new Date() },
      update: { freeStock: r.freeStock, syncedAt: new Date() },
    });
  }
}

// -----------------------------------------------------------------------------
// Test fixtures
// -----------------------------------------------------------------------------

export const TEST_MATERIALS = [
  { material: 'YE1EDWO00001APJP', batch: 'A-26', ordered: 50, available: 50, weight: 1320 },
  { material: 'YV6FRYENE0000PJP', batch: '30-07-2025', ordered: 100, available: 100, weight: 2720 },
  { material: 'YODOVMEHL0000ZZP', batch: 'N/A', ordered: 200, available: 0, weight: 2100 },
];

export const STOCKED_MATERIALS = [
  { material: 'YE1EDWO00001APJP', batch: 'A-26', ordered: 50, available: 50, weight: 1320 },
  { material: 'YV6FRYENE0000PJP', batch: '30-07-2025', ordered: 100, available: 100, weight: 2720 },
  { material: 'YA4COWOCR000043P', batch: '20', ordered: 250, available: 250, weight: 6625 },
];

export const PLENTY_STOCK = STOCKED_MATERIALS.map((m) => ({ material: m.material, freeStock: 500 }));

// -----------------------------------------------------------------------------
// Polling helper
// -----------------------------------------------------------------------------

export async function waitFor<T>(
  pred: () => Promise<T | null>,
  timeoutMs: number,
  label: string,
): Promise<T | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await pred();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  console.log(`  [wait] timeout on "${label}" after ${timeoutMs}ms`);
  return null;
}

// -----------------------------------------------------------------------------
// Engine module loader (must be called AFTER stubs are installed)
// -----------------------------------------------------------------------------

export async function loadEngine() {
  const prismaMod = await import('../src/lib/prisma');
  const engineMod = await import('../src/lib/scenario-engine');
  const eventsMod = await import('../src/lib/scenario-events');
  const auditMod = await import('../src/lib/audit-trail');
  const emailThreadMod = await import('../src/lib/email-thread');
  const triggerMod = await import('../src/lib/auto-gui-trigger');
  const workQueueMod = await import('../src/lib/work-queue');
  const replyCheckerMod = await import('../src/lib/email-reply-checker');
  return {
    prisma: prismaMod.prisma,
    handleReplyV2: engineMod.handleReplyV2,
    executeScenario: engineMod.executeScenario,
    maybeAdvanceScenario: engineMod.maybeAdvanceScenario,
    emitEvent: eventsMod.emitEvent,
    renderAuditTrailForSO: auditMod.renderAuditTrailForSO,
    renderEmailThreadForSO: emailThreadMod.renderEmailThreadForSO,
    handleDispatchConfirmation: triggerMod.handleDispatchConfirmation,
    handleVehicleDetailsReply: triggerMod.handleVehicleDetailsReply,
    checkAndSendBatchToAman: triggerMod.checkAndSendBatchToAman,
    triggerVto1n: triggerMod.triggerVto1n,
    triggerZsoVisibility: triggerMod.triggerZsoVisibility,
    fanOutZload1ForPo: triggerMod.fanOutZload1ForPo,
    sendDispatchConfirmationEmail: triggerMod.sendDispatchConfirmationEmail,
    enqueueWork: workQueueMod.enqueueWork,
    pumpQueue: workQueueMod.pumpQueue,
    // Production cron entry points — driven directly by the chain.
    checkForNewEmails: replyCheckerMod.checkForNewEmails,
    checkForReplies: replyCheckerMod.checkForReplies,
  };
}

export type Env = Awaited<ReturnType<typeof loadEngine>>;
