/*
  Warnings:

  - You are about to drop the column `lrDate` on the `invoice` table. All the data in the column will be lost.
  - You are about to drop the column `lrNumber` on the `invoice` table. All the data in the column will be lost.
  - You are about to drop the column `vehicleNumber` on the `invoice` table. All the data in the column will be lost.
  - You are about to drop the column `hrjInvoiceNumber` on the `loading_slip_item` table. All the data in the column will be lost.
  - You are about to drop the column `lrDate` on the `loading_slip_item` table. All the data in the column will be lost.
  - You are about to drop the column `lrNumber` on the `loading_slip_item` table. All the data in the column will be lost.
  - You are about to drop the column `outboundDeliveryNumber` on the `loading_slip_item` table. All the data in the column will be lost.
  - You are about to drop the column `vehicleNumber` on the `loading_slip_item` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "sales_order" ADD COLUMN "lrDate" DATETIME;
ALTER TABLE "sales_order" ADD COLUMN "lrNumber" TEXT;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_invoice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "salesOrderId" TEXT NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "obdNumber" TEXT,
    "amount" DECIMAL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "shipmentType" TEXT,
    "plantCode" TEXT,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "invoice_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "sales_order" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_invoice" ("amount", "createdAt", "id", "invoiceNumber", "notes", "obdNumber", "plantCode", "salesOrderId", "shipmentType", "status", "updatedAt") SELECT "amount", "createdAt", "id", "invoiceNumber", "notes", "obdNumber", "plantCode", "salesOrderId", "shipmentType", "status", "updatedAt" FROM "invoice";
DROP TABLE "invoice";
ALTER TABLE "new_invoice" RENAME TO "invoice";
CREATE UNIQUE INDEX "invoice_salesOrderId_key" ON "invoice"("salesOrderId");
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
    "plantInvoiceNumber" TEXT,
    "plantInvoiceDate" DATETIME,
    "invoiceQuantity" INTEGER,
    "invoiceWeight" DECIMAL,
    "receivedQuantity" INTEGER,
    "receivedWeight" DECIMAL,
    "deliveryStatus" TEXT,
    "accountPayableStatus" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "loading_slip_item_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "sales_order" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_loading_slip_item" ("accountPayableStatus", "createdAt", "deliveryStatus", "grnNumber", "id", "invoiceQuantity", "invoiceWeight", "lsNumber", "material", "materialDescription", "orderQuantity", "orderWeight", "plantInvoiceDate", "plantInvoiceNumber", "receivedQuantity", "receivedWeight", "salesOrderId", "status", "updatedAt") SELECT "accountPayableStatus", "createdAt", "deliveryStatus", "grnNumber", "id", "invoiceQuantity", "invoiceWeight", "lsNumber", "material", "materialDescription", "orderQuantity", "orderWeight", "plantInvoiceDate", "plantInvoiceNumber", "receivedQuantity", "receivedWeight", "salesOrderId", "status", "updatedAt" FROM "loading_slip_item";
DROP TABLE "loading_slip_item";
ALTER TABLE "new_loading_slip_item" RENAME TO "loading_slip_item";
CREATE UNIQUE INDEX "loading_slip_item_lsNumber_material_key" ON "loading_slip_item"("lsNumber", "material");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
