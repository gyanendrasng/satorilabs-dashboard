-- Add nullable plant column to sales_order. Used to scope free-stock
-- pre-check against the synced inventory_snapshot table. Falls back to
-- SAP_DEFAULT_PLANT env var when null.
ALTER TABLE "sales_order" ADD COLUMN "plant" TEXT;

-- CreateTable: inventory_snapshot — free-stock per (material, plant) from
-- the SAP 2-hourly CSV. Upserted on every sync; one row per material+plant.
CREATE TABLE "inventory_snapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "material" TEXT NOT NULL,
    "materialDescription" TEXT,
    "vertical" TEXT,
    "plant" TEXT NOT NULL,
    "freeStock" INTEGER NOT NULL,
    "syncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "inventory_snapshot_material_plant_key" ON "inventory_snapshot"("material", "plant");
CREATE INDEX "inventory_snapshot_material_idx" ON "inventory_snapshot"("material");

-- CreateTable: inventory_sync_state — singleton tracking the latest CSV
-- file label we've ingested, so subsequent polls can short-circuit.
CREATE TABLE "inventory_sync_state" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "lastFileLabel" TEXT,
    "lastSyncedAt" DATETIME NOT NULL
);
