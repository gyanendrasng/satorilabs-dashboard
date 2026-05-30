import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

interface SAPResultRow {
  sales_order: string;
  material_doc?: string;
  delivery_no?: string;
  invoice_no?: string;
  invoice_date?: string;
  ls_number?: string;
  loaded_quantity?: number;
  status?: string;
}

/**
 * POST /backend/orders/aman/processing-data
 *
 * Receives the ZLOAD3-B1 result for ONE (Bundle, SO) request from auto_gui2.
 * SAP returns one OBD + one HRJ invoice per request, with per-LS rows that
 * carry material_doc + loaded_quantity. We persist:
 *
 *   • Shipment (one row per (Bundle, SO) pair) — obd, invoice no, invoice
 *     date, status, full JSON for forensics
 *   • LoadingSlipItem (per LS in the request) — sapMaterialDoc, sapLoadedQuantity
 *
 * Bundle context arrives via meta.bundle_id (auto_gui2's passthrough),
 * with a fallback to looking up the SO's only bundle if meta is absent.
 *
 * The legacy Invoice row is also upserted (per SO) so existing UI keeps
 * working until the dashboard pages migrate to read from Shipment.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();

    const rows: SAPResultRow[] = Array.isArray(body) ? body : body.items ?? body.data ?? [];
    if (!Array.isArray(rows) || rows.length === 0) {
      return NextResponse.json(
        { error: 'Expected items array or flat array of {sales_order, material_doc, delivery_no, invoice_no, ...}' },
        { status: 400 }
      );
    }

    // Resolve SO. Priority: body.so_number → meta.so_number → rows[0].sales_order → CurrentSO.
    const meta = (body && typeof body === 'object' && body.meta) || {};
    let soNumber: string | undefined =
      body.so_number ?? meta.so_number ?? rows[0]?.sales_order ?? undefined;
    if (!soNumber) {
      const currentSO = await prisma.currentSO.findFirst();
      soNumber = currentSO?.soNumber ?? undefined;
    }
    if (!soNumber) {
      return NextResponse.json(
        { error: 'Could not determine soNumber from payload, meta, rows, or CurrentSO' },
        { status: 400 }
      );
    }

    const salesOrder = await prisma.salesOrder.findFirst({
      where: { soNumber },
      include: { invoice: true, items: { include: { emails: true } } },
    });
    if (!salesOrder) {
      return NextResponse.json({ error: `Sales Order with soNumber '${soNumber}' not found` }, { status: 404 });
    }

    // Resolve bundle. Priority: body.bundle_id (auto-gui2 send_data flat-spreads
    // meta keys at the top level when `data` is a list — see gui_service.py:629)
    // → meta.bundle_id (kept for forward compat if it ever sends nested) → SO's
    // only bundle (if exactly one).
    let bundleId: string | null =
      ((body.bundle_id as string | undefined) ?? (meta?.bundle_id as string | undefined)) ?? null;
    if (!bundleId) {
      const bundles = await prisma.bundle.findMany({
        where: {
          purchaseOrderId: salesOrder.purchaseOrderId,
          items: { some: { salesOrderId: salesOrder.id } },
        },
        select: { id: true },
      });
      if (bundles.length === 1) {
        bundleId = bundles[0].id;
      }
    }

    // Per-request fields are repeated across rows; pick from rows[0].
    // The real auto_gui2 payload doesn't send invoice_date — fall back to
    // "now" so downstream UIs that show an invoice date still have a value.
    const obdNumber = rows[0]?.delivery_no ?? null;
    const invoiceNumber = rows[0]?.invoice_no ?? null;
    const rawDate = rows[0]?.invoice_date ?? null;
    const invoiceDate = rawDate ? new Date(rawDate) : new Date();

    // === Shipment: per (Bundle, SO) pair ===
    let shipment = null as null | { id: string };
    if (bundleId) {
      const upserted = await prisma.shipment.upsert({
        where: { bundleId_salesOrderId: { bundleId, salesOrderId: salesOrder.id } },
        update: {
          obdNumber,
          invoiceNumber,
          invoiceDate,
          sapResults: JSON.stringify(rows),
          status: 'created',
        },
        create: {
          bundleId,
          salesOrderId: salesOrder.id,
          obdNumber,
          invoiceNumber,
          invoiceDate,
          sapResults: JSON.stringify(rows),
          status: 'created',
        },
      });
      shipment = { id: upserted.id };
    } else {
      console.warn(`[ProcessingData] No bundle resolved for SO ${soNumber} — Shipment row not written`);
    }

    // === Per-LS fields on LoadingSlipItem ===
    //
    // The real auto_gui2 / ZLOAD3-B1 payload only carries
    // { sales_order, material_doc, delivery_no, invoice_no } per row — no
    // ls_number, no loaded_quantity. When ls_number is absent we positionally
    // map each row to one of the SO's existing LSI rows (scoped to the
    // bundle when known, ordered by createdAt asc). When loaded_quantity is
    // absent we fall back to LoadingSlipItem.orderQuantity so the audit/UI
    // still has a number to show.
    let lsiUpdated = 0;
    const needPositionalMapping = rows.some((r) => !r.ls_number);
    let positionalLsis: Array<{ id: string; lsNumber: string; orderQuantity: number | null }> = [];
    if (needPositionalMapping) {
      const where = bundleId
        ? { salesOrderId: salesOrder.id, bundleId }
        : { salesOrderId: salesOrder.id };
      const lsisInOrder = await prisma.loadingSlipItem.findMany({
        where,
        select: { id: true, lsNumber: true, orderQuantity: true },
        orderBy: { createdAt: 'asc' },
      });
      positionalLsis = lsisInOrder;
      console.warn(
        `[ProcessingData] ${rows.filter((r) => !r.ls_number).length}/${rows.length} row(s) missing ls_number — positional fallback against ${lsisInOrder.length} LSI(s) for SO ${soNumber}${bundleId ? ` bundle ${bundleId}` : ''}`
      );
    }
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      let lsNumber = r.ls_number;
      let positionalLsiId: string | null = null;
      let positionalOrderQty: number | null = null;
      if (!lsNumber) {
        const lsi = positionalLsis[i];
        if (!lsi) {
          console.warn(
            `[ProcessingData] row ${i} has no ls_number and no positional LSI match (positional list length ${positionalLsis.length}); skipping`
          );
          continue;
        }
        lsNumber = lsi.lsNumber;
        positionalLsiId = lsi.id;
        positionalOrderQty = lsi.orderQuantity;
      }
      const update: Record<string, unknown> = {};
      if (r.material_doc) update.sapMaterialDoc = r.material_doc;
      if (typeof r.loaded_quantity === 'number') {
        update.sapLoadedQuantity = r.loaded_quantity;
      } else if (positionalOrderQty !== null) {
        // No loaded_quantity in payload — fall back to the LSI's orderQuantity.
        update.sapLoadedQuantity = positionalOrderQty;
      }
      if (shipment) update.shipmentId = shipment.id;
      if (Object.keys(update).length === 0) continue;
      const res = positionalLsiId
        ? await prisma.loadingSlipItem.update({ where: { id: positionalLsiId }, data: update }).then(() => ({ count: 1 }))
        : await prisma.loadingSlipItem.updateMany({
            where: { salesOrderId: salesOrder.id, lsNumber },
            data: update,
          });
      lsiUpdated += res.count;
    }

    // === Legacy Invoice (back-compat — keep until UI migrates to Shipment) ===
    let invoice;
    if (salesOrder.invoice) {
      invoice = await prisma.invoice.update({
        where: { id: salesOrder.invoice.id },
        data: {
          ...(invoiceNumber && { invoiceNumber }),
          ...(obdNumber && { obdNumber }),
          sapResults: JSON.stringify(rows),
          status: 'created',
        },
      });
    } else {
      invoice = await prisma.invoice.create({
        data: {
          salesOrderId: salesOrder.id,
          invoiceNumber: invoiceNumber || 'PENDING',
          obdNumber,
          sapResults: JSON.stringify(rows),
          status: 'created',
        },
      });
    }

    // Mark replied emails processed and LSIs completed (scoped to bundle when known).
    const lsiWhere = bundleId
      ? { salesOrderId: salesOrder.id, bundleId }
      : { salesOrderId: salesOrder.id };
    const lsiList = await prisma.loadingSlipItem.findMany({
      where: lsiWhere,
      include: { emails: true },
    });
    for (const item of lsiList) {
      for (const email of item.emails) {
        if (email.status === 'replied') {
          await prisma.email.update({ where: { id: email.id }, data: { status: 'processed' } });
        }
      }
      await prisma.loadingSlipItem.update({ where: { id: item.id }, data: { status: 'completed' } });
    }

    // SO/PO completion is gated on VTO1N-B success, not on ZLOAD3-B1 result.
    // ZLOAD3-B1 only produces the OBD + invoice; the shipment hasn't been
    // created in SAP yet. The vto1n step-status callback flips the Shipment
    // to 'shipped' and, when ALL shipments for the SO are shipped, marks
    // the SO completed and bumps PO stage.

    return NextResponse.json({
      success: true,
      so_number: soNumber,
      bundle_id: bundleId,
      shipment_id: shipment?.id ?? null,
      message: shipment
        ? `Shipment ${shipment.id} saved (OBD ${obdNumber ?? '-'}, Invoice ${invoiceNumber ?? '-'}); ${lsiUpdated} LSI(s) updated.`
        : `Legacy: Invoice ${invoice.invoiceNumber} saved with ${rows.length} SAP result row(s).`,
      invoice,
    });
  } catch (error) {
    console.error('[Aman API 2 - Processing Data] Error:', error);
    return NextResponse.json(
      { error: 'Internal server error', details: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
