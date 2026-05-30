#!/usr/bin/env node
/**
 * Dummy auto_gui2 server — mocks the real auto_gui2 contract closely enough
 * to test the dashboard end-to-end without SAP / VPN / a Windows host.
 *
 * Endpoints:
 *   POST /chat                       Receives the SAP transaction request,
 *                                    schedules a fake "SAP run", then sends
 *                                    the matching data callback + COMPLETION
 *                                    webhook to the dashboard.
 *   POST /email/branch-reply         Returns a canned classification based on
 *                                    keywords in the reply text (or a fixture).
 *   GET  /health, /status            Liveness check.
 *
 * Environment:
 *   PORT                             default 8000
 *   DASHBOARD_URL                    default http://localhost:3000
 *   DUMMY_DELAY_MS                   simulated SAP run latency (default 2000)
 *   DUMMY_FAIL_RATE                  0..1 random failure rate per /chat (default 0)
 *   DUMMY_FAIL_TRANSACTIONS          comma-separated codes that always fail
 *                                    (e.g. "ZLOAD1,VTO1N-B")
 *   DUMMY_LS_PER_SO                  how many LSs to emit per ZLOAD1 fire
 *                                    (default: one per material in the request)
 *
 * Fixtures (drop JSON files to override defaults):
 *   fixtures/visibility/<so>.json    { materials: [...] } for ZSO-VISIBILITY
 *   fixtures/visibility/_default.json
 *   fixtures/branch-reply/<intent>.json  intent ∈ {release_all, release_part, wait}
 *   fixtures/processing/<so>.json    { items: [...] } for ZLOAD3-B1 results
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, 'fixtures');

const PORT = parseInt(process.env.PORT || '8000', 10);
const DASHBOARD_URL = process.env.DASHBOARD_URL || 'http://localhost:3000';
const DELAY_MS = parseInt(process.env.DUMMY_DELAY_MS || '2000', 10);
const FAIL_RATE = parseFloat(process.env.DUMMY_FAIL_RATE || '0');
const FAIL_TXNS = (process.env.DUMMY_FAIL_TRANSACTIONS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const log = (msg) => console.log(`[dummy ${new Date().toISOString().slice(11, 19)}] ${msg}`);

// ---------- helpers ---------------------------------------------------------

function loadFixture(category, key) {
  const p = path.join(FIXTURE_DIR, category, `${key}.json`);
  if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  const fallback = path.join(FIXTURE_DIR, category, '_default.json');
  if (fs.existsSync(fallback)) return JSON.parse(fs.readFileSync(fallback, 'utf8'));
  return null;
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function shouldFail(transactionCode) {
  if (FAIL_TXNS.includes(transactionCode)) return true;
  return Math.random() < FAIL_RATE;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function randomDigits(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 10);
  return s;
}

// ---------- deterministic SAP-number generators ----------------------------
// Real auto_gui2 / SAP returns specific number shapes the artifacts pin down:
//   - LS numbers: 6-digit integers (e.g., 373282 from test_artifacts/ 373282.PDF)
//   - material_doc: 10-digit, sequential within a ZLOAD3 fire (4900000327, …)
//   - delivery_no: 8-digit, ONE per ZLOAD3 fire (85817679)
//   - invoice_no: 10-digit, ONE per ZLOAD3 fire (7682614520)
// We use process-lifetime counters seeded from these artifact numbers so the
// test transcript is deterministic and traceable. Restarting the dummy resets.

let lsCounter = 373282;            // next LS number to hand out (6-digit)
let matDocCounter = 4900000327;    // next material_doc (10-digit, increments per row)
let deliveryNoCounter = 85817679;  // next delivery_no (8-digit, increments per fire)
let invoiceNoCounter = 7682614520; // next invoice_no (10-digit, increments per fire)

function nextLs() {
  return String(lsCounter++);
}
function nextMaterialDoc() {
  return String(matDocCounter++);
}
function nextDeliveryNo() {
  return String(deliveryNoCounter++);
}
function nextInvoiceNo() {
  return String(invoiceNoCounter++);
}

// Tiny, valid PDF stub. Plant doesn't actually open them in tests; just needs bytes.
function makeStubPdf(text) {
  const escaped = String(text).replace(/[()\\]/g, '');
  const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
  const lengths = [];
  let body = '%PDF-1.4\n';
  const obj = (n, content) => {
    lengths[n] = body.length;
    body += `${n} 0 obj\n${content}\nendobj\n`;
  };
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  obj(
    3,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>'
  );
  obj(4, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  obj(5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const xrefStart = body.length;
  body += `xref\n0 6\n0000000000 65535 f\n`;
  for (let i = 1; i <= 5; i++) body += `${String(lengths[i]).padStart(10, '0')} 00000 n\n`;
  body += `trailer << /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(body, 'binary');
}

// ---------- defaults --------------------------------------------------------

function defaultMaterials(soNumber) {
  return {
    materials: [
      {
        material: `OP7WJ-${soNumber.slice(-4)}`,
        material_description: 'LUNIA BROWN HT ELV MDR-P',
        batch: 'B001',
        order_quantity: 20,
        available_stock_for_so: 20,
        order_weight_kg: 480,
      },
      {
        material: `OOWJ-${soNumber.slice(-4)}`,
        material_description: 'DOVER LT GL-P',
        batch: 'B002',
        order_quantity: 20,
        available_stock_for_so: 13,
        order_weight_kg: 240,
      },
      {
        material: `OA4FJ-${soNumber.slice(-4)}`,
        material_description: 'ABESCATO WHITE MT REC-P',
        batch: 'B003',
        order_quantity: 20,
        available_stock_for_so: 20,
        order_weight_kg: 600,
      },
    ],
  };
}

function defaultBranchReply(intent, soNumber) {
  if (intent === 'wait') {
    return {
      success: true,
      intent: 'wait',
      missing_materials: [`OP7WJ-${soNumber.slice(-4)}`],
      email_payload: {
        subject: `Re: SO ${soNumber} — production timeline`,
        body: `Please advise on availability of OP7WJ for SO ${soNumber}.`,
      },
    };
  }
  return {
    success: true,
    intent,
    materials: [
      { material: `OP7WJ-${soNumber.slice(-4)}`, batch: 'B001', quantity: 20 },
      { material: `OOWJ-${soNumber.slice(-4)}`, batch: 'B002', quantity: intent === 'release_part' ? 13 : 20 },
      { material: `OA4FJ-${soNumber.slice(-4)}`, batch: 'B003', quantity: 20 },
    ],
  };
}

// Parse the materials list out of the ZLOAD1 instruction string the dashboard sends.
// Format (from triggerZload1): "- Material: <code>, Batch: <b>, Quantity: <n>"
function parseInstructionMaterials(instruction) {
  if (!instruction) return [];
  const lines = String(instruction).split('\n');
  const out = [];
  for (const line of lines) {
    const m = /Material:\s*([^,]+),\s*Batch:\s*([^,]+),\s*Quantity:\s*(\d+)/i.exec(line);
    if (m) {
      out.push({ material_code: m[1].trim(), batch: m[2].trim(), quantity: parseInt(m[3], 10) });
    }
  }
  return out;
}

// ---------- callback senders ------------------------------------------------

async function postJson(url, body) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    log(`POST ${url} → ${res.status} ${text.slice(0, 120)}`);
    return res.ok;
  } catch (err) {
    log(`POST ${url} FAILED: ${err.message}`);
    return false;
  }
}

async function postCompletion({ work_id, success, summary, meta }) {
  log(`POST /step-status [work=${work_id} success=${success}] ${summary ?? ''}`);
  return postJson(`${DASHBOARD_URL}/backend/orders/aman/step-status`, {
    event: 'workflow_complete',
    meta: { ...(meta || {}), work_id },
    success,
    summary,
    error: success ? null : summary,
  });
}

async function sendVisibility({ so_number, meta, work_id }) {
  const fixture = loadFixture('visibility', so_number) || defaultMaterials(so_number);
  const materials = fixture.materials || fixture;
  log(`POST /visibility-data [so=${so_number} materials=${materials.length} work=${work_id}]`);
  return postJson(`${DASHBOARD_URL}/backend/orders/aman/visibility-data`, {
    so_number,
    materials,
    meta,
  });
}

async function sendZload1Files({ so_number, materials, meta, work_id }) {
  const url = `${DASHBOARD_URL}/backend/orders/aman/zload1-data`;
  const lsPerSo = parseInt(process.env.DUMMY_LS_PER_SO || '0', 10);
  const list = lsPerSo > 0 ? materials.slice(0, lsPerSo) : materials;
  if (list.length === 0) {
    log(`[ZLOAD1 so=${so_number} work=${work_id}] no materials parsed; sending one stub LS so the SO progresses`);
    list.push({ material_code: 'STUB', batch: 'B000', quantity: 1 });
  }
  for (const m of list) {
    // 6-digit LS number from the counter — matches the format the user
    // confirmed via test_artifacts/ 373282.PDF.
    const lsNumber = nextLs();
    const filename = `${lsNumber}.pdf`;
    const pdfBuffer = makeStubPdf(
      `LS ${lsNumber} | SO ${so_number} | ${m.material_code} batch ${m.batch} qty ${m.quantity}`
    );
    const fd = new FormData();
    fd.set('so_number', so_number);
    if (meta?.bundle_id) fd.set('bundle_id', String(meta.bundle_id));
    if (meta?.bundle_number !== undefined) fd.set('bundle_number', String(meta.bundle_number));
    fd.set('file', new Blob([pdfBuffer], { type: 'application/pdf' }), filename);
    try {
      const res = await fetch(url, { method: 'POST', body: fd });
      log(
        `POST /zload1-data [so=${so_number} ls=${lsNumber} material=${m.material_code} bundle=${meta?.bundle_id ?? 'none'} work=${work_id}] → ${res.status}`
      );
    } catch (err) {
      log(`POST ${url} [so=${so_number} ls=${lsNumber}] FAILED: ${err.message}`);
    }
  }
}

async function sendProcessing({ so_number, meta, attachments, work_id }) {
  // Real auto_gui2 / ZLOAD3-B1 callback shape (per test_artifacts/zload3.txt):
  //   { data: [{ sales_order, material_doc, delivery_no, invoice_no }] }
  // All rows in ONE ZLOAD3 fire share the SAME delivery_no + invoice_no.
  // material_doc is sequential (4900000327, 4900000328, …).
  // No ls_number, no loaded_quantity, no invoice_date — those are derived
  // by the dashboard's application layer from the SO's existing LSI rows.
  //
  // A per-SO fixture can override the row count. Otherwise: one row per
  // attachment (one attachment per LS the dashboard already created),
  // falling back to 5 rows if no attachments.
  const fixture = loadFixture('processing', so_number);
  let rows;
  if (fixture) {
    rows = fixture.data || fixture.items || fixture;
  } else {
    const atts = attachments || [];
    const rowCount = atts.length > 0 ? atts.length : 5;
    const sharedDelivery = nextDeliveryNo();
    const sharedInvoice = nextInvoiceNo();
    rows = [];
    for (let i = 0; i < rowCount; i++) {
      rows.push({
        sales_order: so_number,
        material_doc: nextMaterialDoc(),
        delivery_no: sharedDelivery,
        invoice_no: sharedInvoice,
      });
    }
  }
  log(
    `POST /processing-data [so=${so_number} rows=${rows.length} delivery=${rows[0]?.delivery_no} invoice=${rows[0]?.invoice_no} work=${work_id}]`
  );
  return postJson(`${DASHBOARD_URL}/backend/orders/aman/processing-data`, {
    so_number,
    data: rows,
    meta,
  });
}

// ---------- /chat dispatcher ------------------------------------------------

async function handleChat(body) {
  const transactionCode = body.transaction_code;
  const meta = body.meta || {};
  // Real auto_gui2 / dashboard put so_number in `meta.so_number`; older
  // callers used the top level. Try both.
  const soNumber = body.so_number ?? meta.so_number;
  const workId = body.work_id || meta.work_id;
  const attachments = body.attachments || [];

  log(`/chat ${transactionCode} so=${soNumber} bundle=${meta.bundle_id ?? meta.bundle_number ?? 'none'} work_id=${workId} attachments=${attachments.length}`);

  await sleep(DELAY_MS);

  if (shouldFail(transactionCode)) {
    log(`SIMULATED FAILURE for ${transactionCode}`);
    await postCompletion({
      work_id: workId,
      success: false,
      summary: `Simulated failure: ${transactionCode}`,
      meta,
    });
    return;
  }

  try {
    if (transactionCode === 'ZSO-VISIBILITY') {
      await sendVisibility({ so_number: soNumber, meta, work_id: workId });
    } else if (transactionCode === 'ZLOAD1') {
      const materials = parseInstructionMaterials(body.instruction);
      await sendZload1Files({ so_number: soNumber, materials, meta, work_id: workId });
    } else if (transactionCode === 'ZLOAD3-B1') {
      await sendProcessing({ so_number: soNumber, meta, attachments, work_id: workId });
    } else if (transactionCode === 'VTO1N-B' || transactionCode === 'ZLOAD3-A') {
      // No data callback per user-confirmed contract — only /step-status.
      log(`[${transactionCode} so=${soNumber} work=${workId}] no data callback (only /step-status)`);
    } else if (
      transactionCode === 'VA02' ||
      transactionCode === 'ZLOAD2' ||
      transactionCode === 'ZLOADING_CLOSE' ||
      transactionCode === 'MB51'
    ) {
      // User-confirmed: these transactions return success/failure only; no
      // data callback. Just log and fall through to /step-status.
      log(`[${transactionCode} so=${soNumber} work=${workId}] no data callback (only /step-status)`);
    } else {
      log(`Unknown transaction_code: ${transactionCode} — only sending /step-status`);
    }
  } catch (err) {
    log(`Data callback error for ${transactionCode}: ${err.message}`);
  }

  await postCompletion({
    work_id: workId,
    success: true,
    summary: `${transactionCode} completed (dummy)`,
    meta,
  });
}

// ---------- /email/branch-reply --------------------------------------------

function classifyBranchReply(replyHtml) {
  // Strip HTML, then strip Gmail-style quoted blocks (the user's NEW text
  // sits ABOVE the quoted thread). Without this we'd classify on words
  // from the original dispatch recommendation that the reply quotes back.
  let text = String(replyHtml || '').replace(/<[^>]+>/g, ' ');

  // Cut everything after "On <date>, <name> wrote:" markers (Gmail format)
  text = text.replace(/On\s+.{0,120}wrote:[\s\S]*$/i, '');
  text = text.replace(/-{2,}\s*Original Message\s*-{2,}[\s\S]*$/i, '');

  // Remove lines that start with `>` (the actual quote markers)
  text = text
    .split(/\r?\n/)
    .filter((line) => !/^\s*>/.test(line))
    .join(' ');

  text = text.toLowerCase();

  if (/\b(wait|hold|production|not (yet )?ready)\b/.test(text)) return 'wait';
  if (/\bpartial|partly|only what (you|we) have|release.{0,12}part\b/.test(text)) return 'release_part';
  return 'release_all';
}

// ---------- HTTP server -----------------------------------------------------

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/status')) {
      return sendJson(res, 200, { status: 'ok', service: 'dummy-auto-gui2' });
    }

    if (req.method === 'POST' && req.url === '/chat') {
      const body = await readJson(req);
      // ack synchronously, do the work async
      sendJson(res, 200, {
        success: true,
        summary: 'queued (dummy)',
        phases_completed: [],
        meta: body.meta,
      });
      handleChat(body).catch((err) => log(`/chat error: ${err.message}`));
      return;
    }

    if (req.method === 'POST' && req.url === '/email/branch-reply') {
      const body = await readJson(req);
      const intent = classifyBranchReply(body.branch_reply_html);
      const fixture = loadFixture('branch-reply', intent) || defaultBranchReply(intent, body.sales_order || '0000000');
      log(`/email/branch-reply so=${body.sales_order} → intent=${intent}`);
      return sendJson(res, 200, fixture);
    }

    sendJson(res, 404, { error: 'not found', method: req.method, url: req.url });
  } catch (err) {
    log(`unhandled error: ${err.message}`);
    sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  log(`listening on http://localhost:${PORT}`);
  log(`DASHBOARD_URL=${DASHBOARD_URL}`);
  log(`DELAY_MS=${DELAY_MS} FAIL_RATE=${FAIL_RATE} FAIL_TXNS=${FAIL_TXNS.join(',') || '(none)'}`);
});
