#!/usr/bin/env node
/**
 * Dummy auto-gui2 stub. Listens on AUTO_GUI_PORT (default 8000) and logs
 * every /chat POST it receives. Always returns 200 OK so the dashboard's
 * fire-and-forget POST in work-queue.ts:87 succeeds and the work row
 * stays in `firing` state (until a real step-status callback advances it).
 *
 * Usage:
 *   AUTO_GUI_HOST=localhost AUTO_GUI_PORT=8000 npm run dev   # dashboard side
 *   node scripts/dummy-auto-gui2.mjs                         # this stub
 */
import http from 'node:http';

const PORT = Number(process.env.AUTO_GUI_PORT || 8000);

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const stamp = new Date().toISOString();
    console.log(`\n[${stamp}] ${req.method} ${req.url}`);
    console.log('  headers.content-type:', req.headers['content-type']);

    if (req.url === '/chat' && req.method === 'POST') {
      try {
        const parsed = JSON.parse(body);
        console.log('  → transaction_code:', parsed.transaction_code);
        console.log('  → work_id:', parsed.work_id);
        console.log('  → instruction:', String(parsed.instruction).slice(0, 200));
        if (parsed.meta) console.log('  → meta:', JSON.stringify(parsed.meta));
      } catch {
        console.log('  body (raw):', body.slice(0, 500));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, status: 'accepted' }));
      return;
    }

    console.log('  body:', body.slice(0, 500));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
});

server.listen(PORT, () => {
  console.log(`[dummy-auto-gui2] listening on http://localhost:${PORT}`);
  console.log('[dummy-auto-gui2] make sure AUTO_GUI_HOST=localhost in dashboard .env\n');
});
