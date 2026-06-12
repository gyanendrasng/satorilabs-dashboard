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
  orderQuantity: number; // Int
}

export function coerceVa02Args(step: PlannedStep | undefined): Va02Item[] {
  const args = requireArgs(step, 'va02');
  const materials = requireArray(args.materials, 'materials', 'va02');
  return materials.map((raw, i) => {
    const m = raw as Record<string, unknown>;
    const code = asString(m.code, `materials[${i}].code`, 'va02');
    const qty = asInt(m.qty, `materials[${i}].qty`, 'va02');
    if (qty <= 0) {
      throw new PlannerArgsError(`va02.args.materials[${i}].qty must be positive, got ${qty}`);
    }
    return { material: code, orderQuantity: qty };
  });
}

// ─── zload1 (append mode) ──────────────────────────────────────────────────

export interface Zload1AppendArgs {
  appendToBundleId: string;
  materials: Array<{ code: string; batch?: string; qty: number }>;
}

/**
 * Returns the append-mode args when the planner supplied them, otherwise null
 * (initial mode — no args, fan-out from computed bundles). Throws if the
 * planner emitted a partial / malformed append payload.
 */
export function coerceZload1AppendArgs(step: PlannedStep | undefined): Zload1AppendArgs | null {
  const raw = step?.args;
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.appendToBundleId === undefined && r.materials === undefined) return null;

  const appendToBundleId = asString(r.appendToBundleId, 'appendToBundleId', 'zload1');
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
  return { appendToBundleId, materials };
}

// ─── bundle_capacity_assessment ────────────────────────────────────────────

export interface BundleCapacityAssessmentItem {
  material: string;
  /** Additional weight in kilograms this material is being asked to add. */
  deltaKg: number;
}

export function coerceBundleCapacityArgs(step: PlannedStep | undefined): BundleCapacityAssessmentItem[] {
  const args = requireArgs(step, 'bundle_capacity_assessment');
  const items = requireArray(args.items, 'items', 'bundle_capacity_assessment');
  return items.map((raw, i) => {
    const it = raw as Record<string, unknown>;
    const material = asString(it.material, `items[${i}].material`, 'bundle_capacity_assessment');
    if (typeof it.deltaKg !== 'number' || !Number.isFinite(it.deltaKg) || it.deltaKg <= 0) {
      throw new PlannerArgsError(
        `bundle_capacity_assessment.args.items[${i}].deltaKg must be a positive finite number, got ${JSON.stringify(it.deltaKg)}`,
      );
    }
    return { material, deltaKg: it.deltaKg };
  });
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

// ─── lone_zmatana ──────────────────────────────────────────────────────────

/**
 * Returns the list of material codes the planner wants ZMatana run for. The
 * planner emits `{ materials: [{ code }, ...] }`; we project to a flat string
 * array since the trigger function only needs codes.
 */
export function coerceLoneZmatanaArgs(step: PlannedStep | undefined): string[] {
  const args = requireArgs(step, 'lone_zmatana');
  const materials = requireArray(args.materials, 'materials', 'lone_zmatana');
  return materials.map((raw, i) => {
    const m = raw as Record<string, unknown>;
    return asString(m.code, `materials[${i}].code`, 'lone_zmatana');
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

export function coerceZloadingCloseArgs(step: PlannedStep | undefined): ZloadingCloseDeletion[] {
  const args = requireArgs(step, 'zloading_close');
  const deletes = requireArray(args.deletes, 'deletes', 'zloading_close');
  return deletes.map((raw, i) => {
    const d = raw as Record<string, unknown>;
    const material = asString(d.material, `deletes[${i}].material`, 'zloading_close');
    return {
      lsNumber: asOptionalString(d.lsNumber),
      material,
      batch: asOptionalString(d.batch),
    };
  });
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
