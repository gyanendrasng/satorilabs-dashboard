/**
 * Pure-function test for mergeVa02Flush — the engine-internal merge of the
 * planner's INCREASE list with pending branch decreases/deletes into the single
 * material list a VA02 call carries.
 *
 *   npx tsx scripts/test-va02-flush.ts
 *
 * Exits 0 on pass, 1 on fail. No DB, no SAP.
 */

import { mergeVa02Flush, type PendingSoChange, type Va02Material } from '../src/lib/auto-gui-trigger';

const RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';
let failed = false;
const pass = (m: string) => console.log(`${GREEN}✓ PASS${RESET} ${m}`);
const fail = (m: string) => { console.error(`${RED}✗ FAIL${RESET} ${m}`); failed = true; };

// Sort by material for order-insensitive comparison.
const norm = (xs: Va02Material[]) =>
  [...xs].sort((a, b) => a.material.localeCompare(b.material))
    .map((m) => ('op' in m ? `${m.material}:DEL` : `${m.material}:${m.orderQuantity}`))
    .join(', ');

// (a) increases only, no pending → unchanged.
{
  const out = mergeVa02Flush([{ material: 'C', orderQuantity: 20 }], []);
  if (norm(out) === 'C:20') pass('increases only → unchanged');
  else fail(`increases only → got ${norm(out)}`);
}

// (b) pending dec A→5 + pending del B + increase C→20 → all three present.
{
  const pending: PendingSoChange[] = [
    { material: 'A', pendingSoOp: 'dec', pendingSoQty: 5 },
    { material: 'B', pendingSoOp: 'del', pendingSoQty: null },
  ];
  const out = mergeVa02Flush([{ material: 'C', orderQuantity: 20 }], pending);
  if (norm(out) === 'A:5, B:DEL, C:20') pass('dec A + del B + inc C → merged (A:5, B:DEL, C:20)');
  else fail(`dec+del+inc → got ${norm(out)}`);
}

// (c) increase on a material that has a pending DEL → del dropped, increase wins.
{
  const pending: PendingSoChange[] = [{ material: 'B', pendingSoOp: 'del', pendingSoQty: null }];
  const out = mergeVa02Flush([{ material: 'B', orderQuantity: 30 }], pending);
  if (norm(out) === 'B:30') pass('inc supersedes pending del on same material (B:30, not DEL)');
  else fail(`inc-supersedes-del → got ${norm(out)}`);
}

// (d) increase on a material that has a pending DEC → increase wins.
{
  const pending: PendingSoChange[] = [{ material: 'A', pendingSoOp: 'dec', pendingSoQty: 5 }];
  const out = mergeVa02Flush([{ material: 'A', orderQuantity: 40 }], pending);
  if (norm(out) === 'A:40') pass('inc supersedes pending dec on same material (A:40, not 5)');
  else fail(`inc-supersedes-dec → got ${norm(out)}`);
}

// (e) pending dec with null qty is skipped defensively.
{
  const pending: PendingSoChange[] = [{ material: 'A', pendingSoOp: 'dec', pendingSoQty: null }];
  const out = mergeVa02Flush([], pending);
  if (out.length === 0) pass('pending dec with null qty → skipped');
  else fail(`null-qty dec → got ${norm(out)}`);
}

// (f) pending only, no increases → flush carries them alone.
{
  const pending: PendingSoChange[] = [
    { material: 'A', pendingSoOp: 'dec', pendingSoQty: 5 },
    { material: 'B', pendingSoOp: 'del', pendingSoQty: null },
  ];
  const out = mergeVa02Flush([], pending);
  if (norm(out) === 'A:5, B:DEL') pass('pending only (no increases) → A:5, B:DEL');
  else fail(`pending only → got ${norm(out)}`);
}

process.exit(failed ? 1 : 0);
