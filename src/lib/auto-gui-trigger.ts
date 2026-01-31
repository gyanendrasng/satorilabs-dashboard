import { prisma } from './prisma';

const AUTO_GUI_HOST = process.env.AUTO_GUI_HOST || 'localhost';

/**
 * Check if all LoadingSlipItems for a SalesOrder have invoice data,
 * and trigger ZLOAD3 if they do.
 */
export async function checkAndTriggerZLOAD3(
  salesOrderId: string
): Promise<boolean> {
  // Get the sales order with all its loading slip items
  const salesOrder = await prisma.salesOrder.findUnique({
    where: { id: salesOrderId },
    include: {
      items: {
        include: {
          emails: true,
        },
      },
      purchaseOrder: true,
    },
  });

  if (!salesOrder) {
    console.error(`Sales order not found: ${salesOrderId}`);
    return false;
  }

  // Check if all items have invoice data
  const allItemsHaveInvoice = salesOrder.items.every(
    (item) =>
      item.plantInvoiceNumber &&
      item.plantInvoiceDate &&
      item.invoiceQuantity !== null
  );

  if (!allItemsHaveInvoice) {
    console.log(
      `Not all items for SO ${salesOrder.soNumber} have invoice data yet`
    );
    return false;
  }

  // Check if all emails are processed
  const allEmailsProcessed = salesOrder.items.every((item) =>
    item.emails.every((email) => email.status === 'processed')
  );

  if (!allEmailsProcessed) {
    console.log(
      `Not all emails for SO ${salesOrder.soNumber} are processed yet`
    );
    return false;
  }

  // Aggregate data for ZLOAD3
  const loadedQty = salesOrder.items.reduce(
    (sum, item) => sum + (item.invoiceQuantity || 0),
    0
  );

  // Use first item's invoice details (or could concatenate if different)
  const firstItemWithInvoice = salesOrder.items.find(
    (item) => item.plantInvoiceNumber
  );
  const invoiceNumber = firstItemWithInvoice?.plantInvoiceNumber || '';
  const invoiceDate = firstItemWithInvoice?.plantInvoiceDate
    ? formatDate(firstItemWithInvoice.plantInvoiceDate)
    : '';

  // Build instruction for ZLOAD3
  const instruction = `VPN is connected and SAP is logged in. Just go ahead and run the SAP Transaction ZLOAD3 for Sales order number ${salesOrder.soNumber}. Loaded quantity is ${loadedQty}, invoice number is ${invoiceNumber} and invoice date is ${invoiceDate}`;

  try {
    // Send request to auto_gui2
    const response = await fetch(`http://${AUTO_GUI_HOST}:8000/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        instruction,
        transaction_code: 'ZLOAD3',
      }),
    });

    if (!response.ok) {
      throw new Error(`auto_gui2 request failed: ${response.statusText}`);
    }

    console.log(
      `ZLOAD3 triggered for SO ${salesOrder.soNumber}: ${instruction}`
    );

    // Update sales order status/stage
    await prisma.salesOrder.update({
      where: { id: salesOrderId },
      data: {
        status: 'completed',
      },
    });

    // Update purchase order stage if needed
    await updatePurchaseOrderStage(salesOrder.purchaseOrderId);

    return true;
  } catch (error) {
    console.error(
      `Failed to trigger ZLOAD3 for SO ${salesOrder.soNumber}:`,
      error
    );
    return false;
  }
}

/**
 * Format date as DD.MM.YYYY for SAP
 */
function formatDate(date: Date): string {
  const d = new Date(date);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}.${month}.${year}`;
}

/**
 * Update purchase order stage based on all sales orders status
 */
async function updatePurchaseOrderStage(
  purchaseOrderId: string
): Promise<void> {
  const purchaseOrder = await prisma.purchaseOrder.findUnique({
    where: { id: purchaseOrderId },
    include: {
      salesOrders: true,
    },
  });

  if (!purchaseOrder) {
    return;
  }

  // Check if all sales orders are completed
  const allCompleted = purchaseOrder.salesOrders.every(
    (so) => so.status === 'completed'
  );

  if (allCompleted) {
    // Move to next stage (current stage + 1, max 6)
    const nextStage = Math.min(purchaseOrder.stage + 1, 6);
    await prisma.purchaseOrder.update({
      where: { id: purchaseOrderId },
      data: {
        stage: nextStage,
        status: nextStage === 6 ? 'completed' : 'in-progress',
      },
    });
  }
}
