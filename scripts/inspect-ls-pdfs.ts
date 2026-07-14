/**
 * Reconnaissance: dump the raw text of every LS PDF in
 * test_artifacts/loadingslips so we can see what we're parsing against.
 *
 *   npx tsx scripts/inspect-ls-pdfs.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const DIR = path.resolve('test_artifacts/loadingslips');

async function extractText(pdfPath: string): Promise<string> {
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await getDocument({ data }).promise;
  const out: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    // Reconstruct text using the (x,y) coords so columns line up roughly.
    // We sort by y desc then x asc, grouping rows by similar y.
    const items = content.items.map((it: any) => ({
      str: it.str as string,
      x: it.transform[4] as number,
      y: it.transform[5] as number,
    }));
    items.sort((a, b) => b.y - a.y || a.x - b.x);
    let curY = null as number | null;
    let line: string[] = [];
    for (const it of items) {
      if (curY === null || Math.abs(it.y - curY) < 2) {
        line.push(it.str);
        curY = curY ?? it.y;
      } else {
        out.push(line.join(' │ '));
        line = [it.str];
        curY = it.y;
      }
    }
    if (line.length) out.push(line.join(' │ '));
    out.push(`──── page ${i} end ────`);
  }
  return out.join('\n');
}

async function main(): Promise<void> {
  const files = fs
    .readdirSync(DIR)
    .filter((f) => /\.pdf$/i.test(f))
    .sort();
  for (const f of files) {
    const full = path.join(DIR, f);
    console.log(`\n══════════════════════════════════════`);
    console.log(`FILE: ${f}`);
    console.log(`══════════════════════════════════════`);
    try {
      const txt = await extractText(full);
      console.log(txt);
    } catch (err) {
      console.error(`  failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
