/**
 * SAP ZLOAD1 Loading Slip PDF parser.
 *
 * Input: a Buffer holding a SAP-generated Loading Slip PDF (one LS per PDF).
 * Output: a structured ParsedLoadingSlip with the LS header + line items.
 *
 * Strategy
 * ────────
 * 1. Use pdfjs-dist to extract the PDF's text items with their (x, y) coords.
 * 2. Group text items into "lines" by y-coord (within tolerance), and sort
 *    by x within each line. This reconstructs the table row by row.
 * 3. Header scan: regex out `Loading Slip No.`, `Sales Order No`,
 *    `Loading Slip Date`, `Order Date`, `Total Weight`, `Total No. of Boxes`.
 * 4. Item rows: a row starts with a small integer (Sr. No.) and contains
 *    enough columns (≥ 5) — that's the discriminant. Within a row, the
 *    column order (verified across the 12 sample SAP PDFs) is:
 *       [ Sr.No, Description, MRP-pkg, MRP-each, QtyLoaded, BatchNo ]
 *    The first whitespace-separated token of Description is the SAP
 *    material code (e.g. "OA4FJ" from "OA4FJ 600X600-4 BASSWOOD …").
 * 5. Validation: sum(qty across rows) should match `Total No. of Boxes`.
 *    Confidence is computed from this check + presence of all header
 *    fields. The caller can use it to gate "trust this parse vs. fall
 *    back to PENDING".
 *
 * Known assumptions (and where they could break):
 *   - One LS per PDF. SAP appears to print this way; if it ever batches
 *     multiple LSs per file, the header scan would pick only the first.
 *   - Material code is `[A-Z][A-Z0-9]{2,}` at the start of the description.
 *     Real codes observed: OA4FJ, OOWJ, OE1WJ, O7FJ, OQ9FJ, OV5FJ, OV6FJ,
 *     OV7FJ, OE1FJ. All match. If SAP changes the prefix scheme we'd need
 *     to revisit.
 *   - Quantity Loaded is an integer; the per-row "MRP" columns are decimal
 *     numbers with a dot (e.g. 1295.00). That difference is how we
 *     distinguish "this number is the quantity" from "this number is a
 *     price". If a future SAP report ever uses an integer for MRP we'd
 *     need a stricter positional discriminator.
 *   - Batch can be: pure digits ("44"), alphanumeric ("C11", "A33"),
 *     hyphenated ("B-13"), or a date ("12-08-2025", "30-07-2025"). We
 *     accept anything that's the last non-number column on the row.
 */

import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

export interface ParsedLineItem {
  /** 1-based serial number on the slip. */
  srNo: number;
  /** SAP material code, e.g. "OA4FJ". */
  material: string;
  /** Full product description as printed. */
  description: string;
  /** Quantity loaded (boxes). */
  qtyLoaded: number;
  /** Batch identifier as printed on the slip (string — can be a date or code). */
  batch: string;
  /** Package MRP in INR. */
  mrpPkg?: number;
  /** Per-each MRP in INR. */
  mrpEach?: number;
}

export interface ParsedLoadingSlip {
  lsNumber: string;
  lsDate: string | null;
  soNumber: string;
  orderDate: string | null;
  items: ParsedLineItem[];
  totalWeightKg: number | null;
  totalBoxes: number | null;
  /**
   * 0..1 confidence score.
   *   1.0  = every header field parsed AND sum(qtyLoaded)==totalBoxes
   *   0.7  = parsed structure, but the box-total cross-check failed by ≤5%
   *   0.5  = parsed structure but box-total mismatched by >5%
   *   0.0  = header fields missing or no rows extracted
   */
  confidence: number;
  /** Free-text diagnostic — surfaced on confidence<1. */
  warnings: string[];
}

interface TextItem {
  str: string;
  x: number;
  y: number;
}

// Group items into rows by y-coordinate. Two items are in the same row if
// their y values differ by less than `Y_TOLERANCE` PDF units.
const Y_TOLERANCE = 2;

const MATERIAL_CODE_RE = /^[A-Z][A-Z0-9]{2,}$/; // OA4FJ, OOWJ, O7FJ, …
const INT_RE = /^\d+$/;
const DECIMAL_RE = /^\d+\.\d+$/;
const NUMBER_RE = /^\d+(\.\d+)?$/;

/**
 * Extract text from every page, returning a flat array of items in
 * top-to-bottom, left-to-right order.
 */
async function extractTextItems(pdfBuffer: Buffer): Promise<TextItem[]> {
  const data = new Uint8Array(pdfBuffer);
  const doc = await getDocument({
    data,
    // Silence the standardFontDataUrl warning; we don't render, we only
    // need text positions, and pdfjs falls back to embedded fonts fine.
    verbosity: 0,
  }).promise;

  const items: TextItem[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    for (const raw of content.items as Array<{ str: string; transform: number[] }>) {
      if (!raw.str || !raw.str.trim()) continue;
      items.push({
        str: raw.str.trim(),
        x: raw.transform[4],
        // Stack pages: offset y by a big page-index multiplier so page-2
        // items sort below page-1 items.
        y: raw.transform[5] - i * 100000,
      });
    }
  }
  // Sort by y desc (top of page first), then x asc.
  items.sort((a, b) => b.y - a.y || a.x - b.x);
  return items;
}

/** Group adjacent items (after sort) into "rows" by y proximity. */
function groupIntoRows(items: TextItem[]): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentY: number | null = null;
  for (const it of items) {
    if (currentY === null || Math.abs(it.y - currentY) < Y_TOLERANCE) {
      currentRow.push(it.str);
      currentY = currentY ?? it.y;
    } else {
      if (currentRow.length) rows.push(currentRow);
      currentRow = [it.str];
      currentY = it.y;
    }
  }
  if (currentRow.length) rows.push(currentRow);
  return rows;
}

/**
 * Find a value in a single line, supporting both "Label : value" and
 * "Label: value" forms. Returns the value or null.
 */
function findInline(line: string, label: string): string | null {
  // Tolerant of spaces around the colon and of multiple spaces.
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${escaped}\\s*:\\s*([^\\s|│]+(?:\\s+[^|│]+)*?)(?=\\s{2,}|$)`, 'i');
  const m = line.match(re);
  return m ? m[1].trim() : null;
}

/** Parse a single row of cells into a ParsedLineItem, or return null if it
 * doesn't match the item-row shape. */
function tryParseItemRow(cells: string[]): ParsedLineItem | null {
  // An item row starts with a small integer (the Sr. No., 1..N).
  // Within a row, the SAP report's text-extraction order is:
  //   [ Sr.No, Description, MRP-pkg, MRP-each, QtyLoaded, BatchNo ]
  // We've verified this against 12 sample PDFs across 7 different SAP material
  // prefixes. The total cells per row varies (5 vs 6) if MRP-each is missing
  // or merged into description.
  if (cells.length < 4) return null;
  const first = cells[0];
  if (!INT_RE.test(first)) return null;
  const srNo = parseInt(first, 10);
  if (srNo < 1 || srNo > 99) return null;

  // Find the description: it's the cell after Sr.No that starts with a
  // letter (the material code). Walk forward until we find one.
  let descIdx = -1;
  for (let i = 1; i < cells.length; i++) {
    if (/^[A-Z]/.test(cells[i])) {
      descIdx = i;
      break;
    }
  }
  if (descIdx < 0) return null;

  const description = cells[descIdx];
  const firstToken = description.split(/\s+/)[0];
  if (!MATERIAL_CODE_RE.test(firstToken)) return null;
  const material = firstToken;

  // Numbers and batch come after the description. Walk the remaining cells.
  // Pattern observed:
  //   description, "MRP-pkg" (decimal), "MRP-each" (decimal), "qty" (int), "batch" (anything)
  // Batch can look like an int ("44"), a date ("30-07-2025"), or a code
  // ("C11"). To find QTY robustly we take "the integer that sits between
  // the decimals and the batch". The first cell that's not a decimal AND
  // not a number whose ".00" would be a price is the qty.
  const tail = cells.slice(descIdx + 1);

  let mrpPkg: number | undefined;
  let mrpEach: number | undefined;
  let qtyLoaded: number | undefined;
  let batch: string | undefined;

  // Collect decimals as MRP candidates; the first non-decimal-shaped
  // numeric token after them is the qty, and the rest joined back is the
  // batch (handles hyphenated batches like "B-13" that some PDFs split).
  const remaining: string[] = [];
  for (const cell of tail) {
    if (DECIMAL_RE.test(cell)) {
      if (mrpPkg === undefined) mrpPkg = parseFloat(cell);
      else if (mrpEach === undefined) mrpEach = parseFloat(cell);
      else remaining.push(cell);
    } else if (INT_RE.test(cell) && qtyLoaded === undefined && mrpPkg !== undefined) {
      qtyLoaded = parseInt(cell, 10);
    } else {
      remaining.push(cell);
    }
  }

  if (qtyLoaded === undefined) {
    // Fall back: if we didn't find an integer between decimals and batch,
    // try the cell just before the last non-numeric one.
    const ints = tail.filter((c) => INT_RE.test(c));
    if (ints.length > 0) qtyLoaded = parseInt(ints[ints.length - 1], 10);
  }

  // Batch = the remaining tail content joined. SAP usually emits it as a
  // single cell, but if the extractor split it (rare on dates) we re-join.
  batch = remaining.join(' ').trim() || undefined;

  if (qtyLoaded === undefined || !batch) return null;

  return {
    srNo,
    material,
    description,
    qtyLoaded,
    batch,
    mrpPkg,
    mrpEach,
  };
}

/**
 * Parse a SAP-generated Loading Slip PDF.
 *
 * Resolves a ParsedLoadingSlip on success or throws on a hard parse error
 * (corrupt PDF, no text, etc.). Soft errors (e.g. one row failed to parse,
 * box-total cross-check off) are surfaced via `confidence` + `warnings`
 * so the caller can decide whether to commit the data.
 */
export async function parseLoadingSlipPdf(
  pdfBuffer: Buffer
): Promise<ParsedLoadingSlip> {
  const items = await extractTextItems(pdfBuffer);
  if (items.length === 0) {
    throw new Error('PDF contained no extractable text');
  }
  const rows = groupIntoRows(items);
  if (rows.length === 0) {
    throw new Error('PDF text could not be grouped into rows');
  }

  // Header scan. Each row is an array of cells; join with a single space
  // for pattern matching.
  const flat = rows.map((r) => r.join(' '));

  const warnings: string[] = [];
  const findHeader = (label: string): string | null => {
    for (const line of flat) {
      const v = findInline(line, label);
      if (v) return v;
    }
    return null;
  };

  const lsNumber = findHeader('Loading Slip No.');
  const soNumber = findHeader('Sales Order No');
  const lsDate = findHeader('Loading Slip Date');
  const orderDate = findHeader('Order Date');
  const totalBoxesRaw = findHeader('Total No. of Boxes');
  // Total Weight may render as "9275KG" — capture the digits.
  let totalWeightKg: number | null = null;
  for (const line of flat) {
    const m = line.match(/Total Weight\s*:\s*([\d.]+)\s*KG/i);
    if (m) {
      totalWeightKg = parseFloat(m[1]);
      break;
    }
  }

  if (!lsNumber) warnings.push('Loading Slip No. not found');
  if (!soNumber) warnings.push('Sales Order No not found');

  // Walk rows looking for item rows. Stop when we hit the "Narration"
  // section (the footer) — anything that looks like an item row past that
  // point is noise.
  const parsedItems: ParsedLineItem[] = [];
  let inFooter = false;
  for (const row of rows) {
    const joined = row.join(' ');
    if (/Narration\s*:/i.test(joined)) {
      inFooter = true;
      continue;
    }
    if (inFooter) continue;
    const item = tryParseItemRow(row);
    if (item) parsedItems.push(item);
  }

  if (parsedItems.length === 0) {
    warnings.push('no item rows parsed');
  }

  // Confidence scoring.
  let confidence = 0;
  if (lsNumber && soNumber && parsedItems.length > 0) {
    confidence = 1.0;
    const totalBoxes = totalBoxesRaw ? parseInt(totalBoxesRaw.replace(/[^\d]/g, ''), 10) : null;
    if (totalBoxes !== null) {
      const sumQty = parsedItems.reduce((s, it) => s + it.qtyLoaded, 0);
      if (sumQty !== totalBoxes) {
        const drift = Math.abs(sumQty - totalBoxes) / totalBoxes;
        if (drift <= 0.05) {
          confidence = 0.7;
          warnings.push(`sum(qty)=${sumQty} differs from totalBoxes=${totalBoxes} by ≤5%`);
        } else {
          confidence = 0.5;
          warnings.push(`sum(qty)=${sumQty} differs from totalBoxes=${totalBoxes} (>5% drift)`);
        }
      }
    } else {
      // Total boxes not parseable — knock confidence down a notch since
      // we have no cross-check.
      confidence = 0.85;
      warnings.push('Total No. of Boxes not parseable; no cross-check available');
    }
  }

  return {
    lsNumber: lsNumber ?? '',
    lsDate,
    soNumber: soNumber ?? '',
    orderDate,
    items: parsedItems,
    totalWeightKg,
    totalBoxes: totalBoxesRaw ? parseInt(totalBoxesRaw.replace(/[^\d]/g, ''), 10) : null,
    confidence,
    warnings,
  };
}
