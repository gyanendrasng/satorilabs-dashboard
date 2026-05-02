/**
 * Local test for the vehicle-split classifier.
 *
 * Run:  npx tsx scripts/test-vehicle-split-classifier.ts
 *
 * Requires OPENAI_API_KEY in .env (auto-loaded below).
 *
 * Exercises the local OpenAI call (gpt-5.5) over synthetic branch replies
 * the way handleVehicleSplitConfirmation would receive them. No Gmail, no
 * auto_gui2, no DB writes — just the classifier in isolation so you can
 * verify it picks the right intent and material codes from a known list.
 */
import 'dotenv/config';
import { classifyVehicleSplitReply } from '../src/lib/vehicle-split-classifier';

// Material codes for SO 3260628 (the over-weight test case)
const KNOWN_CODES = [
  'YE1MYRO370000PJP', // MYRON WHITE GLDGRE-P
  'YE1PREST00000PJP', // PRESTON STATUARIO PDR-P
  'YE1RAJSM00000PJP', // RAJET SMOKE SPDR-P
  'YV7EUBU880000PJP', // EUBURA SILVER PDR-P
  'YV7FIRM03AN00PJP', // FIRMIN GY ANANT SPDR-P
  'YV7FIRMBLAN00PJP', // FIRMIN BLISS ANANSPDR-P
  'YV7LAFF370000PJP', // LAFFINE WHITE PDR-P
  'YV7SAIF350000PJP', // SAIFRON GOLD PDR-P
];

const CASES = [
  { name: 'plain yes',                 reply: 'yes' },
  { name: 'go ahead with split',       reply: 'go ahead, use 2 vehicles' },
  { name: 'plain no',                  reply: 'no' },
  { name: 'wait',                      reply: 'wait, hold the dispatch' },
  { name: 'remove FIRMIN GY (full name)', reply: 'remove FIRMIN GY ANANT' },
  { name: 'drop FIRMIN GY (short)',    reply: 'drop FIRMIN GY' },
  { name: 'skip by code',              reply: 'skip YV7FIRM03AN00PJP' },
  { name: 'remove SAIFRON',            reply: 'skip SAIFRON, fits 1 truck right?' },
  { name: 'adjust qty',                reply: 'send only 200 of LAFFINE instead of full' },
  { name: 'mixed remove + adjust',     reply: 'drop FIRMIN GY ANANT and send only 100 of EUBURA SILVER' },
  { name: 'ambiguous fluff',           reply: 'thanks, talk soon' },
  { name: 'empty',                     reply: '' },
];

const RED = '\x1b[31m', GREEN = '\x1b[32m', YELLOW = '\x1b[33m', RESET = '\x1b[0m';

async function main() {
  for (const c of CASES) {
    process.stdout.write(`\n${YELLOW}[${c.name}]${RESET}  reply=${JSON.stringify(c.reply)}\n`);
    try {
      const r = await classifyVehicleSplitReply({
        replyHtml: c.reply,
        knownMaterialCodes: KNOWN_CODES,
      });
      process.stdout.write(`  ${GREEN}intent=${r.intent}${RESET}`);
      if (r.intent === 'amend') {
        process.stdout.write(`  remove=[${r.remove.join(', ') || '—'}]`);
        process.stdout.write(`  adjust=${JSON.stringify(r.adjust)}`);
      }
      process.stdout.write(`\n  reason=${r.reason}\n`);
    } catch (err) {
      process.stdout.write(`  ${RED}error: ${err instanceof Error ? err.message : String(err)}${RESET}\n`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
