import { reportError } from "@/lib/errors/report";

import { redactFactsInput } from "./redact";
import { prepareFactsInput } from "./prepare";
import type { FactsExtractor } from "./jev-facts";
import { validateFacts } from "./validate";
import type { ValidFacts } from "./types";

/** One claimed call, as returned by fn_claim_call_facts. */
export type ClaimedCall = {
  fact_id: string;
  claim_token: string;
  call_activity_id: string;
  org_id?: string;
  property_id?: string;
  summary: string | null;
  transcript: string | null;
  contact_names?: string[] | null;
  property_address?: string | null;
  property_city?: string | null;
  property_zip?: string | null;
};

export type ClaimResult = { claims: ClaimedCall[]; exhausted: { fact_id: string; call_activity_id: string }[] };

export type FactsJobDeps = {
  claim(limit: number): Promise<ClaimResult>;
  complete(args: { factId: string; claimToken: string; facts: ValidFacts; status: "proposed" | "no_facts"; model: string | null }): Promise<void>;
  /** Null: summary note only. */
  extractor: FactsExtractor | null;
  now?: () => Date;
  report?: typeof reportError;
};

export type FactsJobResult = { claimed: number; completed: number; failed: number; exhausted: number };

/**
 * Step 1 (extract, outside any transaction) then step 2 (one completion transaction) per claim.
 * A failure in either step leaves the lease to expire: the activity is reclaimed (at most five
 * attempts) and a result from a worker that lost its lease is discarded by the database.
 */
export async function runCallFactsSweep(limit: number, deps: FactsJobDeps): Promise<FactsJobResult> {
  const report = deps.report ?? reportError;
  const now = deps.now ?? (() => new Date());
  const { claims, exhausted } = await deps.claim(limit);
  for (const row of exhausted) {
    report(new Error("call facts job exhausted its attempts"), {
      tags: { surface: "call_facts_sweep", operation: "exhausted", fact_id: row.fact_id, call_activity_id: row.call_activity_id },
    });
  }
  let completed = 0;
  let failed = 0;
  for (const claim of claims) {
    try {
      let facts: ValidFacts = {};
      let model: string | null = null;
      // Redact first: the model only ever sees this text, and evidence is validated against it.
      const input = prepareFactsInput(
        redactFactsInput(
          { summary: claim.summary, transcript: claim.transcript },
          {
            contactNames: claim.contact_names ?? [],
            propertyAddress: { address: claim.property_address, city: claim.property_city, zip: claim.property_zip },
          },
        ),
      );
      if (deps.extractor && (input.summary || input.transcript)) {
        const at = now();
        const extraction = await deps.extractor(input, { now: at });
        facts = validateFacts(extraction.facts, input, at);
        model = extraction.model;
      }
      await deps.complete({
        factId: claim.fact_id,
        claimToken: claim.claim_token,
        facts,
        status: Object.keys(facts).length > 0 ? "proposed" : "no_facts",
        model,
      });
      completed += 1;
    } catch (error) {
      failed += 1;
      report(error instanceof Error ? error : new Error("call facts completion failed"), {
        tags: { surface: "call_facts_sweep", operation: "claim", fact_id: claim.fact_id },
      });
    }
  }
  return { claimed: claims.length, completed, failed, exhausted: exhausted.length };
}
