/**
 * One-off: parse the 4 PDFs in missing_pdfs/ and emit a SQL backfill
 * script that replaces the PENDING placeholder LSIs with real per-material
 * rows.
 *
 *   npx tsx scripts/parse-missing-pdfs.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseLoadingSlipPdf } from '../src/lib/ls-pdf-parser';

const DIR = path.resolve('missing_pdfs');

// LS number → loadingSlipId, from the prod log lines:
//   [ZLOAD1 Data] LoadingSlip 373296 linked to Bundle 1 (id=cmptvn5u0002tqjb801ddtr5f)
//   ... lsiIds: cmptvzrft0035qjb8pv3i8o13, lsId: cmptvzrf10033qjb80cuikbtq
//
// We use the LS row's own salesOrderId at insert time (subquery against
// loading_slip), so we don't need to hardcode it here.
const LS_TO_LSID: Record<string, string> = {
  '373296': 'cmptvzrf10033qjb80cuikbtq',
  '373297': 'cmptw00040037qjb811mcgtdp',
  '373298': 'cmptw0a90003bqjb8j9zfdn7n',
  '373299': 'cmptw0n5w003fqjb8k3h6724c',
};

function sqlString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

async function main(): Promise<void> {
  const files = fs.readdirSync(DIR).filter((f) => /\.pdf$/i.test(f)).sort();

  const out: string[] = [
    '-- One-off backfill: replace PENDING placeholders with parsed material rows',
    '-- for the 4 LSs whose ZLOAD1 callbacks fell back due to the pdfjs worker bug.',
    '-- Wrap in a transaction so all-or-nothing.',
    '',
    'BEGIN TRANSACTION;',
    '',
  ];

  for (const f of files) {
    const buf = fs.readFileSync(path.join(DIR, f));
    const parsed = await parseLoadingSlipPdf(buf);

    // Match the LS by parsed.lsNumber (authoritative — comes from the PDF
    // header itself, not the filename).
    const loadingSlipId = LS_TO_LSID[parsed.lsNumber];
    if (!loadingSlipId) {
      console.error(`!! No DB id mapping for LS ${parsed.lsNumber} — skipping`);
      continue;
    }

    out.push(`-- ─────────────────────────────────────────────────────────────`);
    out.push(`-- LS ${parsed.lsNumber}  (SO ${parsed.soNumber}, conf=${parsed.confidence.toFixed(2)})`);
    out.push(`-- loadingSlipId = ${loadingSlipId}`);
    out.push(`-- items: ${parsed.items.length}`);
    for (const it of parsed.items) {
      out.push(`--   ${it.material} / batch=${it.batch} / qty=${it.qtyLoaded}`);
    }
    if (parsed.warnings.length > 0) {
      out.push(`-- warnings: ${parsed.warnings.join(' | ')}`);
    }
    out.push('');

    // Delete the PENDING placeholder for this LS.
    out.push(`DELETE FROM loading_slip_item`);
    out.push(`WHERE loadingSlipId = ${sqlString(loadingSlipId)}`);
    out.push(`  AND material = 'PENDING';`);
    out.push('');

    // Insert one row per parsed material. `salesOrderId` is sourced from
    // the LoadingSlip row itself via subquery — no need to hardcode it.
    // `id` uses SQLite's randomblob+hex for uniqueness (Prisma's cuid
    // generator runs in the client; raw SQL must supply its own id).
    for (const it of parsed.items) {
      out.push(`INSERT INTO loading_slip_item`);
      out.push(`  (id, salesOrderId, loadingSlipId, lsNumber, material, batch, orderQuantity, materialDescription, status, createdAt, updatedAt)`);
      out.push(`SELECT`);
      out.push(`  lower(hex(randomblob(12))),`);
      out.push(`  ls.salesOrderId,`);
      out.push(`  ls.id,`);
      out.push(`  ls.lsNumber,`);
      out.push(`  ${sqlString(it.material)},`);
      out.push(`  ${sqlString(it.batch)},`);
      out.push(`  ${it.qtyLoaded},`);
      out.push(`  ${sqlString(it.description)},`);
      out.push(`  'pending',`);
      out.push(`  datetime('now'),`);
      out.push(`  datetime('now')`);
      out.push(`FROM loading_slip ls`);
      out.push(`WHERE ls.id = ${sqlString(loadingSlipId)};`);
      out.push('');
    }
  }

  out.push('-- Sanity check: how many rows did we land?');
  out.push(`SELECT lsNumber, material, batch, orderQuantity, status FROM loading_slip_item WHERE lsNumber IN ('373296','373297','373298','373299') ORDER BY lsNumber, material;`);
  out.push('');
  out.push('COMMIT;');

  const sql = out.join('\n');
  const outPath = path.resolve('missing_pdfs/backfill.sql');
  fs.writeFileSync(outPath, sql);
  console.log(`SQL written to ${outPath}`);
  console.log(`\n${sql}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
