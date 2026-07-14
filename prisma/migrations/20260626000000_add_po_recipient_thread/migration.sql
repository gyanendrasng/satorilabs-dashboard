-- Branch single-subject reuse: store the NEW ORDER subject on the PO so every
-- branch outbound replies as "Re: <branchSubject>" into one conversation.
ALTER TABLE "purchase_order" ADD COLUMN "branchSubject" TEXT;

-- Per-(PO, recipient) Gmail thread anchor for PLANT (one thread per plant a PO
-- dispatches from) and PRODUCTION (one thread per PO). Branch stays on the
-- purchase_order.branchThreadId/branchSubject columns.
CREATE TABLE "po_recipient_thread" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "purchaseOrderId" TEXT NOT NULL,
    "recipientEmail" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "anchorMsgId" TEXT,
    "subject" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "po_recipient_thread_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "purchase_order" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "po_recipient_thread_purchaseOrderId_recipientEmail_key" ON "po_recipient_thread"("purchaseOrderId", "recipientEmail");
