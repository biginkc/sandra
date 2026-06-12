/**
 * Lowercased CSV header → target field id.
 *
 * Covers the common export shapes from DealMachine, Zillow, Realtor.com,
 * generic MLS exports, and a few tax-record / skip-trace vendors.
 * Extend as new export shapes show up — the wizard's autodetect reads
 * directly from this map.
 *
 * Rule of thumb: if two sources use the same header for the same target,
 * add it once. If two sources use the same header for *different* targets,
 * drop it from the alias list and let the user map manually.
 */

import { ALL_FIELDS } from "./schema";

export const HEADER_ALIASES: Record<string, string> = {
  // ---------- Property: address ----------
  "address": "address",
  "street address": "address",
  "property address": "address",
  "full address": "address",
  "site address": "address",
  "situs address": "address",
  "prop address": "address",
  "street": "address",

  // Combined-address column (DealMachine Skipped exports). Parser in
  // validate.ts splits it into address/city/state/zip at row-validation time.
  "associated property address full": "address_full",
  "associated property address": "address_full",
  "property address full": "address_full",
  "full property address": "address_full",

  // ---------- Property: city/state/zip/county ----------
  "city": "city",
  "property city": "city",
  "site city": "city",
  "situs city": "city",

  "state": "state",
  "property state": "state",
  "site state": "state",
  "situs state": "state",
  "st": "state",

  "zip": "zip",
  "zip code": "zip",
  "zipcode": "zip",
  "postal code": "zip",
  "postalcode": "zip",
  "property zip": "zip",
  "site zip": "zip",
  "situs zip": "zip",

  "county": "county_name",
  "county name": "county_name",
  "property county": "county_name",

  // ---------- Property: identifiers ----------
  "apn": "apn",
  "parcel id": "apn",
  "parcel number": "apn",
  "parcel #": "apn",
  "parcel": "apn",
  "parcel no": "apn",
  "pin": "apn",
  "tax id": "apn",
  "tax parcel id": "apn",
  "assessor parcel number": "apn",

  "zpid": "zpid",
  "zillow id": "zpid",
  "zillow property id": "zpid",

  "mls": "mls_number",
  "mls #": "mls_number",
  "mls#": "mls_number",
  "mls number": "mls_number",
  "listing id": "mls_number",
  "listing number": "mls_number",

  // ---------- Property: details ----------
  "beds": "beds",
  "bedrooms": "beds",
  "bed": "beds",
  "# of beds": "beds",

  "baths": "baths",
  "bathrooms": "baths",
  "bath": "baths",
  "full baths": "baths",

  "sqft": "sqft",
  "sq ft": "sqft",
  "square feet": "sqft",
  "living area": "sqft",
  "gla": "sqft",
  "building sqft": "sqft",

  "year built": "year_built",
  "yr built": "year_built",
  "built": "year_built",

  "listing price": "listing_price",
  "list price": "listing_price",
  "asking price": "listing_price",
  "price": "listing_price",

  "arv": "arv",
  "after repair value": "arv",
  "avm": "arv", // DealMachine sometimes uses this

  "repair estimate": "repair_estimate",
  "estimated repairs": "repair_estimate",
  "repair costs": "repair_estimate",
  "repairs": "repair_estimate",

  "mortgage balance": "mortgage_balance",
  "mortgage": "mortgage_balance",
  "loan balance": "mortgage_balance",
  "outstanding loan": "mortgage_balance",

  "equity": "equity_estimate",
  "equity estimate": "equity_estimate",
  "estimated equity": "equity_estimate",

  "latitude": "lat",
  "lat": "lat",
  "longitude": "lon",
  "lon": "lon",
  "lng": "lon",
  "long": "lon",

  "source": "source",
  "lead source": "source",

  // ---------- Homeowner ----------
  "owner type": "homeowner_contact_type",
  "contact type": "homeowner_contact_type",

  "owner first name": "homeowner_first_name",
  "owner firstname": "homeowner_first_name",
  "first name": "homeowner_first_name",

  "owner last name": "homeowner_last_name",
  "owner lastname": "homeowner_last_name",
  "last name": "homeowner_last_name",

  "owner entity name": "homeowner_entity_name",
  "entity name": "homeowner_entity_name",
  "llc name": "homeowner_entity_name",
  "company name": "homeowner_entity_name",
  "trust name": "homeowner_entity_name",

  "phone": "homeowner_phone_1",
  "owner phone": "homeowner_phone_1",
  "phone 1": "homeowner_phone_1",
  "phone1": "homeowner_phone_1",
  "primary phone": "homeowner_phone_1",
  "mobile": "homeowner_phone_1",
  "owner mobile": "homeowner_phone_1",

  "phone 1 type": "homeowner_phone_1_type",
  "phone1 type": "homeowner_phone_1_type",
  "phone type": "homeowner_phone_1_type",
  "line type": "homeowner_phone_1_type",

  "phone 2": "homeowner_phone_2",
  "phone2": "homeowner_phone_2",
  "secondary phone": "homeowner_phone_2",
  "alternate phone": "homeowner_phone_2",

  "phone 2 type": "homeowner_phone_2_type",
  "phone2 type": "homeowner_phone_2_type",

  "phone 3": "homeowner_phone_3",
  "phone3": "homeowner_phone_3",
  "tertiary phone": "homeowner_phone_3",

  "phone 3 type": "homeowner_phone_3_type",
  "phone3 type": "homeowner_phone_3_type",

  "email": "homeowner_email",
  "owner email": "homeowner_email",
  "email address": "homeowner_email",
  "email address 1": "homeowner_email", // DealMachine Skipped
  // email_address_2 / _3 deliberately NOT aliased — contacts table holds one
  // email today, so auto-mapping the secondaries would silently drop data.

  "mailing address": "homeowner_mailing_address",
  "owner mailing address": "homeowner_mailing_address",
  "mail address": "homeowner_mailing_address",
  "owner address": "homeowner_mailing_address",
  "primary mailing address": "homeowner_mailing_address", // DealMachine Skipped

  "mailing city": "homeowner_mailing_city",
  "owner mailing city": "homeowner_mailing_city",
  "mail city": "homeowner_mailing_city",
  "owner city": "homeowner_mailing_city",
  "primary mailing city": "homeowner_mailing_city", // DealMachine Skipped

  "mailing state": "homeowner_mailing_state",
  "owner mailing state": "homeowner_mailing_state",
  "mail state": "homeowner_mailing_state",
  "owner state": "homeowner_mailing_state",
  "primary mailing state": "homeowner_mailing_state", // DealMachine Skipped

  "mailing zip": "homeowner_mailing_zip",
  "owner mailing zip": "homeowner_mailing_zip",
  "mail zip": "homeowner_mailing_zip",
  "owner zip": "homeowner_mailing_zip",
  "primary mailing zip": "homeowner_mailing_zip", // DealMachine Skipped

  "do not contact": "homeowner_do_not_contact",
  "dnc": "homeowner_do_not_contact",
  "do not call": "homeowner_do_not_contact",

  // ---------- Agent ----------
  "agent first name": "agent_first_name",
  "listing agent first name": "agent_first_name",

  "agent last name": "agent_last_name",
  "listing agent last name": "agent_last_name",

  "agent phone": "agent_phone",
  "listing agent phone": "agent_phone",

  "agent email": "agent_email",
  "listing agent email": "agent_email",

  "agent brokerage": "agent_brokerage",
  "brokerage": "agent_brokerage",
  "listing office": "agent_brokerage",
  "office name": "agent_brokerage",

  "agent license": "agent_license_number",
  "agent license number": "agent_license_number",
  "license number": "agent_license_number",
  "license #": "agent_license_number",

  // ---------- Skip Genie / DataTree (D4D) ----------
  // Skip-trace exports use prefixed columns: INPUT (what the user
  // submitted), PROP (verified from tax records), PH (skip-traced
  // phones), REL1-5 (relatives, not currently imported). The PROP
  // prefix is preferred over INPUT — it's the address the property
  // record actually belongs to. The colon in the header is preserved
  // by normalizeHeader (only underscores/hyphens/dots get stripped).

  // Property address — PROP: Address Full is the verified single-line
  // address; the wizard's address_full parser splits it into
  // address/city/state/zip at row-validation time.
  "prop: address full": "address_full",

  // Split fields are also present and back up the parsed address.
  "prop: city": "city",
  "prop: state": "state",
  "prop: zip": "zip",

  // APN / parcel — used for dedup against existing properties.
  "prop: parcel id number": "apn",
  "prop: pid": "apn",

  // Owner name — verified from tax records (more reliable than the
  // INPUT name, which is often the submitter's typo or an LLC alias).
  "prop: first name": "homeowner_first_name",
  "prop: last name": "homeowner_last_name",

  // Skip-traced phones — already deduped by Skip Genie, ranked 1-3.
  "ph: phone1": "homeowner_phone_1",
  "ph: phone2": "homeowner_phone_2",
  "ph: phone3": "homeowner_phone_3",

  // Mailing address — PROP: Mail Address Full is the owner's mailing
  // address from the tax record (drives the absentee-owner flag).
  "prop: mail address full": "homeowner_mailing_address",
  "prop: mail city": "homeowner_mailing_city",
  "prop: mail state": "homeowner_mailing_state",
  "prop: mail zip": "homeowner_mailing_zip",

  // ---------- PropStream Property Export ----------
  // PropStream's property exports use "Owner 1" prefixed columns. The
  // format-helper preset auto-renames these during transform; the
  // aliases here are the fallback for files that fail detection or
  // when the user clicks Undo on the auto-apply banner.
  "owner 1 first name": "homeowner_first_name",
  "owner 1 last name": "homeowner_last_name",
  "owner 1 firstname": "homeowner_first_name",
  "owner 1 lastname": "homeowner_last_name",
  "est equity": "equity_estimate",
  "est value": "arv",
  // "estimated equity" already aliased above in the property block.
  "est remaining balance of open loans": "mortgage_balance",
  "effective year built": "year_built",
  "total bathrooms": "baths",
  // Note: "site address", "site city", "site state", "site zip" are
  // already aliased above in the property block — they live there
  // because PropStream + Skip Genie + DataTree all use the same Site
  // prefix for tax-record-derived addresses.
  // PropStream sometimes renders the ZIP-code column with a trailing
  // "Code" suffix (Site/Mailing variants).
  "site zip code": "zip",
  "mailing zip code": "homeowner_mailing_zip",

  // ---------- TitlePro / DataTree title-event exports ----------
  // The "1st Owner's" prefix appears on every TitlePro export shape
  // (death, cash purchase, lis pendens, bankruptcy, default).
  // normalizeHeader doesn't strip apostrophes — the source header
  // "1st Owner's First Name" lowercases to "1st owner's first name"
  // verbatim, so the alias key must keep the apostrophe.
  "1st owner's first name": "homeowner_first_name",
  "1st owner's last name": "homeowner_last_name",
  // TitlePro splits the city/state/zip into a single combined column
  // sometimes — already covered by `address_full` parser via the
  // wizard's combined-address path. No alias needed here; the preset
  // transform splits it explicitly when detection fires.
  "primary owner's first name": "homeowner_first_name",
  "primary owner's last name": "homeowner_last_name",

  // ---------- REISift / DealMachine Skipped contact exports ----------
  // Most REISift snake_case columns auto-match existing title-case
  // aliases via `normalizeHeader` (underscores → spaces, lowercase) —
  // e.g. `phone_1` → "phone 1" → existing alias. Listed here are the
  // columns that don't have a title-case parallel in the existing
  // alias table.
  "associated property address line 1": "address",
  "associated property address city": "city",
  "associated property address state": "state",
  "associated property address zipcode": "zip",
  "associated parcel id": "apn",

  // ---------- BMH Agent Outreach Sheets ----------
  // The 11-column outreach Sheet schema. Most columns either don't
  // have a target field today (Status / Follow Up / Lead Source /
  // Date Created / Link / County) or already alias correctly via the
  // existing entries (Property Address, First/Last Name, Phone,
  // Email). The format-helper preset re-routes First/Last/Phone/Email
  // to agent_* fields during transform; without detection these fall
  // through to the homeowner fields, which is the more common shape
  // for a manually-uploaded county sheet anyway.
};

/**
 * Normalize a header string for alias lookup.
 * Lowercase, trim, drop surrounding quotes, convert underscores/hyphens/dots
 * to spaces, collapse repeated whitespace. Matches real-world CSV variation
 * like "Street_Address", "street-address", "STREET ADDRESS", " address ".
 */
export function normalizeHeader(header: string): string {
  return header
    .trim()
    .replace(/^["']+|["']+$/g, "")
    .toLowerCase()
    .replace(/[_\-.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Try to autodetect the target field id for a CSV header.
 * Returns null if no alias matches.
 */
export function autodetectField(header: string): string | null {
  const key = normalizeHeader(header);
  return HEADER_ALIASES[key] ?? SELF_ALIASES[key] ?? null;
}

/**
 * Self-aliases: every target field's own id (normalized: underscores →
 * spaces) maps to itself, so a CSV exported in Sandra's own column format
 * — e.g. a prepared "skip-traced contacts" backfill file with headers
 * like `homeowner_first_name` — auto-maps without the operator hand-
 * wiring 13 dropdowns. Built from the schema so it can't drift. Vendor
 * aliases always win on conflict (checked first above).
 */
const SELF_ALIASES: Record<string, string> = Object.fromEntries(
  ALL_FIELDS.map((f) => [normalizeHeader(f.id), f.id]),
);

/**
 * Produce an initial mapping by autodetecting all CSV headers.
 * Result keys are target field ids; values are the matched CSV header string
 * (in its original casing) or null for unmapped fields.
 *
 * If two headers map to the same target field, the first wins; the rest
 * are left unmapped. Conflicts are rare in practice but we prefer
 * deterministic behavior to silently-clobbered mappings.
 */
export function autodetectMapping(
  headers: readonly string[],
): Record<string, string | null> {
  const mapping: Record<string, string | null> = {};
  const used = new Set<string>();
  for (const header of headers) {
    const fieldId = autodetectField(header);
    if (fieldId && !used.has(fieldId)) {
      mapping[fieldId] = header;
      used.add(fieldId);
    }
  }

  // Precedence: when a complete per-field address set (address + city +
  // state + zip) is present, prefer it over a combined `address_full`
  // column. The combined column is fragile (regex parser, sometimes ships
  // in space-delimited shapes like Skip Genie / DataTree D4D) where as
  // the per-field columns are pre-split and unambiguous. The user can
  // still map the combined column manually if they want it as the source.
  //
  // Note: the `address` per-field is part of the precondition. Files like
  // D4D ship city/state/zip per-fields but split the street into seven
  // sub-columns with no single `address`-mappable column — for those the
  // combined column stays mapped because it's the only viable street
  // source after a reshape.
  if (
    mapping.address &&
    mapping.city &&
    mapping.state &&
    mapping.zip &&
    mapping.address_full
  ) {
    delete mapping.address_full;
  }

  return mapping;
}
