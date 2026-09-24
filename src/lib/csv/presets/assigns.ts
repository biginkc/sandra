/**
 * Assigns property export preset.
 *
 * A record contains one property and as many as eight separately enriched
 * contacts. The adapter does not select, rank, filter, or collapse contacts:
 * it emits standard property/contact-1 fields for Sandra's legacy views and
 * two lossless JSON envelopes consumed by ingest.ts for the full relation.
 */
import type { TransformResult, VendorPreset } from "./types";

const SIGNATURE_HEADERS = [
  "PropertyAddress",
  "AddressHash",
  "Contact1Name",
  "Contact1Phone_1",
  "Contact8UsedAlternateSource",
] as const;

const CONTACT_POSITIONS = [1, 2, 3, 4, 5, 6, 7, 8] as const;
const PHONE_SLOTS = [1, 2, 3] as const;

type SourceRow = Record<string, string>;

function value(row: SourceRow, key: string): string {
  return (row[key] ?? "").trim();
}

function nameParts(name: string): { first: string; last: string } {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: "", last: "" };
  if (parts.length === 1) return { first: parts[0], last: "" };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

function contactPhoneTypeForSandra(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === "mobile") return "mobile";
  if (normalized === "residential" || normalized === "landline") return "landline";
  // The raw label remains in Assigns Contact Blocks / Assigns Source Row.
  // "unknown" is the importer vocabulary and makes the row reviewable
  // without inventing a line-type classification.
  return "unknown";
}

function contactBlock(row: SourceRow, position: number) {
  const prefix = `Contact${position}`;
  const phones = PHONE_SLOTS.map((slot) => ({
    value: value(row, `${prefix}Phone_${slot}`),
    type: value(row, `${prefix}Phone_${slot}_Type`),
    activityScore: value(row, `${prefix}Phone_${slot}_ActivityScore`),
    dnc: value(row, `${prefix}Phone_${slot}_DNC`),
    litigator: value(row, `${prefix}Phone_${slot}_Litigator`),
    email: value(row, `${prefix}Email_${slot}`),
  }));
  return {
    position,
    name: value(row, `${prefix}Name`),
    type: value(row, `${prefix}Type`),
    phones,
    usedAlternateSource: value(row, `${prefix}UsedAlternateSource`),
  };
}

export const assignsPreset: VendorPreset = {
  id: "assigns",
  label: "Assigns Property Export",
  description:
    "Assigns' property export with up to eight contact blocks. All source " +
    "columns and every contact block are retained without DNC filtering.",
  importable: true,
  version: 1,

  detect(headers) {
    const headerSet = new Set(headers);
    const matched = SIGNATURE_HEADERS.filter((header) => headerSet.has(header));
    if (matched.length === SIGNATURE_HEADERS.length) {
      return {
        id: "assigns",
        confidence: 1,
        reasons: [
          "PropertyAddress + AddressHash and the Contact1..Contact8 block headers are present",
        ],
      };
    }
    if (matched.length >= 3) {
      return {
        id: "assigns",
        confidence: 0.55,
        reasons: [`${matched.length} of ${SIGNATURE_HEADERS.length} Assigns signature headers present`],
      };
    }
    return null;
  },

  transform(rows, headers) {
    const outputHeaders = [
      "Address",
      "City",
      "State",
      "ZIP",
      "County",
      "Latitude",
      "Longitude",
      "Beds",
      "Baths",
      "Square Feet",
      "Homeowner First Name",
      "Homeowner Last Name",
      "Homeowner Phone 1",
      "Homeowner Phone 1 Type",
      "Homeowner Phone 2",
      "Homeowner Phone 2 Type",
      "Homeowner Phone 3",
      "Homeowner Phone 3 Type",
      "Homeowner Email",
      "Assigns Contact Blocks",
      "Assigns Source Row",
    ];

    const transformed = rows.map((row) => {
      const contact1 = contactBlock(row, 1);
      const name = nameParts(contact1.name);
      const contactBlocks = CONTACT_POSITIONS.map((position) => contactBlock(row, position));
      return {
        Address: value(row, "PropertyAddress"),
        City: value(row, "PropertyCity"),
        State: value(row, "PropertyState"),
        ZIP: value(row, "PropertyPostalCode"),
        County: value(row, "County"),
        Latitude: value(row, "Latitude"),
        Longitude: value(row, "Longitude"),
        Beds: value(row, "Beds"),
        Baths: value(row, "Baths"),
        "Square Feet": value(row, "SquareFootage"),
        "Homeowner First Name": name.first,
        "Homeowner Last Name": name.last,
        "Homeowner Phone 1": contact1.phones[0].value,
        "Homeowner Phone 1 Type": contactPhoneTypeForSandra(contact1.phones[0].type),
        "Homeowner Phone 2": contact1.phones[1].value,
        "Homeowner Phone 2 Type": contactPhoneTypeForSandra(contact1.phones[1].type),
        "Homeowner Phone 3": contact1.phones[2].value,
        "Homeowner Phone 3 Type": contactPhoneTypeForSandra(contact1.phones[2].type),
        "Homeowner Email": contact1.phones.map((phone) => phone.email).find(Boolean) ?? "",
        "Assigns Contact Blocks": JSON.stringify(contactBlocks),
        // This is the lossless mapping ledger destination for every original
        // column, including non-operational property fields and all contact
        // metadata. No source column is discarded by the adapter.
        "Assigns Source Row": JSON.stringify(row),
      };
    });

    return {
      rows: transformed,
      headers: outputHeaders,
      stats: {
        rowsIn: rows.length,
        rowsOut: transformed.length,
        rowsCollapsedDup: 0,
        columnsAdded: outputHeaders,
        columnsRemoved: [...headers],
        notes: [
          "Retained every original Assigns column in Assigns Source Row.",
          "Retained Contact1 through Contact8, including all three phones, emails, line types, activity scores, DNC flags, litigator flags, and alternate-source flags.",
          "No DNC filtering or DNC-to-suppression conversion was applied.",
        ],
      },
      suggestions: { sourceSuggestion: "assigns" },
    };
  },
};
