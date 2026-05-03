/**
 * Pure-function test harness for the bundler's same-material grouping logic.
 *
 * Run:  npx tsx scripts/test-bundler.ts
 *
 * No prisma, no OpenAI — exercises packMaterialsIntoBundles directly.
 * Verifies: same-material rows always share a bundle (unless their combined
 * weight exceeds capacity, in which case they split with a warning).
 */
import { packMaterialsIntoBundles, type BundlerInput, type BundlerBin } from '../src/lib/bundler';

const RED = '\x1b[31m', GREEN = '\x1b[32m', YELLOW = '\x1b[33m', DIM = '\x1b[2m', RESET = '\x1b[0m';

const CAP = 31_000; // 31 t default

type Case = {
  name: string;
  items: BundlerInput[];
  cap: number;
  // Each assert returns null if pass, or an error message if fail.
  asserts: Array<(bins: BundlerBin[], warnings: string[]) => string | null>;
};

const sameBundle = (bins: BundlerBin[], ids: string[]) => {
  const bundleByItem = new Map<string, number>();
  for (const b of bins) for (const i of b.itemIds) bundleByItem.set(i, b.bundleNumber);
  const found = ids.map((i) => bundleByItem.get(i));
  if (found.some((x) => x === undefined)) return `missing item(s): ${ids.filter((i) => !bundleByItem.has(i)).join(', ')}`;
  const distinct = new Set(found);
  return distinct.size === 1 ? null : `expected ${ids.join(',')} in same bundle, got bundles ${[...distinct].join(',')}`;
};

const includesItem = (bins: BundlerBin[], id: string) =>
  bins.some((b) => b.itemIds.includes(id)) ? null : `item ${id} not bundled`;

const expectBundleCount = (bins: BundlerBin[], n: number) =>
  bins.length === n ? null : `expected ${n} bundle(s), got ${bins.length}`;

const expectWarningContains = (warnings: string[], substr: string) =>
  warnings.some((w) => w.includes(substr)) ? null : `expected warning containing "${substr}", got: ${JSON.stringify(warnings)}`;

const expectNoWarnings = (warnings: string[]) =>
  warnings.length === 0 ? null : `expected no warnings, got: ${JSON.stringify(warnings)}`;

const CASES: Case[] = [
  {
    name: 'two small different-code materials → fit in one bundle',
    cap: CAP,
    items: [
      { id: 'a', material: 'X', weightKg: 10_000 },
      { id: 'b', material: 'Y', weightKg: 5_000 },
    ],
    asserts: [
      (bins) => expectBundleCount(bins, 1),
      (bins) => sameBundle(bins, ['a', 'b']),
      (_, w) => expectNoWarnings(w),
    ],
  },
  {
    name: 'same material across multiple SOs → all rows share a bundle',
    cap: CAP,
    items: [
      { id: 'so1-X', material: 'X', weightKg: 8_000 },
      { id: 'so2-X', material: 'X', weightKg: 9_000 },
      { id: 'so3-X', material: 'X', weightKg: 7_000 },
      { id: 'so1-Y', material: 'Y', weightKg: 5_000 },
    ],
    asserts: [
      (bins) => sameBundle(bins, ['so1-X', 'so2-X', 'so3-X']),
      (_, w) => expectNoWarnings(w),
    ],
  },
  {
    name: 'same material total > capacity → split across N bundles + warning',
    cap: CAP,
    items: [
      { id: 'a', material: 'X', weightKg: 20_000 },
      { id: 'b', material: 'X', weightKg: 20_000 },
    ],
    asserts: [
      (bins) => expectBundleCount(bins, 2),
      (bins) => (bins.every((b) => b.itemIds.length === 1) ? null : `expected each bundle to have 1 item, got ${bins.map((b) => b.itemIds.length).join(',')}`),
      (_, w) => expectWarningContains(w, 'Material X totals'),
      (_, w) => expectWarningContains(w, 'splitting across 2 bundle(s)'),
    ],
  },
  {
    name: 'mixed sizes → packed efficiently, no avoidable extra bin',
    cap: CAP,
    items: [
      { id: 'big', material: 'A', weightKg: 25_000 },
      { id: 'mid', material: 'B', weightKg: 5_000 },
      { id: 'small', material: 'C', weightKg: 1_000 },
      { id: 'tiny', material: 'D', weightKg: 500 },
    ],
    asserts: [
      // 25 + 5 + 1 + 0.5 = 31.5 t > 31 t cap, so 2 bundles minimum.
      (bins) => expectBundleCount(bins, 2),
      (_, w) => expectNoWarnings(w),
    ],
  },
  {
    name: 'zero-weight row → still gets a bundleId',
    cap: CAP,
    items: [
      { id: 'z', material: 'X', weightKg: 0 },
      { id: 'a', material: 'Y', weightKg: 10_000 },
    ],
    asserts: [
      (bins) => includesItem(bins, 'z'),
      (bins) => includesItem(bins, 'a'),
      (_, w) => expectNoWarnings(w),
    ],
  },
  {
    name: 'single row > capacity → alone in own bundle + CRITICAL warning',
    cap: CAP,
    items: [
      { id: 'huge', material: 'X', weightKg: 40_000 },
      { id: 'small', material: 'Y', weightKg: 5_000 },
    ],
    asserts: [
      (bins) => expectBundleCount(bins, 2),
      (bins) => {
        const hugeBundle = bins.find((b) => b.itemIds.includes('huge'));
        return hugeBundle && hugeBundle.itemIds.length === 1 ? null : 'expected huge to be alone';
      },
      (_, w) => expectWarningContains(w, 'CRITICAL'),
    ],
  },
  {
    name: 'empty input → zero bundles',
    cap: CAP,
    items: [],
    asserts: [(bins) => expectBundleCount(bins, 0)],
  },
];

function runCase(c: Case): boolean {
  process.stdout.write(`\n${YELLOW}[${c.name}]${RESET}\n`);
  const warnings: string[] = [];
  let bins: BundlerBin[] = [];
  try {
    bins = packMaterialsIntoBundles(c.items, c.cap, (m) => warnings.push(m));
  } catch (err) {
    process.stdout.write(`  ${RED}threw: ${err instanceof Error ? err.message : String(err)}${RESET}\n`);
    return false;
  }

  process.stdout.write(`  ${DIM}bundles: ${bins.length}; ${bins.map((b) => `B${b.bundleNumber}=${(b.totalKg / 1000).toFixed(2)}t (${b.itemIds.length} items)`).join(', ')}${RESET}\n`);
  if (warnings.length) process.stdout.write(`  ${DIM}warnings:\n    - ${warnings.join('\n    - ')}${RESET}\n`);

  let ok = true;
  for (const a of c.asserts) {
    const err = a(bins, warnings);
    if (err) {
      ok = false;
      process.stdout.write(`  ${RED}✗ ${err}${RESET}\n`);
    }
  }
  if (ok) process.stdout.write(`  ${GREEN}✓ all asserts passed${RESET}\n`);
  return ok;
}

function main() {
  let passed = 0;
  for (const c of CASES) {
    if (runCase(c)) passed++;
  }
  const total = CASES.length;
  process.stdout.write(`\n${passed === total ? GREEN : RED}=== ${passed}/${total} cases passed ===${RESET}\n`);
  process.exit(passed === total ? 0 : 1);
}

main();
