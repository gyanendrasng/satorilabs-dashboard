#!/usr/bin/env node
/**
 * Simulate auto-gui2 POSTing parsed MB51 rows to the dashboard upload
 * endpoint. Builds a single Y-RED row with the qty given on the CLI.
 *
 *   node scripts/sample-mb51-upload.mjs 120
 *
 * Talks to http://localhost:3000 by default. Override with DASHBOARD_URL env.
 */
const qty = Number(process.argv[2]);
if (!Number.isFinite(qty) || qty <= 0) {
  console.error('usage: node scripts/sample-mb51-upload.mjs <qty>');
  process.exit(1);
}

const url = (process.env.DASHBOARD_URL || 'http://localhost:3000') + '/backend/material-receipts/upload';
const apiKey = process.env.WEBHOOK_API_KEY || 'dummy-webhook-api-key-12345';

const today = new Date().toISOString().slice(0, 10);
const body = {
  rows: [
    {
      material_document: `5000099${String(Date.now()).slice(-3)}`,
      posting_date: today,
      entry_date: today,
      material: 'Y-RED',
      material_description: 'TEST RED',
      movement_type: '101',
      quantity: qty,
      batch: 'TEST-BATCH-' + Date.now().toString().slice(-4),
      base_unit: 'BOX',
      plant: '7651',
      user_name: '14418',
      time_of_entry: '11:00:00',
      purchase_order: '5300099001',
    },
  ],
};

console.log(`[upload] POST ${url}`);
console.log(`[upload] payload: 1 row, Y-RED qty=${qty}`);

const res = await fetch(url, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  },
  body: JSON.stringify(body),
});

console.log(`[upload] HTTP ${res.status}`);
const json = await res.json();
console.log('[upload] response:', JSON.stringify(json, null, 2));
