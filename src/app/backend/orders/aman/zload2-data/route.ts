import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { uploadToS3 } from '@/lib/s3';

/**
 * POST /backend/orders/aman/zload2-data
 *
 * Receives the regenerated LS PDF from auto_gui2 after a ZLOAD2 run modifies
 * an existing loading slip in SAP. Mirrors the ZLOAD2 send_data callback
 * contract documented in BACKEND_ENDPOINTS.md §3.2.
 *
 * Why this is its own endpoint (not /zload1-data):
 *   - ZLOAD1 creates a brand-new LS → must create LoadingSlip + LSI rows.
 *   - ZLOAD2 modifies an existing LS → LoadingSlip already exists; the LSI
 *     rows were already updated by the scenario engine before ZLOAD2 fired.
 *     The PDF returned here is the authoritative SAP confirmation; we just
 *     swap in the new fileUrl.
 *
 * Expected payload: multipart/form-data
 *   file          : the regenerated LS PDF
 *                   filename = "<lsNumber>.PDF" (SAP may zero-pad to 10 digits,
 *                   e.g. "0000373283.PDF")
 *   so_number     : (form field, optional) — pass-through from meta
 *   work_id       : (form field, optional) — pass-through from meta
 *   ...           : any other meta fields are accepted and logged but ignored
 *
 * Completion of the SAP run itself is reported separately on /step-status —
 * the work_id transitions to `done` there. This endpoint is purely the
 * artifact upload; returning 2xx is enough.
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

  // Log every form field so we can see what auto_gui2 actually sent.
  for (const [k, v] of formData.entries()) {
    if (v instanceof Blob) {
      console.log(`[ZLOAD2 Data] field "${k}": Blob size=${v.size} type=${v.type} name=${(v as { name?: string }).name ?? '(none)'}`);
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

  // Extract LS number from filename. SAP can zero-pad to 10 digits
  // (e.g. "0000373283.PDF") — strip leading zeros to match LoadingSlip.lsNumber.
  const rawName = (file as { name?: string }).name ?? '';
  const stem = rawName.replace(/\.[^.]+$/, '').trim();
  const lsNumber = stem.replace(/^0+/, '');
  if (!lsNumber) {
    return NextResponse.json(
      { error: `Could not extract LS number from filename "${rawName}"` },
      { status: 400 }
    );
  }

  const loadingSlip = await prisma.loadingSlip.findUnique({
    where: { lsNumber },
    select: { id: true, lsNumber: true, salesOrderId: true, fileUrl: true },
  });
  if (!loadingSlip) {
    // Don't fail loudly — the SAP run succeeded; not having a row to update
    // is a data-consistency issue we want to see but not crash on. Auto-gui2
    // treats anything 2xx as success.
    console.warn(
      `[ZLOAD2 Data] No LoadingSlip row for lsNumber=${lsNumber} (filename "${rawName}", so=${soNumberField ?? 'n/a'}, work_id=${workIdField ?? 'n/a'}) — PDF will not be persisted`
    );
    return NextResponse.json(
      { received: true, persisted: false, reason: `LoadingSlip ${lsNumber} not found` },
      { status: 200 }
    );
  }

  // Resolve SO number for the R2 key. Prefer the form field (saves a query);
  // fall back to the LoadingSlip → SalesOrder relation.
  let soNumber = soNumberField;
  if (!soNumber) {
    const so = await prisma.salesOrder.findUnique({
      where: { id: loadingSlip.salesOrderId },
      select: { soNumber: true },
    });
    soNumber = so?.soNumber ?? 'unknown';
  }

  // Upload to R2. Key matches the ZLOAD1 layout (ls-pdfs/<soNumber>/<lsNumber>.PDF)
  // so subsequent readers (plant_ls sender, parsers) see one canonical PDF
  // per LS regardless of whether it came from ZLOAD1 or a later ZLOAD2.
  const s3Key = `ls-pdfs/${soNumber}/${lsNumber}.PDF`;
  try {
    const buf = Buffer.from(await file.arrayBuffer());
    await uploadToS3(s3Key, buf, 'application/pdf');
    console.log(`[ZLOAD2 Data] Uploaded regenerated LS PDF to R2: ${s3Key} (${buf.length} bytes)`);
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

  // The corresponding ZLOAD2 step_completed audit event is emitted by
  // /step-status when auto_gui2 acks the work_id. We don't double-emit here.

  return NextResponse.json({
    received: true,
    persisted: true,
    lsNumber,
    soNumber,
    s3Key,
  });
}
