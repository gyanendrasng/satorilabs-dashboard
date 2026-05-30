import XLSX from 'xlsx';

const wb = XLSX.readFile('/Users/apple/Documents/personal/satorilabs-dashboard/Intent Classification.xlsx');
const ws = wb.Sheets['Sheet3'];
if (!ws) {
  console.error('Sheet3 not found. Available:', wb.SheetNames);
  process.exit(1);
}
const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

const superHeaders = rows[0];
const stepNumbers = rows[1];
const stepNames = rows[2];

const groupByCol = [];
{
  let last = '';
  for (let c = 0; c < superHeaders.length; c++) {
    if (superHeaders[c] && String(superHeaders[c]).trim() !== '') last = String(superHeaders[c]).trim();
    groupByCol[c] = last;
  }
}

const META_COLS = 4;

console.log('═══════════════════════════════════════════════════════════════');
console.log('SCENARIOS (rows 4+) → enabled steps');
console.log('═══════════════════════════════════════════════════════════════\n');

let scenarioCount = 0;
let emptyScenarioCount = 0;

for (let r = 3; r < rows.length; r++) {
  const row = rows[r];
  if (!row || row.length === 0) continue;
  const emailType = String(row[0] || '').trim();
  const stage = String(row[1] || '').trim();
  const primaryIntent = String(row[2] || '').trim();
  const augmented = String(row[3] || '').trim();

  if (!emailType && !stage && !primaryIntent && !augmented) continue;

  const enabledSteps = [];
  for (let c = META_COLS; c < row.length; c++) {
    const v = row[c];
    if (String(v).trim() === '1') {
      const stepName = String(stepNames[c] || '').trim() || '(unnamed)';
      const group = groupByCol[c] || '';
      enabledSteps.push({
        col: c,
        stepNum: stepNumbers[c],
        name: stepName,
        group,
      });
    }
  }

  if (enabledSteps.length === 0) {
    emptyScenarioCount++;
    console.log(`\n── R${String(r + 1).padStart(2, '0')}  ${emailType} | ${stage} | ${primaryIntent}`);
    console.log(`     (NO STEPS — receive-only intent)`);
    continue;
  }

  scenarioCount++;
  console.log(`\n── R${String(r + 1).padStart(2, '0')}  ${emailType} | ${stage} | ${primaryIntent}`);
  console.log(`     Steps (${enabledSteps.length}):`);
  let currentGroup = '';
  for (const s of enabledSteps) {
    if (s.group !== currentGroup) {
      console.log(`       [group: ${s.group}]`);
      currentGroup = s.group;
    }
    console.log(`       ${String(s.stepNum).padEnd(8)} ${s.name}`);
  }
}

console.log('\n═══════════════════════════════════════════════════════════════');
console.log(`Total scenarios with steps:    ${scenarioCount}`);
console.log(`Receive-only (no-op) scenarios: ${emptyScenarioCount}`);
console.log('═══════════════════════════════════════════════════════════════');
