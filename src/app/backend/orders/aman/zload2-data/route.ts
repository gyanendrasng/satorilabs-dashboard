import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { uploadToS3 } from '@/lib/s3';
import { parseLoadingSlipPdf, type ParsedLoadingSlip } from '@/lib/ls-pdf-parser';
import {
  sendEmail,
  sendReplyEmailWithAttachment,
  getMessageRfc822Id,
} from '@/lib/gmail';
import { resolvePlantEmailForLoadingSlip } from '@/lib/plant-resolver';

/**
 * Confidence threshold below which we stop trusting the PDF parser. Mirrors
 * /zload1-data — if parse confidence falls below this we keep the existing
 * LSI rows unchanged rather than overwrite them with garbage.
 */
const MIN_PARSER_CONFIDENCE = 0.85;

/**
 * POST /backend/orders/aman/zload2-data
 *
 * Receives the regenerated LS PDF from auto_gui2 after a ZLOAD2 run modifies
 * an existing loading slip in SAP. Mirrors the ZLOAD2 send_data callback
 * contract documented in BACKEND_ENDPOINTS.md §3.2.
 *
 * Three responsibilities:
 *   1. Persist the regenerated PDF to R2; update LoadingSlip.fileUrl.
 *   2. Re-parse the PDF and reconcile LSI rows so the DB matches what SAP
 *      actually saved (line counts/quantities/batches may have shifted).
 *   3. Forward the updated PDF to the LS's plant — in-thread on the original
 *      plant_ls email so the plant sees the modification as a follow-up on
 *      the same chain.
 *
 * Completion of the SAP run itself is reported separately on /step-status —
 * the work_id transitions to `done` there. This route is only the artifact
 * upload + downstream propagation.
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
    const normaliseDesc = (s: string): string => s.toUpperCase().replace(/\s+/g, ' ').trim();
    const soMaterials = await prisma.material.findMany({
      where: { salesOrderId: loadingSlip.salesOrderId },
      select: { material: true, materialDescription: true, batch: true },
    });
    const codeByDescBatch = new Map<string, string>();
    for (const m of soMaterials) {
      if (!m.materialDescription) continue;
      const key = `${normaliseDesc(m.materialDescription)}|${m.batch}`;
      if (!codeByDescBatch.has(key)) codeByDescBatch.set(key, m.material);
    }

    // Build the set of (material, batch) the regenerated PDF reports.
    const keptKeys = new Set<string>();
    for (const item of parsed.items) {
      const lookupKey = `${normaliseDesc(item.description)}|${item.batch}`;
      const realMaterialCode = codeByDescBatch.get(lookupKey);
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

  // ── 3. Forward updated PDF to the plant ──
  // Reply in-thread on the most recent plant_ls email for this LS. Falls
  // back to a brand-new thread if no prior plant_ls exists (shouldn't
  // happen — ZLOAD2 only fires after ZLOAD1 which led to a plant_ls send).
  try {
    const currentLs = await prisma.loadingSlip.findUnique({
      where: { id: loadingSlip.id },
      select: { plantEmail: true, salesOrderId: true },
    });
    const plantRecipient = currentLs?.plantEmail || process.env.PLANT_EMAIL || '';
    if (!plantRecipient) {
      console.warn(`[ZLOAD2 Data] No plant recipient available for LS ${lsNumber} — skipping plant notification`);
    } else {
      const subject = `Updated Loading Slip ${lsNumber} - SO ${soNumber}`;
      const body = [
        `The Loading Slip ${lsNumber} for Sales Order ${soNumber} has been updated.`,
        ``,
        `Please find the revised slip attached.`,
      ].join('\n');
      const attachment = {
        filename: `${lsNumber}.PDF`,
        content: fileBuffer,
        mimeType: 'application/pdf',
      };

      // Find the most recent plant_ls email for this LS to anchor the reply.
      const priorPlantLs = await prisma.email.findFirst({
        where: {
          loadingSlipId: loadingSlip.id,
          emailType: 'plant_ls',
        },
        orderBy: { sentAt: 'desc' },
        select: { id: true, gmailThreadId: true, gmailMessageId: true },
      });

      let sent: { messageId: string; threadId: string };
      if (priorPlantLs?.gmailThreadId && priorPlantLs.gmailMessageId) {
        try {
          const rfc822Id = await getMessageRfc822Id(priorPlantLs.gmailMessageId);
          if (rfc822Id) {
            sent = await sendReplyEmailWithAttachment(
              plantRecipient,
              subject,
              body,
              priorPlantLs.gmailThreadId,
              rfc822Id,
              attachment
            );
            console.log(`[ZLOAD2 Data] Sent updated LS ${lsNumber} to ${plantRecipient} (in-thread reply on email ${priorPlantLs.id})`);
          } else {
            sent = await sendEmail(plantRecipient, subject, body, attachment);
            console.log(`[ZLOAD2 Data] Sent updated LS ${lsNumber} to ${plantRecipient} (new thread — no rfc822Id for anchor)`);
          }
        } catch (replyErr) {
          console.warn(
            `[ZLOAD2 Data] in-thread send failed (${replyErr instanceof Error ? replyErr.message : replyErr}); falling back to new thread`
          );
          sent = await sendEmail(plantRecipient, subject, body, attachment);
        }
      } else {
        sent = await sendEmail(plantRecipient, subject, body, attachment);
        console.log(`[ZLOAD2 Data] Sent updated LS ${lsNumber} to ${plantRecipient} (new thread — no prior plant_ls found)`);
      }

      await prisma.email.create({
        data: {
          salesOrderId: loadingSlip.salesOrderId,
          loadingSlipId: loadingSlip.id,
          gmailMessageId: sent.messageId,
          gmailThreadId: sent.threadId,
          recipientEmail: plantRecipient,
          subject,
          status: 'sent',
          emailType: 'plant_ls',
          sentBody: body,
        },
      });

      try {
        const { emitEvent } = await import('@/lib/scenario-events');
        await emitEvent({
          salesOrderId: loadingSlip.salesOrderId,
          type: 'email_sent',
          payload: {
            emailType: 'plant_ls',
            recipient: plantRecipient,
            subject,
            ls_number: lsNumber,
            gmailMessageId: sent.messageId,
            updated_after: 'zload2',
          },
        });
      } catch {
        // Audit emission must never break the primary flow.
      }
    }
  } catch (sendErr) {
    console.error(
      `[ZLOAD2 Data] Failed to forward updated LS ${lsNumber} to plant:`,
      sendErr instanceof Error ? sendErr.message : sendErr
    );
    // Don't fail the upload — we still acked the SAP artifact. The operator
    // can resend manually if needed.
  }

  return NextResponse.json({
    received: true,
    persisted: true,
    lsNumber,
    soNumber,
    s3Key,
  });
}
