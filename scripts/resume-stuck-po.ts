/**
 * One-off resume driver for a PurchaseOrder whose dispatch stalled.
 *
 *   DATABASE_URL="file:./prisma/dev.db" npx tsx scripts/resume-stuck-po.ts <SO_NUMBER>
 *
 * What it does:
 *   1. Looks up the SO by soNumber and resolves its PurchaseOrder.
 *   2. Prints the current state: every LoadingSlip for the SO, each LS's
 *      bundle linkage, each LSI's material/batch/qty, and any vehicle email
 *      already sent for the PO.
 *   3. Calls checkAndSendCombinedVehicleEmailForPo to re-fire the vehicle
 *      gate. The function is idempotent — it skips if a vehicle_details
 *      email already exists for the PO.
 *
 * This is the right resume point when:
 *   - ZLOAD1 ran (LoadingSlip + LSI rows exist)
 *   - bundleId is now correctly set on every LS (back-fill ran)
 *   - the vehicle_details email never went out
 *
 * If your SO is stuck somewhere ELSE in the pipeline (no LSs at all, plant
 * invoice never landed, etc.), this script will print what's there and
 * the gate call will be a no-op — read the printout, that's the diagnostic.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const soNumber = process.argv[2];
  if (!soNumber) {
    console.error('Usage: npx tsx scripts/resume-stuck-po.ts <SO_NUMBER>');
    process.exit(1);
  }

  const so = await prisma.salesOrder.findFirst({
    where: { soNumber },
    include: {
      purchaseOrder: { select: { id: true, poNumber: true, status: true } },
      loadingSlips: {
        include: {
          items: { select: { id: true, material: true, batch: true, orderQuantity: true, status: true } },
          bundle: { select: { id: true, bundleNumber: true, vehicleNumber: true } },
          emails: { select: { id: true, emailType: true, status: true, recipientEmail: true } },
        },
      },
    },
  });

  if (!so) {
    console.error(`No SalesOrder found for soNumber=${soNumber}`);
    process.exit(1);
  }

  console.log(`\n=== Sales Order ${so.soNumber} ===`);
  console.log(`  SO id:        ${so.id}`);
  console.log(`  Status:       ${so.status}`);
  console.log(`  PO:           ${so.purchaseOrder?.poNumber ?? '(none)'} (id=${so.purchaseOrder?.id ?? 'n/a'}, status=${so.purchaseOrder?.status ?? 'n/a'})`);
  console.log(`  LR:           ${so.lrNumber ?? '(none)'} dated ${so.lrDate?.toISOString().slice(0, 10) ?? '(none)'}`);
  console.log(`  LoadingSlips: ${so.loadingSlips.length}`);

  for (const ls of so.loadingSlips) {
    console.log(`\n  LS ${ls.lsNumber}`);
    console.log(`    id:           ${ls.id}`);
    console.log(`    bundleId:     ${ls.bundleId} (bundle ${ls.bundle?.bundleNumber ?? '?'} vehicle=${ls.bundle?.vehicleNumber ?? 'unset'})`);
    console.log(`    plantEmail:   ${ls.plantEmail}`);
    console.log(`    fileUrl:      ${ls.fileUrl ?? '(none)'}`);
    console.log(`    status:       ${ls.status}`);
    console.log(`    items (${ls.items.length}):`);
    for (const it of ls.items) {
      console.log(
        `      - ${it.material} batch=${it.batch || '(empty)'} qty=${it.orderQuantity ?? '?'} status=${it.status}`
      );
    }
    if (ls.emails.length > 0) {
      console.log(`    emails:`);
      for (const e of ls.emails) {
        console.log(`      - ${e.emailType} → ${e.recipientEmail} [${e.status}]`);
      }
    }
  }

  // Show what vehicle_details emails (if any) exist for the PO.
  if (so.purchaseOrder?.id) {
    const vehEmails = await prisma.email.findMany({
      where: { purchaseOrderId: so.purchaseOrder.id, emailType: 'vehicle_details' },
      select: { id: true, status: true, recipientEmail: true, sentAt: true },
    });
    console.log(`\n  vehicle_details emails on PO: ${vehEmails.length}`);
    for (const e of vehEmails) {
      console.log(`    - to ${e.recipientEmail} sent=${e.sentAt.toISOString()} status=${e.status}`);
    }
  }

  // Refuse to fire if any LS lacks a bundleId — the back-fill didn't finish.
  const orphanLs = so.loadingSlips.filter((ls) => !ls.bundleId);
  if (orphanLs.length > 0) {
    console.error(
      `\n!! ${orphanLs.length} LoadingSlip(s) still have bundleId=NULL: ${orphanLs.map((l) => l.lsNumber).join(', ')}.\n` +
        `   Run scripts/backfill-loading-slips.ts first, or fix these rows manually before resuming.`
    );
    process.exit(2);
  }

  if (!so.purchaseOrder?.id) {
    console.error('No purchaseOrderId on this SO — cannot fire the vehicle gate.');
    process.exit(1);
  }

  console.log(`\n=== Re-firing vehicle-details gate for PO ${so.purchaseOrder.poNumber} ===`);
  const { checkAndSendCombinedVehicleEmailForPo } = await import('../src/lib/auto-gui-trigger');
  const result = await checkAndSendCombinedVehicleEmailForPo(so.purchaseOrder.id);
  console.log(`  sent: ${result.sent}`);
  for (const line of result.logs) console.log(`  ${line}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
