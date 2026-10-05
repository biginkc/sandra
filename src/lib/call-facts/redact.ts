import { KNOWN_REP_NAMES_BY_EMAIL } from "@/lib/coach/rep-display-name";

import { COMMON_WORD_NAMES, GENERIC_TOKENS } from "./name-lists";
import { SUMMARY_MAX_CHARS, TRANSCRIPT_MAX_CHARS } from "./prepare";
import type { FactsInput } from "./types";

/**
 * Pure redaction that runs BEFORE anything is sent to TypeSafe, and whose output is also the text
 * evidence is validated against. It is the ONLY producer of RedactedFactsInput, the only text type the
 * extractor accepts, and it ends with a scan that throws if any known name survived.
 *
 * Known names come from the claim (fn_call_known_names: every member, lead contact, signer and Dialpad
 * name for the call), the hard-coded rep map, and the speaker prefixes found in the transcript itself.
 * Matching rules:
 *   - Text and names are NFKC-normalized, curly apostrophes become ', letters are Unicode (\p{L}).
 *   - Whole names (2+ tokens and every adjacent run of tokens, hyphen/space interchangeable) are
 *     always masked, longest first.
 *   - Single tokens (split on whitespace, hyphens, . _ + digits and apostrophes, with and without
 *     apostrophes): 3+ letters not on a list are masked case-insensitively (ASR is often lowercase);
 *     2-letter tokens and COMMON_WORD_NAMES are masked only when Capitalized; 1-letter tokens and
 *     GENERIC_TOKENS are never masked on their own.
 *   - A match must not touch another letter, so "Rick's", "Ricks'" and "Rick" in "Rick2" mask, while
 *     "Rickety" does not. Possessives keep their suffix: "[name]'s".
 *   - Speaker prefixes ("Name: text") become "Other party" (a lead), "Rep" (a member) or "Speaker A..";
 *     their tokens are also added to the mask set. Existing role labels pass through unchanged.
 *   - Emails, US phone numbers and US street addresses are masked. Dollar amounts survive.
 */
export type RedactionContext = {
  /** Every lead-side name for the call (fn_call_known_names kind 'lead'). */
  contactNames: readonly string[];
  /** Property street line, with optional city and zip. */
  propertyAddress?: { address?: string | null; city?: string | null; zip?: string | null } | null;
  /** Every rep-side name for the call (fn_call_known_names kind 'rep'). */
  repNames?: readonly string[];
};

declare const REDACTED: unique symbol;
/** Text that has passed redaction and the leak scan. The extractor accepts nothing else. */
export type RedactedFactsInput = FactsInput & { readonly [REDACTED]: true };

export class RedactionLeakError extends Error {
  constructor(public readonly leaks: number) {
    super(`redaction leak: ${leaks} known name(s) survived masking`); // never includes the names
    this.name = "RedactionLeakError";
  }
}

export const MASK_NAME = "[name]";
export const MASK_PHONE = "[phone]";
export const MASK_EMAIL = "[email]";
export const MASK_ADDRESS = "[address]";
const PH = ""; // private-use placeholder, so a mask is never re-matched

const LETTER = String.raw`\p{L}\p{M}`;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const normalize = (s: string) => s.normalize("NFKC").replace(/[‘’ʼ′]/g, "'");
const letterCount = (s: string) => (s.match(/\p{L}/gu) ?? []).length;
const isCapitalized = (s: string) => s.length > 0 && s[0] !== s[0].toLowerCase() && s[0] === s[0].toUpperCase();

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const PHONE = /(?<![\w$.,])(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/g;
const STREET_WORDS =
  "street|st|avenue|ave|road|rd|drive|dr|lane|ln|court|ct|boulevard|blvd|way|place|pl|circle|cir|terrace|ter|parkway|pkwy|highway|hwy|trail|trl";
const STREET = new RegExp(String.raw`\b\d{1,6}\s+(?:[A-Za-z0-9.'-]+\s+){0,4}?(?:${STREET_WORDS})\b\.?`, "gi");

type SingleToken = { token: string; capOnly: boolean };
type Matchers = {
  wholes: RegExp[];
  singles: { re: RegExp; capOnly: boolean }[];
  tokens: SingleToken[];
  leadKeys: Set<string>;
  repKeys: Set<string>;
};

// Possessives: "Rick's" (apostrophe is not a letter) and "Ricks'" (captured as group 1) both keep a "'s" suffix.
const bound = (inner: string) => new RegExp(`(?<![${LETTER}])(?:${inner})(?:(s')|(?![${LETTER}]))`, "giu");

/** Tokens of one name: letter runs (apostrophes kept inside), split on everything else. */
function tokensOf(name: string): string[] {
  return normalize(name)
    .split(/[^\p{L}\p{M}']+/u)
    .map((t) => t.replace(/^'+|'+$/g, ""))
    .filter((t) => letterCount(t) >= 1);
}

/** Single-token rule: null = never masked alone. */
function classify(token: string): { capOnly: boolean } | null {
  const l = token.toLowerCase();
  const letters = letterCount(token);
  if (letters < 2 || GENERIC_TOKENS.has(l)) return null;
  return { capOnly: letters === 2 || COMMON_WORD_NAMES.has(l) };
}

function buildMatchers(leadNames: readonly string[], repNames: readonly string[], harvested: readonly string[]): Matchers {
  const wholeSrc = new Set<string>();
  const singleSrc = new Map<string, boolean>(); // lowercased token -> capOnly
  const keys = (names: readonly string[]) => {
    const out = new Set<string>();
    for (const n of names) {
      const full = normalize(n).replace(/\s+/g, " ").trim().toLowerCase();
      if (full) out.add(full);
      for (const t of tokensOf(n)) out.add(t.toLowerCase());
    }
    return out;
  };
  const addName = (name: string) => {
    const n = normalize(name).replace(/\s+/g, " ").trim();
    if (!n) return;
    const toks = tokensOf(n);
    if (toks.length >= 2) {
      for (let a = 0; a < toks.length; a++) {
        for (let b = a + 2; b <= toks.length; b++) wholeSrc.add(toks.slice(a, b).map(escapeRe).join(String.raw`[\s\-]+`));
      }
    }
    // The literal form too ("tom.baker" spoken as written), with flexible whitespace.
    if (toks.length >= 1 && letterCount(n) >= 3 && n.toLowerCase() !== toks.join(" ").toLowerCase()) {
      wholeSrc.add(escapeRe(n).replace(/\s+/g, String.raw`\s+`));
    }
    for (const t of toks) {
      for (const form of new Set([t, t.replace(/'/g, ""), ...t.split("'")])) {
        if (!form) continue;
        const c = classify(form);
        if (!c) continue;
        const prev = singleSrc.get(form.toLowerCase());
        singleSrc.set(form.toLowerCase(), prev === undefined ? c.capOnly : prev && c.capOnly);
      }
    }
  };
  const knownReps = [...repNames, ...KNOWN_REP_NAMES_BY_EMAIL.values()];
  for (const n of [...leadNames, ...knownReps, ...harvested]) addName(n);

  const wholes = [...wholeSrc].sort((a, b) => b.length - a.length).map(bound);
  const tokens: SingleToken[] = [...singleSrc].map(([token, capOnly]) => ({ token, capOnly }));
  const singles = tokens
    .slice()
    .sort((a, b) => b.token.length - a.token.length)
    .map((t) => ({ re: bound(escapeRe(t.token)), capOnly: t.capOnly }));
  return { wholes, singles, tokens, leadKeys: keys(leadNames), repKeys: keys(knownReps) };
}

function maskNames(text: string, m: Matchers): string {
  let out = text;
  const mask = (_hit: string, plural: string | undefined) => (plural ? `${PH}'s` : PH);
  for (const re of m.wholes) out = out.replace(re, mask);
  for (const s of m.singles) out = out.replace(s.re, (hit, plural: string | undefined) => (s.capOnly && !isCapitalized(hit) ? hit : mask(hit, plural)));
  return out;
}

function maskAddress(text: string, terms: readonly string[]): string {
  let out = text;
  for (const term of [...terms].sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(`(?<![${LETTER}\\d])${escapeRe(normalize(term)).replace(/\s+/g, String.raw`\s+`)}(?![${LETTER}\\d])`, "giu"), MASK_ADDRESS);
  }
  return out;
}

const ROLE_LABELS = new Set(["rep", "other party"]);
const LINE = /^([^:\n]{1,80}):\s?([\s\S]*)$/;

/** Pass 1 + 2: mask names and PII and relabel speakers. Exported only so the sweep can inject a faulty masker in tests. */
export function maskFactsInput(input: FactsInput, ctx: RedactionContext): FactsInput {
  const summary = input.summary === null ? null : normalize(input.summary);
  const transcript = input.transcript === null ? null : normalize(input.transcript);
  const lines = transcript === null ? null : transcript.split("\n");
  // Speaker prefixes found in the transcript itself (covers Dialpad's own display names).
  const harvested = (lines ?? []).flatMap((l) => {
    const m = LINE.exec(l);
    return m && !ROLE_LABELS.has(m[1].trim().toLowerCase()) ? [m[1].trim()] : [];
  });
  const m = buildMatchers(ctx.contactNames, ctx.repNames ?? [], harvested);
  const addr = ctx.propertyAddress;
  const addressTerms = [addr?.address, [addr?.address, addr?.city].filter(Boolean).join(", "), addr?.zip && addr?.address ? `${addr.address} ${addr.zip}` : null,
    addr?.zip && addr?.address && addr?.city ? `${addr.address}, ${addr.city} ${addr.zip}` : null]
    .filter((v): v is string => typeof v === "string" && v.trim().length >= 4)
    .map((v) => v.trim());

  const scrub = (text: string): string => {
    // Emails first: a name inside an address must not leave "[name]@domain" behind.
    let out = text.replace(EMAIL, MASK_EMAIL);
    out = maskAddress(out, addressTerms);
    out = maskNames(out, m);
    out = out.replace(STREET, MASK_ADDRESS).replace(PHONE, MASK_PHONE);
    return out.split(PH).join(MASK_NAME);
  };

  const speakers = new Map<string, string>();
  const labelFor = (rawName: string): string => {
    const key = rawName.replace(/\s+/g, " ").trim().toLowerCase();
    if (ROLE_LABELS.has(key)) return key === "rep" ? "Rep" : "Other party";
    const words = tokensOf(rawName).map((w) => w.toLowerCase());
    const every = (set: Set<string>) => set.has(key) || (words.length > 0 && words.every((w) => set.has(w) || GENERIC_TOKENS.has(w)) && words.some((w) => set.has(w)));
    if (every(m.leadKeys)) return "Other party";
    if (every(m.repKeys)) return "Rep";
    let label = speakers.get(key);
    if (!label) {
      const i = speakers.size;
      label = `Speaker ${String.fromCharCode(65 + (i % 26))}${i >= 26 ? Math.floor(i / 26) : ""}`;
      speakers.set(key, label);
    }
    return label;
  };

  return {
    summary: summary === null ? null : scrub(summary),
    transcript:
      lines === null
        ? null
        : lines
            .map((line) => {
              const lm = LINE.exec(line);
              return lm ? `${labelFor(lm[1])}: ${scrub(lm[2])}` : scrub(line);
            })
            .join("\n"),
  };
}

const MASK_TOKENS = /\[(?:name|phone|email|address)\]/g;

/**
 * Independent final check (token scan, not the regex pass): throws RedactionLeakError if any known name
 * still appears. Role labels and masks are removed first. Same classification as the masker.
 */
export function assertNoKnownNames(text: FactsInput, ctx: RedactionContext): void {
  const m = buildMatchers(ctx.contactNames, ctx.repNames ?? [], []);
  const bodies = [text.summary ?? "", ...(text.transcript ?? "").split("\n").map((l) => LINE.exec(l)?.[2] ?? l)];
  let leaks = 0;
  const lookup = new Map(m.tokens.map((t) => [t.token, t.capOnly]));
  for (const body of bodies) {
    for (const word of body.replace(MASK_TOKENS, " ").match(/[\p{L}\p{M}']+/gu) ?? []) {
      const w = word.replace(/^'+|'+$/g, "");
      for (const form of new Set([w, w.replace(/'/g, ""), ...w.split("'")])) {
        const capOnly = lookup.get(form.toLowerCase());
        if (capOnly === undefined) continue;
        if (!capOnly || isCapitalized(form)) leaks += 1;
      }
    }
  }
  if (leaks > 0) throw new RedactionLeakError(leaks);
}

/** Bounds the text, scans it, and brands it. The only way to obtain a RedactedFactsInput. */
export function finalizeRedacted(masked: FactsInput, ctx: RedactionContext): RedactedFactsInput {
  const bounded: FactsInput = {
    summary: masked.summary ? masked.summary.slice(0, SUMMARY_MAX_CHARS) : null,
    transcript: masked.transcript ? masked.transcript.slice(0, TRANSCRIPT_MAX_CHARS) : null,
  };
  assertNoKnownNames(bounded, ctx);
  return bounded as RedactedFactsInput;
}

export function redactFactsInput(input: FactsInput, ctx: RedactionContext): RedactedFactsInput {
  return finalizeRedacted(maskFactsInput(input, ctx), ctx);
}
