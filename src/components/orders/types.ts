export interface LoadingSlipItem {
  id: string;
  salesOrderId: string;
  lsNumber: string;
  material: string;
  materialDescription: string | null;
  orderQuantity: number | null;
  orderWeight: string | null;
  grnNumber: string | null;
  hrjInvoiceNumber: string | null;
  outboundDeliveryNumber: string | null;
  plantInvoiceNumber: string | null;
  plantInvoiceDate: string | null;
  invoiceQuantity: number | null;
  invoiceWeight: string | null;
  receivedQuantity: number | null;
  receivedWeight: string | null;
  lrNumber: string | null;
  lrDate: string | null;
  vehicleNumber: string | null;
  deliveryStatus: string | null;
  accountPayableStatus: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SalesOrder {
  id: string;
  soNumber: string;
  purchaseOrderId: string;
  vehicleNumber: string | null;
  transportId: string | null;
  createdAt: string;
  updatedAt: string;
  items: LoadingSlipItem[];
}

export interface PurchaseOrder {
  id: string;
  poNumber: string;
  customerName: string;
  createdAt: string;
  updatedAt: string;
  salesOrders: SalesOrder[];
}

// Group items by lsNumber
export function groupItemsByLsNumber(items: LoadingSlipItem[]): Map<string, LoadingSlipItem[]> {
  const groups = new Map<string, LoadingSlipItem[]>();
  for (const item of items) {
    const existing = groups.get(item.lsNumber) || [];
    existing.push(item);
    groups.set(item.lsNumber, existing);
  }
  return groups;
}
