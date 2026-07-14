/**
 * Coercion helpers at the planner→handler boundary.
 *
 * The LLM planner emits `args` as JSON (numbers, strings). Prisma columns are
 * stricter: `Material.orderQuantity` is Int, `PurchaseOrder.weightage` is
 * Decimal, etc. These helpers narrow the loose `Record<string, unknown>`
 * shape that the planner emits into the typed payloads each handler needs.
 *
 * Rules (per the plan):
 *   - Trust the planner verbatim — no DB validation here. Shape-only checks.
 *   - Throw on missing/wrong-shape args. Engine routes the throw to
 *     `scenario_failed`; planner re-plans on next tick.
 *   - Coerce numbers to Int via Math.round where the destination is Int.
 *     Fractional qty from the planner is a prompt bug, not a runtime fix —
 *     we log a warning but proceed.
 *   - kg→t conversion happens HERE for tonnage, not in the regex parser.
 */

import type { PlannedStep } from './llm-planner';

class PlannerArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlannerArgsError';
  }
}

function requireArgs(step: PlannedStep | undefined, kind: string): Record<string, unknown> {
  const args = step?.args;
  if (!args || typeof args !== 'object') {
    throw new PlannerArgsError(`${kind} step is missing required args object`);
  }
  return args;
}

function requireArray(value: unknown, field: string, kind: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new PlannerArgsError(`${kind}.args.${field} must be a non-empty array`);
  }
  return value;
}

function asInt(value: unknown, field: string, kind: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new PlannerArgsError(`${kind}.args.${field} must be a finite number, got ${JSON.stringify(value)}`);
  }
  const rounded = Math.round(value);
  if (rounded !== value) {
    console.warn(
      `[planner-args] ${kind}.args.${field} was fractional (${value}) — coerced to Int ${rounded}. Prompt bug?`,
    );
  }
  return rounded;
}

function asString(value: unknown, field: string, kind: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PlannerArgsError(`${kind}.args.${field} must be a non-empty string, got ${JSON.stringify(value)}`);
  }
  return value.trim();
}

function asOptionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

// ─── va02 ────────────────────────────────────────────────────────────────────

export interface Va02Item {
  material: string;
  /** 'inc'|'dec' set the SO line to a new absolute total; 'del' removes the line. */
  op: MaterialOpSummary;
  /** New absolute total (Int) for inc/dec. Absent for del. */
  orderQuantity?: number;
}

export function coerceVa02Args(step: PlannedStep | undefined): Va02Item[] {
  const args = requireArgs(step, 'va02');
  const materials = requireArray(args.materials, 'materials', 'va02');
  return materials.map((raw, i) => {
    const m = raw as Record<string, unknown>;
    const code = asString(m.code, `materials[${i}].code`, 'va02');
    // `op` defaults to 'inc' for backward-compat (older plans emitted increases
    // with no explicit op). V3.0 always sends op; dec/del are valid only in the
    // no-loading-slips window (the engine enforces where they're allowed).
    const rawOp = m.op === undefined ? 'inc' : m.op;
    if (rawOp !== 'inc' && rawOp !== 'dec' && rawOp !== 'del') {
      throw new PlannerArgsError(
        `va02.args.materials[${i}].op must be one of inc|dec|del, got ${JSON.stringify(m.op)}`,
      );
    }
    const op: MaterialOpSummary = rawOp;
    if (op === 'del') {
      return { material: code, op };
    }
    const qty = asInt(m.qty, `materials[${i}].qty`, 'va02');
    if (qty <= 0) {
      throw new PlannerArgsError(
        `va02.args.materials[${i}].qty must be positive for ${op}, got ${qty}`,
      );
    }
    return { material: code, op, orderQuantity: qty };
  });
}

// ─── zload1 (append mode) ──────────────────────────────────────────────────

export interface Zload1AppendArgs {
  /**
   * Existing bundle to append the new LS to. Undefined when `createNewBundle`
   * is true — the engine creates a fresh bundle (extra vehicle) and appends to
   * it (LS-created "preserve" overflow path).
   */
  appendToBundleId?: string;
  /** Append onto a BRAND-NEW bundle the engine creates at execution time. */
  createNewBundle?: boolean;
  materials: Array<{ code: string; batch?: string; qty: number }>;
}

/**
 * Returns the append-mode args when the planner supplied them, otherwise null
 * (initial mode — no args, fan-out from computed bundles). Throws if the
 * planner emitted a partial / malformed append payload.
 *
 * Two append shapes:
 *   - { appendToBundleId, materials }       → append to an existing bundle.
 *   - { createNewBundle: true, materials }  → create a new bundle, then append.
 */
export function coerceZload1AppendArgs(step: PlannedStep | undefined): Zload1AppendArgs | null {
  const raw = step?.args;
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.appendToBundleId === undefined && r.materials === undefined && r.createNewBundle === undefined) return null;

  const createNewBundle = r.createNewBundle === true;
  const appendToBundleId = createNewBundle
    ? undefined
    : asString(r.appendToBundleId, 'appendToBundleId', 'zload1');
  const materials = requireArray(r.materials, 'materials', 'zload1').map((m, i) => {
    const item = m as Record<string, unknown>;
    const code = asString(item.code, `materials[${i}].code`, 'zload1');
    const batch = asOptionalString(item.batch);
    const qty = asInt(item.qty, `materials[${i}].qty`, 'zload1');
    if (qty <= 0) {
      throw new PlannerArgsError(`zload1.args.materials[${i}].qty must be positive, got ${qty}`);
    }
    return { code, batch, qty };
  });
  return { appendToBundleId, createNewBundle, materials };
}

// ─── bundle_capacity_assessment ────────────────────────────────────────────

export interface BundleCapacityAssessmentItem {
  material: string;
  /** Additional weight in kilograms this material is being asked to add. */
  deltaKg: number;
}

/**
 * A material the SAME modify request is DECREASING / DELETING alongside the
 * increases in `items`. Carried so the assessment can credit the space the
 * decrease frees (the increase then fits more easily) and the dispatch emails
 * can show the new lower quantity. `toQty` is the material's new total dispatch
 * quantity in UNITS; `toQty: 0` denotes a delete.
 */
export interface BundleCapacityDecrease {
  material: string;
  toQty: number;
}

export interface BundleCapacityAssessmentArgs {
  items: BundleCapacityAssessmentItem[];
  /**
   * How overflow (kg that doesn't fit existing bundles) resolves:
   *   'new_so'     (default) — post-plant_ls: overflow → branch raises a new SO.
   *   'new_bundle' — LS-created "preserve" path: overflow → extra vehicle
   *                  (new bundle) on the same PO. Set via args.overflowMode.
   */
  overflowMode: 'new_so' | 'new_bundle';
  /** Concurrent decreases/deletes in the same request (optional). */
  decreases: BundleCapacityDecrease[];
}

export function coerceBundleCapacityArgs(step: PlannedStep | undefined): BundleCapacityAssessmentArgs {
  const args = requireArgs(step, 'bundle_capacity_assessment');
  const rawItems = requireArray(args.items, 'items', 'bundle_capacity_assessment');
  const items = rawItems.map((raw, i) => {
    const it = raw as Record<string, unknown>;
    const material = asString(it.material, `items[${i}].material`, 'bundle_capacity_assessment');
    if (typeof it.deltaKg !== 'number' || !Number.isFinite(it.deltaKg) || it.deltaKg <= 0) {
      throw new PlannerArgsError(
        `bundle_capacity_assessment.args.items[${i}].deltaKg must be a positive finite number, got ${JSON.stringify(it.deltaKg)}`,
      );
    }
    return { material, deltaKg: it.deltaKg };
  });
  const overflowMode = args.overflowMode === 'new_bundle' ? 'new_bundle' : 'new_so';

  // Optional concurrent decreases/deletes.
  const decreases: BundleCapacityDecrease[] = [];
  if (Array.isArray(args.decreases)) {
    args.decreases.forEach((raw, i) => {
      const d = raw as Record<string, unknown>;
      const material = asString(d.material, `decreases[${i}].material`, 'bundle_capacity_assessment');
      if (typeof d.toQty !== 'number' || !Number.isFinite(d.toQty) || d.toQty < 0) {
        throw new PlannerArgsError(
          `bundle_capacity_assessment.args.decreases[${i}].toQty must be a non-negative finite number (0 = delete), got ${JSON.stringify(d.toQty)}`,
        );
      }
      decreases.push({ material, toQty: d.toQty });
    });
  }

  return { items, overflowMode, decreases };
}

// ─── email_branch_request_new_so ───────────────────────────────────────────

export interface BranchNewSoItem {
  material: string;
  deltaKg: number;
}

export function coerceBranchNewSoArgs(step: PlannedStep | undefined): BranchNewSoItem[] {
  const args = requireArgs(step, 'email_branch_request_new_so');
  const items = requireArray(args.items, 'items', 'email_branch_request_new_so');
  return items.map((raw, i) => {
    const it = raw as Record<string, unknown>;
    const material = asString(it.material, `items[${i}].material`, 'email_branch_request_new_so');
    if (typeof it.deltaKg !== 'number' || !Number.isFinite(it.deltaKg) || it.deltaKg <= 0) {
      throw new PlannerArgsError(
        `email_branch_request_new_so.args.items[${i}].deltaKg must be a positive finite number, got ${JSON.stringify(it.deltaKg)}`,
      );
    }
    return { material, deltaKg: it.deltaKg };
  });
}

// ─── email_branch_overflow_request ─────────────────────────────────────────

export interface BranchOverflowItem {
  material: string;
  placedKg: number;
  overflowKg: number;
}

export interface BranchOverflowArgs {
  items: BranchOverflowItem[];
  /**
   * How the overflow resolves once the branch confirms:
   *   'new_so'     (default) — branch raises a fresh SO (post-plant_ls flow).
   *   'new_bundle' — we add an extra vehicle on the same PO (LS-created
   *                  "preserve" flow). Set by the planner via args.resolution.
   */
  resolution: 'new_so' | 'new_bundle';
}

export function coerceBranchOverflowArgs(step: PlannedStep | undefined): BranchOverflowArgs {
  const args = requireArgs(step, 'email_branch_overflow_request');
  const rawItems = requireArray(args.items, 'items', 'email_branch_overflow_request');
  const items = rawItems.map((raw, i) => {
    const it = raw as Record<string, unknown>;
    const material = asString(it.material, `items[${i}].material`, 'email_branch_overflow_request');
    if (typeof it.placedKg !== 'number' || !Number.isFinite(it.placedKg) || it.placedKg < 0) {
      throw new PlannerArgsError(
        `email_branch_overflow_request.args.items[${i}].placedKg must be a non-negative finite number, got ${JSON.stringify(it.placedKg)}`,
      );
    }
    if (typeof it.overflowKg !== 'number' || !Number.isFinite(it.overflowKg) || it.overflowKg <= 0) {
      throw new PlannerArgsError(
        `email_branch_overflow_request.args.items[${i}].overflowKg must be a positive finite number, got ${JSON.stringify(it.overflowKg)}`,
      );
    }
    return { material, placedKg: it.placedKg, overflowKg: it.overflowKg };
  });
  const resolution = args.resolution === 'new_bundle' ? 'new_bundle' : 'new_so';
  return { items, resolution };
}

// ─── lone_zmatana ──────────────────────────────────────────────────────────

/**
 * One material the planner wants ZMatana run for. `delta` is the DELTA quantity
 * (units) being added for this material — the amount ZMatana should look for
 * stock against, since the original quantity is already reserved by the
 * existing loading slips. Optional: omitted on the substitution use-case
 * (Rule 6e Phase 2.5) where there is no delta concept; the SAP agent then
 * falls back to the SO line as before.
 */
export interface LoneZmatanaItem {
  code: string;
  delta?: number;
}

/**
 * Returns the materials (code + optional delta) the planner wants ZMatana run
 * for. The planner emits `{ materials: [{ code, delta? }, ...] }`.
 */
export function coerceLoneZmatanaArgs(step: PlannedStep | undefined): LoneZmatanaItem[] {
  const args = requireArgs(step, 'lone_zmatana');
  const materials = requireArray(args.materials, 'materials', 'lone_zmatana');
  return materials.map((raw, i) => {
    const m = raw as Record<string, unknown>;
    const code = asString(m.code, `materials[${i}].code`, 'lone_zmatana');
    let delta: number | undefined;
    if (m.delta !== undefined && m.delta !== null) {
      delta = asInt(m.delta, `materials[${i}].delta`, 'lone_zmatana');
      if (delta <= 0) {
        throw new PlannerArgsError(
          `lone_zmatana.args.materials[${i}].delta must be a positive integer when present, got ${delta}`,
        );
      }
    }
    return { code, delta };
  });
}

// ─── zload2 ─────────────────────────────────────────────────────────────────

export interface Zload2Revision {
  lsNumber?: string;
  material: string;
  batch?: string;
  orderQuantity: number; // Int
}

export function coerceZload2Args(step: PlannedStep | undefined): Zload2Revision[] {
  const args = requireArgs(step, 'zload2');
  const revisions = requireArray(args.revisions, 'revisions', 'zload2');
  return revisions.map((raw, i) => {
    const r = raw as Record<string, unknown>;
    const material = asString(r.material, `revisions[${i}].material`, 'zload2');
    const qty = asInt(r.qty, `revisions[${i}].qty`, 'zload2');
    if (qty <= 0) {
      throw new PlannerArgsError(`zload2.args.revisions[${i}].qty must be positive, got ${qty}`);
    }
    return {
      lsNumber: asOptionalString(r.lsNumber),
      material,
      batch: asOptionalString(r.batch),
      orderQuantity: qty,
    };
  });
}

// ─── zloading_close ─────────────────────────────────────────────────────────

export interface ZloadingCloseDeletion {
  lsNumber?: string;
  material: string;
  batch?: string;
}

export type ZloadingCloseArgs =
  | { mode: 'all' }
  | { mode: 'surgical'; deletions: ZloadingCloseDeletion[] };

/**
 * Two-shape discriminated union:
 *   - `{ all: true }` → wipe every line on every LS of the SO (pre-plant_ls
 *     re-bundle path). Engine resolves the per-LS payload at fireStep time.
 *   - `{ deletes: [...] }` → surgical post-plant_ls per-material delete
 *     (Rule 11). Existing shape preserved verbatim.
 */
export function coerceZloadingCloseArgs(step: PlannedStep | undefined): ZloadingCloseArgs {
  const args = requireArgs(step, 'zloading_close');
  if (args.all === true) {
    return { mode: 'all' };
  }
  const deletes = requireArray(args.deletes, 'deletes', 'zloading_close');
  const deletions = deletes.map((raw, i) => {
    const d = raw as Record<string, unknown>;
    const material = asString(d.material, `deletes[${i}].material`, 'zloading_close');
    return {
      lsNumber: asOptionalString(d.lsNumber),
      material,
      batch: asOptionalString(d.batch),
    };
  });
  return { mode: 'surgical', deletions };
}

// ─── stock_precheck ─────────────────────────────────────────────────────────

export type MaterialOpSummary = 'inc' | 'dec' | 'del';

export interface MaterialModSummary {
  material_code: string;
  operation: MaterialOpSummary;
  quantity: number; // 0 for 'del'
}

const VALID_OPS: ReadonlySet<MaterialOpSummary> = new Set(['inc', 'dec', 'del']);

function coerceMaterialModSummary(
  raw: unknown,
  i: number,
  kind: string,
): MaterialModSummary {
  const m = raw as Record<string, unknown>;
  const code = asString(m.code, `materials[${i}].code`, kind);
  const op = m.op;
  if (typeof op !== 'string' || !VALID_OPS.has(op as MaterialOpSummary)) {
    throw new PlannerArgsError(
      `${kind}.args.materials[${i}].op must be one of inc|dec|del, got ${JSON.stringify(op)}`,
    );
  }
  const operation = op as MaterialOpSummary;
  let qty = 0;
  if (operation !== 'del') {
    qty = asInt(m.qty, `materials[${i}].qty`, kind);
    if (qty <= 0) {
      throw new PlannerArgsError(
        `${kind}.args.materials[${i}].qty must be positive for ${operation}, got ${qty}`,
      );
    }
  } else if (m.qty !== undefined && m.qty !== null && typeof m.qty === 'number' && Number.isFinite(m.qty)) {
    // del + qty is allowed (planner may include the qty-before-delete); ignore numerically.
    qty = 0;
  }
  return { material_code: code, operation, quantity: qty };
}

export function coerceStockPrecheckArgs(step: PlannedStep | undefined): MaterialModSummary[] {
  const args = requireArgs(step, 'stock_precheck');
  const materials = requireArray(args.materials, 'materials', 'stock_precheck');
  return materials.map((raw, i) => coerceMaterialModSummary(raw, i, 'stock_precheck'));
}

// Both email_2nd_release and email_to_branch_notifying_plant_change accept
// the same `{ materials: [...] }` summary shape — they only render bodies.
export function coerceEmailMaterialsArgs(
  step: PlannedStep | undefined,
  kind: 'email_2nd_release' | 'email_to_branch_notifying_plant_change',
): MaterialModSummary[] {
  const args = requireArgs(step, kind);
  const materials = requireArray(args.materials, 'materials', kind);
  return materials.map((raw, i) => coerceMaterialModSummary(raw, i, kind));
}

// ─── email_to_plant (vehicles) ──────────────────────────────────────────────

export interface VehicleSetCoerced {
  bundleNumber?: number;
  vehicleNumber: string;
  driverMobile: string;
  containerNumber: string;
}

export function coerceVehiclesArgs(step: PlannedStep | undefined): VehicleSetCoerced[] {
  const args = requireArgs(step, 'email_to_plant');
  const vehicles = requireArray(args.vehicles, 'vehicles', 'email_to_plant');
  return vehicles.map((raw, i) => {
    const v = raw as Record<string, unknown>;
    const vehicleNumber = asString(v.vehicleNumber, `vehicles[${i}].vehicleNumber`, 'email_to_plant');
    // driverMobile + containerNumber are required by the schema but often
    // arrive as empty strings (older replies omitted container). The
    // downstream Bundle columns accept empty / null, so we pass strings
    // through verbatim rather than throwing on empty.
    const driverMobile = typeof v.driverMobile === 'string' ? v.driverMobile.trim() : '';
    const containerNumber = typeof v.containerNumber === 'string' ? v.containerNumber.trim() : '';
    let bundleNumber: number | undefined;
    if (v.bundleNumber !== undefined && v.bundleNumber !== null) {
      if (typeof v.bundleNumber !== 'number' || !Number.isFinite(v.bundleNumber)) {
        throw new PlannerArgsError(
          `email_to_plant.args.vehicles[${i}].bundleNumber must be a finite number when present, got ${JSON.stringify(v.bundleNumber)}`,
        );
      }
      bundleNumber = Math.round(v.bundleNumber);
    }
    return { bundleNumber, vehicleNumber, driverMobile, containerNumber };
  });
}

// ─── process_tonnage_reply ──────────────────────────────────────────────────

/**
 * Returns tonnes (Decimal-compatible). kg→t conversion happens here so the
 * caller can write `weightage` directly. Preserves full precision.
 */
export function coerceTonnageArgs(step: PlannedStep | undefined): number {
  const args = requireArgs(step, 'process_tonnage_reply');
  const tonnage = args.tonnage;
  if (!tonnage || typeof tonnage !== 'object') {
    throw new PlannerArgsError('process_tonnage_reply.args.tonnage must be an object { value, unit }');
  }
  const t = tonnage as Record<string, unknown>;
  if (typeof t.value !== 'number' || !Number.isFinite(t.value) || t.value <= 0) {
    throw new PlannerArgsError(
      `process_tonnage_reply.args.tonnage.value must be a positive finite number, got ${JSON.stringify(t.value)}`,
    );
  }
  if (t.unit !== 't' && t.unit !== 'kg') {
    throw new PlannerArgsError(
      `process_tonnage_reply.args.tonnage.unit must be "t" or "kg", got ${JSON.stringify(t.unit)}`,
    );
  }
  return t.unit === 'kg' ? t.value / 1000 : t.value;
}
