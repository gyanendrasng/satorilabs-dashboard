#!/usr/bin/env node
/**
 * Test the Option A change: FCFS pool = inflow − our outflow.
 *
 * Scenario:
 *   - SO-A wait recorded at T=Monday, needs Y-RED=100
 *   - MB51 brings 110 boxes Y-RED today          → inflow 110
 *   - SO-X (separate) released 80 boxes Y-RED    → outflow 80
 *   - Pool = 110 − 80 = 30 < 100                 → SO-A NOT reactivated
 *
 * Without the outflow subtraction the pool would be 110 ≥ 100 → SO-A
 * triggers ZSO-VISIBILITY → wasted call (SAP only has 30 actual).
 *
 * Run:
 *   DATABASE_URL="file:./test-fcfs.db" npx prisma db push --schema prisma/schema.prisma --skip-generate
 *   DATABASE_URL="file:./test-fcfs.db" AUTO_GUI_HOST=localhost AUTO_GUI_PORT=8000 npx tsx scripts/test-fcfs-outflow.mjs
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const PREFIX = 'FCFS_TEST_';

async function reset() {
  await prisma.workQueue.deleteMany({});
  await prisma.materialShortage.deleteMany({});
  await prisma.materialReceipt.deleteMany({});
  await prisma.purchaseOrder.deleteMany({ where: { poNumber: { startsWith: PREFIX } } });
  await prisma.customer.deleteMany({ where: { id: { startsWith: PREFIX } } });
}

async function seed() {
  const monday = new Date(Date.now() - 4 * 24 * 3600 * 1000); // 4 days ago
  const tuesday = new Date(Date.now() - 3 * 24 * 3600 * 1000);
  const today = new Date();

  await prisma.customer.create({
    data: { id: PREFIX + 'CUST', name: 'Test', weightage: 45 },
  });
  // PO + waiting SO-A
  const poA = await prisma.purchaseOrder.create({
    data: { poNumber: PREFIX + 'PO-A', customerName: 'Test', customerId: PREFIX + 'CUST', stage: 3 },
  });
  const soA = await prisma.salesOrder.create({
    data: { soNumber: 'TEST-SO-A', purchaseOrderId: poA.id, status: 'pending', requiresInput: false, visibilityState: 'received' },
  });
  // Record SO-A's shortage on Monday
  await prisma.materialShortage.create({
    data: { salesOrderId: soA.id, material: 'Y-RED', shortQty: 100, recordedAt: monday },
  });

  // MB51 today: 110 of Y-RED
  await prisma.materialReceipt.create({
    data: {
      materialDocument: 'DOC-INFLOW-1',
      postingDate: today,
      entryDate: today,
      material: 'Y-RED',
      movementType: '101',
      quantity: 110,
      batch: 'B-INFLOW',
      baseUnit: 'BOX',
      plant: '7651',
    },
  });

  // PO + already-released SO-X consuming 80 boxes Y-RED, released TUESDAY
  // (i.e. AFTER Monday's shortage was recorded — should count as outflow).
  const poX = await prisma.purchaseOrder.create({
    data: { poNumber: PREFIX + 'PO-X', customerName: 'Test', customerId: PREFIX + 'CUST', stage: 4 },
  });
  const soX = await prisma.salesOrder.create({
    data: { soNumber: 'TEST-SO-X', purchaseOrderId: poX.id, status: 'pending', requiresInput: false, visibilityState: 'received' },
  });
  await prisma.material.create({
    data: {
      salesOrderId: soX.id,
      material: 'Y-RED',
      batch: 'B-OUTFLOW',
      orderQuantity: 80,
      availableStock: 80,
      dispatchQuantity: 80,
      releasedAt: tuesday,
    },
  });

  // Also seed an "old release" from BEFORE Monday — should NOT be counted.
  // Same SO-X, different material row.
  const veryOld = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  await prisma.material.create({
    data: {
      salesOrderId: soX.id,
      material: 'Y-RED',
      batch: 'B-OLDRELEASE',
      orderQuantity: 999,
      availableStock: 999,
      dispatchQuantity: 999,
      releasedAt: veryOld,
    },
  });

  return { soA };
}

async function main() {
  console.log('[test] reset + seed');
  await reset();
  const { soA } = await seed();

  const { reactivateCoveredShortages } = await import('../src/lib/shortage-reactivator.ts');
  const result = await reactivateCoveredShortages();

  console.log('\n[test] reactivator result:', JSON.stringify({
    reactivatedSos: result.reactivatedSos,
    considered: result.considered,
  }, null, 2));

  // Pool log line should reveal: inflow 110, outflow 80, pool 30.
  const poolLine = result.logs.find((l) => l.includes('Pool snapshot'));
  console.log('[test] pool log:', poolLine);

  // Assertions
  if (result.reactivatedSos.length !== 0) {
    throw new Error(`FAIL: expected NO reactivations (pool 30 < shortage 100), got ${result.reactivatedSos.join(', ')}`);
  }

  // SO-A's shortage should still be open
  const aShortage = await prisma.materialShortage.findFirst({
    where: { salesOrderId: soA.id, resolvedAt: null },
  });
  if (!aShortage) throw new Error('FAIL: SO-A shortage was incorrectly resolved');

  console.log('\n[test] ✅ Option A verified');
  console.log('  - inflow 110, outflow 80, pool 30');
  console.log('  - 30 < 100 → SO-A NOT reactivated (correct)');
  console.log('  - shortage still open');
  console.log('  - old release (>30d) excluded from outflow');
}

main()
  .catch((e) => {
    console.error('\n[test] ❌ FAILED:', e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
