/**
 * checkForNewEmails must distinguish a freshly-composed NEW ORDER from a branch
 * REPLY (both now share the unified "Re: New Order - <id>" subject). The
 * discriminator is the In-Reply-To / References header — exercised here via the
 * pure `hasReplyHeaders` predicate behind `isReplyMessage`.
 *
 *   npx tsx scripts/test-newemail-skips-replies.ts   (or: npm test)
 *
 * Exits 0/1.
 */

import { hasReplyHeaders } from '../src/lib/gmail';

const RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';
let failed = false;
const pass = (m: string) => console.log(`${GREEN}✓ PASS${RESET} ${m}`);
const fail = (m: string) => { console.error(`${RED}✗ FAIL${RESET} ${m}`); failed = true; };
const check = (c: boolean, m: string) => (c ? pass(m) : fail(m));

// Fresh-composed new order — no reply headers → NOT a reply (process it).
check(hasReplyHeaders('', '') === false, 'no headers → not a reply (new order)');
check(hasReplyHeaders(null, null) === false, 'null headers → not a reply');
check(hasReplyHeaders(undefined, undefined) === false, 'undefined headers → not a reply');
check(hasReplyHeaders('   ', '  ') === false, 'whitespace-only headers → not a reply');

// Replies carry In-Reply-To and/or References → IS a reply (skip it).
check(hasReplyHeaders('<abc@mail.gmail.com>', '') === true, 'In-Reply-To present → reply');
check(hasReplyHeaders('', '<root@mail> <abc@mail>') === true, 'References present → reply');
check(hasReplyHeaders('<x@mail>', '<x@mail>') === true, 'both present → reply');

process.exit(failed ? 1 : 0);
