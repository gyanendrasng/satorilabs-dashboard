-- AlterTable: add intentLabel column to sales_order (nullable, no backfill needed)
ALTER TABLE "sales_order" ADD COLUMN "intentLabel" TEXT;

-- CreateTable: scenario_progress (one active scenario per SalesOrder)
CREATE TABLE "scenario_progress" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "salesOrderId" TEXT NOT NULL,
    "scenarioKey" TEXT NOT NULL,
    "currentStepIndex" INTEGER NOT NULL DEFAULT 0,
    "state" TEXT NOT NULL DEFAULT 'ready',
    "classifierOutput" TEXT NOT NULL,
    "triggerEmailId" TEXT,
    "lastWorkId" TEXT,
    "lastEmailId" TEXT,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "scenario_progress_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "sales_order" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex: one active scenario per SalesOrder
CREATE UNIQUE INDEX "scenario_progress_salesOrderId_key" ON "scenario_progress"("salesOrderId");

-- CreateIndex: sweep idle/awaiting scenarios from cron
CREATE INDEX "scenario_progress_state_updatedAt_idx" ON "scenario_progress"("state", "updatedAt");
