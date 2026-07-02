import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { uploadToS3 } from '@/lib/s3';
import { checkAndSendCombinedVehicleEmailForPo } from '@/lib/auto-gui-trigger';
import { parseLoadingSlipPdf, type ParsedLoadingSlip } from '@/lib/ls-pdf-parser';
import { resolveLsiCode, normaliseLsiDesc, normaliseBatchToken, type LsiMatEntry } from '../zload2-data/route';
// linkLsiToBundle was removed in the LoadingSlip refactor — LSIs reach a
// bundle via their parent LoadingSlip now.

/**
 * Confidence threshold below which we stop trusting the PDF parser and
 * fall back to a single `material='PENDING'` placeholder LSI. 0.85 covers
 * "parsed cleanly but total-boxes cross-check unavailable" through to
 * "every field present + cross-check passed". Anything lower means the
 * SAP report layout likely shifted — better to surface than to fabricate.
 */
const MIN_PARSER_CONFIDENCE = 0.85;

const PLANT_EMAIL = process.env.PLANT_EMAIL || '';

/**
 * POST /backend/orders/aman/zload1-data
 *
 * Receives an LS file from Aman (auto_gui2) after executing ZLOAD1 (Stage 1).
 * ZLOAD1 creates loading slips in SAP — this endpoint mirrors them into our
 * DB but does NOT email the plant. Plant emails are sent later by the
 * vehicle-details flow once the branch confirms transport.
 *
 * Expected: multipart/form-data with:
 * - so_number    : string  SAP sales order number
 * - bundle_number: string  1-based bundle index within the PurchaseOrder
 *                          (stable across replans — preferred over bundle_id cuid)
 * - bundle_id    : string  legacy cuid — accepted for back-compat but only
 *                          used if bundle_number isn't sent and Bundle is
 *                          actually findable
 * - file         : File    the LS PDF, filename = "<lsNumber>.PDF"
 *
 * Schema model (post-refactor):
 *   Bundle ─< LoadingSlip ─< LoadingSlipItem
 *   - A Bundle represents one vehicle.
 *   - A LoadingSlip is one plant's shipment within a bundle. ≥1 per bundle
 *     (more when the bundle's SKUs come from multiple plants).
 *   - A LoadingSlipItem is one SKU line on an LS.
 */
export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const soNumberField = formData.get('so_number') as string | null;
    const bundleNumberField = formData.get('bundle_number') as string | null;
    const bundleIdField = formData.get('bundle_id') as string | null;
    // append-mode marker. When present, this ZLOAD1 was fired as an
    // append-to-existing-bundle (post-plant-intimation fits_other_bundle
    // path). We log louder + run the bundle-weight recompute against the
    // named bundle directly so the rollup stays honest.
    const appendToBundleIdField = formData.get('append_to_bundle_id') as string | null;

    console.log(
      `[ZLOAD1 Data] Received callback — file: ${file?.name || 'none'}, ` +
        `size: ${file?.size || 0}, so_number: ${soNumberField || 'not provided'}, ` +
        `bundle_number: ${bundleNumberField || 'not provided'}, ` +
        `bundle_id (legacy): ${bundleIdField || 'not provided'}` +
        (appendToBundleIdField ? `, append_to_bundle_id: ${appendToBundleIdField}` : '')
    );

    if (!file) {
      return NextResponse.json({ error: 'No file received' }, { status: 400 });
    }

    // Extract LS number from filename (e.g., "373292.PDF" → "373292")
    const lsNumber = file.name.replace(/\.[^.]+$/, '').trim();
    if (!lsNumber) {
      return NextResponse.json(
        { error: 'Could not extract LS number from filename' },
        { status: 400 }
      );
    }

    // Resolve SO: form field → CurrentSO singleton.
    let soNumber = soNumberField;
    if (!soNumber) {
      const currentSO = await prisma.currentSO.findFirst();
      if (!currentSO) {
        return NextResponse.json(
          { error: 'No current SO number set and so_number not provided' },
          { status: 404 }
        );
      }
      soNumber = currentSO.soNumber;
    }

    const salesOrder = await prisma.salesOrder.findFirst({
      where: { soNumber },
      select: { id: true, soNumber: true, purchaseOrderId: true },
    });
    if (!salesOrder) {
      return NextResponse.json(
        { error: `Sales order not found: ${soNumber}` },
        { status: 404 }
      );
    }

    // Resolve Bundle. Prefer bundle_number (stable integer scoped to PO);
    // fall back to bundle_id cuid for back-compat with any in-flight ZLOAD1
    // jobs enqueued by the previous code path.
    let bundle: { id: string; bundleNumber: number } | null = null;
    if (bundleNumberField && salesOrder.purchaseOrderId) {
      const n = Number.parseInt(bundleNumberField, 10);
      if (Number.isFinite(n) && n > 0) {
        bundle = await prisma.bundle.findUnique({
          where: {
            purchaseOrderId_bundleNumber: {
              purchaseOrderId: salesOrder.purchaseOrderId,
              bundleNumber: n,
            },
          },
          select: { id: true, bundleNumber: true },
        });
        if (!bundle) {
          console.warn(
            `[ZLOAD1 Data] No Bundle for PO ${salesOrder.purchaseOrderId} / bundleNumber ${n} — ` +
              `the bundle may have been replanned. Falling back to bundle_id lookup if available.`
          );
        }
      }
    }
    if (!bundle && bundleIdField) {
      bundle = await prisma.bundle.findUnique({
        where: { id: bundleIdField },
        select: { id: true, bundleNumber: true },
      });
      if (!bundle) {
        console.warn(
          `[ZLOAD1 Data] Legacy bundle_id=${bundleIdField} no longer exists — likely deleted by a replan.`
        );
      }
    }
    if (!bundle) {
      // We can't create a LoadingSlip without a Bundle FK. This is the same
      // failure mode that produced the P2003 in prod; with the new schema we
      // detect it BEFORE writing instead of swallowing a FK violation after.
      console.error(
        `[ZLOAD1 Data] Cannot resolve Bundle for SO ${soNumber} LS ${lsNumber}. ` +
          `LoadingSlip will not be created. The LSI will still be stored so the file isn't lost.`
      );
    }

    // Upload the file to R2.
    const fileBuffer = Buffer.from(await file.arrayBuffer());
    const contentType = /\.pdf$/i.test(file.name) ? 'application/pdf' : 'application/octet-stream';
    const s3Key = `ls-files/${salesOrder.soNumber}/${file.name}`;
    await uploadToS3(s3Key, fileBuffer, contentType);

    // Find-or-create the LoadingSlip. The plant email defaults to the
    // PLANT_EMAIL env var; later, when we have a Plant table, this gets
    // resolved per-material via the SAP plant code from the LS file.
    let loadingSlip: { id: string; lsNumber: string } | null = null;
    if (bundle) {
      loadingSlip = await prisma.loadingSlip.upsert({
        where: { lsNumber },
        create: {
          lsNumber,
          bundleId: bundle.id,
          salesOrderId: salesOrder.id,
          plantEmail: PLANT_EMAIL,
          fileUrl: s3Key,
          status: 'pending',
        },
        update: {
          // Keep the LS row's bundleId stable — re-running ZLOAD1 for the
          // same LS shouldn't move it between bundles. Just update fileUrl
          // (a re-fire may produce a fresh PDF).
          fileUrl: s3Key,
        },
        select: { id: true, lsNumber: true },
      });
      console.log(
        `[ZLOAD1 Data] LoadingSlip ${loadingSlip.lsNumber} linked to Bundle ${bundle.bundleNumber} (id=${bundle.id})`
      );
    }

    // ──────────────────────────────────────────────────────────────────
    // Parse the LS PDF to extract per-material lines (material code, batch,
    // quantity, description). On a clean parse we create one LSI per
    // material so the LSI table becomes the authoritative SKU↔LS mapping
    // — ZLOAD2/ZLOAD_Close lookups don't need to wait for /initial-data.
    //
    // If the parser comes back with low confidence (layout drift, scan
    // artefact, etc.) we fall back to the legacy single `material='PENDING'`
    // placeholder so the LS file still gets stored and the SO continues
    // through dispatch. The placeholder gets enriched by /initial-data
    // when auto_gui2 sends the `items` JSON.
    // ──────────────────────────────────────────────────────────────────
    let parsed: ParsedLoadingSlip | null = null;
    try {
      parsed = await parseLoadingSlipPdf(fileBuffer);
      if (parsed.confidence < 1) {
        console.warn(
          `[ZLOAD1 Data] PDF parse confidence ${parsed.confidence.toFixed(2)} for LS ${lsNumber}` +
            (parsed.warnings.length ? ` — ${parsed.warnings.join('; ')}` : '')
        );
      }
    } catch (parseErr) {
      console.warn(
        `[ZLOAD1 Data] PDF parse failed for LS ${lsNumber}: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}. ` +
          `Falling back to PENDING placeholder.`
      );
    }

    const useParsed =
      parsed !== null &&
      parsed.confidence >= MIN_PARSER_CONFIDENCE &&
      parsed.items.length > 0 &&
      loadingSlip !== null;

    let createdLsiIds: string[] = [];

    if (useParsed && parsed && loadingSlip) {
      // Sanity: if the PDF's printed soNumber doesn't match our resolved SO,
      // log loudly but trust the URL-supplied SO (auto_gui2 is the authority
      // on routing). A mismatch could indicate the wrong PDF arrived on this
      // callback — flag it for human review without blocking the write.
      if (parsed.soNumber && parsed.soNumber !== salesOrder.soNumber) {
        console.warn(
          `[ZLOAD1 Data] PDF soNumber=${parsed.soNumber} does not match callback soNumber=${salesOrder.soNumber} for LS ${lsNumber} — proceeding with callback SO.`
        );
      }

      // Resolve the real SAP material code per parsed PDF row.
      //
      // The PDF doesn't print SAP material codes; it only prints the
      // product description (e.g. "OT2FJ 300X300-10 GREY MATT-P"). The
      // parser previously extracted the first whitespace token of that
      // description as `material` — but "OT2FJ" is a product family, not
      // a SAP code. Two genuinely-different SKUs can share the same family
      // prefix (e.g. "OT2FJ ... GREY MATT-P" → YT20000030000D5P vs
      // "OT2FJ ... REC LENOX BLANCO MTDG-P" → YT2LEBL000000D5P), and the
      // (loadingSlipId, family, batch) upsert collapses them into one row.
      //
      // ZSO-VISIBILITY already stored the SO's real Materials with both
      // SAP code and description. Look up each PDF row's real code by
      // (description, batch) against that table. Whitespace is normalised
      // because the visibility payload sometimes carries double spaces
      // ("ALMITOS LT  GL REC-P") that the PDF prints as single spaces.
      const soMaterials = await prisma.material.findMany({
        where: { salesOrderId: salesOrder.id },
        select: { material: true, materialDescription: true, batch: true },
      });
      // Index each Material row by (normalised description, batch token). A
      // multi-batch material stores its batches as one comma-joined string
      // ("RP08, B01"), but the LS PDF prints one physical row PER batch — so
      // we index every individual batch token (plus the joined string) so a
      // per-batch PDF row resolves to the real code instead of falling back
      // to the family prefix and creating a mangled LSI per batch.
      //
      // Matching uses the SHARED resolveLsiCode (same as zload2-data): a
      // batch-qualified prefix match first, then a description-only fallback so
      // a stale 'N/A' batch on the Material row still resolves by a unique
      // description. The old inline matcher here was batch-only, so an append
      // whose Material batch had drifted fell straight to the family prefix.
      const matEntries: LsiMatEntry[] = [];
      for (const m of soMaterials) {
        // Keep materials even without a description — an empty desc can't match
        // by text but its batch still feeds resolveLsiCode's unique-batch tier.
        const desc = m.materialDescription ? normaliseLsiDesc(m.materialDescription) : '';
        const batchTokens = String(m.batch ?? '')
          .split(',')
          .map((b) => normaliseBatchToken(b))
          .filter((b) => b.length > 0);
        const joined = normaliseBatchToken(m.batch ?? '');
        if (joined) batchTokens.push(joined);
        matEntries.push({ desc, batchTokens, code: m.material });
      }

      for (const item of parsed.items) {
        // Look up the real SAP code by (description, batch). If no unique
        // Material row matches, fall back to the PDF's family prefix and log —
        // that's a recoverable miss but worth attention.
        const realMaterialCode = resolveLsiCode(matEntries, item.description, item.batch);

        const materialForLsi = realMaterialCode ?? item.material;
        if (!realMaterialCode) {
          console.warn(
            `[ZLOAD1 Data] No Material row matched PDF row on LS ${lsNumber}: ` +
              `description="${item.description}", batch="${item.batch}". ` +
              `Falling back to family prefix "${item.material}" — this row may collide ` +
              `with another LSI if the family appears twice on this LS.`
          );
        }

        const lsi = await prisma.loadingSlipItem.upsert({
          where: {
            loadingSlipId_material_batch: {
              loadingSlipId: loadingSlip.id,
              material: materialForLsi,
              batch: item.batch,
            },
          },
          create: {
            salesOrderId: salesOrder.id,
            loadingSlipId: loadingSlip.id,
            lsNumber,
            material: materialForLsi,
            batch: item.batch,
            materialDescription: item.description,
            orderQuantity: item.qtyLoaded,
            status: 'pending',
          },
          update: {
            // Enrich-only: never overwrite the composite key columns.
            materialDescription: item.description,
            ...(item.qtyLoaded !== undefined ? { orderQuantity: item.qtyLoaded } : {}),
          },
          select: { id: true },
        });
        createdLsiIds.push(lsi.id);
      }

      // Drop any stale PENDING placeholder LSI that may have been created
      // earlier (e.g. by a pre-parser code path or a failed retry). It's
      // unreachable now that the real material rows exist.
      const removed = await prisma.loadingSlipItem.deleteMany({
        where: {
          loadingSlipId: loadingSlip.id,
          material: 'PENDING',
        },
      });
      if (removed.count > 0) {
        console.log(
          `[ZLOAD1 Data] Removed ${removed.count} stale PENDING placeholder(s) for LS ${lsNumber}`
        );
      }

      console.log(
        `[ZLOAD1 Data] Parsed LS ${lsNumber}: ${parsed.items.length} item(s) — ` +
          parsed.items
            .map((it) => `${it.material}/${it.batch}×${it.qtyLoaded}`)
            .join(', ')
      );

      // Now that we know every material on this LS, resolve the plant email
      // by the shared 3-char plant code prefix and persist it on the LS row.
      // sendLSEmail reads LoadingSlip.plantEmail downstream.
      try {
        const lsiMaterials = (
          await prisma.loadingSlipItem.findMany({
            where: { loadingSlipId: loadingSlip.id },
            select: { material: true },
          })
        ).map((r) => r.material);
        const { resolvePlantEmailForLoadingSlip } = await import('@/lib/plant-resolver');
        const plantEmail = await resolvePlantEmailForLoadingSlip(lsiMaterials, lsNumber);
        if (plantEmail) {
          await prisma.loadingSlip.update({
            where: { id: loadingSlip.id },
            data: { plantEmail },
          });
          console.log(`[ZLOAD1 Data] LS ${lsNumber} plantEmail resolved → ${plantEmail}`);
        }
      } catch (resolveErr) {
        console.warn(
          `[ZLOAD1 Data] Plant email resolution failed for LS ${lsNumber}: ${resolveErr instanceof Error ? resolveErr.message : String(resolveErr)}`
        );
      }
    } else {
      // Legacy fallback: single PENDING placeholder. /initial-data will
      // fill it in if auto_gui2 supplies an `items` JSON.
      const existing = await prisma.loadingSlipItem.findFirst({
        where: { salesOrderId: salesOrder.id, lsNumber },
      });

      const placeholder = existing
        ? await prisma.loadingSlipItem.update({
            where: { id: existing.id },
            data: loadingSlip ? { loadingSlipId: loadingSlip.id } : {},
          })
        : await prisma.loadingSlipItem.create({
            data: {
              salesOrderId: salesOrder.id,
              loadingSlipId: loadingSlip?.id ?? null,
              lsNumber,
              material: 'PENDING',
              status: 'pending',
            },
          });
      createdLsiIds.push(placeholder.id);
    }

    console.log(
      `[ZLOAD1 Data] Stored LS file — SO: ${soNumber}, LS: ${lsNumber}, ` +
        `file: ${file.name}, s3Key: ${s3Key}, ` +
        `lsiIds: ${createdLsiIds.join(',') || '(none)'}, ` +
        `lsId: ${loadingSlip?.id ?? '(unlinked)'}, ` +
        `source: ${useParsed ? 'pdf-parse' : 'PENDING-placeholder'}`
    );

    // Live-update Bundle.totalWeightKg from the (potentially new) Material
    // rows linked to this bundle. Covers both initial mode (no-op when the
    // bundler's pre-set value already matches) and append mode (where the
    // appended material adds weight that the bundler never knew about).
    if (bundle) {
      try {
        const { recomputeBundleWeight } = await import('@/lib/bundle-capacity');
        await recomputeBundleWeight(bundle.id);
      } catch (recomputeErr) {
        console.warn(
          `[ZLOAD1 Data] Bundle weight recompute failed for bundle ${bundle.id} (LS ${lsNumber}): ${recomputeErr instanceof Error ? recomputeErr.message : String(recomputeErr)}`,
        );
      }
    }

    // First LS landed → SO moves to ls_created. Idempotent.
    await prisma.salesOrder.update({
      where: { id: salesOrder.id },
      data: { status: 'ls_created' },
    });

    // Gate: if every ZLOAD1 row for this PO is now `done`, send the combined
    // vehicle-details email (idempotent — safe to call on every callback).
    if (salesOrder.purchaseOrderId) {
      try {
        await checkAndSendCombinedVehicleEmailForPo(salesOrder.purchaseOrderId);
      } catch (gateErr) {
        console.error(
          `[ZLOAD1 Data] Combined-vehicle-email gate error for PO ${salesOrder.purchaseOrderId}:`,
          gateErr
        );
      }
    }

    return NextResponse.json({
      success: true,
      so_number: soNumber,
      soNumber,
      lsNumber,
      fileUrl: s3Key,
      loadingSlipId: loadingSlip?.id ?? null,
      bundleId: bundle?.id ?? null,
      itemsCreated: createdLsiIds.length,
      parserConfidence: parsed?.confidence ?? null,
      source: useParsed ? 'pdf-parse' : 'PENDING-placeholder',
    });
  } catch (error) {
    console.error('[Aman API - ZLOAD1 Data] Error:', error);
    return NextResponse.json(
      {
        error: 'Internal server error',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
