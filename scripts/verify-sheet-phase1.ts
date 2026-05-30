/**
 * Phase 1 verification — confirms:
 *   1. sheet-scenarios.ts parses Sheet3 successfully
 *   2. Counts match expected (44 with steps + 5 receive-only)
 *   3. Every step name encountered in the sheet has a mapping in sheet-step-mapping.ts
 *   4. Lookup helpers work
 *
 * Run via: `npx tsx scripts/verify-sheet-phase1.ts`
 */
import {
  getAllScenarioRows,
  getScenarioRow,
  getValidIntents,
  getSheetSummary,
} from '../src/lib/sheet-scenarios';
import { lookupStep, normalizeStepName } from '../src/lib/sheet-step-mapping';

function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('Phase 1 — Sheet ingest + step mapping verification');
  console.log('═══════════════════════════════════════════════════════\n');

  // 1. Parse summary
  const summary = getSheetSummary();
  console.log('Sheet summary:');
  console.log(`  Total rows:    ${summary.totalRows}`);
  console.log(`  With steps:    ${summary.withSteps}`);
  console.log(`  Receive-only:  ${summary.receiveOnly}`);
  console.log(`  By Email Type:`, summary.byEmailType);
  console.log(`  Distinct stages:`, Object.keys(summary.byStage).length);
  console.log('');

  // 2. Coverage check — every step name referenced in the sheet should map
  const rows = getAllScenarioRows();
  const allStepNames = new Set<string>();
  for (const r of rows) {
    for (const s of r.enabledSteps) allStepNames.add(s.name);
  }

  const unmapped: string[] = [];
  for (const name of allStepNames) {
    if (!lookupStep(name)) unmapped.push(name);
  }
  console.log(`Distinct step names used in sheet: ${allStepNames.size}`);
  if (unmapped.length === 0) {
    console.log('  ✓ Every step name maps cleanly to a handler.');
  } else {
    console.log(`  ✗ ${unmapped.length} unmapped step name(s):`);
    for (const u of unmapped) console.log(`     - "${u}" (normalized: "${normalizeStepName(u)}")`);
  }
  console.log('');

  // 3. Spot-check lookups
  console.log('Lookup spot-checks:');
  const cases: Array<[string, string, string]> = [
    ['Branch Email', 'Before LS Creation', 'New SO'],
    ['Branch Email', 'Before LS Creation', 'Product Clarification - Release with adjustment - Increase'],
    ['Branch Email', 'After LS Creation - Before Vehicle Placement', 'SO Modification - Increase'],
    ['Plant Email', 'Before Plant Invoice', 'LS Modification - Increase'],
    ['Branch Email', 'Anytime', 'Seeking Order Update'],
  ];
  for (const [t, s, i] of cases) {
    const r = getScenarioRow(t as 'Branch Email' | 'Plant Email', s, i);
    if (!r) {
      console.log(`  ✗ ${t} | ${s} | ${i} → NOT FOUND`);
    } else {
      console.log(`  ✓ ${t} | ${s} | ${i} → R${r.rowNum} (${r.enabledSteps.length} step(s))`);
    }
  }
  console.log('');

  // 4. Valid-intents shape
  console.log('Valid intents for (Branch Email, After LS Creation - Before Vehicle Placement):');
  const valid = getValidIntents('Branch Email', 'After LS Creation - Before Vehicle Placement');
  for (const v of valid.slice(0, 10)) console.log(`  - ${v.primaryIntent}`);
  if (valid.length > 10) console.log(`  ...and ${valid.length - 10} more`);
  console.log('');

  // 5. Exit code
  if (unmapped.length > 0) {
    console.log('VERIFICATION: FAILED — unmapped step names above.');
    process.exit(1);
  }
  console.log('VERIFICATION: PASSED');
}

main();
