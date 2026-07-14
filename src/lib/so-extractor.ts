import { z } from 'zod';
import { getLlmService } from './llm-service';

const ExtractionSchema = z.object({
  customerId: z.string().min(1).nullable(),
  soNumbers: z.array(z.string().regex(/^\d{7,}$/)).min(1).max(4),
  // Vehicle capacity in tonnes. May arrive in any unit form in the email
  // (35, 35 t, 35 tonnes, 35000 kg, etc.); the LLM is instructed to
  // normalise to tonnes. Null when the email doesn't mention it — in that
  // case the intake handler sends a tonnage_inquiry follow-up to branch.
  vehicleTonnage: z.number().positive().nullable(),
});

export interface OrderExtraction {
  customerId: string | null;
  soNumbers: string[];
  vehicleTonnage: number | null;
}

/**
 * Extract customer_id + 1–4 SO numbers from a NEW ORDER email body.
 *
 * customer_id is the upstream system's identifier for the dispatch customer
 * (e.g. "CUST-1234" or "42"). When absent, returns null and the caller may
 * skip Customer linking (the PO will be created without a customer).
 *
 * This is the NEW ORDER intake extractor — it runs BEFORE any SalesOrder /
 * PurchaseOrder rows exist, so it predates the LLM planner. The planner
 * takes over for every subsequent inbound on the thread.
 * `extractOrderInfoFallback` (regex) below is the last-resort fallback when
 * the AI call errors.
 */
export async function extractOrderInfoWithAI(emailBody: string): Promise<OrderExtraction> {
  // Goes through the shared LLM wrapper (src/lib/llm-service.ts) so the
  // provider/model is governed by LLM_PROVIDER / LLM_MODEL env vars, same as
  // the planner. Temperature is forced low (0.1) because this is structured
  // extraction, not free-form reasoning.
  const llm = getLlmService();
  const result = await llm.chat({
    messages: [
      {
        role: 'system',
        content:
          'You extract dispatch information from "NEW ORDER" emails sent by branches. Return strict JSON of the form {"customerId": "<id-or-null>", "soNumbers": ["1234567", ...], "vehicleTonnage": <number-or-null>}. Rules: (1) "customerId" is the customer/account identifier — usually labelled customer_id, customer id, customer code, account, etc. May be alphanumeric like "CUST-1234" or numeric like "42". Set null if you cannot find one. (2) "soNumbers" is the list of SAP Sales Order numbers (7+ digit numeric strings). There are 1–4 of them, in any layout. Do not invent values. (3) "vehicleTonnage" is the truck/vehicle capacity for this dispatch, normalised to TONNES. The email may say it in any unit (e.g. "35", "35 t", "35 tonnes", "35000 kg", "35MT"); convert to a tonnes number. Examples: "35 t" → 35, "35000 kg" → 35, "35.5 tonnes" → 35.5. Set null if the email does NOT mention vehicle capacity / tonnage / truck size at all. Do not infer or invent values.',
      },
      {
        role: 'user',
        content: `Extract the customer id, every SO number, and the vehicle tonnage from this email body:\n\n${emailBody}`,
      },
    ],
    requireJson: true,
    temperature: 0.1,
  });

  if (!result.text) throw new Error('LLM returned empty content for order extraction');

  const parsed = ExtractionSchema.safeParse(result.json);
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
    vehicleTonnage: parsed.data.vehicleTonnage,
  };
}

/**
 * Best-effort regex extractor: returns SO numbers (1–4), an optional
 * customer id parsed from a `customer_id: …` line, and a best-guess
 * vehicle tonnage (normalised to tonnes) when an unambiguous unit-tagged
 * number appears.
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

  // Tonnage regex: catch the common unit-tagged shapes. Order matters —
  // we try kg first (>1000) so a stray "35000 kg" doesn't get mis-read as
  // 35000 tonnes. Falls through to null when nothing matches.
  let vehicleTonnage: number | null = null;
  const kgMatch = stripped.match(/(\d+(?:\.\d+)?)\s*kg\b/i);
  if (kgMatch) {
    const kg = parseFloat(kgMatch[1]);
    if (kg > 0) vehicleTonnage = kg / 1000;
  }
  if (vehicleTonnage === null) {
    const tonneMatch = stripped.match(/(\d+(?:\.\d+)?)\s*(?:tonnes?|tons?|mt|t)\b/i);
    if (tonneMatch) {
      const t = parseFloat(tonneMatch[1]);
      if (t > 0) vehicleTonnage = t;
    }
  }

  return { customerId, soNumbers, vehicleTonnage };
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
