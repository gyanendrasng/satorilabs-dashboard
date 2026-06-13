/**
 * Append-only chronological event log for the scenario engine.
 *
 * Every state transition inside the engine emits one ScenarioEvent. The
 * dashboard renders these as a timeline; the classifier reads them as
 * mid-flow context for the LLM.
 *
 * Append failures are swallowed and logged — event logging must never break
 * the engine's primary execution path.
 */
import { prisma } from './prisma';

export type ScenarioEventType =
  | 'email_received'
  | 'classifier_decision'
  | 'scenario_started'
  | 'step_fired'
  | 'step_completed'
  | 'email_sent'
  | 'scenario_completed'
  | 'scenario_aborted'
  | 'scenario_failed'
  // Emitted when an inbound reply is escalated to the human supervisor
  // (either via planner-emitted email_supervisor_question or a dispatcher
  // fallback when no actionable plan can be produced).
  | 'email_escalated'
  // Emitted when the engine's safety net auto-injects a step into a plan
  // because the planner produced an incomplete plan (e.g. zload2 without a
  // follow-on plant email). Surfaced loudly in logs; the audit event lets
  // the planner observe the fallback on its next plan call.
  | 'safety_net_injection';

export interface EmitEventArgs {
  salesOrderId: string;
  scenarioProgressId?: string | null;
  type: ScenarioEventType;
  payload: Record<string, unknown>;
}

export async function emitEvent(args: EmitEventArgs): Promise<void> {
  try {
    await prisma.scenarioEvent.create({
      data: {
        salesOrderId: args.salesOrderId,
        scenarioProgressId: args.scenarioProgressId ?? null,
        type: args.type,
        payload: JSON.stringify(args.payload),
      },
    });
  } catch (err) {
    console.error(
      `[ScenarioEvent] Failed to emit ${args.type} for SO ${args.salesOrderId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Fetch the last `limit` events for an SO, oldest-first. Used by the
 * classifier to give the LLM mid-flow context.
 */
export async function getRecentEventsForSO(args: {
  salesOrderId: string;
  limit?: number;
}): Promise<
  Array<{
    id: string;
    type: string;
    payload: Record<string, unknown>;
    createdAt: Date;
    scenarioProgressId: string | null;
  }>
> {
  const limit = args.limit ?? 50;
  const rows = await prisma.scenarioEvent.findMany({
    where: { salesOrderId: args.salesOrderId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  // Reverse to oldest-first for chronological presentation.
  return rows
    .map((r) => ({
      id: r.id,
      type: r.type,
      payload: safeParseJson(r.payload),
      createdAt: r.createdAt,
      scenarioProgressId: r.scenarioProgressId,
    }))
    .reverse();
}

function safeParseJson(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return { raw: s };
  }
}
