-- Supervisor-escalation columns on the Email model. Used by the unified
-- LLM reply classifier: when it returns action='other', the engine sends
-- a `supervisor_inquiry` email and flags the trigger row here. The hop
-- counter prevents infinite supervisor-loop on broken threads.
ALTER TABLE "email" ADD COLUMN "awaitingSupervisor" BOOLEAN NOT NULL DEFAULT 0;
ALTER TABLE "email" ADD COLUMN "supervisorHops" INTEGER NOT NULL DEFAULT 0;
