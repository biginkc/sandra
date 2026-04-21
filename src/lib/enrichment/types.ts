/**
 * Cross-vendor enrichment shapes. Adapters parse provider-specific
 * responses into these and the rest of the app never sees vendor jargon.
 */

export type AddressInput = {
  address: string;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
};

/** Maps to `properties.cass_status` enum on the database. */
export type CassStatus = "unverified" | "verified" | "invalid" | "ambiguous";

export type VerifiedAddress = {
  /** USPS-standardized full street line, ready to write into `address_normalized`. */
  standardized: string;
  /** Normalized to the four `cass_status` enum values. */
  cassStatus: CassStatus;
  /** Optional individual components if the provider returned them. */
  components: {
    primaryNumber?: string;
    streetName?: string;
    streetSuffix?: string;
    secondaryDesignator?: string;
    secondaryNumber?: string;
    city?: string;
    state?: string;
    zip5?: string;
    plus4?: string;
  };
  /** Geocoding when available (some providers include lat/lon free with CASS). */
  lat?: number | null;
  lon?: number | null;
  /** USPS DPV vacancy flag — true / false / null when the provider didn't say. */
  isVacant?: boolean | null;
  /** Residential vs commercial vs PO Box, when the provider returns RDI. */
  isResidential?: boolean | null;
  /** 5-digit state+county FIPS, when the provider returns it (saves us a lookup). */
  fipsCode?: string | null;
  /** Raw provider response — stored in `properties.cass_raw_response` for audit. */
  raw: unknown;
};

/**
 * Common interface every address-verification adapter implements. Same
 * pattern as MessagingProvider — swapping vendors is one adapter file.
 */
export interface AddressVerifier {
  /** Identifier written to `properties` audit / cache rows ("smartystreets" / "lob" / etc.). */
  readonly providerId: string;
  /** Single-address verification. */
  verify(address: AddressInput): Promise<VerifiedAddress | null>;
}
