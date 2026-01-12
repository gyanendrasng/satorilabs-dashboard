-- CreateTable
CREATE TABLE "purchase_order" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "poNumber" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "sales_order" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "soNumber" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "vehicleNumber" TEXT,
    "transportId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "sales_order_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "purchase_order" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "loading_slip_item" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "salesOrderId" TEXT NOT NULL,
    "lsNumber" TEXT NOT NULL,
    "material" TEXT NOT NULL,
    "materialDescription" TEXT,
    "orderQuantity" INTEGER,
    "orderWeight" DECIMAL,
    "grnNumber" TEXT,
    "hrjInvoiceNumber" TEXT,
    "outboundDeliveryNumber" TEXT,
    "plantInvoiceNumber" TEXT,
    "plantInvoiceDate" DATETIME,
    "invoiceQuantity" INTEGER,
    "invoiceWeight" DECIMAL,
    "receivedQuantity" INTEGER,
    "receivedWeight" DECIMAL,
    "lrNumber" TEXT,
    "lrDate" DATETIME,
    "vehicleNumber" TEXT,
    "deliveryStatus" TEXT,
    "accountPayableStatus" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "loading_slip_item_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "sales_order" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "purchase_order_poNumber_key" ON "purchase_order"("poNumber");

-- CreateIndex
CREATE UNIQUE INDEX "loading_slip_item_lsNumber_material_key" ON "loading_slip_item"("lsNumber", "material");
