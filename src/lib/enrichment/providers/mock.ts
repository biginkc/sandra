import type {
  AddressInput,
  AddressVerifier,
  CassStatus,
  VerifiedAddress,
} from "../types";

/**
 * Deterministic fake verifier used by the integration test suite (gated by
 * `ADDRESS_VERIFIER_PROVIDER=mock` in `.env.test.local` via
 * `vitest.integration.config.ts`). Never hits the network.
 *
 * Behavior is keyed off the raw address string so tests can force specific
 * cass_status outcomes without a fixture layer:
 *
 *   - address starts with "INVALID"  → cass_status = "invalid"
 *   - address starts with "AMBIG"    → cass_status = "ambiguous"
 *   - address contains "VACANT"      → cass_status = "verified", is_vacant=true
 *   - otherwise                      → cass_status = "verified", is_vacant=false
 *
 * The standardized output is just the input uppercased with canonical
 * suffixes — enough to verify that `address_normalized` dedup works end-to-end.
 */
export class MockAddressVerifier implements AddressVerifier {
  readonly providerId = "mock";

  // eslint-disable-next-line @typescript-eslint/require-await
  async verify(input: AddressInput): Promise<VerifiedAddress | null> {
    const addr = (input.address ?? "").trim();
    const upper = addr.toUpperCase();

    const status: CassStatus = upper.startsWith("INVALID")
      ? "invalid"
      : upper.startsWith("AMBIG")
        ? "ambiguous"
        : "verified";

    const standardized = [
      upper,
      input.city ? input.city.toUpperCase() : null,
      input.state ?? null,
      input.zip ?? null,
    ]
      .filter((s): s is string => !!s)
      .join(", ");

    return {
      standardized: status === "verified" ? standardized : "",
      cassStatus: status,
      components: {
        primaryNumber: addr.split(" ")[0],
        city: input.city ?? undefined,
        state: input.state ?? undefined,
        zip5: input.zip ?? undefined,
      },
      lat: 39.0997,
      lon: -94.5786,
      isVacant: upper.includes("VACANT") ? true : false,
      isResidential: true,
      fipsCode: "29095",
      raw: { mock: true, input },
    };
  }
}
