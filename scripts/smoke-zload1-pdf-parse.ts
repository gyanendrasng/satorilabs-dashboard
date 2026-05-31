/**
 * Smoke: call the parser directly on each sample LS PDF and print the
 * material rows we would have written to LoadingSlipItem. No DB writes,
 * no HTTP — just verifies the wire-up logic produces the right shape.
 *
 *   npx tsx scripts/smoke-zload1-pdf-parse.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseLoadingSlipPdf } from '../src/lib/ls-pdf-parser';

const DIR = path.resolve('test_artifacts/loadingslips');
const MIN_CONFIDENCE = 0.85;

async function main(): Promise<void> {
  const files = fs.readdirSync(DIR).filter((f) => /\.pdf$/i.test(f)).sort();
  let totalLsis = 0;
  let totalSkipped = 0;
  for (const f of files) {
    const buf = fs.readFileSync(path.join(DIR, f));
    try {
      const parsed = await parseLoadingSlipPdf(buf);
      const useParsed = parsed.confidence >= MIN_CONFIDENCE && parsed.items.length > 0;
      console.log(
        `LS ${parsed.lsNumber} (SO ${parsed.soNumber}, conf=${parsed.confidence.toFixed(2)}, ` +
          `${useParsed ? 'WRITE' : 'FALLBACK'}): ${parsed.items.length} item(s)`
      );
      if (useParsed) {
        for (const it of parsed.items) {
          console.log(
            `  → upsert LSI { loadingSlipId: <ls>, material: "${it.material}", lsNumber: "${parsed.lsNumber}", orderQuantity: ${it.qtyLoaded} }`
          );
          totalLsis++;
        }
      } else {
        console.log(`  → fallback: 1 PENDING placeholder LSI`);
        totalSkipped++;
      }
    } catch (err) {
      console.log(`LS ${f}: HARD FAIL — ${err instanceof Error ? err.message : err}`);
      totalSkipped++;
    }
  }
  console.log(`\nTotal LSIs that would be written: ${totalLsis} (across ${files.length - totalSkipped}/${files.length} PDFs)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
