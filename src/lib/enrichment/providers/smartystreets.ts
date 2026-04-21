import { ConfigurationError, ProviderError, ValidationError } from "@/lib/errors/classes";

import type {
  AddressInput,
  AddressVerifier,
  CassStatus,
  VerifiedAddress,
} from "../types";

const ENDPOINT = "https://us-street.api.smartystreets.com/street-address";

type SmartyCandidate = {
  input_index: number;
  candidate_index: number;
  delivery_line_1?: string;
  delivery_line_2?: string;
  last_line?: string;
  components?: {
    primary_number?: string;
    street_name?: string;
    street_suffix?: string;
    secondary_designator?: string;
    secondary_number?: string;
    city_name?: string;
    state_abbreviation?: string;
    zipcode?: string;
    plus4_code?: string;
  };
  metadata?: {
    latitude?: number;
    longitude?: number;
    vacant?: "Y" | "N";
  };
  analysis?: {
    /** Y / S / D = deliverable variants; N = not confirmed. */
    dpv_match_code?: "Y" | "N" | "S" | "D";
    /** Multiple candidates returned → ambiguous address. */
    active?: string;
  };
};

export class SmartyStreetsVerifier implements AddressVerifier {
  readonly providerId = "smartystreets";

  constructor(
    private readonly authId: string,
    private readonly authToken: string,
  ) {}

  async verify(address: AddressInput): Promise<VerifiedAddress | null> {
    if (!address.address) {
      throw new ValidationError("Address is required for verification");
    }

    const url = new URL(ENDPOINT);
    url.searchParams.set("auth-id", this.authId);
    url.searchParams.set("auth-token", this.authToken);
    url.searchParams.set("license", "us-core-cloud");
    // Always ask for up to 5 candidates so we can detect ambiguity.
    url.searchParams.set("candidates", "5");

    const body = JSON.stringify([
      {
        street: address.address,
        city: address.city ?? undefined,
        state: address.state ?? undefined,
        zipcode: address.zip ?? undefined,
      },
    ]);

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Host": "us-street.api.smartystreets.com",
        },
        body,
      });
    } catch (e) {
      throw new ProviderError(
        e instanceof Error ? e.message : String(e),
        "smartystreets",
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new ProviderError(
        `SmartyStreets ${response.status}: ${text || response.statusText}`,
        "smartystreets",
        { status: response.status },
      );
    }

    const candidates = (await response.json()) as SmartyCandidate[];
    return parseSmartyResponse(candidates);
  }
}

/**
 * Pure response parser — exported for unit testing without an HTTP layer.
 * Returns the first candidate as the verified address; multiple candidates
 * are flagged as `ambiguous`. Empty result → null cassStatus → "invalid".
 */
export function parseSmartyResponse(
  candidates: SmartyCandidate[],
): VerifiedAddress {
  if (!candidates || candidates.length === 0) {
    return {
      standardized: "",
      cassStatus: "invalid",
      components: {},
      raw: candidates,
    };
  }

  const ambiguous = candidates.length > 1;
  const c = candidates[0];

  const cassStatus: CassStatus = ambiguous
    ? "ambiguous"
    : matchCodeToCassStatus(c.analysis?.dpv_match_code);

  const standardized = [
    c.delivery_line_1,
    c.delivery_line_2,
    c.last_line,
  ]
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .join(", ");

  return {
    standardized,
    cassStatus,
    components: {
      primaryNumber: c.components?.primary_number,
      streetName: c.components?.street_name,
      streetSuffix: c.components?.street_suffix,
      secondaryDesignator: c.components?.secondary_designator,
      secondaryNumber: c.components?.secondary_number,
      city: c.components?.city_name,
      state: c.components?.state_abbreviation,
      zip5: c.components?.zipcode,
      plus4: c.components?.plus4_code,
    },
    lat: c.metadata?.latitude ?? null,
    lon: c.metadata?.longitude ?? null,
    isVacant:
      c.metadata?.vacant === "Y"
        ? true
        : c.metadata?.vacant === "N"
          ? false
          : null,
    raw: candidates,
  };
}

function matchCodeToCassStatus(code: string | undefined): CassStatus {
  switch (code) {
    case "Y":
    case "S":
    case "D":
      return "verified";
    case "N":
      return "invalid";
    default:
      return "unverified";
  }
}

/**
 * Factory used by the registry. Throws ConfigurationError (not ProviderError)
 * when env vars are missing — distinct error class so the UI can suggest
 * "set up SmartyStreets credentials" instead of "the API failed".
 */
export function smartyStreetsFromEnv(): SmartyStreetsVerifier {
  const authId = process.env.SMARTY_AUTH_ID;
  const authToken = process.env.SMARTY_AUTH_TOKEN;
  if (!authId || !authToken) {
    throw new ConfigurationError(
      "SmartyStreets credentials missing. Set SMARTY_AUTH_ID and SMARTY_AUTH_TOKEN in .env.local.",
    );
  }
  return new SmartyStreetsVerifier(authId, authToken);
}
