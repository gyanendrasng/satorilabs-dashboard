-- CreateTable
CREATE TABLE "invoice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "salesOrderId" TEXT NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "obdNumber" TEXT,
    "amount" DECIMAL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "lrNumber" TEXT,
    "lrDate" DATETIME,
    "vehicleNumber" TEXT,
    "shipmentType" TEXT,
    "plantCode" TEXT,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "invoice_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "sales_order" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_loading_slip_item" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "salesOrderId" TEXT NOT NULL,
    "lsNumber" TEXT NOT NULL,
    "material" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
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
INSERT INTO "new_loading_slip_item" ("accountPayableStatus", "createdAt", "deliveryStatus", "grnNumber", "hrjInvoiceNumber", "id", "invoiceQuantity", "invoiceWeight", "lrDate", "lrNumber", "lsNumber", "material", "materialDescription", "orderQuantity", "orderWeight", "outboundDeliveryNumber", "plantInvoiceDate", "plantInvoiceNumber", "receivedQuantity", "receivedWeight", "salesOrderId", "updatedAt", "vehicleNumber") SELECT "accountPayableStatus", "createdAt", "deliveryStatus", "grnNumber", "hrjInvoiceNumber", "id", "invoiceQuantity", "invoiceWeight", "lrDate", "lrNumber", "lsNumber", "material", "materialDescription", "orderQuantity", "orderWeight", "outboundDeliveryNumber", "plantInvoiceDate", "plantInvoiceNumber", "receivedQuantity", "receivedWeight", "salesOrderId", "updatedAt", "vehicleNumber" FROM "loading_slip_item";
DROP TABLE "loading_slip_item";
ALTER TABLE "new_loading_slip_item" RENAME TO "loading_slip_item";
CREATE UNIQUE INDEX "loading_slip_item_lsNumber_material_key" ON "loading_slip_item"("lsNumber", "material");
CREATE TABLE "new_purchase_order" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "poNumber" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'in-progress',
    "stage" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_purchase_order" ("createdAt", "customerName", "id", "poNumber", "updatedAt") SELECT "createdAt", "customerName", "id", "poNumber", "updatedAt" FROM "purchase_order";
DROP TABLE "purchase_order";
ALTER TABLE "new_purchase_order" RENAME TO "purchase_order";
CREATE UNIQUE INDEX "purchase_order_poNumber_key" ON "purchase_order"("poNumber");
CREATE TABLE "new_sales_order" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "soNumber" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "vehicleNumber" TEXT,
    "transportId" TEXT,
    "driverMobile" TEXT,
    "containerNumber" TEXT,
    "sealNumber" TEXT,
    "weight" DECIMAL,
    "containerType" TEXT,
    "deliveryLocations" TEXT,
    "specialInstructions" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "requiresInput" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "sales_order_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "purchase_order" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_sales_order" ("createdAt", "id", "purchaseOrderId", "soNumber", "transportId", "updatedAt", "vehicleNumber") SELECT "createdAt", "id", "purchaseOrderId", "soNumber", "transportId", "updatedAt", "vehicleNumber" FROM "sales_order";
DROP TABLE "sales_order";
ALTER TABLE "new_sales_order" RENAME TO "sales_order";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "invoice_salesOrderId_key" ON "invoice"("salesOrderId");
