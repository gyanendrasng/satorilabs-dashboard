#!/usr/bin/env node
/**
 * Seed a controllable scenario for FCFS reactivation testing.
 *
 * Creates:
 *   - Customer "TEST-CUST"
 *   - 2 Purchase Orders, each with 1 Sales Order (SO-A, SO-B)
 *   - Materials with availableStock < orderQuantity for both
 *   - MaterialShortage rows: SO-A recorded 2h ago, SO-B recorded 1h ago
 *     (so SO-A wins FCFS if both can be served)
 *
 * Layout (designed to test FCFS fairness):
 *   SO-A short:  Y-RED → 100 boxes
 *   SO-B short:  Y-RED →  60 boxes
 *
 *   If MaterialReceipt has Y-RED total = 120  → only SO-A can be served
 *   If MaterialReceipt has Y-RED total = 200  → SO-A served (100), then SO-B served (60), pool=40 left
 *   If MaterialReceipt has Y-RED total =  50  → neither served
 *
 * Run:
 *   node scripts/seed-mb51-test.mjs
 *
 * To wipe and re-seed:
 *   node scripts/seed-mb51-test.mjs --reset
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function reset() {
  // Order matters: shortages and materials cascade off SO; SO cascades off PO.
  await prisma.materialShortage.deleteMany({ where: { salesOrder: { soNumber: { startsWith: 'TEST-SO-' } } } });
  await prisma.material.deleteMany({ where: { salesOrder: { soNumber: { startsWith: 'TEST-SO-' } } } });
  await prisma.salesOrder.deleteMany({ where: { soNumber: { startsWith: 'TEST-SO-' } } });
  await prisma.purchaseOrder.deleteMany({ where: { poNumber: { startsWith: 'TEST-PO-' } } });
  await prisma.customer.deleteMany({ where: { id: 'TEST-CUST' } });
  await prisma.materialReceipt.deleteMany({ where: { material: { startsWith: 'Y-' } } });
  console.log('[seed] reset done');
}

async function main() {
  if (process.argv.includes('--reset')) {
    await reset();
    return;
  }

  await reset();

  await prisma.customer.create({
    data: { id: 'TEST-CUST', name: 'Test Customer', weightage: 31 },
  });

  const now = Date.now();
  const twoHoursAgo = new Date(now - 2 * 3600 * 1000);
  const oneHourAgo = new Date(now - 1 * 3600 * 1000);

  // SO-A — recorded earlier (FCFS winner)
  const poA = await prisma.purchaseOrder.create({
    data: {
      poNumber: 'TEST-PO-A',
      customerName: 'Test Customer',
      customerId: 'TEST-CUST',
      stage: 1,
    },
  });
  const soA = await prisma.salesOrder.create({
    data: {
      soNumber: 'TEST-SO-A',
      purchaseOrderId: poA.id,
      visibilityState: 'received',
      status: 'pending',
      requiresInput: false,
    },
  });
  await prisma.material.create({
    data: {
      salesOrderId: soA.id,
      material: 'Y-RED',
      materialDescription: 'TEST RED',
      batch: 'B1',
      orderQuantity: 200,
      availableStock: 100, // short by 100
      orderWeightKg: 1000,
    },
  });
  await prisma.materialShortage.create({
    data: {
      salesOrderId: soA.id,
      material: 'Y-RED',
      shortQty: 100,
      recordedAt: twoHoursAgo,
    },
  });

  // SO-B — recorded later (loses FCFS when stock is tight)
  const poB = await prisma.purchaseOrder.create({
    data: {
      poNumber: 'TEST-PO-B',
      customerName: 'Test Customer',
      customerId: 'TEST-CUST',
      stage: 1,
    },
  });
  const soB = await prisma.salesOrder.create({
    data: {
      soNumber: 'TEST-SO-B',
      purchaseOrderId: poB.id,
      visibilityState: 'received',
      status: 'pending',
      requiresInput: false,
    },
  });
  await prisma.material.create({
    data: {
      salesOrderId: soB.id,
      material: 'Y-RED',
      materialDescription: 'TEST RED',
      batch: 'B2',
      orderQuantity: 100,
      availableStock: 40, // short by 60
      orderWeightKg: 500,
    },
  });
  await prisma.materialShortage.create({
    data: {
      salesOrderId: soB.id,
      material: 'Y-RED',
      shortQty: 60,
      recordedAt: oneHourAgo,
    },
  });

  console.log('[seed] created:');
  console.log('  TEST-PO-A → TEST-SO-A short Y-RED=100 (recorded 2h ago)');
  console.log('  TEST-PO-B → TEST-SO-B short Y-RED= 60 (recorded 1h ago)');
  console.log('\nNext: run a sample upload to feed receipts and watch FCFS run.');
  console.log('  node scripts/sample-mb51-upload.mjs 120     # only SO-A wins');
  console.log('  node scripts/sample-mb51-upload.mjs 200     # both SOs win');
  console.log('  node scripts/sample-mb51-upload.mjs 50      # neither wins');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
