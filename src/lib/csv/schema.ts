/**
 * Target-field schema for CSV mapping.
 *
 * Each section corresponds to a group in the wizard's mapping UI:
 *  - `property` — required (at least `address` + `state` must map)
 *  - `homeowner` — optional (whole section can be unmapped)
 *  - `agent` — optional (whole section can be unmapped)
 *
 * The `type` drives per-field normalization in `normalize.ts` and
 * validation rules in `validate.ts`.
 */

export type FieldSection = "property" | "homeowner" | "agent";

export type FieldType =
  | "text"
  | "phone"
  | "email"
  | "zip"
  | "number"
  | "int"
  | "boolean"
  | "state"
  | "address"
  | "apn"
  | "county"
  | "enum";

export type TargetField = {
  id: string;
  label: string;
  section: FieldSection;
  type: FieldType;
  required?: boolean;
  enumValues?: readonly string[];
  helpText?: string;
};

const SOURCE_VALUES = [
  "mls",
  "driving_for_dollars",
  "direct_mail",
  "referral",
  "skip_trace",
  "probate",
  "pre_foreclosure",
  "other",
] as const;

const CONTACT_TYPE_VALUES = ["person", "entity"] as const;

// Vendor labels like "Wireless", "Mobile", "Land Line", and "Landline"
// normalize to this vocabulary during validation. Anything else (or blank)
// lands as null → stored as 'unknown'.
const PHONE_LINE_TYPE_VALUES = ["mobile", "landline", "unknown"] as const;

export const PROPERTY_FIELDS: readonly TargetField[] = [
  // Required fields first — grouped so the user can't miss them.
  { id: "address", label: "Address", section: "property", type: "address", required: true },
  { id: "state", label: "State", section: "property", type: "state", required: true },
  // Combined-address path — explicit alternative that satisfies both
  // required fields above by parsing a single column. Displayed right
  // after the required pair so the relationship is visually obvious.
  {
    id: "address_full",
    label: "Full Address (combined)",
    section: "property",
    type: "text",
    helpText:
      "Alternative to mapping Address + State separately. A single column like \"123 Main St, Kansas City, MO 64108\" auto-splits into Address / City / State / ZIP.",
  },
  { id: "city", label: "City", section: "property", type: "text" },
  { id: "zip", label: "ZIP", section: "property", type: "zip" },
  { id: "county_name", label: "County", section: "property", type: "county", helpText: "County name; FIPS resolved on ingest" },
  { id: "apn", label: "APN", section: "property", type: "apn", helpText: "Assessor Parcel Number" },
  { id: "zpid", label: "Zillow ID", section: "property", type: "text" },
  { id: "mls_number", label: "MLS Number", section: "property", type: "text" },
  { id: "beds", label: "Beds", section: "property", type: "number" },
  { id: "baths", label: "Baths", section: "property", type: "number" },
  { id: "sqft", label: "Square Feet", section: "property", type: "number" },
  { id: "year_built", label: "Year Built", section: "property", type: "int" },
  { id: "listing_price", label: "Listing Price", section: "property", type: "number" },
  { id: "arv", label: "ARV", section: "property", type: "number" },
  { id: "repair_estimate", label: "Repair Estimate", section: "property", type: "number" },
  { id: "mortgage_balance", label: "Mortgage Balance", section: "property", type: "number" },
  { id: "equity_estimate", label: "Equity Estimate", section: "property", type: "number" },
  { id: "lat", label: "Latitude", section: "property", type: "number" },
  { id: "lon", label: "Longitude", section: "property", type: "number" },
  { id: "source", label: "Source", section: "property", type: "enum", enumValues: SOURCE_VALUES, helpText: "How the lead entered the pipeline" },
];

export const HOMEOWNER_FIELDS: readonly TargetField[] = [
  { id: "homeowner_contact_type", label: "Type (person/entity)", section: "homeowner", type: "enum", enumValues: CONTACT_TYPE_VALUES },
  { id: "homeowner_first_name", label: "First Name", section: "homeowner", type: "text" },
  { id: "homeowner_last_name", label: "Last Name", section: "homeowner", type: "text" },
  { id: "homeowner_entity_name", label: "Entity Name (LLC/trust)", section: "homeowner", type: "text" },
  { id: "homeowner_phone_1", label: "Phone 1", section: "homeowner", type: "phone" },
  { id: "homeowner_phone_1_type", label: "Phone 1 Line Type", section: "homeowner", type: "enum", enumValues: PHONE_LINE_TYPE_VALUES },
  { id: "homeowner_phone_2", label: "Phone 2", section: "homeowner", type: "phone" },
  { id: "homeowner_phone_2_type", label: "Phone 2 Line Type", section: "homeowner", type: "enum", enumValues: PHONE_LINE_TYPE_VALUES },
  { id: "homeowner_phone_3", label: "Phone 3", section: "homeowner", type: "phone" },
  { id: "homeowner_phone_3_type", label: "Phone 3 Line Type", section: "homeowner", type: "enum", enumValues: PHONE_LINE_TYPE_VALUES },
  { id: "homeowner_email", label: "Email", section: "homeowner", type: "email" },
  { id: "homeowner_mailing_address", label: "Mailing Address", section: "homeowner", type: "text" },
  { id: "homeowner_mailing_city", label: "Mailing City", section: "homeowner", type: "text" },
  { id: "homeowner_mailing_state", label: "Mailing State", section: "homeowner", type: "state" },
  { id: "homeowner_mailing_zip", label: "Mailing ZIP", section: "homeowner", type: "zip" },
  { id: "homeowner_do_not_contact", label: "Do Not Contact", section: "homeowner", type: "boolean" },
  // Identity-only channel, never stored to a contact's phone_1/2/3 columns.
  // A vendor's DNC-flagged phone number MUST still be able to find and
  // suppress an existing contact even when it doesn't fit any of the 3
  // storage slots (e.g. PropStream's 5-phone pool already has 3 clean
  // survivors) — the 3-slot cap is a STORAGE constraint, identity matching
  // has no such limit. Pipe-delimited list of normalized phone numbers, set
  // by preset transforms (propstream.ts) alongside homeowner_do_not_contact.
  // Read only by ingest.ts's DNC-scoped matching; never written to the DB.
  { id: "homeowner_dnc_phones", label: "DNC Phone Numbers (identity only)", section: "homeowner", type: "text" },
];

export const AGENT_FIELDS: readonly TargetField[] = [
  { id: "agent_first_name", label: "First Name", section: "agent", type: "text" },
  { id: "agent_last_name", label: "Last Name", section: "agent", type: "text" },
  { id: "agent_phone", label: "Phone", section: "agent", type: "phone" },
  { id: "agent_phone_type", label: "Phone Line Type", section: "agent", type: "enum", enumValues: PHONE_LINE_TYPE_VALUES },
  { id: "agent_email", label: "Email", section: "agent", type: "email" },
  { id: "agent_brokerage", label: "Brokerage", section: "agent", type: "text" },
  { id: "agent_license_number", label: "License Number", section: "agent", type: "text" },
];

export const ALL_FIELDS: readonly TargetField[] = [
  ...PROPERTY_FIELDS,
  ...HOMEOWNER_FIELDS,
  ...AGENT_FIELDS,
];

export function getField(id: string): TargetField | undefined {
  return ALL_FIELDS.find((f) => f.id === id);
}

export function isSectionMapped(
  section: FieldSection,
  mapping: Readonly<Record<string, string | null>>,
): boolean {
  const sectionFields = ALL_FIELDS.filter((f) => f.section === section);
  return sectionFields.some((f) => !!mapping[f.id]);
}

export function isSectionComplete(
  section: FieldSection,
  mapping: Readonly<Record<string, string | null>>,
): boolean {
  const required = ALL_FIELDS.filter((f) => f.section === section && f.required);
  return required.every((f) => {
    if (!!mapping[f.id]) return true;
    // address + state can be satisfied by a mapped combined-address column
    if ((f.id === "address" || f.id === "state") && !!mapping.address_full) {
      return true;
    }
    return false;
  });
}
