import type { FactsInput } from "./types";

/**
 * Pure redaction that runs BEFORE anything is sent to the model, and whose output is also the text
 * evidence is validated against (the model never sees, and can never quote, the raw text).
 *
 * Rules, in order:
 *   1. The lead's contact names, the org members' names (reps) and the property address are masked
 *      wherever they appear, in the transcript body AND the summary, case-insensitively, as whole
 *      names and as first/last-name tokens of 3+ letters.
 *   2. Transcript speaker prefixes ("Name: text") become role labels: "Other party" when the name
 *      is one of the lead's names, "Rep" when it is one of the supplied rep names, otherwise a
 *      neutral "Speaker A", "Speaker B" (stable per distinct name).
 *   3. Email addresses, US phone numbers and US street addresses are masked.
 * Dollar amounts are left alone: asking price and mortgage depend on them.
 */
export type RedactionContext = {
  /** Lead contact first/last/entity names. */
  contactNames: readonly string[];
  /** Property street line, with optional city and zip. */
  propertyAddress?: { address?: string | null; city?: string | null; zip?: string | null } | null;
  /** Display names of the org's members (reps, assignee), from the claim. */
  repNames?: readonly string[];
};

export const MASK_NAME = "[name]";
export const MASK_PHONE = "[phone]";
export const MASK_EMAIL = "[email]";
export const MASK_ADDRESS = "[address]";

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const PHONE = /(?<![\w$.,])(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/g;
const STREET_WORDS =
  "street|st|avenue|ave|road|rd|drive|dr|lane|ln|court|ct|boulevard|blvd|way|place|pl|circle|cir|terrace|ter|parkway|pkwy|highway|hwy|trail|trl";
const STREET = new RegExp(`\\b\\d{1,6}\\s+(?:[A-Za-z0-9.'-]+\\s+){0,4}?(?:${STREET_WORDS})\\b\\.?`, "gi");

function maskTerms(text: string, terms: readonly string[], mask: string): string {
  let out = text;
  // Longest first so "Jane Smith" is masked whole before "Jane".
  for (const term of [...terms].sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(`(?<![A-Za-z0-9])${escapeRe(term).replace(/\s+/g, "\\s+")}(?![A-Za-z0-9])`, "gi"), mask);
  }
  return out;
}

function nameTerms(names: readonly string[]): { whole: string[]; parts: string[] } {
  const whole = names.map((n) => n.replace(/\s+/g, " ").trim()).filter((n) => n.length >= 2);
  const parts = whole.flatMap((n) => n.split(/[^A-Za-z']+/)).filter((p) => p.replace(/'/g, "").length >= 3);
  return { whole, parts };
}

const LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export function redactFactsInput(input: FactsInput, ctx: RedactionContext): FactsInput {
  const lead = nameTerms(ctx.contactNames);
  const leadKeys = new Set([...lead.whole, ...lead.parts].map(norm));
  const rep = nameTerms(ctx.repNames ?? []);
  const repKeys = new Set([...rep.whole, ...rep.parts].map(norm));
  const addr = ctx.propertyAddress;
  const addressTerms = [addr?.address, [addr?.address, addr?.city].filter(Boolean).join(", "), addr?.zip && addr?.address ? `${addr.address} ${addr.zip}` : null]
    .filter((v): v is string => typeof v === "string" && v.trim().length >= 4)
    .map((v) => v.trim());

  const scrub = (text: string): string => {
    // Emails first: a name inside an address must not leave "[name]@domain" behind.
    let out = text.replace(EMAIL, MASK_EMAIL);
    out = maskTerms(out, addressTerms, MASK_ADDRESS);
    out = maskTerms(out, [...lead.whole, ...lead.parts, ...rep.whole, ...rep.parts], MASK_NAME);
    out = out.replace(STREET, MASK_ADDRESS).replace(PHONE, MASK_PHONE);
    return out;
  };

  const speakers = new Map<string, string>();
  const labelFor = (rawName: string): string => {
    const key = norm(rawName);
    const words = key.split(/[\s,]+/).filter(Boolean);
    if (leadKeys.has(key) || (words.length > 0 && words.every((w) => leadKeys.has(w)))) return "Other party";
    if (repKeys.has(key) || (words.length > 0 && words.every((w) => repKeys.has(w)))) return "Rep";
    let label = speakers.get(key);
    if (!label) {
      label = `Speaker ${LABELS[speakers.size % 26]}${speakers.size >= 26 ? Math.floor(speakers.size / 26) : ""}`;
      speakers.set(key, label);
    }
    return label;
  };

  const transcript =
    input.transcript === null
      ? null
      : input.transcript
          .split("\n")
          .map((line) => {
            const m = /^([^:\n]{1,80}):\s?([\s\S]*)$/.exec(line);
            return m ? `${labelFor(m[1])}: ${scrub(m[2])}` : scrub(line);
          })
          .join("\n");
  return { summary: input.summary === null ? null : scrub(input.summary), transcript };
}
