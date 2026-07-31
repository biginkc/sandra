/**
 * PropStream Property Export preset.
 *
 * PropStream's "Property Export" CSVs are property-centric and ship a
 * 5-phone × 4-email block plus an `Owner 1` / `Owner 2` First/Last name
 * pair. Sandra's homeowner schema holds 3 phone slots, 1 email, and one
 * person name — so we collapse the wide vendor shape down before mapping.
 *
 * Detection signature (uniquely PropStream):
 *   `Phone 1` + `Phone 1 Type` + `Phone 1 DNC` + `Method of Add`
 *
 * Transform highlights:
 *   - Phone fold: drop slots whose `Phone N DNC` is truthy first, then
 *     keep the first 3 of the survivors. Any DNC-flagged slot promotes
 *     `homeowner_do_not_contact = true` for the whole row AND its
 *     normalized number is carried on `homeowner_dnc_phones` (identity
 *     matching only, never stored) so a DNC number crowded out of the
 *     3 storage slots can still find + suppress the existing contact.
 *   - Email fold: `Email 1..4` → `homeowner_email` (first non-empty).
 *   - Owner names: `Owner 1 First Name` / `Owner 1 Last Name` →
 *     `homeowner_first_name` / `homeowner_last_name`. Owner 2 dropped
 *     with a `stats.notes` entry (multi-owner deferred — see plan).
 *   - `Method of Add: "Manual"` → `suggestions.tags = ["propstream-manual"]`
 *
 * No row-level dedup — PropStream is already one-row-per-property.
 */
import { normalizePhone, toBoolOrNull } from "@/lib/csv/normalize";
import { lineTypeFromVendorLabel } from "@/lib/messaging/line-type";

import type { TransformResult, VendorPreset } from "./types";

const PHONE_SLOTS = [1, 2, 3, 4, 5] as const;
const EMAIL_SLOTS = [1, 2, 3, 4] as const;

const SIGNATURE_HEADERS = [
  "Phone 1",
  "Phone 1 Type",
  "Phone 1 DNC",
  "Method of Add",
] as const;

export const propstreamPreset: VendorPreset = {
  id: "propstream",
  label: "PropStream Property Export",
  description:
    "PropStream's per-county \"Property Export\" CSVs (Tired Landlords, " +
    "Vacant, Seniors, Low Equity, etc.). We collapse the 5-phone block " +
    "into 3 slots, fold DNC flags, and merge Owner 1's name.",
  importable: true,
  version: 1,

  detect(headers) {
    const headerSet = new Set(headers);
    const matched = SIGNATURE_HEADERS.filter((h) => headerSet.has(h));
    if (matched.length === SIGNATURE_HEADERS.length) {
      return {
        id: "propstream",
        confidence: 1.0,
        reasons: ["Phone 1 / Phone 1 Type / Phone 1 DNC / Method of Add headers present"],
      };
    }
    if (matched.length >= 3) {
      // Near-miss: enough overlap to suggest PropStream-ish but not
      // strict enough to auto-apply. Below MIN_CONFIDENCE so banner
      // stays hidden.
      return {
        id: "propstream",
        confidence: 0.5,
        reasons: [`${matched.length} of 4 PropStream signature headers present`],
      };
    }
    return null;
  },

  transform(rows, headers) {
    const headerSet = new Set(headers);
    const columnsRemoved = new Set<string>();
    const columnsAdded: string[] = [];
    const notes: string[] = [];

    let rowsWithDncMerged = 0;
    let rowsWithOwner2Dropped = 0;
    let rowsWithManualMethod = 0;

    const out: Record<string, string>[] = rows.map((row) => {
      const next: Record<string, string> = { ...row };

      // ---- Phone fold ---------------------------------------------------
      type Slot = { phone: string; type: string; dnc: boolean };
      const slots: Slot[] = [];
      let anyDnc = false;
      for (const i of PHONE_SLOTS) {
        const phoneKey = `Phone ${i}`;
        const typeKey = `Phone ${i} Type`;
        const dncKey = `Phone ${i} DNC`;
        if (headerSet.has(phoneKey)) columnsRemoved.add(phoneKey);
        if (headerSet.has(typeKey)) columnsRemoved.add(typeKey);
        if (headerSet.has(dncKey)) columnsRemoved.add(dncKey);
        const phone = (next[phoneKey] ?? "").trim();
        if (!phone) continue;
        const dnc = toBoolOrNull(next[dncKey]) === true;
        if (dnc) anyDnc = true;
        slots.push({ phone, type: (next[typeKey] ?? "").trim(), dnc });
      }
      // Storage (3 phone slots) and identity matching are two different
      // concerns that must not share one array. A clean survivor always
      // wins a slot over a DNC one; mobiles before landlines among the
      // clean survivors (everything downstream texts slot 1, so a known
      // mobile must win it); keep the first 3 — never a DNC number.
      const mobileFirst = (list: Slot[]) => [
        ...list.filter((s) => lineTypeFromVendorLabel(s.type) === "mobile"),
        ...list.filter((s) => lineTypeFromVendorLabel(s.type) !== "mobile"),
      ];
      const ranked = mobileFirst(slots.filter((s) => !s.dnc)).slice(0, 3);
      for (let i = 1; i <= 3; i++) {
        const target = `homeowner_phone_${i}`;
        const typeTarget = `homeowner_phone_${i}_type`;
        const slot = ranked[i - 1];
        next[target] = slot ? slot.phone : "";
        next[typeTarget] = slot ? lineTypeFromVendorLabel(slot.type) : "";
        if (!columnsAdded.includes(target)) columnsAdded.push(target);
        if (!columnsAdded.includes(typeTarget)) columnsAdded.push(typeTarget);
      }
      // Identity channel: EVERY DNC-flagged number on the row, regardless
      // of how many clean phones already filled the 3 storage slots. The
      // 3-slot cap above is a storage constraint; matching an existing
      // contact by a DNC number has no such limit — a row with 3 clean
      // phones AND a 4th/5th DNC one must still be able to find the
      // contact that owns the DNC number if none of the 3 clean numbers
      // match it (Codex PR #310 round-3 finding: `.slice(0, 3)` was
      // silently discarding the DNC number before ingest.ts ever saw it).
      // Never written to a contact's phone_1/2/3 — ingest.ts reads this
      // column ONLY to widen its existing-contact match candidates on a
      // DNC-flagged row.
      const dncPhones = slots
        .filter((s) => s.dnc)
        .map((s) => normalizePhone(s.phone))
        .filter((p): p is string => !!p);
      if (dncPhones.length > 0) {
        next.homeowner_dnc_phones = [...new Set(dncPhones)].join("|");
        if (!columnsAdded.includes("homeowner_dnc_phones")) {
          columnsAdded.push("homeowner_dnc_phones");
        }
      }
      // Drop the per-phone source columns from the row.
      for (const i of PHONE_SLOTS) {
        delete next[`Phone ${i}`];
        delete next[`Phone ${i} Type`];
        delete next[`Phone ${i} DNC`];
      }
      if (anyDnc) {
        next.homeowner_do_not_contact = "true";
        if (!columnsAdded.includes("homeowner_do_not_contact")) {
          columnsAdded.push("homeowner_do_not_contact");
        }
        rowsWithDncMerged++;
      }

      // ---- Email fold ---------------------------------------------------
      let chosenEmail = "";
      for (const i of EMAIL_SLOTS) {
        const key = `Email ${i}`;
        if (headerSet.has(key)) columnsRemoved.add(key);
        const v = (next[key] ?? "").trim();
        if (!chosenEmail && v) chosenEmail = v;
        delete next[key];
      }
      if (chosenEmail) {
        next.homeowner_email = chosenEmail;
        if (!columnsAdded.includes("homeowner_email")) {
          columnsAdded.push("homeowner_email");
        }
      }

      // ---- Owner names --------------------------------------------------
      const owner1First = (next["Owner 1 First Name"] ?? "").trim();
      const owner1Last = (next["Owner 1 Last Name"] ?? "").trim();
      const owner2First = (next["Owner 2 First Name"] ?? "").trim();
      const owner2Last = (next["Owner 2 Last Name"] ?? "").trim();
      if (headerSet.has("Owner 1 First Name")) columnsRemoved.add("Owner 1 First Name");
      if (headerSet.has("Owner 1 Last Name")) columnsRemoved.add("Owner 1 Last Name");
      if (headerSet.has("Owner 2 First Name")) columnsRemoved.add("Owner 2 First Name");
      if (headerSet.has("Owner 2 Last Name")) columnsRemoved.add("Owner 2 Last Name");
      delete next["Owner 1 First Name"];
      delete next["Owner 1 Last Name"];
      delete next["Owner 2 First Name"];
      delete next["Owner 2 Last Name"];
      if (owner1First) {
        next.homeowner_first_name = owner1First;
        if (!columnsAdded.includes("homeowner_first_name")) {
          columnsAdded.push("homeowner_first_name");
        }
      }
      if (owner1Last) {
        next.homeowner_last_name = owner1Last;
        if (!columnsAdded.includes("homeowner_last_name")) {
          columnsAdded.push("homeowner_last_name");
        }
      }
      if (owner2First || owner2Last) rowsWithOwner2Dropped++;

      // ---- Method of Add ------------------------------------------------
      const method = (next["Method of Add"] ?? "").trim();
      if (method.toLowerCase() === "manual") rowsWithManualMethod++;

      return next;
    });

    if (rowsWithDncMerged > 0) {
      notes.push(
        `Folded 5-phone block into 3 slots; ${rowsWithDncMerged} row(s) had a DNC-flagged number — set Do Not Contact = true`,
      );
    } else {
      notes.push("Folded 5-phone block into 3 slots");
    }
    notes.push("Folded Email 1..4 into a single email; secondary emails dropped");
    notes.push("Mapped Owner 1's name to homeowner first/last");
    if (rowsWithOwner2Dropped > 0) {
      notes.push(
        `Owner 2 columns dropped on ${rowsWithOwner2Dropped} row(s) (multi-owner deferred to a future schema bump)`,
      );
    }

    // Build the new headers list: original headers minus removed columns,
    // plus the canonical homeowner fields we added (in stable order).
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
        sourceSuggestion: "propstream",
        tags: rowsWithManualMethod > 0 ? ["propstream-manual"] : undefined,
      },
    };
    return result;
  },
};
