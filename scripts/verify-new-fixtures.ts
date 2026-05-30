/**
 * Light-touch verification for the 5 new sheet rows added in this phase:
 *   - R4  branch|before_ls|new_so|-
 *   - R9  branch|anytime|status_update|-
 *   - R10 branch|after_ls_before_invoice|vehicle_details|-
 *   - R18 branch|before_ls|wait|-   (regression guard for the MB51 fix)
 *   - R44 plant|after_plant_invoice|invoice_sent|-
 *
 * For each: assert the sheet row resolves through the adapter and the
 * resulting step list either has the expected first step (release path) or
 * is empty for Anytime intents (handled by the special-case in handleReplyV2).
 *
 * This is a parsing/adapter check — NOT a full e2e drive (the harness in
 * scripts/test-scenarios-e2e.ts already validates engine execution; this
 * script only verifies the new rows are wired correctly).
 */
import { getScenarioFromKey } from '../src/lib/sheet-scenario-adapter';

interface Expectation {
  key: string;
  description: string;
  expectedFirstStep: string | null;       // null = empty step list (Anytime intents)
  expectedMinSteps: number;
}

const EXPECTATIONS: Expectation[] = [
  {
    key: 'branch|before_ls|new_so|-',
    description: 'R4 — NEW SO inbound (segment ends at ls_dispatch email)',
    expectedFirstStep: 'zso_visibility',
    expectedMinSteps: 2,
  },
  {
    key: 'branch|anytime|status_update|-',
    description: 'R9 — Seeking Order Update auto-reply (Anytime; handler not stepwise)',
    expectedFirstStep: null,
    expectedMinSteps: 0,
  },
  {
    key: 'branch|after_ls_before_invoice|vehicle_details|-',
    description: 'R10 — Sharing Vehicle Details (forward to plant)',
    expectedFirstStep: 'email_to_plant',
    expectedMinSteps: 1,
  },
  {
    key: 'branch|before_ls|wait|-',
    description: 'R18 — Hold/Wait (MB51 park; regression guard for wait fix)',
    expectedFirstStep: 'mb51',
    expectedMinSteps: 1,
  },
  {
    key: 'plant|after_plant_invoice|invoice_sent|-',
    description: 'R44 — Plant invoice arrival (internal-only: zload3+zso_auto → vt01n)',
    expectedFirstStep: 'await_plant_invoice',
    expectedMinSteps: 2,
  },
];

function main(): void {
  let pass = 0;
  let fail = 0;

  for (const exp of EXPECTATIONS) {
    const scenario = getScenarioFromKey(exp.key);
    const reasons: string[] = [];

    if (!scenario) {
      reasons.push('adapter returned null (KEY_TO_COORD miss or sheet row not found)');
    } else {
      const kinds = scenario.steps.map((s) => s.kind);
      if (kinds.length < exp.expectedMinSteps) {
        reasons.push(`expected ≥${exp.expectedMinSteps} step(s), got ${kinds.length}`);
      }
      if (exp.expectedFirstStep === null && kinds.length !== 0) {
        reasons.push(`expected empty step list (Anytime intent), got [${kinds.join(', ')}]`);
      } else if (exp.expectedFirstStep !== null && kinds[0] !== exp.expectedFirstStep) {
        reasons.push(`first step: expected ${exp.expectedFirstStep}, got ${kinds[0] ?? '(none)'}`);
      }
    }

    if (reasons.length === 0) {
      console.log(`  ✓ ${exp.key.padEnd(58)} ${exp.description}`);
      pass++;
    } else {
      console.log(`  ✗ ${exp.key}`);
      console.log(`    ${exp.description}`);
      for (const r of reasons) console.log(`    - ${r}`);
      fail++;
    }
  }

  console.log('');
  console.log(`Summary: ${pass} PASS, ${fail} FAIL`);
  if (fail > 0) process.exit(1);
}

main();
