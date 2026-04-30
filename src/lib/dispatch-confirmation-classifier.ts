import OpenAI from 'openai';
import { z } from 'zod';

const ClassificationSchema = z.object({
  intent: z.enum(['yes', 'no', 'ambiguous']),
  reason: z.string(),
});

export interface DispatchConfirmationIntent {
  intent: 'yes' | 'no' | 'ambiguous';
  reason: string;
}

/**
 * Classify a branch reply to a dispatch-confirmation email.
 *
 * Branch reply email bodies typically include a short top-of-message reply
 * (e.g. "yes", "looks good, proceed") followed by the entire quoted
 * confirmation email below. The quoted section contains words like
 * "confirmed", "wait", "change", "skip" etc. that fool a naive regex.
 *
 * The model is asked to ignore quoted/forwarded content and only judge the
 * branch's actual response.
 *
 *   yes        — branch approves the dispatch plan as-is, fire ZLOAD1
 *   no         — branch wants changes, holds, cancels — operator handles
 *   ambiguous  — model not confident; treat like 'no' (operator review)
 */
export async function classifyDispatchConfirmation(
  replyHtml: string
): Promise<DispatchConfirmationIntent> {
  const stripped = replyHtml.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

  const openai = new OpenAI();
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.1,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'You classify a branch dispatcher\'s reply to a dispatch-confirmation email. Return strict JSON of the form {"intent": "yes" | "no" | "ambiguous", "reason": "<short explanation>"}. Rules: (1) Look ONLY at the branch\'s new reply text at the top of the message. IGNORE any quoted/forwarded content (lines starting with ">", text after "On ... wrote:", or content that repeats the original confirmation). (2) "yes" = the branch approves the dispatch plan as-is, with no changes ("yes", "confirm", "proceed", "go ahead", "approved", etc.). (3) "no" = the branch wants changes, exclusions, more time, or rejects ("skip X", "send only N of Y", "wait", "hold", "no", "revise"). (4) "ambiguous" = unclear intent or no actual response (just signature, just thanks, etc.). When in doubt, prefer "ambiguous" over guessing.',
      },
      {
        role: 'user',
        content: `Classify this branch reply:\n\n${stripped}`,
      },
    ],
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw) throw new Error('OpenAI returned empty content for dispatch confirmation classification');

  const parsed = ClassificationSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(`Dispatch confirmation classification zod validation failed: ${parsed.error.message}`);
  }

  return parsed.data;
}
