import { COACH_TOKENS, type CoachCallContext, type CoachEntryFields, type CoachToken, type ResolvedToken, type ResolvedTokens } from "./types";

/** Rendered by the UI as a subtle placeholder chip — never left blank. */
export const COACH_TOKEN_PLACEHOLDER = "—";

function countyPrefix(county: string | null): string | null {
  const letters = county?.replace(/[^a-zA-Z]/g, "") ?? "";
  if (letters.length < 2) return null;
  return letters.slice(0, 2).toUpperCase();
}

function last4Alnum(value: string | null): string | null {
  if (!value) return null;
  const alnum = value.replace(/[^a-zA-Z0-9]/g, "");
  if (alnum.length === 0) return null;
  return alnum.slice(-4).toUpperCase();
}

/**
 * {county_first2_upper}-{lead_id_last4}. Per the approved script's token
 * legend, the documented fallback triggers when COUNTY is missing (not
 * when the lead id is) and its value is the seller phone's last 4 digits
 * ALONE — no county prefix, since county is exactly what's unavailable.
 * When county is present but the lead id isn't, the county prefix is kept
 * and the phone digits are used as the suffix instead.
 */
export function resolveFileNumber(context: CoachCallContext): ResolvedToken {
  const prefix = countyPrefix(context.propertyCounty);
  const phoneTail = last4Alnum(context.sellerPhoneE164);

  if (!prefix) {
    // County missing entirely — documented fallback is the phone tail alone.
    return phoneTail
      ? { value: phoneTail, isPlaceholder: false }
      : { value: COACH_TOKEN_PLACEHOLDER, isPlaceholder: true };
  }

  const idTail = last4Alnum(context.leadId);
  if (idTail) return { value: `${prefix}-${idTail}`, isPlaceholder: false };

  // County is known but the lead id isn't — keep the county prefix and
  // fall back to the phone tail as the suffix.
  if (phoneTail) return { value: `${prefix}-${phoneTail}`, isPlaceholder: false };

  return { value: COACH_TOKEN_PLACEHOLDER, isPlaceholder: true };
}

function firstName(name: string | null): string | null {
  const trimmed = name?.trim();
  if (!trimmed) return null;
  return trimmed.split(/\s+/)[0];
}

function resolvedOrPlaceholder(value: string | null): ResolvedToken {
  const trimmed = value?.trim();
  return trimmed ? { value: trimmed, isPlaceholder: false } : { value: COACH_TOKEN_PLACEHOLDER, isPlaceholder: true };
}

function trustedValueOrEntry(
  trustedValue: string | null,
  entryValue: string | null,
): string | null {
  return trustedValue?.trim() ? trustedValue : entryValue;
}

export const EMPTY_ENTRY_FIELDS: CoachEntryFields = {
  motivation: null,
  cold_caller_name: null,
  closing_date: null,
  offer_price: null,
  net_to_seller: null,
};

/** Fills every token the script can reference — 6 from live lead/rep
 * context at dial time, plus session-owned values the rep types in during
 * the call (entryFields; omit to treat them all as unset). Never
 * returns a blank string for a missing value — callers render
 * `isPlaceholder` tokens as a subtle (or, for entry tokens, editable) chip
 * instead. */
export function resolveCoachTokens(
  context: CoachCallContext,
  entryFields: CoachEntryFields = EMPTY_ENTRY_FIELDS,
): ResolvedTokens {
  const entries = COACH_TOKENS.map((token): [CoachToken, ResolvedToken] => {
    switch (token) {
      case "file_number":
        return [token, resolveFileNumber(context)];
      case "seller_name":
        return [token, resolvedOrPlaceholder(firstName(context.sellerName))];
      case "property_address":
        return [token, resolvedOrPlaceholder(context.propertyAddress)];
      case "rep_name":
        return [token, resolvedOrPlaceholder(context.repName)];
      case "rep_phone":
        return [token, resolvedOrPlaceholder(context.repPhoneE164)];
      case "motivation":
        return [token, resolvedOrPlaceholder(trustedValueOrEntry(context.motivation, entryFields.motivation))];
      case "cold_caller_name":
        return [token, resolvedOrPlaceholder(trustedValueOrEntry(context.coldCallerName, entryFields.cold_caller_name))];
      case "year_built":
        return [token, resolvedOrPlaceholder(context.yearBuilt)];
      case "closing_date":
        return [token, resolvedOrPlaceholder(entryFields.closing_date)];
      case "offer_price":
        return [token, resolvedOrPlaceholder(entryFields.offer_price)];
      case "net_to_seller":
        return [token, resolvedOrPlaceholder(entryFields.net_to_seller)];
    }
  });
  return Object.fromEntries(entries) as ResolvedTokens;
}

export type ScriptTextSegment =
  | { kind: "text"; value: string }
  | { kind: "token"; token: CoachToken; resolved: ResolvedToken };

const TOKEN_PATTERN = /\{(\w+)\}/g;

const KNOWN_TOKENS: readonly string[] = COACH_TOKENS;

/** Splits a script phrase into plain-text and token segments so the UI can
 * render resolved values inline and unresolved ones as placeholder chips.
 * Tokens the script defines but the resolver doesn't cover pass through as
 * literal text. Only used for landmark/match phrase display (debugging) —
 * the live script panel uses resolveDisplayText below. */
export function resolveScriptText(text: string, tokens: ResolvedTokens): ScriptTextSegment[] {
  const segments: ScriptTextSegment[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const [full, tokenName] = match;
    const index = match.index ?? 0;
    if (index > lastIndex) segments.push({ kind: "text", value: text.slice(lastIndex, index) });
    if (KNOWN_TOKENS.includes(tokenName)) {
      const token = tokenName as CoachToken;
      segments.push({ kind: "token", token, resolved: tokens[token] });
    } else {
      segments.push({ kind: "text", value: full });
    }
    lastIndex = index + full.length;
  }
  if (lastIndex < text.length) segments.push({ kind: "text", value: text.slice(lastIndex) });
  return segments;
}

export type DisplayTextSegment =
  | { kind: "text"; value: string }
  | { kind: "token"; token: CoachToken; resolved: ResolvedToken }
  | { kind: "tone"; label: string };

const DISPLAY_PATTERN = /\{\{tone:([^}]+)\}\}|\{(\w+)\}/g;

/** Splits one script `display` line into text/token/tone segments. Handles
 * both `{token}` placeholders and inline `{{tone:label}}` cues (the script
 * JSON's markup for a tone reminder that sits mid-sentence, e.g. "…the
 * streets! {{tone:playful tone}} No seriously…"). This is the only
 * resolver that feeds the live script panel's "Say" copy. */
export function resolveDisplayText(text: string, tokens: ResolvedTokens): DisplayTextSegment[] {
  const segments: DisplayTextSegment[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(DISPLAY_PATTERN)) {
    const [full, toneLabel, tokenName] = match;
    const index = match.index ?? 0;
    if (index > lastIndex) segments.push({ kind: "text", value: text.slice(lastIndex, index) });
    if (toneLabel) {
      segments.push({ kind: "tone", label: toneLabel });
    } else if (tokenName && KNOWN_TOKENS.includes(tokenName)) {
      const token = tokenName as CoachToken;
      segments.push({ kind: "token", token, resolved: tokens[token] });
    } else {
      segments.push({ kind: "text", value: full });
    }
    lastIndex = index + full.length;
  }
  if (lastIndex < text.length) segments.push({ kind: "text", value: text.slice(lastIndex) });
  return segments;
}
