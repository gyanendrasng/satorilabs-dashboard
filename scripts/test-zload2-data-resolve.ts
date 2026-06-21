/**
 * Pure-function test for resolveLsiCode — the ZLOAD2/ZLOAD1 PDF-row → SAP-code
 * matcher in src/app/backend/orders/aman/zload2-data/route.ts.
 *
 *   npx tsx scripts/test-zload2-data-resolve.ts
 *
 * Exits 0 on pass, 1 on fail. No DB, no network.
 *
 * Regression target: the surgical-increase bug where the Material row still
 * carried a stale batch ("N/A") while the regenerated PDF printed the real
 * batch ("P"). The batch-qualified match missed, and the OLD code dropped to
 * the family prefix ("OOWJ") — a wrong code that broke PlantResolver. The fix
 * adds a unique-description fallback so the real code resolves anyway.
 */

import {
  resolveLsiCode,
  normaliseLsiDesc,
  type LsiMatEntry,
} from '../src/app/backend/orders/aman/zload2-data/route';

const RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';
let failed = false;
const pass = (m: string) => console.log(`${GREEN}✓ PASS${RESET} ${m}`);
const fail = (m: string) => { console.error(`${RED}✗ FAIL${RESET} ${m}`); failed = true; };

// Helper mirroring how the route builds matEntries (batch tokens split on comma
// + the joined string, all alongside the normalised description).
const entry = (code: string, desc: string, batch: string): LsiMatEntry => {
  const batchTokens = batch.split(',').map((b) => b.trim()).filter((b) => b.length > 0);
  return { code, desc: normaliseLsiDesc(desc), batchTokens: [...batchTokens, normaliseLsiDesc(batch)] };
};

// (a) batch-qualified hit — description + batch both line up → real code.
{
  const entries = [entry('YO00000530000SOP', 'OOWJ 108X108-80 MANGO YELLOW GL UNREC- P', 'P')];
  const got = resolveLsiCode(entries, 'OOWJ 108X108-80 MANGO YELLOW GL UNREC- P', 'P');
  if (got === 'YO00000530000SOP') pass('batch-qualified match → real code');
  else fail(`batch-qualified → got ${got}`);
}

// (b) THE BUG: Material batch is stale "N/A" but the PDF prints real "P".
//     Batch doesn't match, but the description is UNIQUE → must resolve to the
//     real code (NOT fall through to the caller's family-prefix fallback).
{
  const entries = [entry('YO00000530000SOP', 'OOWJ 108X108-80 MANGO YELLOW GL UNREC- P', 'N/A')];
  const got = resolveLsiCode(entries, 'OOWJ 108X108-80 MANGO YELLOW GL UNREC- P', 'P');
  if (got === 'YO00000530000SOP') pass('stale N/A batch + unique desc → real code (the surgical-increase bug)');
  else fail(`stale-batch unique-desc → got ${got} (expected YO00000530000SOP)`);
}

// (c) truncated PDF description (text layer drops the "-P" suffix) + batch hit.
{
  const entries = [entry('YV7HATLI00000PJP', 'OV7FJ 600X1200-2 HATTIE LIME SPDR-P', 'D-01')];
  const got = resolveLsiCode(entries, 'OV7FJ 600X1200-2 HATTIE LIME SPDR', 'D-01');
  if (got === 'YV7HATLI00000PJP') pass('truncated PDF desc (prefix match) + batch → real code');
  else fail(`truncated-desc → got ${got}`);
}

// (d) AMBIGUOUS: two materials share a description prefix and the batch doesn't
//     disambiguate → must stay UNRESOLVED (undefined) so the caller treats it
//     as ambiguous (family-prefix warning), NOT silently pick one.
{
  const entries = [
    entry('YAAAA0000000001P', 'OABC 100X100-1 SHARED PREFIX', 'X1'),
    entry('YBBBB0000000002P', 'OABC 100X100-1 SHARED PREFIX', 'X2'),
  ];
  const got = resolveLsiCode(entries, 'OABC 100X100-1 SHARED PREFIX', 'P'); // batch P matches neither
  if (got === undefined) pass('ambiguous shared desc + non-matching batch → undefined');
  else fail(`ambiguous → got ${got} (expected undefined)`);
}

// (e) multi-batch material ("RP08, B01") → per-token match resolves either batch.
{
  const entries = [entry('YU7CATHDC0000U1P', 'OU7FJ 800X1600-2 CASANDRATHUNDERDECGHR-P', 'RP08, B01')];
  const got = resolveLsiCode(entries, 'OU7FJ 800X1600-2 CASANDRATHUNDERDECGHR-P', 'B01');
  if (got === 'YU7CATHDC0000U1P') pass('multi-batch material, per-token batch → real code');
  else fail(`multi-batch → got ${got}`);
}

// (f) two materials share a desc prefix but DISTINCT batches → batch disambiguates.
{
  const entries = [
    entry('YAAAA0000000001P', 'OABC 100X100-1 SHARED PREFIX', 'X1'),
    entry('YBBBB0000000002P', 'OABC 100X100-1 SHARED PREFIX', 'X2'),
  ];
  const got = resolveLsiCode(entries, 'OABC 100X100-1 SHARED PREFIX', 'X2');
  if (got === 'YBBBB0000000002P') pass('shared desc + distinct batch → batch disambiguates');
  else fail(`batch-disambiguation → got ${got}`);
}

process.exit(failed ? 1 : 0);
