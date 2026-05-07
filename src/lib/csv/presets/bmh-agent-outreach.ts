/**
 * BMH Agent Outreach (per-county Google Sheet) preset.
 *
 * The BMH outreach Sheets are one-per-county tabs with a fixed schema:
 *
 *   Property Address | First Name | Last Name | Phone | Email | Link |
 *   Status | Follow Up | Lead Source | Date Created | County
 *
 * (Older sheets used "First Seen" instead of "Lead Source"; both are
 * accepted by the detector — Lead Source is preferred when present.)
 *
 * Each row is an agent contact tied to a property listing. The contact
 * fields map to `agent_*` and the address splits into the property
 * fields. The three workflow columns (Status, Follow Up, Lead Source)
 * are carried as `suggestions.tags` until a future schema phase grows
 * dedicated outreach-state fields.
 *
 * Detection signature: all 11 expected headers present (1.0); 8+ of 11
 * present (0.7+) for column drift tolerance.
 */
import { normalizeCountyName, parseFullAddress } from "@/lib/csv/normalize";

import type { TransformResult, VendorPreset } from "./types";

const REQUIRED_HEADERS = [
  "Property Address",
  "First Name",
  "Last Name",
  "Phone",
  "Email",
  "Link",
  "Status",
  "Follow Up",
  "Date Created",
  "County",
] as const;

/** Old sheets used "First Seen", newer sheets use "Lead Source". Either
 *  one counts toward the 11-column signature. */
const ALTERNATE_LEAD_SOURCE = ["Lead Source", "First Seen"] as const;

export const bmhAgentOutreachPreset: VendorPreset = {
  id: "bmh_outreach",
  label: "BMH Agent Outreach Sheets",
  description:
    "BMH's per-county agent-outreach Google Sheets (Clay County MO, " +
    "Camden County MO, Caddo Parish LA, etc.). We split the combined " +
    "Property Address, map agent contact fields, and carry Status / " +
    "Follow Up / Lead Source as tags.",
  importable: true,
  version: 1,

  detect(headers) {
    const headerSet = new Set(headers);
    const matched = REQUIRED_HEADERS.filter((h) => headerSet.has(h));
    const hasLeadSource = ALTERNATE_LEAD_SOURCE.some((h) => headerSet.has(h));
    const totalSignal = matched.length + (hasLeadSource ? 1 : 0);
    const targetCount = REQUIRED_HEADERS.length + 1; // 11 total

    if (totalSignal === targetCount) {
      return {
        id: "bmh_outreach",
        confidence: 0.95,
        reasons: ["All 11 BMH outreach headers present"],
      };
    }
    if (totalSignal >= 8) {
      return {
        id: "bmh_outreach",
        confidence: 0.7 + ((totalSignal - 8) * 0.05),
        reasons: [`${totalSignal} of ${targetCount} BMH outreach headers present`],
      };
    }
    if (totalSignal >= 5) {
      return {
        id: "bmh_outreach",
        confidence: 0.45,
        reasons: [`${totalSignal} of ${targetCount} BMH outreach headers present`],
      };
    }
    return null;
  },

  transform(rows, headers) {
    const headerSet = new Set(headers);
    const columnsRemoved = new Set<string>();
    const columnsAdded: string[] = [];
    const notes: string[] = [];

    let rowsWithAddressSplit = 0;
    let rowsWithAddressKept = 0;
    const tags = new Set<string>();
    let countySuggestion: string | null = null;

    const out: Record<string, string>[] = rows.map((row) => {
      const next: Record<string, string> = { ...row };

      // ---- Property Address: split when parseable -----------------------
      const combined = (next["Property Address"] ?? "").trim();
      if (combined) {
        const parsed = parseFullAddress(combined);
        if (parsed) {
          next.address = parsed.address;
          next.city = parsed.city;
          next.state = parsed.state;
          next.zip = parsed.zip;
          delete next["Property Address"];
          for (const target of ["address", "city", "state", "zip"]) {
            if (!columnsAdded.includes(target)) columnsAdded.push(target);
          }
          columnsRemoved.add("Property Address");
          rowsWithAddressSplit++;
        } else {
          // Unparseable — let the wizard map it as `address_full`.
          next.address_full = combined;
          delete next["Property Address"];
          if (!columnsAdded.includes("address_full")) {
            columnsAdded.push("address_full");
          }
          columnsRemoved.add("Property Address");
          rowsWithAddressKept++;
        }
      }

      // ---- Agent fields -------------------------------------------------
      const agentMappings: Array<[string, string]> = [
        ["First Name", "agent_first_name"],
        ["Last Name", "agent_last_name"],
        ["Phone", "agent_phone"],
        ["Email", "agent_email"],
      ];
      for (const [src, target] of agentMappings) {
        const v = (next[src] ?? "").trim();
        if (v) {
          next[target] = v;
          if (!columnsAdded.includes(target)) columnsAdded.push(target);
        }
        delete next[src];
        columnsRemoved.add(src);
      }

      // ---- County -------------------------------------------------------
      const county = (next.County ?? "").trim();
      if (county) {
        next.county_name = county;
        if (!columnsAdded.includes("county_name")) columnsAdded.push("county_name");
        if (!countySuggestion) {
          const normalized = normalizeCountyName(county);
          if (normalized) {
            // Title-case for display in the suggested list name.
            countySuggestion = normalized
              .split(/\s+/)
              .map((w) => w[0].toUpperCase() + w.slice(1))
              .join(" ");
          }
        }
      }
      delete next.County;
      columnsRemoved.add("County");

      // ---- Tags from outreach-state columns -----------------------------
      // Collect first, then DELETE the source columns so autodetect
      // doesn't re-map "Lead Source" → property.source enum (its
      // values are realtor.com / zillow / etc — free-form strings, not
      // enum members). These three plus Date Created and Link travel
      // as tags only; nothing else needs them on the row.
      for (const stateCol of ["Status", "Follow Up", "Lead Source", "First Seen"]) {
        const v = (next[stateCol] ?? "").trim();
        if (v) tags.add(v);
        delete next[stateCol];
        if (headerSet.has(stateCol)) columnsRemoved.add(stateCol);
      }
      // Drop ancillary columns that have no schema target either —
      // Link is the realtor listing URL (could become a future field),
      // Date Created is the spreadsheet's audit timestamp.
      for (const ancillary of ["Link", "Date Created"]) {
        delete next[ancillary];
        if (headerSet.has(ancillary)) columnsRemoved.add(ancillary);
      }

      return next;
    });

    if (rowsWithAddressSplit > 0) {
      notes.push(
        `Split combined Property Address into address/city/state/zip on ${rowsWithAddressSplit} row(s)`,
      );
    }
    if (rowsWithAddressKept > 0) {
      notes.push(
        `Kept ${rowsWithAddressKept} row(s) as address_full where the combined value couldn't be parsed`,
      );
    }
    notes.push(
      "Mapped First Name / Last Name / Phone / Email to agent_* fields",
    );
    notes.push(
      "Status / Follow Up / Lead Source preserved as tags (no schema change yet)",
    );

    const newHeaders = [
      ...headers.filter((h) => !columnsRemoved.has(h)),
      ...columnsAdded.filter((h) => !headers.includes(h)),
    ];

    const listNameSuggestion = countySuggestion
      ? `${countySuggestion} outreach`
      : undefined;

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
        sourceSuggestion: "agent_outreach",
        listNameSuggestion,
        tags: tags.size > 0 ? [...tags] : undefined,
      },
    };
    return result;
  },
};
