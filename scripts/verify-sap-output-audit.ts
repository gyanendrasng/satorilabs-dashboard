/**
 * Verifies that step_completed events carrying a `sap_output` blob render
 * usefully in renderAuditTrailForSO. Seeds a synthetic SO + a sequence of
 * scenario_event rows, then prints the rendered timeline.
 *
 * Run against the test DB:
 *   DATABASE_URL="file:./test-scenarios.db" npx tsx scripts/verify-sap-output-audit.ts
 */
import { prisma } from '../src/lib/prisma';
import { renderAuditTrailForSO } from '../src/lib/audit-trail';

async function main(): Promise<void> {
  const stamp = Date.now();
  const customerId = `cust-sap-${stamp}`;
  const poId = `po-sap-${stamp}`;
  const soId = `so-sap-${stamp}`;

  await prisma.customer.upsert({
    where: { id: customerId },
    create: { id: customerId, name: 'SapOutputTest' },
    update: {},
  });
  await prisma.purchaseOrder.create({
    data: {
      id: poId,
      customerId,
      customerName: 'SapOutputTest',
      poNumber: `PO-${stamp}`,
      status: 'pending',
    },
  });
  await prisma.salesOrder.create({
    data: {
      id: soId,
      purchaseOrderId: poId,
      soNumber: `SO-${stamp}`,
      status: 'pending',
      requiresInput: false,
    },
  });

  const events = [
    {
      type: 'scenario_started',
      payload: { scenario_key: 'branch|before_ls|release_all|-' },
    },
    {
      type: 'step_fired',
      payload: { kind: 'zso_visibility' },
    },
    {
      type: 'step_completed',
      payload: {
        kind: 'zso_visibility',
        sap_output: {
          materials: [
            { material: 'M-A', ordered: 100, available: 100 },
            { material: 'M-B', ordered: 100, available: 80 },
          ],
        },
      },
    },
    {
      type: 'step_fired',
      payload: { kind: 'zload1' },
    },
    {
      type: 'step_completed',
      payload: {
        kind: 'zload1',
        sap_output: {
          ls_count: 2,
          loading_slips: [
            { ls: 'LS-12345', material: 'M-A', quantity: 100 },
            { ls: 'LS-12346', material: 'M-B', quantity: 80 },
          ],
        },
      },
    },
    {
      type: 'step_fired',
      payload: { kind: 'await_plant_invoice' },
    },
    {
      type: 'step_completed',
      payload: {
        kind: 'await_plant_invoice',
        sap_output: { invoice_number: 'HRJ-98765', obd_number: 'OBD-555', amount: '12500.00' },
      },
    },
  ];

  for (const e of events) {
    await prisma.scenarioEvent.create({
      data: {
        salesOrderId: soId,
        type: e.type,
        payload: JSON.stringify(e.payload),
      },
    });
  }

  const rendered = await renderAuditTrailForSO({ salesOrderId: soId });
  console.log('Rendered audit trail:\n');
  console.log(rendered);
  console.log('');

  // Assertions: each SAP summary should appear in the rendered output.
  const expected = [
    'M-A=100, M-B=80',                                      // zso_visibility
    'LS-12345:M-A=100, LS-12346:M-B=80',                    // zload1
    'invoice=HRJ-98765 obd=OBD-555 amount=12500.00',        // await_plant_invoice
  ];

  let fail = 0;
  for (const sub of expected) {
    if (rendered.includes(sub)) {
      console.log(`  ✓ contains: ${sub}`);
    } else {
      console.log(`  ✗ MISSING:  ${sub}`);
      fail++;
    }
  }

  // Cleanup
  await prisma.scenarioEvent.deleteMany({ where: { salesOrderId: soId } });
  await prisma.salesOrder.delete({ where: { id: soId } });
  await prisma.purchaseOrder.delete({ where: { id: poId } });
  await prisma.customer.delete({ where: { id: customerId } });

  if (fail > 0) {
    console.log(`\n${fail} expectation(s) failed.`);
    process.exit(1);
  }
  console.log('\n✓ All SAP-output summaries present in rendered audit.');
}

main().catch(async (e) => {
  console.error('FATAL:', e);
  await prisma.$disconnect();
  process.exit(1);
});
