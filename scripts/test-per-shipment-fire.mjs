#!/usr/bin/env node
/**
 * End-to-end test of the per-shipment VTO1N fire invariant.
 *
 * Seeds two Shipments under one SalesOrder (mirroring the multi-bundle PO
 * scenario), calls `triggerVto1n(shipment1.id)` directly — the same call
 * the new PATCH /backend/orders/shipments/[id] endpoint makes — and asserts
 * exactly one work_queue row was created, scoped to shipment 1, leaving
 * shipment 2 untouched.
 *
 * Run with an isolated test DB to avoid touching prisma/dev.db:
 *   DATABASE_URL="file:./test-per-shipment.db" node scripts/test-per-shipment-fire.mjs
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const TEST_PREFIX = 'PERSHIP_TEST_';

async function reset() {
  // Cascading deletes via PO; clean any prior test artifacts.
  await prisma.workQueue.deleteMany({});
  await prisma.purchaseOrder.deleteMany({ where: { poNumber: { startsWith: TEST_PREFIX } } });
  await prisma.customer.deleteMany({ where: { id: { startsWith: TEST_PREFIX } } });
}

async function seed() {
  const cust = await prisma.customer.create({
    data: { id: TEST_PREFIX + 'CUST', name: 'Test Customer', weightage: 45 },
  });
  const po = await prisma.purchaseOrder.create({
    data: {
      poNumber: TEST_PREFIX + 'PO',
      customerName: 'Test Customer',
      customerId: cust.id,
      stage: 5,
      status: 'in-progress',
    },
  });
  const so = await prisma.salesOrder.create({
    data: {
      soNumber: 'TEST-SO-1',
      purchaseOrderId: po.id,
      status: 'pending',
      requiresInput: false,
      visibilityState: 'received',
      lrNumber: null,
      lrDate: null,
      vehicleNumber: null,
    },
  });
  const b1 = await prisma.bundle.create({
    data: {
      purchaseOrderId: po.id,
      bundleNumber: 1,
      vehicleNumber: 'B1-VEHICLE',
      driverMobile: '1111111111',
    },
  });
  const b2 = await prisma.bundle.create({
    data: {
      purchaseOrderId: po.id,
      bundleNumber: 2,
      vehicleNumber: 'B2-VEHICLE',
      driverMobile: '2222222222',
    },
  });
  const s1 = await prisma.shipment.create({
    data: {
      bundleId: b1.id,
      salesOrderId: so.id,
      obdNumber: 'OBD-B1-001',
      invoiceNumber: 'INV-B1-001',
      status: 'created',
    },
  });
  const s2 = await prisma.shipment.create({
    data: {
      bundleId: b2.id,
      salesOrderId: so.id,
      obdNumber: 'OBD-B2-001',
      invoiceNumber: 'INV-B2-001',
      status: 'created',
    },
  });
  return { cust, po, so, b1, b2, s1, s2 };
}

async function fillShipmentDetailsForOne(shipmentId, lrNumber, lrDate) {
  // Mirror what /backend/orders/shipments/[id] PATCH does — minus the
  // auth/HTTP plumbing. Update Shipment LR fields, then call triggerVto1n
  // for ONLY that shipmentId.
  await prisma.shipment.update({
    where: { id: shipmentId },
    data: { lrNumber, lrDate },
  });
  // Import triggerVto1n via dynamic import so prisma client is initialized first.
  const { triggerVto1n } = await import('../src/lib/auto-gui-trigger.ts');
  await triggerVto1n(shipmentId);
}

async function main() {
  console.log('[test] reset + seed');
  await reset();
  const { so, s1, s2 } = await seed();

  // Sanity: pre-state
  const preWQ = await prisma.workQueue.count();
  console.log(`[test] pre work_queue rows: ${preWQ} (expect 0)`);
  if (preWQ !== 0) throw new Error('pre-condition: work_queue should be empty');

  // Action: fill ONLY shipment 1.
  console.log(`[test] filling form for shipment 1 (id=${s1.id}, OBD=${s1.obdNumber})`);
  await fillShipmentDetailsForOne(s1.id, 'LR-TEST-001', new Date('2026-05-06'));

  // Verify
  const wq = await prisma.workQueue.findMany({});
  console.log(`[test] post work_queue rows: ${wq.length}`);
  for (const row of wq) {
    const payload = JSON.parse(row.payload);
    console.log(`  - ${row.id}: step=${row.step}, state=${row.state}, shipment_id=${payload.meta?.shipment_id}, bundle_number=${payload.meta?.bundle_number}, obd=${payload.meta?.obd_number}`);
  }

  if (wq.length !== 1) {
    throw new Error(`FAIL: expected exactly 1 work_queue row, got ${wq.length}`);
  }
  const only = wq[0];
  if (only.step !== 'vto1n') throw new Error(`FAIL: expected step=vto1n, got ${only.step}`);
  const payload = JSON.parse(only.payload);
  if (payload.meta?.shipment_id !== s1.id) {
    throw new Error(`FAIL: expected shipment_id=${s1.id}, got ${payload.meta?.shipment_id}`);
  }

  // Verify shipment 2 untouched
  const s2Now = await prisma.shipment.findUnique({ where: { id: s2.id } });
  console.log(`[test] shipment 2 (untouched check): status=${s2Now.status}, lrNumber=${s2Now.lrNumber}, shipmentTriggeredAt=${s2Now.shipmentTriggeredAt}`);
  if (s2Now.status !== 'created') throw new Error(`FAIL: shipment 2 status changed to ${s2Now.status}`);
  if (s2Now.lrNumber !== null) throw new Error(`FAIL: shipment 2 lrNumber leaked: ${s2Now.lrNumber}`);
  if (s2Now.shipmentTriggeredAt !== null) throw new Error(`FAIL: shipment 2 shipmentTriggeredAt was set`);

  // Verify shipment 1 was flipped to shipment-triggered
  const s1Now = await prisma.shipment.findUnique({ where: { id: s1.id } });
  console.log(`[test] shipment 1 (target check): status=${s1Now.status}, lrNumber=${s1Now.lrNumber}, shipmentTriggeredAt=${s1Now.shipmentTriggeredAt ? 'set' : 'null'}`);
  if (s1Now.status !== 'shipment-triggered') throw new Error(`FAIL: shipment 1 not in shipment-triggered (got ${s1Now.status})`);
  if (s1Now.lrNumber !== 'LR-TEST-001') throw new Error(`FAIL: shipment 1 lrNumber not stored`);

  // Verify SO LR fields stayed null (no leak from per-shipment fill)
  const soNow = await prisma.salesOrder.findUnique({ where: { id: so.id } });
  console.log(`[test] SO LR check: lrNumber=${soNow.lrNumber}, vehicleNumber=${soNow.vehicleNumber}`);
  if (soNow.lrNumber !== null) throw new Error(`FAIL: SO.lrNumber was set to ${soNow.lrNumber} — should stay null`);

  console.log('\n[test] ✅ ALL ASSERTIONS PASS');
  console.log('  - exactly 1 vto1n work_queue row');
  console.log('  - target shipment 1: triggered, LR stored');
  console.log('  - other shipment 2: status=created, LR=null, untouched');
  console.log('  - SO.lrNumber: null (no SO-level leak)');
}

main()
  .catch((e) => {
    console.error('\n[test] ❌ FAILED:', e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
