/**
 * Side-by-side comparison: SCENARIOS registry steps vs sheet-derived steps
 * for the same key. Lets us see what fixtures will need updates before we
 * flip the engine to the sheet-driven path.
 */
import { SCENARIOS } from '../src/lib/dispatch-scenarios';
import { getScenarioFromKey, getAllSheetBackedKeys } from '../src/lib/sheet-scenario-adapter';

function main() {
  const keys = getAllSheetBackedKeys();
  console.log('Comparison: SCENARIOS registry  vs  sheet-derived\n');

  let same = 0;
  let diff = 0;
  const diffs: Array<{ key: string; oldSteps: string[]; newSteps: string[] }> = [];

  for (const key of keys) {
    const oldScenario = SCENARIOS[key];
    const newScenario = getScenarioFromKey(key);
    if (!oldScenario || !newScenario) {
      console.log(`  MISSING: ${key}`);
      continue;
    }
    const oldSteps = oldScenario.steps.map((s) => s.kind);
    const newSteps = newScenario.steps.map((s) => s.kind);
    const equal =
      oldSteps.length === newSteps.length &&
      oldSteps.every((s, i) => s === newSteps[i]);
    if (equal) {
      same++;
    } else {
      diff++;
      diffs.push({ key, oldSteps, newSteps });
    }
  }

  console.log(`Same step lists: ${same}/${keys.length}`);
  console.log(`Different:       ${diff}/${keys.length}\n`);

  for (const d of diffs) {
    console.log(`── ${d.key} ──`);
    console.log(`  OLD (${d.oldSteps.length}): ${d.oldSteps.join(' → ')}`);
    console.log(`  NEW (${d.newSteps.length}): ${d.newSteps.join(' → ')}`);
    console.log('');
  }
}

main();
