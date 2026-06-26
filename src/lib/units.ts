/**
 * Weight ↔ unit (box) conversion helpers.
 *
 * Internally the bundler/capacity math is in kilograms (orderWeightKg is the
 * full-order weight on basis orderQuantity, so kgPerUnit = orderWeightKg /
 * orderQuantity). The BRANCH, however, thinks in units (boxes), not weight — so
 * every branch-facing overflow/placed figure is converted to units for display
 * via these helpers. Keep internal math + the planner audit trail in kg.
 */

/** Per-unit weight (kg) for a material, from its full-order weight + quantity. */
export function kgPerUnitOf(
  orderWeightKg: number | null | undefined,
  orderQuantity: number | null | undefined,
): number {
  const w = orderWeightKg ? Number(orderWeightKg) : 0;
  const oq = orderQuantity ?? 0;
  return oq > 0 && w > 0 ? w / oq : 0;
}

/** Convert a kg figure to whole units (boxes). Returns 0 when kgPerUnit is unknown. */
export function kgToUnits(kg: number, kgPerUnit: number): number {
  if (!(kgPerUnit > 0)) return 0;
  return Math.round(kg / kgPerUnit);
}
