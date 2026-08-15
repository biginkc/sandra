import { ConfigurationError } from "@/lib/errors/classes";
import type { PhoneLineType } from "@/lib/messaging/line-type";
export { TELNYX_LOOKUP_COST_USD } from "@/lib/provider-pricing";

/**
 * Telnyx Number Lookup client. Docs:
 *   https://developers.telnyx.com/docs/identity-services/number-lookup
 *
 * Auth: `Authorization: Bearer <TELNYX_API_KEY>`.
 *
 * Endpoint used:
 *   - GET /v2/number_lookup/{e164}?type=carrier — $0.003/lookup
 *
 * Used by the CSV-import workflow to classify phones that arrive with
 * no vendor line-type label, so they can satisfy the migration-080 hard
 * rule (unlabeled numbers are never saved) instead of being dropped.
 */

const BASE_URL = "https://api.telnyx.com/v2/number_lookup";

/** Telnyx carrier-type lookup price per number. Used for the wizard's
 *  cost estimate and the job-summary cost record. */
const MAX_IN_FLIGHT = 5;
const RETRY_BACKOFF_MS = 1_000;

type TelnyxLookupResponse = {
  data?: {
    carrier?: { type?: string | null } | null;
    portability?: { line_type?: string | null } | null;
  };
};

/**
 * Telnyx label → our vocabulary. VoIP maps to mobile deliberately:
 * VoIP numbers receive SMS, and the whole point of classification is
 * deciding textability. Anything unrecognized stays 'unknown' (and is
 * then dropped by the ingest hard rule).
 */
export function lineTypeFromTelnyxLabel(
  label: string | null | undefined,
): PhoneLineType {
  const v = (label ?? "").trim().toLowerCase();
  if (v === "mobile" || v === "wireless" || v === "voip") return "mobile";
  if (v === "landline" || v === "fixed line") return "landline";
  return "unknown";
}

export class TelnyxLineTypeLookup {
  constructor(private readonly apiKey: string) {
    if (!apiKey) {
      throw new ConfigurationError("Telnyx API key is required");
    }
  }

  /**
   * Classify a batch of E.164 numbers. Concurrency-limited to
   * MAX_IN_FLIGHT; a single number's failure never throws — that number
   * just comes back 'unknown'. The returned map covers every input.
   */
  async classify(
    phoneNumbers: string[],
  ): Promise<Map<string, PhoneLineType>> {
    const result = new Map<string, PhoneLineType>();
    let cursor = 0;

    const worker = async (): Promise<void> => {
      while (cursor < phoneNumbers.length) {
        const number = phoneNumbers[cursor++];
        result.set(number, await this.classifyOne(number));
      }
    };

    await Promise.all(
      Array.from(
        { length: Math.min(MAX_IN_FLIGHT, phoneNumbers.length) },
        () => worker(),
      ),
    );

    return result;
  }

  /** One lookup, with a single retry on 429/5xx. Never throws. */
  private async classifyOne(number: string): Promise<PhoneLineType> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await fetch(
          `${BASE_URL}/${encodeURIComponent(number)}?type=carrier`,
          {
            headers: {
              Authorization: `Bearer ${this.apiKey}`,
              Accept: "application/json",
            },
          },
        );

        if (response.status === 429 || response.status >= 500) {
          if (attempt === 0) {
            await sleep(RETRY_BACKOFF_MS);
            continue;
          }
          return "unknown";
        }
        if (!response.ok) return "unknown"; // 4xx — invalid number etc.

        const body = (await response.json()) as TelnyxLookupResponse;
        const carrierType = lineTypeFromTelnyxLabel(body.data?.carrier?.type);
        if (carrierType !== "unknown") return carrierType;
        return lineTypeFromTelnyxLabel(body.data?.portability?.line_type);
      } catch {
        if (attempt === 0) {
          await sleep(RETRY_BACKOFF_MS);
          continue;
        }
        return "unknown";
      }
    }
    return "unknown";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Factory used by the workflow. Throws ConfigurationError if the env
 *  var isn't set. */
export function telnyxLookupFromEnv(): TelnyxLineTypeLookup {
  const key = process.env.TELNYX_API_KEY?.trim();
  if (!key) {
    throw new ConfigurationError("TELNYX_API_KEY is not set");
  }
  return new TelnyxLineTypeLookup(key);
}
