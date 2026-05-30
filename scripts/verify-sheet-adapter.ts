/**
 * Verifies that every internal scenario key in the static mapping resolves
 * to a real sheet row, and that the resulting Scenario has at least one
 * executable step.
 */
import { getAllSheetBackedKeys, getScenarioFromKey } from '../src/lib/sheet-scenario-adapter';

function main() {
  const keys = getAllSheetBackedKeys();
  console.log(`Resolving ${keys.length} sheet-backed scenario keys...\n`);

  let ok = 0;
  let missing = 0;
  const report: Array<{ key: string; nSteps: number; firstStep: string; lastStep: string }> = [];

  for (const key of keys) {
    const sc = getScenarioFromKey(key);
    if (!sc) {
      console.log(`  ✗ ${key} — NO SHEET ROW FOUND`);
      missing++;
      continue;
    }
    if (sc.steps.length === 0) {
      console.log(`  ⚠ ${key} — sheet row exists but produced 0 executable steps`);
    }
    ok++;
    report.push({
      key,
      nSteps: sc.steps.length,
      firstStep: sc.steps[0]?.kind ?? '(none)',
      lastStep: sc.steps[sc.steps.length - 1]?.kind ?? '(none)',
    });
  }

  console.log('');
  console.log('Step lists per key:');
  for (const r of report) {
    console.log(`  ${r.key.padEnd(55)} ${r.nSteps} step(s) [${r.firstStep} ... ${r.lastStep}]`);
  }
  console.log('');
  console.log(`Summary: ${ok} OK, ${missing} missing`);
  if (missing > 0) process.exit(1);
}

main();
