/**
 * Application-side test runner. Discovers every scripts/test-*.ts, runs each in
 * its own child process against ONE shared throwaway SQLite DB, and prints a
 * pass/fail table. Exits 1 if any test fails.
 *
 *   npm test            # run all
 *   npm test -- bundler # run only tests whose filename contains "bundler"
 *
 * No test framework — each test is a standalone tsx script that asserts and
 * exits 0/1. DB-backed tests create + clean up their own fixtures; the shared
 * DB just needs the schema pushed once (done here before running anything).
 */

import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

// One throwaway DB for the whole run. PID keeps concurrent runs from colliding.
const DB_PATH = `/tmp/sl-test-${process.pid}.db`;
const DATABASE_URL = `file:${DB_PATH}`;
const childEnv = { ...process.env, DATABASE_URL };

const filter = process.argv[2];

const RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', BOLD = '\x1b[1m', RESET = '\x1b[0m';

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: repoRoot, env: childEnv, encoding: 'utf8', ...opts });
}

console.log(`${DIM}Provisioning throwaway test DB at ${DB_PATH}…${RESET}`);
const push = run('npx', ['prisma', 'db', 'push', '--schema', 'prisma/schema.prisma', '--skip-generate'], { stdio: 'pipe' });
if (push.status !== 0) {
  console.error(`${RED}Failed to provision test DB:${RESET}\n${push.stdout}\n${push.stderr}`);
  process.exit(1);
}

let testFiles = readdirSync(join(repoRoot, 'scripts'))
  .filter((f) => /^test-.*\.ts$/.test(f))
  .sort();
if (filter) testFiles = testFiles.filter((f) => f.includes(filter));

if (testFiles.length === 0) {
  console.error(`${RED}No test files matched${filter ? ` "${filter}"` : ''}.${RESET}`);
  process.exit(1);
}

console.log(`${BOLD}Running ${testFiles.length} test file(s)…${RESET}\n`);

const results = [];
for (const f of testFiles) {
  const start = Date.now();
  const r = run('npx', ['tsx', join('scripts', f)], { stdio: 'pipe' });
  const ms = Date.now() - start;
  const ok = r.status === 0;
  results.push({ f, ok, ms });
  // Surface failing output inline so the reason is visible without a re-run.
  if (!ok) {
    console.log(`${RED}✗ ${f}${RESET} ${DIM}(${ms}ms)${RESET}`);
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trimEnd();
    if (out) console.log(out.split('\n').map((l) => `    ${l}`).join('\n'));
  } else {
    console.log(`${GREEN}✓ ${f}${RESET} ${DIM}(${ms}ms)${RESET}`);
  }
}

const passed = results.filter((r) => r.ok).length;
const failedCount = results.length - passed;
console.log(`\n${BOLD}── Summary ──${RESET}`);
console.log(`${GREEN}${passed} passed${RESET}${failedCount ? `, ${RED}${failedCount} failed${RESET}` : ''} of ${results.length}`);

// Best-effort cleanup of the throwaway DB.
try { run('rm', ['-f', DB_PATH, `${DB_PATH}-journal`, `${DB_PATH}-wal`, `${DB_PATH}-shm`]); } catch { /* ignore */ }

process.exit(failedCount ? 1 : 0);
