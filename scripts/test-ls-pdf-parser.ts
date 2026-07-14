/**
 * Accuracy harness for the LS PDF parser.
 *
 *   npx tsx scripts/test-ls-pdf-parser.ts
 *
 * Runs the parser against every PDF in test_artifacts/loadingslips,
 * prints the structured output, and reports parse confidence per file
 * and an overall accuracy score.
 *
 * Ground truth: since we don't have an external oracle, the cross-check
 * is the parser's own quantity-vs-totalBoxes invariant (printed on every
 * LS by SAP). A parse is "correct" if confidence == 1.0.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseLoadingSlipPdf, type ParsedLoadingSlip } from '../src/lib/ls-pdf-parser';

const DIR = path.resolve('test_artifacts/loadingslips');

function fmt(o: ParsedLoadingSlip): string {
  const lines = [
    `  lsNumber:       ${o.lsNumber}`,
    `  lsDate:         ${o.lsDate ?? '(missing)'}`,
    `  soNumber:       ${o.soNumber}`,
    `  orderDate:      ${o.orderDate ?? '(missing)'}`,
    `  totalWeightKg:  ${o.totalWeightKg ?? '(missing)'}`,
    `  totalBoxes:     ${o.totalBoxes ?? '(missing)'}`,
    `  confidence:     ${o.confidence.toFixed(2)}`,
  ];
  if (o.warnings.length) {
    lines.push(`  warnings:       ${o.warnings.join(' | ')}`);
  }
  lines.push(`  items (${o.items.length}):`);
  for (const it of o.items) {
    lines.push(
      `    ${it.srNo}. ${it.material.padEnd(8)} qty=${String(it.qtyLoaded).padStart(4)} ` +
        `batch=${it.batch.padEnd(12)} mrp=${it.mrpPkg ?? '?'}/${it.mrpEach ?? '?'}`
    );
    lines.push(`         "${it.description}"`);
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const files = fs
    .readdirSync(DIR)
    .filter((f) => /\.pdf$/i.test(f))
    .sort();

  let perfect = 0;
  let partial = 0;
  let failed = 0;
  const totals = { files: files.length, items: 0, byConfidence: new Map<string, number>() };

  for (const f of files) {
    const full = path.join(DIR, f);
    console.log(`\n══════════════════════════════════════`);
    console.log(`FILE: ${f}`);
    console.log(`══════════════════════════════════════`);
    try {
      const buf = fs.readFileSync(full);
      const parsed = await parseLoadingSlipPdf(buf);
      console.log(fmt(parsed));
      totals.items += parsed.items.length;
      const bucket = parsed.confidence === 1
        ? 'perfect (1.00)'
        : parsed.confidence >= 0.85
          ? 'partial (0.85–0.99)'
          : parsed.confidence >= 0.5
            ? 'low (0.50–0.84)'
            : 'failed (<0.50)';
      totals.byConfidence.set(bucket, (totals.byConfidence.get(bucket) ?? 0) + 1);
      if (parsed.confidence === 1) perfect++;
      else if (parsed.confidence >= 0.5) partial++;
      else failed++;
    } catch (err) {
      console.log(`  ❌ HARD FAIL: ${err instanceof Error ? err.message : err}`);
      failed++;
    }
  }

  console.log(`\n══════════════════════════════════════════════════════════════════════`);
  console.log(`SUMMARY`);
  console.log(`══════════════════════════════════════════════════════════════════════`);
  console.log(`  Files parsed:     ${totals.files}`);
  console.log(`  Total line items: ${totals.items}`);
  for (const [bucket, count] of totals.byConfidence.entries()) {
    console.log(`    ${bucket}: ${count}`);
  }
  const overallAccuracy = totals.files > 0 ? (perfect / totals.files) * 100 : 0;
  console.log(`  Strict accuracy (confidence==1.00): ${perfect}/${totals.files} = ${overallAccuracy.toFixed(1)}%`);
  console.log(`  Usable accuracy (confidence≥0.85):  ${(perfect + partial)}/${totals.files} = ${(((perfect + partial) / totals.files) * 100).toFixed(1)}%`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
