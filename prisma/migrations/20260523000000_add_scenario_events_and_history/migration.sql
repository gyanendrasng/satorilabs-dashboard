-- Drop the unique constraint on scenario_progress.salesOrderId to allow
-- multiple scenario runs per SalesOrder (history is preserved for audit).
DROP INDEX IF EXISTS "scenario_progress_salesOrderId_key";

-- New composite index used by the engine to find the active scenario for an SO:
--   SELECT * FROM scenario_progress
--   WHERE salesOrderId = ? AND state NOT IN ('completed','aborted','failed')
--   ORDER BY createdAt DESC LIMIT 1
CREATE INDEX IF NOT EXISTS "scenario_progress_salesOrderId_state_idx"
  ON "scenario_progress" ("salesOrderId", "state");

-- CreateTable: scenario_event (append-only chronological log)
CREATE TABLE "scenario_event" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "salesOrderId" TEXT NOT NULL,
    "scenarioProgressId" TEXT,
    "type" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "scenario_event_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "sales_order" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "scenario_event_scenarioProgressId_fkey" FOREIGN KEY ("scenarioProgressId") REFERENCES "scenario_progress" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- Index for the dashboard timeline query: events for an SO ordered by createdAt
CREATE INDEX "scenario_event_salesOrderId_createdAt_idx" ON "scenario_event"("salesOrderId", "createdAt");
