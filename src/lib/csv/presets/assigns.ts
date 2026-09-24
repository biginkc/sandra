/**
 * Assigns property export preset.
 *
 * A record contains one property and as many as eight separately enriched
 * contacts. The adapter does not select, rank, filter, or collapse contacts:
 * it emits property fields and two lossless JSON envelopes consumed by
 * ingest.ts for the full relation. No contact is silently selected as the
 * property homeowner or campaign recipient.
 */
import type { TransformResult, VendorPreset } from "./types";

const SIGNATURE_HEADERS = [
  "Id",
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

function contactPhoneTypeForSandra(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === "mobile") return "mobile";
  if (normalized === "residential" || normalized === "landline") return "landline";
  // The raw label remains in Assigns Contact Blocks / Assigns Source Row.
  // "unknown" is the importer vocabulary and makes the row reviewable
  // without inventing a line-type classification.
  return "unknown";
}

function stableBlockFingerprint(block: {
  name: string;
  type: string;
  phones: readonly Record<string, string>[];
  usedAlternateSource: string;
}): string {
  // FNV-1a: a deterministic in-browser identity component, not a security
  // primitive. It distinguishes changed source blocks while vendor Id +
  // position provides the stable record namespace.
  let hash = 0x811c9dc5;
  const input = JSON.stringify(block);
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function contactBlock(row: SourceRow, position: number) {
  const prefix = `Contact${position}`;
  const phones = PHONE_SLOTS.map((slot) => ({
    value: value(row, `${prefix}Phone_${slot}`),
    type: contactPhoneTypeForSandra(value(row, `${prefix}Phone_${slot}_Type`)),
    sourceType: value(row, `${prefix}Phone_${slot}_Type`),
    activityScore: value(row, `${prefix}Phone_${slot}_ActivityScore`),
    dnc: value(row, `${prefix}Phone_${slot}_DNC`),
    litigator: value(row, `${prefix}Phone_${slot}_Litigator`),
    email: value(row, `${prefix}Email_${slot}`),
  }));
  const name = value(row, `${prefix}Name`);
  const type = value(row, `${prefix}Type`);
  const usedAlternateSource = value(row, `${prefix}UsedAlternateSource`);
  return {
    sourceIdentity: `${value(row, "Id")}:${position}:${stableBlockFingerprint({ name, type, phones, usedAlternateSource })}`,
    position,
    name,
    type,
    phones,
    usedAlternateSource,
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
      "Assigns Source Record ID",
      "Assigns Contact Blocks",
      "Assigns Source Row",
    ];

    const transformed = rows.map((row) => {
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
        "Assigns Source Record ID": value(row, "Id"),
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
