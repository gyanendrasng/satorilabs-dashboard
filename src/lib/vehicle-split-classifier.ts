import OpenAI from 'openai';
import { z } from 'zod';

const AdjustSchema = z.object({
  material_code: z.string().min(1),
  quantity: z.number().int().nonnegative(),
});

const ClassificationSchema = z.discriminatedUnion('intent', [
  z.object({ intent: z.literal('split'), reason: z.string() }),
  z.object({ intent: z.literal('cancel'), reason: z.string() }),
  z.object({
    intent: z.literal('amend'),
    remove: z.array(z.string().min(1)).default([]),
    adjust: z.array(AdjustSchema).default([]),
    reason: z.string(),
  }),
  z.object({ intent: z.literal('ambiguous'), reason: z.string() }),
]);

export type VehicleSplitIntent = z.infer<typeof ClassificationSchema>;

/**
 * Classify a branch reply to a vehicle_split_inquiry email — locally, without
 * calling auto_gui2's branch-reply classifier.
 *
 *   split      — branch agrees to two trucks ("yes", "ok split", "use 2 vehicles")
 *   cancel     — branch wants to revise / hold ("no", "wait")
 *   amend      — branch wants to drop or shrink line items so the load fits
 *                ("remove FIRMIN GY", "skip YV7FIRM…", "send only 200 of LAFFINE")
 *   ambiguous  — unclear / no actionable response → operator review
 *
 * The model is told the available material codes for this PO so it never
 * fabricates new ones, and is told to ignore quoted/forwarded content
 * below the branch's actual reply.
 */
export async function classifyVehicleSplitReply(args: {
  replyHtml: string;
  knownMaterialCodes: string[];
}): Promise<VehicleSplitIntent> {
  const stripped = args.replyHtml.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const codeList = args.knownMaterialCodes.join(', ');

  const openai = new OpenAI();
  const completion = await openai.chat.completions.create({
    model: 'gpt-5.5',
    temperature: 0.1,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          [
            'You classify a branch dispatcher\'s reply to a "vehicle split inquiry" email.',
            'The system told the branch their dispatch exceeds the truck capacity and offered three paths: split into 2 trucks, cancel/revise, or amend the load.',
            'Return STRICT JSON with shape:',
            '  {"intent":"split","reason":"..."}',
            '  {"intent":"cancel","reason":"..."}',
            '  {"intent":"amend","remove":["MATCODE",...],"adjust":[{"material_code":"MATCODE","quantity":N},...],"reason":"..."}',
            '  {"intent":"ambiguous","reason":"..."}',
            'Rules:',
            '(1) Look ONLY at the branch\'s NEW reply text at the top of the message. IGNORE quoted/forwarded content (lines starting with ">", text after "On ... wrote:", any block that repeats the original inquiry).',
            '(2) "split" = branch confirms 2 vehicles ("yes", "ok", "go ahead", "split", "use two", "send in 2 trucks").',
            '(3) "cancel" = branch declines / wants to revise without specifying changes ("no", "hold", "wait", "revise").',
            '(4) "amend" = branch identifies specific line items to drop or reduce ("remove FIRMIN", "skip OE1FJ…", "drop SAIFRON", "send only 200 of LAFFINE", "150 instead of 300 of FIRMIN"). Map each name to a material code from the allowed list.',
            '(5) ALL material_code values MUST come from the allowed list — never invent new codes. If the branch references a material not in the list, leave it out.',
            '(6) When in doubt, prefer "ambiguous" over guessing.',
          ].join(' '),
      },
      {
        role: 'user',
        content:
          `Allowed material codes for this PO: ${codeList}\n\n` +
          `Classify this branch reply:\n\n${stripped}`,
      },
    ],
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw) throw new Error('OpenAI returned empty content for vehicle-split classification');

  const parsed = ClassificationSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(`Vehicle-split classification zod validation failed: ${parsed.error.message}`);
  }
  return parsed.data;
}
