import OpenAI from 'openai';
import { z } from 'zod';

const SoListSchema = z.object({
  soNumbers: z.array(z.string().regex(/^\d{7,}$/)).min(1).max(4),
});

export async function extractSoNumbersWithAI(emailBody: string): Promise<string[]> {
  const openai = new OpenAI();
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.1,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'You extract SAP Sales Order (SO) numbers from "NEW ORDER" emails sent by branches. SO numbers are 7+ digit numeric strings. There may be 1 to 4 of them in a single email, listed in any order or formatting (numbered list, comma-separated, line-separated, etc). Return strict JSON of the form {"soNumbers": ["1234567", ...]} with at most 4 entries. Do not invent numbers.',
      },
      {
        role: 'user',
        content: `Extract every SO number from this email body:\n\n${emailBody}`,
      },
    ],
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw) throw new Error('OpenAI returned empty content for SO extraction');

  const parsed = SoListSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(`SO extraction zod validation failed: ${parsed.error.message}`);
  }

  const seen = new Set<string>();
  return parsed.data.soNumbers.filter((n) => {
    if (seen.has(n)) return false;
    seen.add(n);
    return true;
  });
}

export function extractSoNumbersFallback(emailBody: string): string[] {
  const stripped = emailBody.replace(/<[^>]*>/g, ' ');
  const matches = stripped.match(/\d{7,}/g) || [];
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const n of matches) {
    if (seen.has(n)) continue;
    seen.add(n);
    unique.push(n);
    if (unique.length === 4) break;
  }
  return unique;
}
