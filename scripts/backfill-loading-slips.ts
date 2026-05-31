/**
 * One-shot back-fill: create LoadingSlip rows from existing LoadingSlipItem
 * rows so the new schema's FK invariants hold.
 *
 * Run AFTER `prisma db push --schema prisma/schema.prisma` lands the new
 * LoadingSlip model + LoadingSlipItem.loadingSlipId column.
 *
 *   DATABASE_URL="file:./prisma/dev.db" npx tsx scripts/backfill-loading-slips.ts
 *
 * Behaviour:
 *   1. Group all LoadingSlipItem rows by lsNumber.
 *   2. For each group, derive a bundleId, salesOrderId, plantEmail, fileUrl
 *      from the group's rows + any plant_ls Email pointing at one of them.
 *   3. Find-or-create a LoadingSlip row.
 *   4. Set LoadingSlipItem.loadingSlipId on every row in the group.
 *   5. Re-point plant_ls Email rows from loadingSlipItemId → loadingSlipId
 *      (kept on the Email row so per-LS replies route cleanly).
 *
 * Idempotent: re-running performs no DB writes if every LSI already has
 * loadingSlipId set and every plant_ls Email has loadingSlipId set.
 *
 * Conservative: if a group is unresolvable (no bundleId on any LSI, no
 * matching plant_ls Email for plantEmail), the script logs a warning and
 * skips that group rather than fabricating data. Such rows stay with
 * loadingSlipId=NULL and need manual remediation.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const DEFAULT_PLANT_EMAIL = process.env.PLANT_EMAIL || '';

interface Group {
  lsNumber: string;
  lsiIds: string[];
  salesOrderId: string;
  bundleIdCandidate: string | null;
  fileUrlCandidate: string | null;
}

async function backfill(): Promise<void> {
  const allLsis = await prisma.loadingSlipItem.findMany({
    select: {
      id: true,
      lsNumber: true,
      salesOrderId: true,
      loadingSlipId: true,
    },
  });

  console.log(`[backfill] Scanning ${allLsis.length} LoadingSlipItem row(s).`);

  // Group LSIs by lsNumber. A single lsNumber can in principle appear under
  // multiple SOs (cross-SO LS reuse — shouldn't happen in our pipeline but
  // is technically possible at the SAP level). We treat (lsNumber, salesOrderId)
  // as the grouping key for safety.
  const groups = new Map<string, Group>();
  for (const lsi of allLsis) {
    const key = `${lsi.salesOrderId}::${lsi.lsNumber}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        lsNumber: lsi.lsNumber,
        lsiIds: [],
        salesOrderId: lsi.salesOrderId,
        bundleIdCandidate: null,
        fileUrlCandidate: null,
      };
      groups.set(key, g);
    }
    g.lsiIds.push(lsi.id);
  }
  console.log(`[backfill] Found ${groups.size} unique (SO, lsNumber) group(s).`);

  // Pull bundleId + fileUrl candidates by re-reading raw rows. Prisma's typed
  // client no longer exposes LoadingSlipItem.bundleId / .fileUrl (they were
  // dropped from the schema), but the columns still exist physically until
  // we run a `prisma db push` that drops them. Until then, we read via $queryRaw.
  let rawRows: Array<{ id: string; bundleId: string | null; fileUrl: string | null }> = [];
  try {
    rawRows = await prisma.$queryRaw<
      Array<{ id: string; bundleId: string | null; fileUrl: string | null }>
    >`SELECT id, bundleId, fileUrl FROM loading_slip_item`;
  } catch (err) {
    // Columns already dropped — that's fine, nothing to back-fill from there.
    console.log(`[backfill] Note: loading_slip_item.bundleId/fileUrl columns no longer present (already migrated). ${err instanceof Error ? err.message : err}`);
  }
  const lsiExtra = new Map(rawRows.map((r) => [r.id, r]));

  for (const g of groups.values()) {
    for (const lsiId of g.lsiIds) {
      const extra = lsiExtra.get(lsiId);
      if (!extra) continue;
      if (!g.bundleIdCandidate && extra.bundleId) g.bundleIdCandidate = extra.bundleId;
      if (!g.fileUrlCandidate && extra.fileUrl) g.fileUrlCandidate = extra.fileUrl;
    }
  }

  // Pull existing plant_ls Email rows once. We'll match by loadingSlipItemId
  // to derive a plantEmail (Email.recipientEmail) per LS group.
  const plantLsEmails = await prisma.email.findMany({
    where: { emailType: 'plant_ls' },
    select: {
      id: true,
      loadingSlipItemId: true,
      loadingSlipId: true,
      recipientEmail: true,
    },
  });

  const plantEmailByLsiId = new Map<string, string>();
  for (const e of plantLsEmails) {
    if (e.loadingSlipItemId && e.recipientEmail) {
      plantEmailByLsiId.set(e.loadingSlipItemId, e.recipientEmail);
    }
  }

  let created = 0;
  let skipped = 0;
  let linkedLsis = 0;
  let linkedEmails = 0;

  for (const g of groups.values()) {
    // Resolve plantEmail: prefer the Email row's recipient, fall back to env.
    let plantEmail: string | null = null;
    for (const lsiId of g.lsiIds) {
      const e = plantEmailByLsiId.get(lsiId);
      if (e) {
        plantEmail = e;
        break;
      }
    }
    if (!plantEmail) plantEmail = DEFAULT_PLANT_EMAIL || null;

    if (!g.bundleIdCandidate) {
      console.warn(
        `[backfill] SKIP ls=${g.lsNumber} so=${g.salesOrderId}: no bundleId on any of ${g.lsiIds.length} LSIs. Cannot create LoadingSlip without a bundle. Leaving loadingSlipId=NULL.`
      );
      skipped++;
      continue;
    }
    if (!plantEmail) {
      console.warn(
        `[backfill] SKIP ls=${g.lsNumber} so=${g.salesOrderId}: no plantEmail found (no plant_ls Email and PLANT_EMAIL env empty). Leaving loadingSlipId=NULL.`
      );
      skipped++;
      continue;
    }

    // Idempotent upsert keyed on lsNumber (unique).
    const ls = await prisma.loadingSlip.upsert({
      where: { lsNumber: g.lsNumber },
      create: {
        lsNumber: g.lsNumber,
        bundleId: g.bundleIdCandidate,
        salesOrderId: g.salesOrderId,
        plantEmail,
        fileUrl: g.fileUrlCandidate,
        status: 'pending',
      },
      update: {}, // existing row: don't overwrite — back-fill is one-way
    });

    const wasCreated = ls.createdAt.getTime() === ls.updatedAt.getTime();
    if (wasCreated) {
      created++;
      console.log(
        `[backfill] Created LoadingSlip ls=${g.lsNumber} (bundle=${g.bundleIdCandidate}, plant=${plantEmail}, ${g.lsiIds.length} item(s))`
      );
    }

    // Link every LSI in the group to this LoadingSlip. Use updateMany; rows
    // already pointing at this LS are no-ops.
    const r1 = await prisma.loadingSlipItem.updateMany({
      where: { id: { in: g.lsiIds }, loadingSlipId: null },
      data: { loadingSlipId: ls.id },
    });
    linkedLsis += r1.count;

    // Re-point plant_ls Email rows: those carrying any of these LSI ids in
    // loadingSlipItemId should also carry the new loadingSlipId.
    const r2 = await prisma.email.updateMany({
      where: {
        emailType: 'plant_ls',
        loadingSlipItemId: { in: g.lsiIds },
        loadingSlipId: null,
      },
      data: { loadingSlipId: ls.id },
    });
    linkedEmails += r2.count;
  }

  console.log(
    `[backfill] Done. LoadingSlip rows created: ${created}. Groups skipped: ${skipped}. ` +
      `LSIs newly linked: ${linkedLsis}. plant_ls emails newly linked: ${linkedEmails}.`
  );

  // Sanity: any LSI still with loadingSlipId=NULL?
  const orphanLsiCount = await prisma.loadingSlipItem.count({
    where: { loadingSlipId: null },
  });
  if (orphanLsiCount > 0) {
    console.warn(
      `[backfill] WARNING: ${orphanLsiCount} LoadingSlipItem row(s) still have loadingSlipId=NULL. These will not be reachable via the new LoadingSlip path. Investigate before relying on the new code paths in prod.`
    );
  }
}

backfill()
  .catch((err) => {
    console.error('[backfill] FAILED:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
