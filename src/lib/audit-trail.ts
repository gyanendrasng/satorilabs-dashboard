/**
 * Renders the per-SO audit trail as a compact event timeline for the
 * classifier prompt.
 *
 * Source: the `scenario_event` table (append-only log emitted by the engine).
 *
 * Output format — one line per event, oldest-first, timestamps as deltas
 * from the SO's first event:
 *
 *   [T+0:00:00] email_received      from branch@x.com — Subject "NEW ORDER 3260642"
 *   [T+0:00:02] classifier_decision Branch Email | Before LS Creation | New SO
 *   [T+0:00:02] scenario_started    Branch Email - Before LS Creation - New SO
 *   [T+0:00:03] step_fired          ZSO Visibility + Zmatana
 *   [T+0:01:14] step_completed      ZSO Visibility + Zmatana ✓
 *   [T+0:01:14] email_sent          ls_dispatch to branch@x.com
 *   [T+0:01:14] scenario_completed
 *
 * Used by `classifyReply` to give the LLM full workflow state, not just the
 * latest email. With this in context the classifier can reason "ZLOAD1
 * already fired, so 'Release All' is no longer valid — must be a
 * modification."
 */
import { getRecentEventsForSO } from './scenario-events';

interface RenderOpts {
  salesOrderId: string;
  maxEvents?: number; // default 60
}

export async function renderAuditTrailForSO(opts: RenderOpts): Promise<string> {
  const maxEvents = opts.maxEvents ?? 60;
  const events = await getRecentEventsForSO({
    salesOrderId: opts.salesOrderId,
    limit: maxEvents,
  });

  if (events.length === 0) return '(no prior actions on this SO yet)';

  const t0 = events[0].createdAt.getTime();
  const lines: string[] = [];
  for (const e of events) {
    const dt = e.createdAt.getTime() - t0;
    const tag = formatDelta(dt);
    const typePadded = e.type.padEnd(20);
    const summary = summarizePayload(e.type, e.payload);
    lines.push(`${tag} ${typePadded} ${summary}`);
  }
  return lines.join('\n');
}

function formatDelta(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `[T+${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}]`;
}

function summarizePayload(type: string, p: Record<string, unknown>): string {
  switch (type) {
    case 'email_received': {
      const from = String(p.from ?? p.sender ?? '?');
      const subject = truncate(String(p.subject ?? ''), 60);
      const excerpt = truncate(String(p.body_excerpt ?? p.replyBody ?? ''), 80);
      return `from ${from}${subject ? ` — Subject "${subject}"` : ''}${excerpt ? ` — "${excerpt}"` : ''}`;
    }
    case 'classifier_decision': {
      const action = p.action ? String(p.action) : null;
      const scen = p.scenario_key ? String(p.scenario_key) : null;
      const intent = p.primaryIntent ? String(p.primaryIntent) : null;
      const aug = p.augmentedIntent ? String(p.augmentedIntent) : null;
      if (aug) return aug;
      if (scen) return scen;
      if (intent) return intent;
      if (action) return `action=${action}`;
      return '(no classification fields)';
    }
    case 'scenario_started':
      return String(p.scenario_key ?? p.augmentedIntent ?? '?');
    case 'step_fired':
    case 'step_completed': {
      const kind = String(p.kind ?? p.stepName ?? '?');
      const ok = type === 'step_completed' ? ' ✓' : '';
      const sap = type === 'step_completed' && p.sap_output
        ? ' — ' + summariseSapOutput(p.sap_output as Record<string, unknown>)
        : '';
      // bundle_capacity_assessment writes its verdicts onto the
      // step_completed payload (not sap_output, since it's engine-side, not
      // a SAP txn). Surface them so the planner can route per-item on its
      // next plan call. Without this the trail just shows the step ran and
      // the planner has no signal to advance off Rule 6e — it re-emits
      // bundle_capacity_assessment indefinitely.
      const verdicts = type === 'step_completed' && kind === 'bundle_capacity_assessment'
        ? ' — verdicts: ' + summariseBundleVerdicts(p.verdicts)
        : '';
      return `${kind}${ok}${sap}${verdicts}`;
    }
    case 'email_sent': {
      const recipient = String(p.recipient ?? p.to ?? '?');
      const emailType = String(p.emailType ?? '?');
      const subject = truncate(String(p.subject ?? ''), 60);
      return `${emailType} to ${recipient}${subject ? ` — "${subject}"` : ''}`;
    }
    case 'scenario_completed':
      return String(p.scenario_key ?? p.augmentedIntent ?? 'completed');
    case 'scenario_aborted':
      return `reason: ${truncate(String(p.reason ?? p.error ?? ''), 80)}`;
    case 'scenario_failed':
      return `error: ${truncate(String(p.error ?? ''), 80)}`;
    case 'email_escalated':
      return `to supervisor: ${truncate(String(p.description ?? p.suggested_question_for_supervisor ?? ''), 80)}`;
    default:
      // Fall back to a one-line JSON squish.
      return truncate(JSON.stringify(p), 100);
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

/**
 * One-line summary of bundle_capacity_assessment verdicts. The shape matches
 * what `assessPostLsIncrease` writes onto the step_completed payload:
 *   `[{material, verdict, bundleId?, remainingKg?}, ...]`
 *
 * The planner uses this to choose the per-item path on its next plan call
 * (fits_same_bundle → zload2; fits_other_bundle → zload1 append;
 *  needs_new_so → email_branch_request_new_so). If verdicts are missing
 * from the rendered audit, the planner re-emits bundle_capacity_assessment
 * forever — see Rule 6e in llm-planner.ts.
 */
function summariseBundleVerdicts(v: unknown): string {
  if (!Array.isArray(v) || v.length === 0) return '(no verdicts)';
  const parts: string[] = [];
  for (const row of v) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const material = String(r.material ?? '?');
    const verdict = String(r.verdict ?? '?');
    const bundleId = typeof r.bundleId === 'string' ? r.bundleId : null;
    const remainingKg = typeof r.remainingKg === 'number' ? r.remainingKg : null;
    // The engine stamps the deltaKg the planner asked the assessment to
    // evaluate. Surface it so the planner can tell two assessments apart
    // by quantity (e.g. "verdict for the 209-unit ask vs the 202-unit ask").
    const assessedDeltaKg = typeof r.assessedDeltaKg === 'number' ? r.assessedDeltaKg : null;
    const extras: string[] = [];
    if (assessedDeltaKg !== null) extras.push(`assessedDeltaKg=${assessedDeltaKg}`);
    if (bundleId) extras.push(`bundleId=${bundleId}`);
    if (remainingKg !== null) extras.push(`remainingKg=${remainingKg}`);
    const tail = extras.length > 0 ? `(${extras.join(', ')})` : '';
    parts.push(`${material}=${verdict}${tail}`);
  }
  return parts.join(', ') || '(no verdicts)';
}

/**
 * One-line summary of a step's SAP output payload. Matches the shapes
 * produced by `collectSapOutputForStep` in scenario-engine.ts. Keep this
 * compact — it lands in the classifier's prompt next to the timeline.
 */
function summariseSapOutput(o: Record<string, unknown>): string {
  // ZLOAD1/ZLOAD2/ZLOAD_Delete shape — { ls_count, loading_slips: [...] }
  if (Array.isArray(o.loading_slips)) {
    const slips = o.loading_slips as Array<{ ls?: unknown; material?: unknown; quantity?: unknown }>;
    const sample = slips
      .slice(0, 3)
      .map((s) => `${s.ls ?? '?'}:${s.material ?? '?'}=${s.quantity ?? '?'}`)
      .join(', ');
    const more = slips.length > 3 ? `, +${slips.length - 3} more` : '';
    return `LS ${sample}${more}`;
  }
  // VA02/ZSO_Visibility shape — { materials: [{material, ordered, dispatch|available}] }
  if (Array.isArray(o.materials)) {
    const mats = o.materials as Array<{ material?: unknown; ordered?: unknown; dispatch?: unknown; available?: unknown }>;
    const sample = mats
      .slice(0, 3)
      .map((m) => {
        const value = m.dispatch ?? m.available ?? '?';
        return `${m.material ?? '?'}=${value}`;
      })
      .join(', ');
    const more = mats.length > 3 ? `, +${mats.length - 3} more` : '';
    return `materials ${sample}${more}`;
  }
  // ZLOAD3/Invoice shape — { invoice_number, obd_number, amount }
  if (typeof o.invoice_number === 'string') {
    const parts: string[] = [`invoice=${o.invoice_number}`];
    if (o.obd_number) parts.push(`obd=${o.obd_number}`);
    if (o.amount) parts.push(`amount=${o.amount}`);
    return parts.join(' ');
  }
  // VT01N/Shipment shape — { shipment_count, shipments: [...] }
  if (Array.isArray(o.shipments)) {
    const ships = o.shipments as Array<{ obd?: unknown; status?: unknown }>;
    const sample = ships
      .slice(0, 2)
      .map((s) => `${s.obd ?? '?'}:${s.status ?? '?'}`)
      .join(', ');
    const more = ships.length > 2 ? `, +${ships.length - 2} more` : '';
    return `shipments ${sample}${more}`;
  }
  return truncate(JSON.stringify(o), 80);
}
