-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_chat" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'New Training Session',
    "mode" TEXT NOT NULL DEFAULT 'training',
    "lastMessageAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "chat_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_chat" ("createdAt", "id", "lastMessageAt", "title", "updatedAt", "userId") SELECT "createdAt", "id", "lastMessageAt", "title", "updatedAt", "userId" FROM "chat";
DROP TABLE "chat";
ALTER TABLE "new_chat" RENAME TO "chat";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
