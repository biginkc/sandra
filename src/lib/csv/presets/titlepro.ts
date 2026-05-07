/**
 * TitlePro / DataTree title-event export preset.
 *
 * TitlePro/DataTree exports share a property base (Site Address, APN,
 * 1st Owner's First/Last, valuation) plus a 2-letter event-prefix block.
 * Five subtypes ship today:
 *
 *   AD.* — Affidavit of Death           (death lists)
 *   CP.* — Cash Purchase                (cash-buyer lists)
 *   LP.* — Lis Pendens                  (pre-foreclosure)
 *   BK.* — Bankruptcy
 *   DF.* — Default / Notice of Default  (foreclosure)
 *
 * Detection signature: any of the above prefixes paired (`XX.type` +
 * `XX.file_date`). Subtype = whichever prefix dominates the headers.
 *
 * Transform highlights:
 *   - APN merge: when both `APN` (numeric, may be scientific notation)
 *     and `APN (text)` (`="..."` Excel-armored) exist, prefer the text
 *     variant after stripping the armor. `normalizeApn` then rejects any
 *     remaining sci-notation values at validation time.
 *   - Row dedup: collapse repeats sharing
 *     `(normalizedAPN, eventPrefix, file_date)`, keeping the most
 *     recent `insert_date`.
 *   - Owner: `1st Owner's First Name` / `Last Name` →
 *     `homeowner_first_name` / `homeowner_last_name`.
 *   - Subtype + list-name: surfaced as `suggestions.tags` and
 *     `suggestions.listNameSuggestion`.
 */
import { normalizeApn } from "@/lib/csv/normalize";

import type { TransformResult, VendorPreset } from "./types";

type EventPrefix = "AD" | "CP" | "LP" | "BK" | "DF";

const EVENT_PREFIXES: readonly EventPrefix[] = ["AD", "CP", "LP", "BK", "DF"];

const SUBTYPE_BY_PREFIX: Record<EventPrefix, string> = {
  AD: "titlepro-death",
  CP: "titlepro-cash-purchase",
  LP: "titlepro-lis-pendens",
  BK: "titlepro-bankruptcy",
  DF: "titlepro-default",
};

const LIST_LABEL_BY_PREFIX: Record<EventPrefix, string> = {
  AD: "Death",
  CP: "Cash Purchase",
  LP: "Pre-Foreclosure",
  BK: "Bankruptcy",
  DF: "Default",
};

/** Strip Excel's `="..."` armor that appears on ID columns formatted as
 *  text to avoid auto-conversion to scientific notation. Idempotent. */
function stripExcelArmor(raw: string): string {
  const trimmed = raw.trim();
  const m = trimmed.match(/^="(.*)"$/);
  return m ? m[1] : trimmed;
}

/** Count how many headers carry each event prefix. Returns the prefix
 *  with the strongest signal plus its raw count. */
function dominantPrefix(headers: readonly string[]): {
  prefix: EventPrefix | null;
  count: number;
  totalEventHeaders: number;
} {
  const counts: Record<EventPrefix, number> = { AD: 0, CP: 0, LP: 0, BK: 0, DF: 0 };
  let total = 0;
  for (const h of headers) {
    for (const p of EVENT_PREFIXES) {
      if (h.startsWith(`${p}.`)) {
        counts[p]++;
        total++;
        break;
      }
    }
  }
  let best: EventPrefix | null = null;
  let bestCount = 0;
  for (const p of EVENT_PREFIXES) {
    if (counts[p] > bestCount) {
      bestCount = counts[p];
      best = p;
    }
  }
  return { prefix: best, count: bestCount, totalEventHeaders: total };
}

export const titleproPreset: VendorPreset = {
  id: "titlepro",
  label: "TitlePro / DataTree Title Events",
  description:
    "Title-event exports from TitlePro or DataTree (Death, Cash Purchase, " +
    "Lis Pendens, Bankruptcy, Default). We merge the dual APN columns, " +
    "collapse repeated parcels, and tag the event subtype as a list label.",
  importable: true,
  version: 1,

  detect(headers) {
    const headerSet = new Set(headers);
    const { prefix, count, totalEventHeaders } = dominantPrefix(headers);
    if (!prefix || count === 0) return null;

    // Strong fingerprint: dominant prefix has both `.type` AND `.file_date`,
    // and dominant prefix accounts for ≥ 70% of all event headers.
    const hasType = headerSet.has(`${prefix}.type`);
    const hasFileDate = headerSet.has(`${prefix}.file_date`);
    const dominanceRatio = totalEventHeaders > 0 ? count / totalEventHeaders : 0;

    if (hasType && hasFileDate && dominanceRatio >= 0.7) {
      return {
        id: "titlepro",
        confidence: 1.0,
        reasons: [
          `${prefix}.type + ${prefix}.file_date headers present`,
          `${count} event-prefixed columns share the ${prefix} prefix`,
        ],
        subtype: SUBTYPE_BY_PREFIX[prefix],
      };
    }

    // Mixed-prefix file: degraded confidence so banner stays hidden.
    if (hasType && hasFileDate && totalEventHeaders > 0) {
      return {
        id: "titlepro",
        confidence: 0.55,
        reasons: [
          `Event-prefixed columns present but mixed across ${EVENT_PREFIXES.filter((p) => headers.some((h) => h.startsWith(`${p}.`))).length} prefixes`,
        ],
        subtype: SUBTYPE_BY_PREFIX[prefix],
      };
    }

    return null;
  },

  transform(rows, headers) {
    const headerSet = new Set(headers);
    const { prefix } = dominantPrefix(headers);
    const columnsRemoved = new Set<string>();
    const columnsAdded: string[] = [];
    const notes: string[] = [];

    const hasApnText = headerSet.has("APN (text)");
    const hasApnNumeric = headerSet.has("APN");

    let rowsWithBeneficiaryDropped = 0;

    // First pass: per-row reshape (APN merge, owner mapping).
    const reshaped: Record<string, string>[] = rows.map((row) => {
      const next: Record<string, string> = { ...row };

      // ---- APN merge ----------------------------------------------------
      if (hasApnText) {
        const armored = (next["APN (text)"] ?? "").trim();
        if (armored) {
          next.APN = stripExcelArmor(armored);
        }
        delete next["APN (text)"];
      }

      // ---- Owner names --------------------------------------------------
      const firstName = (next["1st Owner's First Name"] ?? "").trim();
      const lastName = (next["1st Owner's Last Name"] ?? "").trim();
      if (firstName) {
        next.homeowner_first_name = firstName;
        if (!columnsAdded.includes("homeowner_first_name")) {
          columnsAdded.push("homeowner_first_name");
        }
      }
      if (lastName) {
        next.homeowner_last_name = lastName;
        if (!columnsAdded.includes("homeowner_last_name")) {
          columnsAdded.push("homeowner_last_name");
        }
      }

      // ---- Beneficiary block (drop with note) ---------------------------
      // We don't actually delete beneficiary cells — they pass through
      // as raw columns and are simply not aliased. Counting here just
      // surfaces the multi-owner case in stats.notes for transparency.
      const hasBeneficiaryData = Object.keys(next).some(
        (k) => /beneficiary/i.test(k) && next[k]?.trim(),
      );
      if (hasBeneficiaryData) {
        rowsWithBeneficiaryDropped++;
      }

      return next;
    });

    if (hasApnText) {
      columnsRemoved.add("APN (text)");
      notes.push("Merged APN + APN (text) into a single APN column");
    }
    if (rowsWithBeneficiaryDropped > 0) {
      notes.push(
        `Beneficiary block dropped on ${rowsWithBeneficiaryDropped} row(s) (multi-owner deferred to a future schema bump)`,
      );
    }
    if (hasApnNumeric && !hasApnText) {
      notes.push("APN column kept as-is — no Excel-armored variant present");
    }

    // Second pass: dedup by (normalizedAPN, eventPrefix, file_date),
    // keeping the row with the most-recent insert_date if available
    // (ISO-ish strings sort lexically). When APN can't be normalized we
    // fall back to the row's index so dedup is a no-op for that row.
    const eventPrefix = prefix ?? "";
    const fileDateKey = eventPrefix ? `${eventPrefix}.file_date` : "";
    const insertDateKey = eventPrefix ? `${eventPrefix}.insert_date` : "";

    const seen = new Map<string, { row: Record<string, string>; idx: number }>();
    let collapsed = 0;
    reshaped.forEach((row, idx) => {
      const apnNormalized = normalizeApn(row.APN);
      const fileDate = (row[fileDateKey] ?? "").trim();
      if (!apnNormalized || !eventPrefix || !fileDate) {
        // Can't dedup this row safely — keep it under a unique key.
        seen.set(`__keep_${idx}`, { row, idx });
        return;
      }
      const key = `${apnNormalized}|${eventPrefix}|${fileDate}`;
      const prev = seen.get(key);
      if (!prev) {
        seen.set(key, { row, idx });
        return;
      }
      // Tie-break: prefer the most recent insert_date.
      const a = (prev.row[insertDateKey] ?? "").trim();
      const b = (row[insertDateKey] ?? "").trim();
      if (b && b >= a) {
        seen.set(key, { row, idx });
      }
      collapsed++;
    });

    const out = [...seen.values()]
      .sort((a, b) => a.idx - b.idx)
      .map((e) => e.row);

    if (collapsed > 0) {
      notes.push(
        `Collapsed ${collapsed} duplicate parcel/event row(s) (same APN + ${eventPrefix} + file_date)`,
      );
    }

    // Build new headers: drop APN (text) if it was present, append the
    // canonical homeowner fields we added.
    const newHeaders = [
      ...headers.filter((h) => !columnsRemoved.has(h)),
      ...columnsAdded.filter((h) => !headers.includes(h)),
    ];

    const subtype = prefix ? SUBTYPE_BY_PREFIX[prefix] : undefined;
    const listSeed = prefix && fileDateKey ? out[0]?.[fileDateKey] : "";
    const yearMonth = listSeed ? listSeed.slice(0, 7) : "";
    const listLabel = prefix ? LIST_LABEL_BY_PREFIX[prefix] : "";
    const listNameSuggestion =
      listLabel && yearMonth ? `${listLabel} — ${yearMonth}` : listLabel || undefined;

    const result: TransformResult = {
      rows: out,
      headers: newHeaders,
      stats: {
        rowsIn: rows.length,
        rowsOut: out.length,
        rowsCollapsedDup: collapsed,
        columnsAdded,
        columnsRemoved: [...columnsRemoved],
        notes,
      },
      suggestions: {
        sourceSuggestion: "titlepro",
        listNameSuggestion,
        tags: subtype ? [subtype] : undefined,
      },
    };
    return result;
  },
};
