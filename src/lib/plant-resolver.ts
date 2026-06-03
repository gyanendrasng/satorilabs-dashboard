/**
 * Plant resolution — material code → plant email.
 *
 * Domain rule: every SAP material code starts with a 3-character plant code
 * (e.g. material "YT2LEBL000000D5P" → plant "YT2"). Every loading slip is
 * produced by exactly ONE plant, so all material codes on a given LS share
 * the same prefix. We resolve the email by looking up that prefix in the
 * `plant` table (Plant.id IS the SAP plant code, by design).
 *
 * Fallback: if the Plant row is missing (new plant code not yet seeded),
 * log a warning and use PLANT_EMAIL env so dispatch isn't blocked. The
 * operator can add the row later — subsequent LSs from that plant will
 * resolve correctly.
 */
import { prisma } from './prisma';

const PLANT_EMAIL_FALLBACK = process.env.PLANT_EMAIL || '';

export function plantCodeFromMaterial(material: string): string | null {
  if (!material || material.length < 3) return null;
  return material.slice(0, 3).toUpperCase();
}

/**
 * Resolve the plant email for a single material code via its 3-char prefix.
 * Returns the env fallback (and logs a warning) when the Plant row is
 * missing. Never throws — dispatch should not block on a missing seed.
 */
export async function resolvePlantEmailForMaterial(material: string): Promise<string> {
  const code = plantCodeFromMaterial(material);
  if (!code) {
    console.warn(`[PlantResolver] Material "${material}" has no 3-char prefix — using env fallback`);
    return PLANT_EMAIL_FALLBACK;
  }
  const plant = await prisma.plant.findUnique({
    where: { id: code },
    select: { email: true },
  });
  if (!plant) {
    console.warn(
      `[PlantResolver] No Plant row for code "${code}" (material "${material}") — using env fallback "${PLANT_EMAIL_FALLBACK}"`
    );
    return PLANT_EMAIL_FALLBACK;
  }
  return plant.email;
}

/**
 * Resolve the plant email for a whole loading slip. Reads every material on
 * the LS, derives the plant code from each, and asserts they all agree
 * (the "one LS, one plant" invariant). If they disagree, logs loudly and
 * falls back to env — the data is inconsistent and a human needs to look.
 */
export async function resolvePlantEmailForLoadingSlip(
  materials: ReadonlyArray<string>,
  lsNumber: string,
): Promise<string> {
  if (materials.length === 0) {
    console.warn(`[PlantResolver] LS ${lsNumber} has no materials — using env fallback`);
    return PLANT_EMAIL_FALLBACK;
  }
  const codes = new Set<string>();
  for (const m of materials) {
    const c = plantCodeFromMaterial(m);
    if (c) codes.add(c);
  }
  if (codes.size === 0) {
    console.warn(`[PlantResolver] LS ${lsNumber} — no material yielded a valid plant code; env fallback`);
    return PLANT_EMAIL_FALLBACK;
  }
  if (codes.size > 1) {
    console.warn(
      `[PlantResolver] LS ${lsNumber} mixes plant codes [${[...codes].join(', ')}] — violates "one LS, one plant" invariant. Using env fallback.`
    );
    return PLANT_EMAIL_FALLBACK;
  }
  const [code] = [...codes];
  const plant = await prisma.plant.findUnique({
    where: { id: code },
    select: { email: true },
  });
  if (!plant) {
    console.warn(
      `[PlantResolver] LS ${lsNumber} — no Plant row for code "${code}"; using env fallback "${PLANT_EMAIL_FALLBACK}"`
    );
    return PLANT_EMAIL_FALLBACK;
  }
  return plant.email;
}
