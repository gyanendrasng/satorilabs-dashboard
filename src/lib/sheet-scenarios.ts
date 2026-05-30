/**
 * Parses Sheet3 of `Intent Classification.xlsx` at module load and exposes
 * a queryable registry of (Email Type, Stage, Primary Intent) → step list.
 *
 * The sheet is the **source of truth** for what to do when each kind of
 * inbound email arrives. The dashboard's scenario engine looks up the
 * matching row and walks the marked '1' step columns until it sends an
 * outbound email — then terminates.
 *
 * Structure expected in Sheet3:
 *   Row 1 — super-headers (group labels spanning step ranges)
 *   Row 2 — "Step 1" .. "Step 96" labels (over columns E onwards)
 *   Row 3 — actual STEP NAMES (e.g. "ZSO Visibility + Zmatana", "VA02").
 *           Columns A..D of Row 3 are metadata labels:
 *             A=Email Type, B=Stage, C=Primary Intent, D=Augmented Intent
 *   Row 4+ — scenarios; cells contain '1' (do step) or empty (skip)
 *
 * Reload semantics: parsed once at module load. Server restart picks up
 * sheet changes.
 */
import * as XLSX from 'xlsx';
import path from 'path';
import type { ScenarioEmailType } from './dispatch-scenarios';

/** The sheet's column-A label (title-case). Internal callers use the
 * lowercase ScenarioEmailType; convert via toSheetEmailType in
 * dispatch-scenarios.ts before passing to the sheet lookup helpers. */
export type EmailType = 'Branch Email' | 'Plant Email';

/** Convenience: convert ScenarioEmailType (lowercase) → sheet EmailType. */
export function emailTypeOf(s: ScenarioEmailType): EmailType {
  return s === 'branch' ? 'Branch Email' : 'Plant Email';
}

export interface SheetStep {
  /** 1-indexed step number from Row 2 (Step 1..Step 96). */
  stepNum: number;
  /** Step name from Row 3 (e.g. "ZSO Visibility + Zmatana"). */
  name: string;
  /** Super-header from Row 1 (the stage-bucket this column belongs to). */
  group: string;
  /** Original column index (0-based) — useful for ordering. */
  col: number;
}

export interface SheetRow {
  /** Sheet row number (1-indexed, for traceability). */
  rowNum: number;
  emailType: EmailType | '';
  stage: string;
  primaryIntent: string;
  augmentedIntent: string;
  /** Steps marked '1' for this scenario, in column order. */
  enabledSteps: SheetStep[];
}

const SHEET_FILE = path.join(process.cwd(), 'Intent Classification.xlsx');
const SHEET_NAME = 'Sheet3';
const META_COLS = 4; // A..D — Email Type / Stage / Primary Intent / Augmented Intent

let _rowsCache: SheetRow[] | null = null;
let _byKeyCache: Map<string, SheetRow> | null = null;

/**
 * Lazily parse the sheet on first call. Subsequent calls return cached data.
 */
function parseSheet(): SheetRow[] {
  if (_rowsCache) return _rowsCache;

  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.readFile(SHEET_FILE);
  } catch (err) {
    throw new Error(
      `[sheet-scenarios] Failed to read ${SHEET_FILE}: ${err instanceof Error ? err.message : err}`,
    );
  }

  const ws = wb.Sheets[SHEET_NAME];
  if (!ws) {
    throw new Error(
      `[sheet-scenarios] Sheet "${SHEET_NAME}" not found. Available: ${wb.SheetNames.join(', ')}`,
    );
  }

  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: '' });
  if (rows.length < 4) {
    throw new Error(`[sheet-scenarios] Sheet3 has only ${rows.length} rows; expected ≥ 4`);
  }

  const superHeaders = rows[0] as unknown[]; // Row 1
  const stepNumbers = rows[1] as unknown[];  // Row 2 — "Step N" labels
  const stepNames = rows[2] as unknown[];    // Row 3 — step name + (cols 0..3) metadata labels

  // Map each column → super-header (forward-fill blank cells from the previous group).
  const groupByCol: string[] = [];
  {
    let last = '';
    const maxCol = Math.max(superHeaders.length, stepNames.length);
    for (let c = 0; c < maxCol; c++) {
      const v = superHeaders[c];
      if (v && String(v).trim() !== '') last = String(v).trim();
      groupByCol[c] = last;
    }
  }

  const out: SheetRow[] = [];
  for (let r = 3; r < rows.length; r++) {
    const row = (rows[r] || []) as unknown[];
    if (row.length === 0) continue;
    const emailType = String(row[0] ?? '').trim() as EmailType | '';
    const stage = String(row[1] ?? '').trim();
    const primaryIntent = String(row[2] ?? '').trim();
    const augmentedIntent = String(row[3] ?? '').trim();
    // Skip totally blank rows.
    if (!emailType && !stage && !primaryIntent && !augmentedIntent) continue;

    const enabledSteps: SheetStep[] = [];
    for (let c = META_COLS; c < row.length; c++) {
      if (String(row[c] ?? '').trim() !== '1') continue;
      const stepNumRaw = stepNumbers[c];
      const stepNumMatch = String(stepNumRaw ?? '').match(/\d+/);
      const stepNum = stepNumMatch ? parseInt(stepNumMatch[0], 10) : c - META_COLS + 1;
      const name = String(stepNames[c] ?? '').trim() || '(unnamed)';
      enabledSteps.push({
        stepNum,
        name,
        group: groupByCol[c] || '',
        col: c,
      });
    }

    out.push({
      rowNum: r + 1,
      emailType,
      stage,
      primaryIntent,
      augmentedIntent,
      enabledSteps,
    });
  }

  _rowsCache = out;
  return out;
}

/**
 * Map keyed by `${emailType}|${stage}|${primaryIntent}` for O(1) lookups.
 */
function byKey(): Map<string, SheetRow> {
  if (_byKeyCache) return _byKeyCache;
  const m = new Map<string, SheetRow>();
  for (const r of parseSheet()) {
    if (!r.emailType || !r.stage || !r.primaryIntent) continue;
    m.set(`${r.emailType}|${r.stage}|${r.primaryIntent}`, r);
  }
  _byKeyCache = m;
  return m;
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * Force a re-parse on next access. Useful in dev/tests after the sheet file
 * has been replaced. In production the server restart is the normal way to
 * pick up changes.
 */
export function reloadScenarioSheet(): void {
  _rowsCache = null;
  _byKeyCache = null;
}

/**
 * All non-blank rows from Sheet3, in sheet order. Includes receive-only
 * intents (no enabledSteps).
 */
export function getAllScenarioRows(): SheetRow[] {
  return parseSheet();
}

/**
 * Lookup a single scenario by (emailType, stage, primaryIntent). Returns
 * null if no row matches.
 */
export function getScenarioRow(
  emailType: EmailType,
  stage: string,
  primaryIntent: string,
): SheetRow | null {
  return byKey().get(`${emailType}|${stage}|${primaryIntent}`) ?? null;
}

/**
 * All valid intents the classifier may pick for a given (emailType, stage).
 * Includes the row's primaryIntent + augmentedIntent so the prompt can show
 * both. Also unions any rows whose stage is 'Anytime' for this emailType —
 * those intents are valid at every stage.
 */
export function getValidIntents(
  emailType: EmailType,
  stage: string,
): Array<{ primaryIntent: string; augmentedIntent: string }> {
  const rows = parseSheet();
  const matches = rows.filter(
    (r) =>
      r.emailType === emailType &&
      (r.stage === stage || r.stage === 'Anytime') &&
      r.primaryIntent !== '' &&
      r.augmentedIntent !== '',
  );
  // Dedupe by augmentedIntent (sheet may have duplicates with empty rows).
  const seen = new Set<string>();
  const out: Array<{ primaryIntent: string; augmentedIntent: string }> = [];
  for (const r of matches) {
    if (seen.has(r.augmentedIntent)) continue;
    seen.add(r.augmentedIntent);
    out.push({ primaryIntent: r.primaryIntent, augmentedIntent: r.augmentedIntent });
  }
  return out;
}

/**
 * Summary counts — useful for boot-time logging and tests.
 */
export function getSheetSummary(): {
  totalRows: number;
  withSteps: number;
  receiveOnly: number;
  byEmailType: Record<string, number>;
  byStage: Record<string, number>;
} {
  const rows = parseSheet();
  let withSteps = 0;
  let receiveOnly = 0;
  const byEmailType: Record<string, number> = {};
  const byStage: Record<string, number> = {};
  for (const r of rows) {
    if (r.enabledSteps.length > 0) withSteps++;
    else receiveOnly++;
    if (r.emailType) byEmailType[r.emailType] = (byEmailType[r.emailType] ?? 0) + 1;
    if (r.stage) byStage[r.stage] = (byStage[r.stage] ?? 0) + 1;
  }
  return { totalRows: rows.length, withSteps, receiveOnly, byEmailType, byStage };
}
