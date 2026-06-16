/**
 * BACKWARD-COMPAT SHIM (Phase 1 of unified-classifier rollout).
 *
 * The function `selectScenarioForReply` used to live here as the only LLM
 * classifier. It has been replaced by the unified `classifyReply` in
 * src/lib/reply-classifier.ts, which returns a tagged-union covering all
 * inbound email intents (scenarios, yes/no decisions, vehicle extraction,
 * NEW ORDER, supervisor escalation, etc.).
 *
 * This shim preserves the old signature so existing callers (scenario-engine,
 * test harness, etc.) keep working until the dispatcher is wired up in
 * Phase 2. The shim:
 *   - Forwards args to classifyReply with appropriate triggerEmailType.
 *   - Projects the union back to the old ScenarioSelection shape.
 *   - Non-scenario classifications (a possibility once the new prompt is in
 *     place) are coerced to scenario_key='unknown' with an escalate_reason
 *     that names the rejected action — preserving the old "unknown →
 *     escalate" contract used by the engine today.
 */
import {
  classifyReply,
  type ClassifierActiveScenario,
  type ClassifierMaterial,
  type ClassifierValidKey,
} from './reply-classifier';
import type { Stage } from './dispatch-scenarios';

// -----------------------------------------------------------------------------
// Legacy output type — kept so existing callers compile unchanged.
// -----------------------------------------------------------------------------

export interface ScenarioSelection {
  scenario_key: string;
  reasoning: string;
  escalate_reason?: string;
  materials: Array<{
    material_code: string;
    batch: string;
    operation?: 'keep' | 'increase' | 'decrease' | 'delete';
    quantity: number;
  }>;
  action_on_active?: 'abort_and_replace' | 'escalate' | null;
}

// Legacy aliases — some callers imported these names.
export type SelectorMaterial = ClassifierMaterial;
export type SelectorValidKey = ClassifierValidKey;
export type SelectorActiveScenario = ClassifierActiveScenario;

export async function selectScenarioForReply(args: {
  soNumber: string;
  sender: 'branch' | 'plant';
  stage: Stage;
  emailThread: string;
  materials: SelectorMaterial[];
  validKeys: SelectorValidKey[];
  activeScenario?: SelectorActiveScenario | null;
  /** Optional — passed through to the unified classifier for better routing. */
  triggerEmailType?: string;
}): Promise<ScenarioSelection> {
  const cls = await classifyReply({
    soNumber: args.soNumber,
    sender: args.sender,
    stage: args.stage,
    emailThread: args.emailThread,
    materials: args.materials,
    validKeys: args.validKeys,
    triggerEmailType: args.triggerEmailType ?? null,
    activeScenario: args.activeScenario ?? null,
  });

  if (cls.action === 'scenario') {
    return {
      scenario_key: cls.scenario_key,
      reasoning: cls.reasoning,
      escalate_reason: cls.escalate_reason,
      materials: cls.materials,
      action_on_active: cls.action_on_active ?? null,
    };
  }

  // Non-scenario classifications are unreachable for callers using this shim
  // *as long as* the LLM keeps picking 'scenario' for the kinds of emails
  // this shim is invoked on (all scenario-shaped today). If a future caller
  // accidentally routes a non-scenario email through here, coerce to unknown
  // so the engine takes its existing escalation path.
  return {
    scenario_key: 'unknown',
    reasoning: 'reasoning' in cls ? (cls as { reasoning?: string }).reasoning ?? '' : '',
    escalate_reason: `Unified classifier picked action="${cls.action}" but legacy caller expected scenario`,
    materials: [],
    action_on_active: args.activeScenario ? 'escalate' : null,
  };
}
