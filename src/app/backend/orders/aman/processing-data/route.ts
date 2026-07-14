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
 * Receives the ZLOAD3-B1 result for ONE bundle from auto_gui2. Each result row
 * is one loading slip and carries that LS's own HRJ invoice (invoice_no) plus
 * the OBD/delivery it landed on (delivery_no). A delivery can group several LSs,
 * and a bundle can have several deliveries, so we persist:
 *
 *   • LoadingSlip (per LS) — its own invoiceNumber, invoiceDate, obdNumber
 *   • Shipment (per DISTINCT OBD) — obd + representative invoice + status; the
 *     unit VT01N fires against (one call per OBD, unchanged)
 *   • LoadingSlipItem (per LS) — sapMaterialDoc, sapLoadedQuantity, shipmentId
 *
 * Bundle context arrives via meta.bundle_id (auto_gui2's passthrough), with a
 * fallback to the SO's only bundle if meta is absent.
 *
 * The legacy per-SO Invoice row is still upserted (coarse, from row 0) for
 * back-compat until the UI reads the per-LS invoices off LoadingSlip.
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
          // After the LoadingSlip refactor, a bundle reaches LSIs through
          // its LoadingSlips. Pick bundles that contain at least one LS for
          // this SO.
          loadingSlips: { some: { salesOrderId: salesOrder.id } },
        },
        select: { id: true },
      });
      if (bundles.length === 1) {
        bundleId = bundles[0].id;
      }
    }

    // === Per-LS invoice + per-OBD shipment ===
    // Each ZLOAD3 result row is ONE loading slip: it carries that LS's own HRJ
    // invoice (invoice_no) and the OBD/delivery it was placed on (delivery_no).
    // Domain facts: a single OBD can group several loading slips, and one
    // bundle/truck can carry several OBDs. So the invoice is stored PER LOADING
    // SLIP (LoadingSlip.invoiceNumber) and one Shipment is created PER DISTINCT
    // OBD (grouping the LSs on it) — the unit VT01N fires against. ZLOAD3 firing
    // itself (checkAndSendBatchToAman, per bundle) is unchanged.

    // Positional fallback: some payloads omit ls_number. Map row i → the i-th
    // LSI of this SO/bundle (createdAt asc) to recover its LS + qty.
    let lsiUpdated = 0;
    const needPositionalMapping = rows.some((r) => !r.ls_number);
    let positionalLsis: Array<{ id: string; lsNumber: string; orderQuantity: number | null }> = [];
    if (needPositionalMapping) {
      const where = bundleId
        ? { salesOrderId: salesOrder.id, loadingSlip: { bundleId } }
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

    // One Shipment per distinct OBD, created lazily as rows reference it.
    const shipmentByObd = new Map<string, string>(); // obd -> shipment.id
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

      // NOTE: per-LS invoice is intentionally NOT written to LoadingSlip yet.
      // The ZLOAD3 payload has no ls_number (rows are keyed by material_doc), so
      // pinning each invoice to a specific loading slip would be an unreliable
      // positional guess. The delivery/OBD + its invoices are captured on the
      // Shipment below; the per-LS invoice fields on LoadingSlip stay null until
      // the SAP LS→invoice mapping is supplied, then we backfill them reliably.

      // Resolve / lazily create the Shipment for this row's OBD (the VT01N unit).
      // Only when we know the bundle AND the row carries an OBD.
      let shipmentId: string | null = null;
      if (bundleId && r.delivery_no) {
        shipmentId = shipmentByObd.get(r.delivery_no) ?? null;
        if (!shipmentId) {
          const invDate = r.invoice_date ? new Date(r.invoice_date) : new Date();
          const sh = await prisma.shipment.upsert({
            where: { obdNumber: r.delivery_no },
            update: { bundleId, salesOrderId: salesOrder.id, invoiceNumber: r.invoice_no ?? null, invoiceDate: invDate, status: 'created' },
            create: { obdNumber: r.delivery_no, bundleId, salesOrderId: salesOrder.id, invoiceNumber: r.invoice_no ?? null, invoiceDate: invDate, status: 'created' },
          });
          shipmentId = sh.id;
          shipmentByObd.set(r.delivery_no, shipmentId);
        }
      } else if (!r.delivery_no) {
        console.warn(`[ProcessingData] LS ${lsNumber} row has no delivery_no (OBD) — no Shipment created for it.`);
      }

      // Per-LSI SAP fields + shipment link.
      const update: Record<string, unknown> = {};
      if (r.material_doc) update.sapMaterialDoc = r.material_doc;
      if (typeof r.loaded_quantity === 'number') {
        update.sapLoadedQuantity = r.loaded_quantity;
      } else if (positionalOrderQty !== null) {
        // No loaded_quantity in payload — fall back to the LSI's orderQuantity.
        update.sapLoadedQuantity = positionalOrderQty;
      }
      if (shipmentId) update.shipmentId = shipmentId;
      if (Object.keys(update).length === 0) continue;
      const res = positionalLsiId
        ? await prisma.loadingSlipItem.update({ where: { id: positionalLsiId }, data: update }).then(() => ({ count: 1 }))
        : await prisma.loadingSlipItem.updateMany({
            where: { salesOrderId: salesOrder.id, lsNumber },
            data: update,
          });
      lsiUpdated += res.count;
    }

    // Store each OBD's rows on its Shipment for forensics.
    for (const [obd, shipmentId] of shipmentByObd) {
      await prisma.shipment.update({
        where: { id: shipmentId },
        data: { sapResults: JSON.stringify(rows.filter((r) => r.delivery_no === obd)) },
      });
    }

    // === Legacy Invoice (per SO, back-compat — keep until UI reads per-LS) ===
    // Coarse: a single per-SO row from row 0. The per-LS truth now lives on
    // LoadingSlip; the per-OBD dispatch unit lives on Shipment.
    const legacyObd = rows[0]?.delivery_no ?? null;
    const legacyInvoiceNo = rows[0]?.invoice_no ?? null;
    let invoice;
    if (salesOrder.invoice) {
      invoice = await prisma.invoice.update({
        where: { id: salesOrder.invoice.id },
        data: {
          ...(legacyInvoiceNo && { invoiceNumber: legacyInvoiceNo }),
          ...(legacyObd && { obdNumber: legacyObd }),
          sapResults: JSON.stringify(rows),
          status: 'created',
        },
      });
    } else {
      invoice = await prisma.invoice.create({
        data: {
          salesOrderId: salesOrder.id,
          invoiceNumber: legacyInvoiceNo || 'PENDING',
          obdNumber: legacyObd,
          sapResults: JSON.stringify(rows),
          status: 'created',
        },
      });
    }

    // Mark replied emails processed and LSIs completed (scoped to bundle when
    // known). After the LoadingSlip refactor, LSIs reach a bundle via their
    // parent LS, so we join through loadingSlip.bundleId.
    const lsiWhere = bundleId
      ? { salesOrderId: salesOrder.id, loadingSlip: { bundleId } }
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
      shipment_ids: [...shipmentByObd.values()],
      message: shipmentByObd.size > 0
        ? `${shipmentByObd.size} shipment(s) saved for OBD(s) [${[...shipmentByObd.keys()].join(', ')}]; ${lsiUpdated} LSI(s) updated.`
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
