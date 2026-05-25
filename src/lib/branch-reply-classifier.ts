import OpenAI from 'openai';
import { z } from 'zod';

// Existing per-material entry. Optional `operation` is added for the new
// 'modify' intent; legacy callers ignore it.
const MaterialSchema = z.object({
  material_code: z.string(),
  batch: z.string().default(''),
  quantity: z.number().default(0),
  // 'keep' = no change, 'increase'/'decrease' = new quantity to set,
  // 'delete' = remove the line. Populated only for `intent: 'modify'`.
  operation: z.enum(['keep', 'increase', 'decrease', 'delete']).optional(),
});

const ClassificationSchema = z.object({
  sales_order: z.string().default(''),
  intent: z.enum(['release_all', 'release_part', 'wait', 'modify']),
  // Populated only when intent === 'modify'. Encodes which combination of
  // operations the branch is requesting so the engine can resolve to a row in
  // the spreadsheet lookup table.
  modification: z
    .enum(['increase', 'decrease', 'delete', 'inc_dec', 'inc_del', 'dec_del'])
    .optional(),
  materials: z.array(MaterialSchema).default([]),
  missing_materials: z.array(z.string()).default([]),
  reasoning: z.string().default(''),
});

export type BranchReplyIntent = z.infer<typeof ClassificationSchema>;

/**
 * Classify a branch reply to a dispatch (ls_dispatch) email — locally,
 * replacing the auto_gui2 /email/branch-reply call.
 *
 * Returns one of:
 *   release_all   — branch accepts ALL materials, proceed with full dispatch.
 *   release_part  — branch accepts SOME materials only.
 *   wait          — branch wants to wait for materials to become available.
 *   modify        — branch requests a quantity change (increase/decrease/delete
 *                   one or more line items). Carries a `modification` label.
 *
 * The legacy callers (handleBranchReply) only read intent + materials +
 * missing_materials, so the new `modification` field is invisible to them.
 */
export async function classifyBranchReply(args: {
  originalEmailHtml: string;
  branchReplyHtml: string;
  salesOrder?: string;
}): Promise<BranchReplyIntent> {
  const targetSo = args.salesOrder ?? '';
  const prompt = `You are an expert at analyzing business emails related to sales order dispatch.

You are given two emails:
1. ORIGINAL DISPATCH EMAIL: Contains a dispatch status with sales order number, materials, stock availability, batches, and quantities. NOTE: this email may contain dispatch sections for MULTIPLE sales orders (a combined PO-level email with separate per-SO tables/sections).
2. BRANCH REPLY: The branch's response to the dispatch email.

TARGET SALES ORDER: ${targetSo}

Your task:
1. Use the TARGET SALES ORDER above as the "sales_order" in your output. Locate the section of the ORIGINAL DISPATCH EMAIL that belongs to that SO and IGNORE all other SO sections — every "materials" / "missing_materials" entry you return MUST come from the target SO's section only, never from sibling SOs in the same email.
2. Classify the branch's reply intent into exactly one of four categories (for the target SO):
   - "release_all":  Branch accepts ALL materials of the target SO as-is and wants to proceed with full dispatch (no quantity changes).
   - "release_part": Branch accepts only SOME materials of the target SO (partial acceptance, but no quantity changes on accepted lines).
   - "wait":         Branch wants to wait for some/all materials of the target SO to become available before dispatching.
   - "modify":       Branch requests a QUANTITY CHANGE on one or more materials — increase, decrease, or delete a line. Any explicit "increase X to N", "reduce X to N", "make X = N", or "remove/delete X" phrasing maps here. This is distinct from "release_part" — release_part keeps the original quantities on accepted lines; "modify" changes them.

3. Based on the intent (for the target SO ONLY):
   - For "release_all":  Extract ALL materials from the target SO's section with their material_code, batch, and quantity. Do NOT set "operation".
   - For "release_part": Extract ONLY the materials of the target SO the branch explicitly accepted with their material_code, batch, and quantity. Do NOT set "operation".
   - For "wait":         Set "materials" to []. Identify which materials of the target SO are MISSING or UNAVAILABLE in "missing_materials".
   - For "modify":       Extract EVERY material the branch is acting on. For each, set "operation":
       * "increase" — branch wants more than ordered (new quantity > original)
       * "decrease" — branch wants less than ordered (new quantity > 0 and < original)
       * "delete"   — branch wants the line removed entirely (quantity = 0)
       * "keep"     — line stays untouched (only include "keep" rows if the branch listed them explicitly)
     For each material, "quantity" is the NEW target quantity the branch wants (use 0 for "delete").
     ALSO set "modification" to one of:
       * "increase" — only increase ops
       * "decrease" — only decrease ops
       * "delete"   — only delete ops
       * "inc_dec"  — both increase and decrease ops present
       * "inc_del"  — both increase and delete ops present
       * "dec_del"  — both decrease and delete ops present

ORIGINAL DISPATCH EMAIL:
${args.originalEmailHtml}

BRANCH REPLY:
${args.branchReplyHtml}

Respond with a JSON object in this exact format:
{
    "sales_order": "${targetSo}",
    "intent": "<release_all | release_part | wait | modify>",
    "modification": "<increase | decrease | delete | inc_dec | inc_del | dec_del>",  // ONLY for intent='modify'; omit otherwise
    "materials": [
        {
            "material_code": "<material code>",
            "batch": "<batch number>",
            "quantity": <numeric quantity or 0 if unknown>,
            "operation": "<keep | increase | decrease | delete>"   // ONLY for intent='modify'
        }
    ],
    "missing_materials": ["<material_code1>", "<material_code2>"],
    "reasoning": "<brief explanation of why you classified this intent>"
}

Rules:
- "sales_order" MUST equal the TARGET SALES ORDER given above. Never substitute a different SO number, even if the email contains others.
- "materials" and "missing_materials" MUST contain ONLY entries from the target SO's section of the dispatch email. Do not mix in materials that belong to a sibling SO.
- For "release_all", extract every material from the target SO's dispatch table.
- For "release_part", extract only the materials of the target SO the branch explicitly mentioned wanting.
- For "wait", identify materials of the target SO that are unavailable or that the branch is waiting for.
- For "modify", "operation" is REQUIRED on every entry. The "modification" field is REQUIRED at the top level.
- quantity must be a number, not a string.
- Return ONLY valid JSON, no other text.`;

  const openai = new OpenAI();
  const completion = await openai.chat.completions.create({
    model: 'gpt-5.2',
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: 'You are an expert dispatch coordinator email analyzer. Always respond with valid JSON.',
      },
      { role: 'user', content: prompt },
    ],
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw) throw new Error('OpenAI returned empty content for branch-reply classification');

  const parsed = ClassificationSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(`Branch-reply classification zod validation failed: ${parsed.error.message}`);
  }

  if (!parsed.data.sales_order && args.salesOrder) {
    parsed.data.sales_order = args.salesOrder;
  }
  return parsed.data;
}
