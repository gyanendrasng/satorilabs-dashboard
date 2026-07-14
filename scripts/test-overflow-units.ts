/**
 * Overflow figures shown to the branch are in UNITS (boxes), not kg. The
 * conversion is kg → units via kgPerUnit = orderWeightKg / orderQuantity.
 *
 *   npx tsx scripts/test-overflow-units.ts   (or: npm test)
 *
 * Exits 0/1.
 */

import { kgPerUnitOf, kgToUnits } from '../src/lib/units';

const RED = '\x1b[31m', GREEN = '\x1b[32m', RESET = '\x1b[0m';
let failed = false;
const pass = (m: string) => console.log(`${GREEN}✓ PASS${RESET} ${m}`);
const fail = (m: string) => { console.error(`${RED}✗ FAIL${RESET} ${m}`); failed = true; };
const check = (c: boolean, m: string) => (c ? pass(m) : fail(m));

// kgPerUnit = 1000 kg / 100 units = 10 kg/unit.
const kpu = kgPerUnitOf(1000, 100);
check(kpu === 10, 'kgPerUnitOf(1000,100) = 10');

// 3000 kg overflow at 10 kg/unit = 300 units.
check(kgToUnits(3000, kpu) === 300, '3000 kg → 300 units');
check(kgToUnits(475, kpu) === 48, '475 kg → 48 units (rounded)');

// Defensive: unknown kgPerUnit → 0 units (never NaN/Infinity).
check(kgToUnits(500, 0) === 0, 'kgToUnits with kgPerUnit 0 → 0');
check(kgPerUnitOf(0, 0) === 0, 'kgPerUnitOf(0,0) = 0');
check(kgPerUnitOf(null, 100) === 0, 'kgPerUnitOf(null,100) = 0');

process.exit(failed ? 1 : 0);
