/**
 * Integration test for deriveStage() — seeds a test SO into the configured
 * DB and walks it through each stage transition, asserting the returned
 * stage label at each milestone.
 *
 * Run with DATABASE_URL pointing to an isolated DB (e.g. test-scenarios.db)
 * because this script writes to and then wipes SalesOrder/PurchaseOrder rows.
 */
import { prisma } from '../src/lib/prisma';
import { deriveStage } from '../src/lib/dispatch-scenarios';

interface Expectation {
  label: string;
  expect: string;
  setup: (so: { id: string; poId: string }) => Promise<void>;
}

async function main(): Promise<void> {
  const stamp = Date.now();
  const customerId = `cust-stage-${stamp}`;
  const poId = `po-stage-${stamp}`;
  const soId = `so-stage-${stamp}`;

  // ─── Seed ─────────────────────────────────────────────────────────────
  await prisma.customer.upsert({
    where: { id: customerId },
    create: { id: customerId, name: 'StageDeriveTest' },
    update: {},
  });
  await prisma.purchaseOrder.create({
    data: {
      id: poId,
      customerId,
      customerName: 'StageDeriveTest',
      poNumber: `PO-${stamp}`,
      status: 'pending',
    },
  });
  const so = await prisma.salesOrder.create({
    data: {
      id: soId,
      purchaseOrderId: poId,
      soNumber: `SO-${stamp}`,
      status: 'pending',
      requiresInput: true,
    },
  });
  const bundle = await prisma.bundle.create({
    data: { purchaseOrderId: poId, bundleNumber: 1 },
  });

  const ctx = { id: so.id, poId, bundleId: bundle.id };

  // ─── Expectations cascade through the lifecycle ───────────────────────
  // Each `setup` mutates the DB to push the SO into the next stage; we
  // then assert the deriveStage label matches.
  const expectations: Expectation[] = [
    {
      label: 'fresh SO with no LS files',
      expect: 'before_ls',
      setup: async () => {},
    },
    {
      label: 'LoadingSlip with file exists, no vehicle yet',
      expect: 'after_ls_before_invoice',
      setup: async () => {
        const ls = await prisma.loadingSlip.create({
          data: {
            lsNumber: 'LS-stage-1',
            bundleId: ctx.bundleId,
            salesOrderId: ctx.id,
            plantEmail: 'test-plant@example.com',
            fileUrl: 'r2://test/ls.pdf',
          },
        });
        await prisma.loadingSlipItem.create({
          data: {
            salesOrderId: ctx.id,
            loadingSlipId: ls.id,
            lsNumber: 'LS-stage-1',
            material: 'M-A',
            orderQuantity: 100,
          },
        });
        await prisma.salesOrder.update({
          where: { id: ctx.id },
          data: { status: 'ls_created' },
        });
      },
    },
    {
      label: 'bundle has vehicleNumber set, plant_ls not sent',
      expect: 'after_vehicle_placement',
      setup: async () => {
        await prisma.bundle.update({
          where: { id: ctx.bundleId },
          data: { vehicleNumber: 'KA01-1234' },
        });
      },
    },
    {
      label: 'plant_ls email status=sent, no invoice yet',
      expect: 'after_email_to_plant',
      setup: async () => {
        await prisma.email.create({
          data: {
            salesOrderId: ctx.id,
            purchaseOrderId: ctx.poId,
            recipientEmail: 'plant@example.com',
            subject: 'LS forward',
            status: 'sent',
            emailType: 'plant_ls',
            gmailMessageId: `msg-${stamp}-1`,
            gmailThreadId: `thr-${stamp}-1`,
          },
        });
      },
    },
    {
      // A plant_ls reply alone is NOT proof of invoice arrival — it could be
      // a modification request. Stage stays at after_email_to_plant; only an
      // Invoice row (from ZLOAD3 processing-data callback) advances to
      // after_plant_invoice.
      label: 'plant_ls reply only — still after_email_to_plant',
      expect: 'after_email_to_plant',
      setup: async () => {
        await prisma.email.updateMany({
          where: { salesOrderId: ctx.id, emailType: 'plant_ls' },
          data: { replyHtml: '<p>plant modification proposal</p>', repliedAt: new Date() },
        });
      },
    },
    {
      label: 'Invoice row created (ZLOAD3 callback complete)',
      expect: 'after_plant_invoice',
      setup: async () => {
        await prisma.invoice.create({
          data: {
            salesOrderId: ctx.id,
            invoiceNumber: `INV-${stamp}`,
          },
        });
      },
    },
    {
      label: 'shipment in shipment-triggered state',
      expect: 'after_invoice',
      setup: async () => {
        await prisma.shipment.create({
          data: {
            bundleId: ctx.bundleId,
            salesOrderId: ctx.id,
            status: 'shipment-triggered',
            shipmentTriggeredAt: new Date(),
          },
        });
      },
    },
  ];

  let pass = 0;
  let fail = 0;
  for (const exp of expectations) {
    await exp.setup({ id: ctx.id, poId: ctx.poId });
    const actual = await deriveStage(ctx.id);
    if (actual === exp.expect) {
      console.log(`  ✓ ${exp.label.padEnd(55)} → ${actual}`);
      pass++;
    } else {
      console.log(`  ✗ ${exp.label}`);
      console.log(`    expected: ${exp.expect}`);
      console.log(`    actual:   ${actual}`);
      fail++;
    }
  }

  // ─── Cleanup ─────────────────────────────────────────────────────────
  await prisma.shipment.deleteMany({ where: { salesOrderId: ctx.id } });
  await prisma.invoice.deleteMany({ where: { salesOrderId: ctx.id } });
  await prisma.email.deleteMany({ where: { salesOrderId: ctx.id } });
  await prisma.loadingSlipItem.deleteMany({ where: { salesOrderId: ctx.id } });
  await prisma.bundle.deleteMany({ where: { purchaseOrderId: ctx.poId } });
  await prisma.salesOrder.delete({ where: { id: ctx.id } });
  await prisma.purchaseOrder.delete({ where: { id: ctx.poId } });
  await prisma.customer.delete({ where: { id: customerId } });

  console.log('');
  console.log(`Summary: ${pass} PASS, ${fail} FAIL`);
  if (fail > 0) process.exit(1);
}

main().catch(async (e) => {
  console.error('FATAL:', e);
  await prisma.$disconnect();
  process.exit(1);
});
