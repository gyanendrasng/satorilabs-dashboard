export interface LoadingSlipItem {
  id: string;
  salesOrderId: string;
  lsNumber: string;
  material: string;
  status: string;
  // Aman fields
  materialDescription: string | null;
  orderQuantity: number | null;
  orderWeight: string | null;
  grnNumber: string | null;
  // User input fields
  plantInvoiceNumber: string | null;
  plantInvoiceDate: string | null;
  invoiceQuantity: number | null;
  invoiceWeight: string | null;
  receivedQuantity: number | null;
  receivedWeight: string | null;
  deliveryStatus: string | null;
  accountPayableStatus: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Invoice {
  id: string;
  salesOrderId: string;
  invoiceNumber: string; // HRJ Invoice Number
  obdNumber: string | null; // Outbound Delivery Number
  amount: string | null;
  status: string;
  shipmentType: string | null;
  plantCode: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SalesOrder {
  id: string;
  soNumber: string;
  purchaseOrderId: string;
  vehicleNumber: string | null;
  transportId: string | null;
  driverMobile: string | null;
  containerNumber: string | null;
  sealNumber: string | null;
  weight: string | null;
  containerType: string | null;
  deliveryLocations: string | null;
  specialInstructions: string | null;
  lrNumber: string | null; // Lorry Receipt Number
  lrDate: string | null; // Lorry Receipt Date
  status: string;
  requiresInput: boolean;
  createdAt: string;
  updatedAt: string;
  items: LoadingSlipItem[];
  invoice: Invoice | null;
}

export interface PurchaseOrder {
  id: string;
  poNumber: string;
  customerName: string;
  status: string;
  stage: number;
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
