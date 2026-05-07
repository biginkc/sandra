/**
 * REISift / DealMachine "Skipped" contact-export preset.
 *
 * REISift contact CSVs (often labeled `dealmachine-contacts-*.csv` or
 * with misleading names like `Expired_Listing-...csv`) are
 * contact-centric: one row = one person, with an associated property.
 * Headers are snake_case, phones come in 3 slots × 6 sub-attributes
 * (carrier, usage, prepaid, etc.), and DNC entries arrive as the
 * literal string `"DNC Excluded"` in the phone field.
 *
 * Detection signature: `contact_id` + `associated_property_id` + `phone_1`.
 *
 * Transform highlights:
 *   - DNC decode: any phone field literally equal to `"DNC Excluded"` →
 *     null + sets `homeowner_do_not_contact = true` for the row.
 *   - Address selection: when complete split address (address + city +
 *     state + zip) is present alongside a complete `address_full`, drop
 *     `address_full` so the wizard's existing precedence rule prefers
 *     split. When split is incomplete, keep `address_full`.
 *   - Phone fold: `phone_1`/`phone_2`/`phone_3` → homeowner slots; the
 *     six per-phone sub-attribute columns are dropped (carrier / type /
 *     usage / prepaid / etc. — out of scope for v1).
 *   - Names: snake_case ALL-CAPS title-cased via `normalizeName`.
 */
import { normalizeName } from "@/lib/csv/normalize";

import type { TransformResult, VendorPreset } from "./types";

const SIGNATURE_HEADERS = [
  "contact_id",
  "associated_property_id",
  "phone_1",
] as const;

const PHONE_SLOTS = [1, 2, 3] as const;

/** Per-phone sub-attribute suffixes that REISift ships alongside each
 *  `phone_N` column. Dropped during transform — Sandra's homeowner
 *  schema doesn't carry carrier/usage/prepaid metadata in v1. */
const PHONE_SUB_ATTRS = [
  "activity_status",
  "carrier",
  "prepaid_indicator",
  "type",
  "usage_2_months",
  "usage_12_months",
  "owner",
] as const;

const DNC_SENTINEL = "DNC Excluded";

const ASSOCIATED_ADDRESS_HEADERS = {
  full: "associated_property_address_full",
  line1: "associated_property_address_line_1",
  city: "associated_property_address_city",
  state: "associated_property_address_state",
  zip: "associated_property_address_zipcode",
} as const;

export const reisiftPreset: VendorPreset = {
  id: "reisift",
  label: "REISift / DealMachine Skipped Contacts",
  description:
    "Contact-centric CSV exports from REISift or DealMachine's skip-trace " +
    "feed. We decode \"DNC Excluded\" sentinels into proper Do Not Contact " +
    "flags, fold the 3-phone block into homeowner phones, and reconcile " +
    "the combined vs split address columns.",
  importable: true,
  version: 1,

  detect(headers) {
    const headerSet = new Set(headers);
    const matched = SIGNATURE_HEADERS.filter((h) => headerSet.has(h));
    if (matched.length === SIGNATURE_HEADERS.length) {
      return {
        id: "reisift",
        confidence: 1.0,
        reasons: [
          "contact_id + associated_property_id + phone_1 headers present (snake_case contact-centric shape)",
        ],
      };
    }
    if (matched.length >= 2) {
      return {
        id: "reisift",
        confidence: 0.55,
        reasons: [`${matched.length} of 3 REISift signature headers present`],
      };
    }
    return null;
  },

  transform(rows, headers) {
    const headerSet = new Set(headers);
    const columnsRemoved = new Set<string>();
    const columnsAdded: string[] = [];
    const notes: string[] = [];

    let rowsWithDncDecoded = 0;
    let rowsWithAddressFullDropped = 0;
    let rowsWithAddressFullKept = 0;

    const out: Record<string, string>[] = rows.map((row) => {
      const next: Record<string, string> = { ...row };
      let rowHadDnc = false;

      // ---- Phone fold + DNC decode -------------------------------------
      for (const i of PHONE_SLOTS) {
        const sourceKey = `phone_${i}`;
        const targetKey = `homeowner_phone_${i}`;
        if (headerSet.has(sourceKey)) columnsRemoved.add(sourceKey);
        const raw = (next[sourceKey] ?? "").trim();
        delete next[sourceKey];
        if (raw === DNC_SENTINEL) {
          rowHadDnc = true;
          next[targetKey] = "";
        } else if (raw) {
          next[targetKey] = raw;
        }
        if (!columnsAdded.includes(targetKey)) columnsAdded.push(targetKey);

        // Drop sub-attribute columns regardless of value.
        for (const attr of PHONE_SUB_ATTRS) {
          const subKey = `phone_${i}_${attr}`;
          if (headerSet.has(subKey)) columnsRemoved.add(subKey);
          delete next[subKey];
        }
      }
      if (rowHadDnc) {
        next.homeowner_do_not_contact = "true";
        if (!columnsAdded.includes("homeowner_do_not_contact")) {
          columnsAdded.push("homeowner_do_not_contact");
        }
        rowsWithDncDecoded++;
      }

      // ---- Address selection -------------------------------------------
      const splitComplete =
        !!(next[ASSOCIATED_ADDRESS_HEADERS.line1] ?? "").trim() &&
        !!(next[ASSOCIATED_ADDRESS_HEADERS.city] ?? "").trim() &&
        !!(next[ASSOCIATED_ADDRESS_HEADERS.state] ?? "").trim() &&
        !!(next[ASSOCIATED_ADDRESS_HEADERS.zip] ?? "").trim();
      const fullPresent = !!(next[ASSOCIATED_ADDRESS_HEADERS.full] ?? "").trim();

      if (splitComplete && fullPresent) {
        // Existing autodetect precedence in aliases.ts:327-335 prefers
        // split when both are mapped. Drop the combined column to keep
        // the file unambiguous.
        delete next[ASSOCIATED_ADDRESS_HEADERS.full];
        rowsWithAddressFullDropped++;
      } else if (fullPresent) {
        rowsWithAddressFullKept++;
      }

      // ---- Names -------------------------------------------------------
      const firstName = normalizeName(next.first_name);
      const lastName = normalizeName(next.last_name);
      if (firstName) {
        next.first_name = firstName;
      }
      if (lastName) {
        next.last_name = lastName;
      }

      return next;
    });

    if (rowsWithDncDecoded > 0) {
      notes.push(
        `Decoded "${DNC_SENTINEL}" sentinel on ${rowsWithDncDecoded} row(s) — set Do Not Contact = true`,
      );
    }
    if (rowsWithAddressFullDropped > 0) {
      notes.push(
        `Dropped associated_property_address_full on ${rowsWithAddressFullDropped} row(s) where the split address was complete`,
      );
      columnsRemoved.add(ASSOCIATED_ADDRESS_HEADERS.full);
    }
    if (rowsWithAddressFullKept > 0) {
      notes.push(
        `Kept associated_property_address_full on ${rowsWithAddressFullKept} row(s) where the split address was incomplete`,
      );
    }
    notes.push(
      "Folded phone_1..3 into homeowner_phone_1..3; per-phone sub-attributes (carrier, usage, prepaid) dropped — out of scope for v1",
    );

    const newHeaders = [
      ...headers.filter((h) => !columnsRemoved.has(h)),
      ...columnsAdded.filter((h) => !headers.includes(h)),
    ];

    const result: TransformResult = {
      rows: out,
      headers: newHeaders,
      stats: {
        rowsIn: rows.length,
        rowsOut: out.length,
        rowsCollapsedDup: 0,
        columnsAdded,
        columnsRemoved: [...columnsRemoved],
        notes,
      },
      suggestions: {
        sourceSuggestion: "reisift",
      },
    };
    return result;
  },
};
