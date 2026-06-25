/**
 * coerceVa02Args must accept op: inc | dec | del (V3.0).
 *
 *   npx tsx scripts/test-va02-dec-del-args.ts   (or: npm test)
 *
 * Pre-fix coerceVa02Args stripped `op` and required qty>0, so a planner-emitted
 * DELETE threw (qty missing) and a DECREASE was silently mis-typed as an increase
 * (the root of the SO-line-down regression). This asserts inc/dec/del all coerce
 * correctly and bad input still throws. No DB.
 *
 * Exits 0/1.
 */

import { coerceVa02Args } from '../src/lib/planner-step-args';
import type { PlannedStep } from '../src/lib/llm-planner';

const RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';
let failed = false;
const pass = (m: string) => console.log(`${GREEN}✓ PASS${RESET} ${m}`);
const fail = (m: string) => { console.error(`${RED}✗ FAIL${RESET} ${m}`); failed = true; };

const step = (materials: unknown[]): PlannedStep => ({ kind: 'va02', args: { materials } });

// inc → {op:'inc', orderQuantity}
{
  const [r] = coerceVa02Args(step([{ code: 'M', op: 'inc', qty: 210 }]));
  if (r.op === 'inc' && r.orderQuantity === 210) pass("inc → {op:'inc', orderQuantity:210}");
  else fail(`inc → ${JSON.stringify(r)}`);
}
// dec → {op:'dec', orderQuantity} (NOT mis-typed as an increase)
{
  const [r] = coerceVa02Args(step([{ code: 'M', op: 'dec', qty: 150 }]));
  if (r.op === 'dec' && r.orderQuantity === 150) pass("dec → {op:'dec', orderQuantity:150}");
  else fail(`dec → ${JSON.stringify(r)}`);
}
// del → {op:'del'}, no orderQuantity
{
  const [r] = coerceVa02Args(step([{ code: 'M', op: 'del' }]));
  if (r.op === 'del' && r.orderQuantity === undefined) pass("del → {op:'del'} (no qty)");
  else fail(`del → ${JSON.stringify(r)}`);
}
// del with a stray qty → still del, qty ignored
{
  const [r] = coerceVa02Args(step([{ code: 'M', op: 'del', qty: 99 }]));
  if (r.op === 'del' && r.orderQuantity === undefined) pass('del + stray qty → del, qty ignored');
  else fail(`del+qty → ${JSON.stringify(r)}`);
}
// missing op → defaults to inc (back-compat with older plans)
{
  const [r] = coerceVa02Args(step([{ code: 'M', qty: 200 }]));
  if (r.op === 'inc' && r.orderQuantity === 200) pass('missing op → defaults to inc');
  else fail(`no-op → ${JSON.stringify(r)}`);
}
// dec with qty<=0 → throws
{
  let threw = false;
  try { coerceVa02Args(step([{ code: 'M', op: 'dec', qty: 0 }])); } catch { threw = true; }
  if (threw) pass('dec qty=0 → throws');
  else fail('dec qty=0 did NOT throw');
}
// invalid op → throws
{
  let threw = false;
  try { coerceVa02Args(step([{ code: 'M', op: 'bump', qty: 5 }])); } catch { threw = true; }
  if (threw) pass('invalid op → throws');
  else fail('invalid op did NOT throw');
}

process.exit(failed ? 1 : 0);
