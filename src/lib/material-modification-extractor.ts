/**
 * Material modification extractor.
 *
 * Step executors that need a per-material modification list (va02, zload2,
 * zloading_close, email_2nd_release, email_to_branch_notifying_plant_change)
 * call this. It wraps the existing classifyBranchReply LLM call but exposes
 * a narrower contract: input is just the reply text + the target SO; output
 * is just the modification list.
 *
 * The planner never sees this module — extraction is the executor's job, not
 * the planner's. The planner emits step kinds; this fills in the data each
 * step needs at the moment it fires.
 */
import { prisma } from './prisma';
import { classifyBranchReply, type BranchReplyIntent } from './branch-reply-classifier';

export interface MaterialModification {
  material_code: string;
  /** undefined = "keep" (no change). */
  operation: 'increase' | 'decrease' | 'delete' | undefined;
  /** Quantity for increase/decrease. Undefined for delete and keep. */
  quantity: number | undefined;
}

export interface ExtractedModifications {
  /** All material lines mentioned by the reply (including 'keep'). */
  materials: MaterialModification[];
  /** Subset where operation === 'increase'. */
  increases: MaterialModification[];
  /** Subset where operation === 'decrease'. */
  decreases: MaterialModification[];
  /** Subset where operation === 'delete'. */
  deletes: MaterialModification[];
  /** Raw classifier reasoning, for audit. */
  reasoning: string;
  /** True iff at least one modification operation was extracted. */
  hasAnyModification: boolean;
}

export async function extractMaterialModifications(args: {
  salesOrderId: string;
  replyHtml: string;
}): Promise<ExtractedModifications> {
  const so = await prisma.salesOrder.findUnique({
    where: { id: args.salesOrderId },
    select: { soNumber: true },
  });

  // For the original-email context the existing extractor expects, we pass
  // an empty string. classifyBranchReply tolerates this — it'll just rely on
  // the reply text + target SO number for parsing.
  let cls: BranchReplyIntent;
  try {
    cls = await classifyBranchReply({
      originalEmailHtml: '',
      branchReplyHtml: args.replyHtml,
      salesOrder: so?.soNumber ?? '',
    });
  } catch (err) {
    console.warn(
      `[MOD_EXTRACTOR] classifyBranchReply failed for SO ${args.salesOrderId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {
      materials: [],
      increases: [],
      decreases: [],
      deletes: [],
      reasoning: '(extractor failed)',
      hasAnyModification: false,
    };
  }

  const materials: MaterialModification[] = cls.materials.map((m) => ({
    material_code: m.material_code,
    operation: m.operation && m.operation !== 'keep' ? m.operation : undefined,
    quantity: m.quantity > 0 ? m.quantity : undefined,
  }));

  return {
    materials,
    increases: materials.filter((m) => m.operation === 'increase'),
    decreases: materials.filter((m) => m.operation === 'decrease'),
    deletes: materials.filter((m) => m.operation === 'delete'),
    reasoning: cls.reasoning,
    hasAnyModification: materials.some((m) => m.operation !== undefined),
  };
}
