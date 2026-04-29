import OpenAI from 'openai';
import { z } from 'zod';

const ExtractionSchema = z.object({
  customerId: z.string().min(1).nullable(),
  soNumbers: z.array(z.string().regex(/^\d{7,}$/)).min(1).max(4),
});

export interface OrderExtraction {
  customerId: string | null;
  soNumbers: string[];
}

/**
 * Extract customer_id + 1–4 SO numbers from a NEW ORDER email body.
 *
 * customer_id is the upstream system's identifier for the dispatch customer
 * (e.g. "CUST-1234" or "42"). When absent, returns null and the caller may
 * skip Customer linking (the PO will be created without a customer).
 */
export async function extractOrderInfoWithAI(emailBody: string): Promise<OrderExtraction> {
  const openai = new OpenAI();
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.1,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'You extract dispatch information from "NEW ORDER" emails sent by branches. Return strict JSON of the form {"customerId": "<id-or-null>", "soNumbers": ["1234567", ...]}. Rules: (1) "customerId" is the customer/account identifier — usually labelled customer_id, customer id, customer code, account, etc. May be alphanumeric like "CUST-1234" or numeric like "42". Set null if you cannot find one. (2) "soNumbers" is the list of SAP Sales Order numbers (7+ digit numeric strings). There are 1–4 of them, in any layout. Do not invent values.',
      },
      {
        role: 'user',
        content: `Extract the customer id and every SO number from this email body:\n\n${emailBody}`,
      },
    ],
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw) throw new Error('OpenAI returned empty content for order extraction');

  const parsed = ExtractionSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(`Order extraction zod validation failed: ${parsed.error.message}`);
  }

  const seen = new Set<string>();
  const dedupedSoNumbers = parsed.data.soNumbers.filter((n) => {
    if (seen.has(n)) return false;
    seen.add(n);
    return true;
  });

  return {
    customerId: parsed.data.customerId,
    soNumbers: dedupedSoNumbers,
  };
}

/**
 * Best-effort regex extractor: returns SO numbers (1–4) and an optional
 * customer id parsed from a `customer_id: …` / `customer id: …` line.
 */
export function extractOrderInfoFallback(emailBody: string): OrderExtraction {
  const stripped = emailBody.replace(/<[^>]*>/g, ' ');

  const customerMatch = stripped.match(
    /customer[\s_-]*id\s*[:=#]?\s*([A-Za-z0-9_-]+)/i
  );
  const customerId = customerMatch ? customerMatch[1] : null;

  const matches = stripped.match(/\b\d{7,}\b/g) || [];
  const seen = new Set<string>();
  const soNumbers: string[] = [];
  for (const n of matches) {
    if (seen.has(n)) continue;
    seen.add(n);
    soNumbers.push(n);
    if (soNumbers.length === 4) break;
  }

  return { customerId, soNumbers };
}

// ---- back-compat re-exports (existing callers) ------------------------------

/** @deprecated use extractOrderInfoWithAI; this drops the customerId. */
export async function extractSoNumbersWithAI(emailBody: string): Promise<string[]> {
  const { soNumbers } = await extractOrderInfoWithAI(emailBody);
  return soNumbers;
}

/** @deprecated use extractOrderInfoFallback; this drops the customerId. */
export function extractSoNumbersFallback(emailBody: string): string[] {
  return extractOrderInfoFallback(emailBody).soNumbers;
}
