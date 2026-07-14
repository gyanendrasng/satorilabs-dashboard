import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { uploadToS3 } from '@/lib/s3';
import { parseLoadingSlipPdf, type ParsedLoadingSlip } from '@/lib/ls-pdf-parser';
import { resolvePlantEmailForLoadingSlip } from '@/lib/plant-resolver';
import { normaliseForMatch } from '@/lib/text-normalize';

/**
 * Confidence threshold below which we stop trusting the PDF parser. Mirrors
 * /zload1-data — if parse confidence falls below this we keep the existing
 * LSI rows unchanged rather than overwrite them with garbage.
 */
const MIN_PARSER_CONFIDENCE = 0.85;

/** One indexed Material row for PDF-row → SAP-code resolution. */
export interface LsiMatEntry {
  /** Normalised material description (uppercase, single-spaced). */
  desc: string;
  /** Individual batch tokens (a multi-batch material splits "RP08, B01"). */
  batchTokens: string[];
  /** The real SAP material code. */
  code: string;
}

/** Comparison key for a description: fully sanitised (invisible / zero-width /
 *  non-breaking chars folded away, NFKC, whitespace collapsed) + upper-cased.
 *  Thin wrapper so the exported name and existing callers stay stable. */
export function normaliseLsiDesc(s: string): string {
  return normaliseForMatch(s);
}

/** Comparison key for a batch token: same sanitisation as descriptions. Batch
 *  codes (e.g. "AN-72") are short and exact — the strongest signal we have when
 *  a description is missing or garbled. */
export function normaliseBatchToken(s: string): string {
  return normaliseForMatch(s);
}

/**
 * Resolve a PDF row (description, batch) to a real SAP code against the SO's
 * indexed Material rows. Pure + exported so it is unit-testable in isolation.
 *
 * Inputs are fully sanitised (see text-normalize.ts) so a lone invisible /
 * non-breaking character can no longer defeat the comparison.
 *
 * Three tiers, tried in decreasing confidence; each resolves only when its
 * signal is UNAMBIGUOUS (exactly one candidate), else we fall through:
 *   1. desc + batch — description prefix-matches (either direction; the PDF text
 *      layer truncates long descriptions) AND the batch token matches. Strongest.
 *   2. unique description — a single material's description matches (its batch
 *      may be a stale 'N/A' on the Material row while the PDF prints the real one).
 *   3. unique batch — NEW safety net. The batch token maps to exactly one
 *      material on the SO, regardless of description. This covers the failure
 *      that motivated this rewrite: the Material row's LLM-extracted description
 *      was absent/garbled so tiers 1–2 found nothing, yet the batch ("AN-72")
 *      still pins the code exactly. Shared batches like "P" hit many lines →
 *      ambiguous → this never mis-fires on them.
 *
 * If every tier is ambiguous/empty we return undefined and the caller keeps its
 * family-prefix fallback (logged loudly) rather than guessing wrong.
 */
export function resolveLsiCode(
  matEntries: LsiMatEntry[],
  rawDesc: string,
  rawBatch: string,
): string | undefined {
  const d = normaliseLsiDesc(rawDesc);
  const b = normaliseBatchToken(rawBatch);

  const descAndBatch = new Set<string>(); // desc matches AND batch matches
  const descOnly = new Set<string>();     // desc matches (any batch)
  const batchOnly = new Set<string>();    // batch matches (any/no desc)

  for (const e of matEntries) {
    const batchMatch = b.length > 0 && e.batchTokens.includes(b);
    if (batchMatch) batchOnly.add(e.code);

    // An empty stored description can't disambiguate by text — skip the desc
    // tiers for it, but it still contributes its batch to tier 3 above.
    const descMatch =
      e.desc.length > 0 && (e.desc === d || e.desc.startsWith(d) || d.startsWith(e.desc));
    if (!descMatch) continue;
    descOnly.add(e.code);
    if (batchMatch) descAndBatch.add(e.code);
  }

  if (descAndBatch.size === 1) return [...descAndBatch][0];
  if (descOnly.size === 1) return [...descOnly][0];
  if (batchOnly.size === 1) return [...batchOnly][0];
  return undefined;
}

/**
 * POST /backend/orders/aman/zload2-data
 *
 * Receives the regenerated LS PDF from auto_gui2 after a ZLOAD2 run modifies
 * an existing loading slip in SAP. Mirrors the ZLOAD2 send_data callback
 * contract documented in BACKEND_ENDPOINTS.md §3.2.
 *
 * Two responsibilities:
 *   1. Persist the regenerated PDF to R2; update LoadingSlip.fileUrl.
 *   2. Re-parse the PDF and reconcile LSI rows so the DB matches what SAP
 *      actually saved (line counts/quantities/batches may have shifted).
 *
 * Plant notification is PLANNER-DRIVEN — handled by the email_to_plant or
 * email_modified_ls_to_plant step that the planner emits alongside zload2.
 * If the planner truncates its plan and omits the email step, the engine's
 * safety net (scenario-engine.ts handlePostModifyPlantEmailGap) detects the
 * gap when the scenario terminates and auto-emits the correct step with
 * loud logging so the failure is visible.
 *
 * Completion of the SAP run itself is reported separately on /step-status —
 * the work_id transitions to `done` there. This route is only the artifact
 * upload + LSI reconciliation.
 */
export async function POST(request: Request) {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch (err) {
    console.error('[ZLOAD2 Data] formData parse failed:', err);
    return NextResponse.json(
      { error: 'Expected multipart/form-data with a `file` field', details: String(err) },
      { status: 400 }
    );
  }

  const file = formData.get('file');
  const soNumberField = (formData.get('so_number') as string | null) ?? null;
  const workIdField = (formData.get('work_id') as string | null) ?? null;
  const lsNumberField = (formData.get('ls_number') as string | null) ?? null;

  // Log every form field so we can see what auto_gui2 actually sent.
  for (const [k, v] of formData.entries()) {
    if (v instanceof Blob) {
      console.log(
        `[ZLOAD2 Data] field "${k}": Blob size=${v.size} type=${v.type} name=${(v as { name?: string }).name ?? '(none)'}`
      );
    } else {
      console.log(`[ZLOAD2 Data] field "${k}":`, String(v).slice(0, 200));
    }
  }

  if (!(file instanceof Blob)) {
    return NextResponse.json(
      { error: 'No `file` in form data — auto_gui2 should send the regenerated LS PDF as the `file` field' },
      { status: 400 }
    );
  }

  // Resolve LS number. Prefer the `ls_number` form field (authoritative —
  // sent verbatim from the original triggerZload2 meta), and fall back to
  // the filename only if the form field is missing.
  //
  // Filename fallback strips SAP's zero-padding (e.g. "0000373283.PDF"
  // → "373283"). Filenames like "slip.pdf" (test-mode fixtures) used to
  // resolve to lsNumber="slip" silently, and the LoadingSlip lookup would
  // then miss every time. Form field first prevents that.
  const rawName = (file as { name?: string }).name ?? '';
  const stem = rawName.replace(/\.[^.]+$/, '').trim();
  const lsNumberFromFilename = stem.replace(/^0+/, '');
  const lsNumber = (lsNumberField && lsNumberField.trim().replace(/^0+/, '')) || lsNumberFromFilename;
  if (!lsNumber) {
    return NextResponse.json(
      { error: `Could not resolve LS number — ls_number form field empty and filename "${rawName}" has no number` },
      { status: 400 }
    );
  }
  if (lsNumberField && lsNumberFromFilename && lsNumberField !== lsNumberFromFilename) {
    console.warn(
      `[ZLOAD2 Data] ls_number form field "${lsNumberField}" disagrees with filename-derived "${lsNumberFromFilename}". Trusting form field.`
    );
  }

  const loadingSlip = await prisma.loadingSlip.findUnique({
    where: { lsNumber },
    select: {
      id: true,
      lsNumber: true,
      salesOrderId: true,
      bundleId: true,
      fileUrl: true,
      plantEmail: true,
    },
  });
  if (!loadingSlip) {
    // ZLOAD2 was fired against an LS we don't have a row for — this would
    // mean a planner emitted zload2 for a slip that never came through
    // /zload1-data. Surface it but don't fail the upload; auto_gui2 treats
    // anything 2xx as success.
    console.warn(
      `[ZLOAD2 Data] No LoadingSlip row for lsNumber=${lsNumber} (filename "${rawName}", so=${soNumberField ?? 'n/a'}, work_id=${workIdField ?? 'n/a'}) — PDF will not be persisted`
    );
    return NextResponse.json(
      { received: true, persisted: false, reason: `LoadingSlip ${lsNumber} not found` },
      { status: 200 }
    );
  }

  // ── 1. Upload PDF to R2 (overwrites the older ZLOAD1 PDF at the same key) ──
  const so = await prisma.salesOrder.findUnique({
    where: { id: loadingSlip.salesOrderId },
    select: { soNumber: true, id: true },
  });
  const soNumber = soNumberField ?? so?.soNumber ?? 'unknown';

  const fileBuffer = Buffer.from(await file.arrayBuffer());
  const s3Key = `ls-pdfs/${soNumber}/${lsNumber}.PDF`;
  try {
    await uploadToS3(s3Key, fileBuffer, 'application/pdf');
    console.log(`[ZLOAD2 Data] Uploaded regenerated LS PDF to R2: ${s3Key} (${fileBuffer.length} bytes)`);
  } catch (err) {
    console.error('[ZLOAD2 Data] R2 upload failed:', err);
    return NextResponse.json(
      { error: 'Failed to upload PDF to R2', details: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
  await prisma.loadingSlip.update({
    where: { id: loadingSlip.id },
    data: { fileUrl: s3Key },
  });

  // ── 2. Re-parse and reconcile LSIs ──
  // Same flow as /zload1-data: parse the PDF, look up the real SAP material
  // codes via the SO's Material table (by description+batch), then upsert
  // LSI rows. Quantities and batches reflect what SAP saved AFTER ZLOAD2.
  // Stale lines (present before, gone in the regenerated PDF) get deleted.
  let parsed: ParsedLoadingSlip | null = null;
  try {
    parsed = await parseLoadingSlipPdf(fileBuffer);
    if (parsed.confidence < 1) {
      console.warn(
        `[ZLOAD2 Data] PDF parse confidence ${parsed.confidence.toFixed(2)} for LS ${lsNumber}` +
          (parsed.warnings.length ? ` — ${parsed.warnings.join('; ')}` : '')
      );
    }
  } catch (parseErr) {
    console.warn(
      `[ZLOAD2 Data] PDF parse failed for LS ${lsNumber}: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}. ` +
        `Keeping pre-ZLOAD2 LSI rows.`
    );
  }

  const useParsed =
    parsed !== null &&
    parsed.confidence >= MIN_PARSER_CONFIDENCE &&
    parsed.items.length > 0;

  if (useParsed && parsed) {
    // Resolve real SAP codes from the SO's Material table by (description, batch).
    const soMaterials = await prisma.material.findMany({
      where: { salesOrderId: loadingSlip.salesOrderId },
      select: { material: true, materialDescription: true, batch: true },
    });
    // Index each Material row by (normalised description, batch token). A
    // multi-batch material stores its batches as one comma-joined string
    // ("RP08, B01"), but the LS PDF prints one physical row PER batch — index
    // every individual batch token (plus the joined string) so a per-batch PDF
    // row resolves to the real code instead of the family prefix.
    const matEntries: LsiMatEntry[] = [];
    for (const m of soMaterials) {
      // Keep materials even without a description — an empty desc can't match by
      // text but its batch still feeds resolveLsiCode's unique-batch tier.
      const desc = m.materialDescription ? normaliseLsiDesc(m.materialDescription) : '';
      const batchTokens = String(m.batch ?? '')
        .split(',')
        .map((b) => normaliseBatchToken(b))
        .filter((b) => b.length > 0);
      const joined = normaliseBatchToken(m.batch ?? '');
      if (joined) batchTokens.push(joined);
      matEntries.push({ desc, batchTokens, code: m.material });
    }

    // Build the set of (material, batch) the regenerated PDF reports.
    const keptKeys = new Set<string>();
    for (const item of parsed.items) {
      const realMaterialCode = resolveLsiCode(matEntries, item.description, item.batch);
      const materialForLsi = realMaterialCode ?? item.material;
      if (!realMaterialCode) {
        console.warn(
          `[ZLOAD2 Data] No Material row matched PDF row on LS ${lsNumber}: ` +
            `description="${item.description}", batch="${item.batch}". ` +
            `Falling back to family prefix "${item.material}".`
        );
      }

      await prisma.loadingSlipItem.upsert({
        where: {
          loadingSlipId_material_batch: {
            loadingSlipId: loadingSlip.id,
            material: materialForLsi,
            batch: item.batch,
          },
        },
        create: {
          salesOrderId: loadingSlip.salesOrderId,
          loadingSlipId: loadingSlip.id,
          lsNumber,
          material: materialForLsi,
          batch: item.batch,
          materialDescription: item.description,
          orderQuantity: item.qtyLoaded,
          status: 'pending',
        },
        update: {
          materialDescription: item.description,
          ...(item.qtyLoaded !== undefined ? { orderQuantity: item.qtyLoaded } : {}),
        },
      });
      keptKeys.add(`${materialForLsi}|${item.batch}`);
    }

    // Remove LSI rows that were on this LS before ZLOAD2 but are gone now.
    // This is how ZLOAD_Delete-style removals are reflected when SAP returns
    // the regenerated PDF without those lines.
    const existingLsis = await prisma.loadingSlipItem.findMany({
      where: { loadingSlipId: loadingSlip.id },
      select: { id: true, material: true, batch: true },
    });
    const stale = existingLsis.filter((r) => !keptKeys.has(`${r.material}|${r.batch}`));
    if (stale.length > 0) {
      await prisma.loadingSlipItem.deleteMany({
        where: { id: { in: stale.map((r) => r.id) } },
      });
      console.log(
        `[ZLOAD2 Data] Removed ${stale.length} stale LSI row(s) from LS ${lsNumber}: ` +
          stale.map((r) => `${r.material}/${r.batch}`).join(', ')
      );
    }

    console.log(
      `[ZLOAD2 Data] Reconciled LS ${lsNumber}: ${parsed.items.length} item(s) — ` +
        parsed.items.map((it) => `${it.material}/${it.batch}×${it.qtyLoaded}`).join(', ')
    );

    // Re-resolve plantEmail in case ZLOAD2 introduced a material from a
    // different plant (would violate the "one LS, one plant" invariant —
    // the resolver logs loudly and falls back to env if so).
    try {
      const lsiMaterials = (
        await prisma.loadingSlipItem.findMany({
          where: { loadingSlipId: loadingSlip.id },
          select: { material: true },
        })
      ).map((r) => r.material);
      const resolvedPlantEmail = await resolvePlantEmailForLoadingSlip(lsiMaterials, lsNumber);
      if (resolvedPlantEmail && resolvedPlantEmail !== loadingSlip.plantEmail) {
        await prisma.loadingSlip.update({
          where: { id: loadingSlip.id },
          data: { plantEmail: resolvedPlantEmail },
        });
        console.log(
          `[ZLOAD2 Data] LS ${lsNumber} plantEmail updated → ${resolvedPlantEmail} (was ${loadingSlip.plantEmail})`
        );
      }
    } catch (resolveErr) {
      console.warn(
        `[ZLOAD2 Data] Plant email re-resolve failed for LS ${lsNumber}: ${resolveErr instanceof Error ? resolveErr.message : String(resolveErr)}`
      );
    }
  }

  // ── 2b. Live-update Bundle.totalWeightKg ──
  // ZLOAD2 changes line quantities on the LS; the upstream VA02 → ZSO_Visibility
  // path already updated the Material rows. Recompute this bundle's weight
  // from its Material rows so the post-plant bundle_capacity_assessment helper
  // reads an honest value. No-op when the value hasn't drifted.
  if (loadingSlip.bundleId) {
    try {
      const { recomputeBundleWeight } = await import('@/lib/bundle-capacity');
      await recomputeBundleWeight(loadingSlip.bundleId);
    } catch (recomputeErr) {
      console.warn(
        `[ZLOAD2 Data] Bundle weight recompute failed for bundle ${loadingSlip.bundleId} (LS ${lsNumber}): ${recomputeErr instanceof Error ? recomputeErr.message : String(recomputeErr)}`,
      );
    }
  }

  // ── 3. Plant notification is now PLANNER-DRIVEN ──
  // The planner decides which plant email to send after a zload2 cycle:
  //   - email_to_plant (full set) when no prior plant_ls exists (Rule 10b-i).
  //   - email_modified_ls_to_plant (touched LSs only) when plant_ls has
  //     already been sent for this PO (Rule 10b-ii / Rule 11).
  // The engine has a safety net that auto-emits the correct step if a
  // scenario containing zload2/zloading_close ends without a plant email
  // (see scenario-engine.ts handlePostModifyPlantEmailGap). Do not
  // auto-send here — it would race with the planner-emitted step and
  // duplicate the email to the plant.

  return NextResponse.json({
    received: true,
    persisted: true,
    lsNumber,
    soNumber,
    s3Key,
  });
}
