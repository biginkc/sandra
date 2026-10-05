import { CALLBACK_DEFAULT_TIMEZONE } from "@/lib/norma/callback-time";
import { wallTimeToUtc } from "@/lib/time/zoned";

import { FACT_FIELDS, type FactsInput, type ValidFacts } from "./types";

/**
 * Every rule that decides whether a proposed fact survives lives HERE, in code, never in the
 * prompt. A field is dropped (never repaired) when:
 *   - it is not one of the six known fields;
 *   - its value or evidence is not a non-empty string (bounded length);
 *   - its evidence does not appear verbatim (case-insensitive, whitespace-collapsed) in the input;
 *   - asking_price / mortgage do not parse to a positive dollar amount (stored normalized, "$185,000");
 *   - next_step is not an ISO date or date-time ("YYYY-MM-DD" or "YYYY-MM-DDTHH:MM", Central time,
 *     default 09:00) that is still in the future and within the horizon (stored as an ISO instant).
 */
export const FACT_VALUE_MAX = 300;
export const FACT_EVIDENCE_MAX = 500;
export const NEXT_STEP_HORIZON_DAYS = 365;
export const NEXT_STEP_DEFAULT_HOUR = 9;
export const MAX_DOLLARS = 1_000_000_000;

export function normalizeForEvidence(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** "$185,000", "185k", "1.2 million", "185000" -> 185000. Null for anything else. */
export function parseDollarAmount(raw: string): number | null {
  const text = raw.trim().toLowerCase().replace(/,/g, "");
  const match = /^\$?\s*(\d+(?:\.\d+)?)\s*(k|thousand|m|mm|million)?$/.exec(text);
  if (!match) return null;
  const base = Number(match[1]);
  const unit = match[2];
  const multiplier = !unit ? 1 : unit === "k" || unit === "thousand" ? 1_000 : 1_000_000;
  const amount = Math.round(base * multiplier * 100) / 100;
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_DOLLARS) return null;
  return amount;
}

export function formatDollars(amount: number): string {
  return `$${amount.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

/** ISO date or date-time in Central time -> ISO instant, only when strictly in the future and inside the horizon. */
export function parseFutureNextStep(raw: string, now: Date): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?$/.exec(raw.trim());
  if (!match) return null;
  const parsed = wallTimeToUtc({
    date: match[1],
    time: match[2] ?? `${String(NEXT_STEP_DEFAULT_HOUR).padStart(2, "0")}:00`,
    timeZone: CALLBACK_DEFAULT_TIMEZONE,
  });
  if (!parsed.ok) return null;
  const at = parsed.utc.getTime();
  if (at <= now.getTime()) return null;
  if (at > now.getTime() + NEXT_STEP_HORIZON_DAYS * 24 * 60 * 60 * 1000) return null;
  return parsed.utc.toISOString();
}

function str(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : null;
}

/** Returns only the fields that pass every rule. Unknown input shapes yield `{}`. */
export function validateFacts(raw: unknown, input: FactsInput, now: Date): ValidFacts {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const haystack = normalizeForEvidence([input.summary ?? "", input.transcript ?? ""].join("\n"));
  if (haystack === "") return {};
  const out: ValidFacts = {};
  for (const field of FACT_FIELDS) {
    const entry = (raw as Record<string, unknown>)[field];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const value = str((entry as Record<string, unknown>).value, FACT_VALUE_MAX);
    const evidence = str((entry as Record<string, unknown>).evidence, FACT_EVIDENCE_MAX);
    if (!value || !evidence) continue;
    if (!haystack.includes(normalizeForEvidence(evidence))) continue;
    if (field === "asking_price" || field === "mortgage") {
      const amount = parseDollarAmount(value);
      if (amount === null) continue;
      out[field] = { value: formatDollars(amount), evidence };
    } else if (field === "next_step") {
      const instant = parseFutureNextStep(value, now);
      if (instant === null) continue;
      out[field] = { value: instant, evidence };
    } else {
      out[field] = { value, evidence };
    }
  }
  return out;
}
