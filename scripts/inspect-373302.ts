/**
 * Dump the raw pdfjs text extraction for LS 373302 so we can see exactly
 * how cells are positioned and why the parser collapsed two rows into one.
 *
 *   npx tsx scripts/inspect-373302.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const FILE = path.resolve('missing_pdfs/ 373302.PDF');

async function main(): Promise<void> {
  const buf = fs.readFileSync(FILE);
  const data = new Uint8Array(buf);
  const doc = await getDocument({ data, verbosity: 0 }).promise;

  console.log('═══════════════ RAW pdfjs items (str, x, y) ═══════════════');
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const items = (content.items as Array<{ str: string; transform: number[] }>)
      .filter((it) => it.str && it.str.trim())
      .map((it) => ({ str: it.str.trim(), x: it.transform[4], y: it.transform[5] }));

    // Sort by y desc, then x asc — same order the parser uses.
    items.sort((a, b) => b.y - a.y || a.x - b.x);

    for (const it of items) {
      console.log(`  x=${it.x.toFixed(1).padStart(7)}  y=${it.y.toFixed(1).padStart(7)}  ${JSON.stringify(it.str)}`);
    }
    console.log(`──── page ${i} end ────`);
  }

  console.log('\n═══════════════ Grouped into rows (Y_TOLERANCE=2) ═══════════════');
  // Replicate the parser's grouping logic.
  const Y_TOLERANCE = 2;
  const page = await doc.getPage(1);
  const content = await page.getTextContent();
  const items = (content.items as Array<{ str: string; transform: number[] }>)
    .filter((it) => it.str && it.str.trim())
    .map((it) => ({ str: it.str.trim(), x: it.transform[4], y: it.transform[5] }));
  items.sort((a, b) => b.y - a.y || a.x - b.x);

  let curRow: string[] = [];
  let curY: number | null = null;
  const rows: string[][] = [];
  for (const it of items) {
    if (curY === null || Math.abs(it.y - curY) < Y_TOLERANCE) {
      curRow.push(it.str);
      curY = curY ?? it.y;
    } else {
      if (curRow.length) rows.push(curRow);
      curRow = [it.str];
      curY = it.y;
    }
  }
  if (curRow.length) rows.push(curRow);

  rows.forEach((row, i) => {
    console.log(`  Row ${i + 1}: ${row.map((c) => JSON.stringify(c)).join(' | ')}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
