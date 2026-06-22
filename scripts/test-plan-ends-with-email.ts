/**
 * Unit test for planEndsWithOutboundEmail (src/lib/dispatch-scenarios.ts), the
 * classifier the engine uses to decide whether to bridge a re-plan after an
 * engine-fetch step (plan ended on a SAP/fetch step → re-plan) or wait for a
 * reply (plan ended on an outbound email → don't re-plan).
 *
 *   npx tsx scripts/test-plan-ends-with-email.ts
 *
 * Exits 0/1.
 */

import { planEndsWithOutboundEmail } from '../src/lib/dispatch-scenarios';

const RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';
let failed = false;
const pass = (m: string) => console.log(`${GREEN}✓ PASS${RESET} ${m}`);
const fail = (m: string) => { console.error(`${RED}✗ FAIL${RESET} ${m}`); failed = true; };

function check(label: string, kinds: string[], expected: boolean) {
  const got = planEndsWithOutboundEmail(kinds.map((kind) => ({ kind: kind as any })));
  if (got === expected) pass(`${label} → ${expected}`);
  else fail(`${label} → got ${got}, expected ${expected}`);
}

// Ends on a SAP / engine-fetch step → NOT an email boundary (must re-plan / wait).
check('[lone_zmatana]', ['lone_zmatana'], false);
check('[bundle_capacity_assessment]', ['bundle_capacity_assessment'], false);
check('[stock_precheck, va02]', ['stock_precheck', 'va02'], false);
check('[]', [], false);

// Ends on an outbound email → wait-for-reply boundary (do NOT re-plan).
check('[lone_zmatana, email_confirm_product_details]', ['lone_zmatana', 'email_confirm_product_details'], true);
check('[va02, lone_zmatana, email_2nd_release]', ['va02', 'lone_zmatana', 'email_2nd_release'], true);
check('[zload2, email_modified_ls_to_plant]', ['zload2', 'email_modified_ls_to_plant'], true);
check('[email_clarify_branch]', ['email_clarify_branch'], true);

process.exit(failed ? 1 : 0);
