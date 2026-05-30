import XLSX from 'xlsx';
const wb = XLSX.readFile('/Users/apple/Documents/personal/satorilabs-dashboard/Intent_Classification.xlsx');
const ws = wb.Sheets['Sheet3'];
const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
for (let r = 18; r < 24; r++) {
  const row = rows[r];
  console.log(`R${r+1}: stage="${row[1]}" intent="${row[2]}"`);
  console.log(`     aug="${row[3]}"`);
}
