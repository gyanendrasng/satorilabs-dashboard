/**
 * Confirms getValidScenarioKeys() exposes every sheet-backed key for the
 * correct (sender, stage) tuple. The classifier uses this list as the LLM's
 * output vocabulary, so a missing key here means the LLM can't pick that
 * scenario.
 */
import { getValidScenarioKeys, type Stage } from '../src/lib/dispatch-scenarios';
import { getAllSheetBackedKeys } from '../src/lib/sheet-scenario-adapter';

const ALL_STAGES: Stage[] = [
  'before_ls',
  'after_ls_before_invoice',
  'after_vehicle_placement',
  'after_email_to_plant',
  'after_plant_invoice',
  'after_invoice',
];

function main(): void {
  const sheetKeys = new Set(getAllSheetBackedKeys());

  // Build a map: sheetKey → expected (sender, stage[]) it should appear in.
  // The classifier passes one specific (sender, stage) — but Anytime keys
  // must appear in EVERY (sender, stage) tuple for that sender.
  const missing: Array<{ sender: string; stage: string; key: string }> = [];
  const reached = new Set<string>();

  for (const sender of ['branch', 'plant'] as const) {
    for (const stage of ALL_STAGES) {
      const keys = getValidScenarioKeys(sender, stage);
      for (const k of keys) reached.add(k.key);

      // For each sheet-backed key whose prefix matches this (sender, stage),
      // it MUST appear in the returned list.
      const prefix = `${sender}|${stage}|`;
      for (const sheetKey of sheetKeys) {
        if (sheetKey.startsWith(prefix) && !keys.find((k) => k.key === sheetKey)) {
          missing.push({ sender, stage, key: sheetKey });
        }
      }
      // Every Anytime key for this sender must appear regardless of stage.
      const anytimePrefix = `${sender}|anytime|`;
      for (const sheetKey of sheetKeys) {
        if (sheetKey.startsWith(anytimePrefix) && !keys.find((k) => k.key === sheetKey)) {
          missing.push({ sender, stage, key: sheetKey });
        }
      }
    }
  }

  // Coverage check: every sheet-backed key should be reachable through at
  // least one (sender, stage) tuple.
  const unreached = Array.from(sheetKeys).filter((k) => !reached.has(k));

  console.log(`Sheet-backed keys total:    ${sheetKeys.size}`);
  console.log(`Reached via some tuple:     ${sheetKeys.size - unreached.length}`);
  console.log(`Never reached:              ${unreached.length}`);
  console.log(`Per-tuple omissions found:  ${missing.length}`);

  if (unreached.length > 0) {
    console.log('\nKeys never reached:');
    for (const k of unreached) console.log(`  - ${k}`);
  }
  if (missing.length > 0) {
    console.log('\nPer-(sender,stage) omissions:');
    for (const m of missing.slice(0, 20)) {
      console.log(`  - (${m.sender}, ${m.stage}) missing ${m.key}`);
    }
    if (missing.length > 20) console.log(`  ...and ${missing.length - 20} more`);
  }

  // Show what a sample stage exposes — sanity check on shape.
  console.log('\nSample: getValidScenarioKeys("branch", "after_vehicle_placement"):');
  for (const k of getValidScenarioKeys('branch', 'after_vehicle_placement')) {
    console.log(`  ${k.key}  (${k.stepKinds.length} steps)`);
  }

  if (unreached.length > 0 || missing.length > 0) process.exit(1);
  console.log('\n✓ All sheet-backed keys reachable through validKeys.');
}

main();
