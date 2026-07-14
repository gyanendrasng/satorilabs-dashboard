/**
 * Focused unit test for the engine-side guard on `zloading_close (all)`.
 *
 * The full planner-tests harness uses the real LLM and cannot reliably force
 * the planner to emit a specific malformed step. This script seeds a minimal
 * DB state — one SalesOrder with one LoadingSlip in `status='sent_to_plant'`
 * — then directly invokes the engine with a forged ScenarioProgress whose
 * generatedSteps array contains `zloading_close { all: true }`. It asserts:
 *
 *   1. The scenario reaches state='failed'.
 *   2. The error message mentions 'post-intimation' / 'sent_to_plant'.
 *   3. ZERO WorkQueue rows for triggerZloadingClose are created.
 *
 * Usage:
 *   DATABASE_URL="file:./dev.db" npx tsx scripts/test-zloading-close-guard.ts
 *
 * The script does NOT reset the schema — point DATABASE_URL at any
 * schema-prepared SQLite file (e.g. the dev or a pre-pushed test db).
 * Records created by the test are removed at the end (pass or fail).
 */

async function main(): Promise<void> {
  process.env.DATABASE_URL = process.env.DATABASE_URL || 'file:./dev.db';
  console.log(`[guard-test] Using DATABASE_URL=${process.env.DATABASE_URL}`);

  const { prisma } = await import('../src/lib/prisma');
  const { executeScenario } = await import('../src/lib/scenario-engine');

  // Seed minimal entities with deterministic ids so cleanup is targeted.
  const CUST_ID = 'cust-guard-test';
  const PO_NUM = 'PO-GUARD-1';
  const SO_NUM = '9999991';

  // Clean any leftovers from a prior aborted run.
  await prisma.workQueue.deleteMany({ where: { salesOrder: { soNumber: SO_NUM } } });
  await prisma.scenarioProgress.deleteMany({ where: { salesOrder: { soNumber: SO_NUM } } });
  await prisma.loadingSlipItem.deleteMany({ where: { salesOrder: { soNumber: SO_NUM } } });
  await prisma.loadingSlip.deleteMany({ where: { salesOrder: { soNumber: SO_NUM } } });
  await prisma.salesOrder.deleteMany({ where: { soNumber: SO_NUM } });
  await prisma.bundle.deleteMany({ where: { purchaseOrder: { poNumber: PO_NUM } } });
  await prisma.purchaseOrder.deleteMany({ where: { poNumber: PO_NUM } });
  await prisma.customer.deleteMany({ where: { id: CUST_ID } });

  const customer = await prisma.customer.create({
    data: { id: CUST_ID, name: 'Guard Test' },
  });
  const po = await prisma.purchaseOrder.create({
    data: {
      poNumber: PO_NUM,
      customerId: customer.id,
      customerName: 'Guard Test',
      weightage: 35,
    },
  });
  const so = await prisma.salesOrder.create({
    data: {
      soNumber: SO_NUM,
      purchaseOrderId: po.id,
      status: 'in_progress',
    },
  });
  const bundle = await prisma.bundle.create({
    data: {
      purchaseOrderId: po.id,
      bundleNumber: 1,
      totalWeightKg: 1000,
    },
  });
  const ls = await prisma.loadingSlip.create({
    data: {
      lsNumber: 'LS-GUARD-1',
      bundleId: bundle.id,
      salesOrderId: so.id,
      plantEmail: 'plant-test@example.com',
      status: 'sent_to_plant',
    },
  });
  await prisma.loadingSlipItem.create({
    data: {
      lsNumber: ls.lsNumber,
      loadingSlipId: ls.id,
      salesOrderId: so.id,
      material: 'M-A',
      batch: 'B1',
      orderQuantity: 10,
    },
  });

  // Forge a scenario_progress with a zloading_close (all) step.
  const progress = await prisma.scenarioProgress.create({
    data: {
      salesOrderId: so.id,
      scenarioKey: 'llm-planned',
      classifierOutput: JSON.stringify({ source: 'guard-test' }),
      generatedSteps: JSON.stringify([
        { kind: 'zloading_close', rationale: 'forged for guard test', args: { all: true } },
      ]),
      currentStepIndex: 0,
      stopAfterIndex: 0,
      state: 'firing',
    },
  });

  // Capture pre-call workQueue count.
  const preCount = await prisma.workQueue.count({ where: { salesOrderId: so.id } });

  // Invoke the engine.
  console.log('[guard-test] invoking executeScenario…');
  try {
    await executeScenario({ salesOrderId: so.id });
  } catch (err) {
    console.log(`[guard-test] executeScenario threw: ${err instanceof Error ? err.message : err}`);
  }

  // Assertions.
  const failures: string[] = [];
  const after = await prisma.scenarioProgress.findUnique({ where: { id: progress.id } });
  if (after?.state !== 'failed') {
    failures.push(`expected state='failed', got '${after?.state ?? '(missing)'}'`);
  }
  if (!after?.error || !/post-intimation|sent_to_plant/i.test(after.error)) {
    failures.push(
      `expected error message to mention 'post-intimation' or 'sent_to_plant', got: ${after?.error ?? '(none)'}`,
    );
  }
  const postCount = await prisma.workQueue.count({ where: { salesOrderId: so.id } });
  if (postCount > preCount) {
    failures.push(
      `expected ZERO new WorkQueue rows after the refused step, got ${postCount - preCount} new row(s)`,
    );
  }

  // Cleanup before reporting (so re-runs don't accumulate).
  await prisma.workQueue.deleteMany({ where: { salesOrderId: so.id } });
  await prisma.scenarioProgress.deleteMany({ where: { salesOrderId: so.id } });
  await prisma.loadingSlipItem.deleteMany({ where: { salesOrderId: so.id } });
  await prisma.loadingSlip.deleteMany({ where: { salesOrderId: so.id } });
  await prisma.salesOrder.delete({ where: { id: so.id } });
  await prisma.bundle.delete({ where: { id: bundle.id } });
  await prisma.purchaseOrder.delete({ where: { id: po.id } });
  await prisma.customer.delete({ where: { id: customer.id } });

  if (failures.length > 0) {
    console.error('FAIL');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('PASS - engine refused zloading_close (all) on a sent_to_plant SO and fired no SAP work');
  process.exit(0);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(2);
});
