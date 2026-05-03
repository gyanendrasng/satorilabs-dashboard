import OpenAI from 'openai';
import { z } from 'zod';

const MaterialSchema = z.object({
  material_code: z.string(),
  batch: z.string().default(''),
  quantity: z.number().default(0),
});

const ClassificationSchema = z.object({
  sales_order: z.string().default(''),
  intent: z.enum(['release_all', 'release_part', 'wait']),
  materials: z.array(MaterialSchema).default([]),
  missing_materials: z.array(z.string()).default([]),
  reasoning: z.string().default(''),
});

export type BranchReplyIntent = z.infer<typeof ClassificationSchema>;

/**
 * Classify a branch reply to a dispatch (ls_dispatch) email — locally,
 * replacing the auto_gui2 /email/branch-reply call.
 *
 * Prompt is copied verbatim from auto_gui2/services/email_workflow_service.py
 * (BRANCH_REPLY_CLASSIFICATION_PROMPT) so behavior matches the Python service.
 *
 *   release_all  — branch accepts ALL materials, proceed with full dispatch
 *   release_part — branch accepts SOME materials only
 *   wait         — branch wants to wait for materials to become available
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
2. Classify the branch's reply intent into exactly one of three categories. The classification should reflect the branch's intent FOR THE TARGET SO specifically (the branch may reply about multiple SOs in one message — interpret only the part that pertains to the target SO):
   - "release_all": Branch accepts ALL materials of the target SO and wants to proceed with full dispatch.
   - "release_part": Branch accepts only SOME materials of the target SO (partial acceptance).
   - "wait": Branch wants to wait for all/some materials of the target SO to become available before dispatching.
3. Based on the intent (for the target SO ONLY):
   - For "release_all": Extract ALL materials from the target SO's section with their material_code, batch, and quantity.
   - For "release_part": Extract ONLY the materials of the target SO the branch explicitly accepted with their material_code, batch, and quantity.
   - For "wait": Identify which materials of the target SO are MISSING or UNAVAILABLE (mentioned as unavailable or not confirmed).

ORIGINAL DISPATCH EMAIL:
${args.originalEmailHtml}

BRANCH REPLY:
${args.branchReplyHtml}

Respond with a JSON object in this exact format:
{
    "sales_order": "${targetSo}",
    "intent": "<release_all | release_part | wait>",
    "materials": [
        {
            "material_code": "<material code>",
            "batch": "<batch number>",
            "quantity": <numeric quantity or 0 if unknown>
        }
    ],
    "missing_materials": ["<material_code1>", "<material_code2>"],
    "reasoning": "<brief explanation of why you classified this intent>"
}

Rules:
- "sales_order" MUST equal the TARGET SALES ORDER given above. Never substitute a different SO number, even if the email contains others.
- "materials" and "missing_materials" MUST contain ONLY entries from the target SO's section of the dispatch email. Do not mix in materials that belong to a sibling SO.
- "materials" should contain the materials to be RELEASED (empty array for "wait" intent).
- "missing_materials" should contain unavailable material codes (empty array for "release_all" and "release_part").
- For "release_all", extract every material from the target SO's dispatch table.
- For "release_part", extract only the materials of the target SO the branch explicitly mentioned wanting.
- For "wait", identify materials of the target SO that are unavailable or that the branch is waiting for.
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
