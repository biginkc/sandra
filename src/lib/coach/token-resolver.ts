import { COACH_TOKENS, type CoachCallContext, type CoachEntryFields, type CoachToken, type ResolvedToken, type ResolvedTokens } from "./types";

/** Rendered by the UI as a subtle placeholder chip — never left blank. */
export const COACH_TOKEN_PLACEHOLDER = "—";

function repInitials(repName: string | null): string | null {
  const nameParts = repName?.trim().split(/\s+/) ?? [];
  if (nameParts.length < 2) return null;
  const firstInitial = nameParts[0]?.match(/\p{L}/u)?.[0];
  const lastInitial = nameParts.at(-1)?.match(/\p{L}/u)?.[0];
  return firstInitial && lastInitial
    ? `${firstInitial}${lastInitial}`.toUpperCase()
    : null;
}

function finalSixIdCharacters(leadId: string | null): string | null {
  const id = leadId?.trim();
  if (!id || id.length < 6) return null;
  const suffix = id.slice(-6);
  return /^[a-zA-Z0-9]{6}$/.test(suffix) ? suffix : null;
}

/** {authenticated rep first initial}{last initial}-{final six property ID characters}. */
export function resolveFileNumber(context: CoachCallContext): ResolvedToken {
  const initials = repInitials(context.authenticatedRepName ?? null);
  const idSuffix = finalSixIdCharacters(context.leadId);
  return initials && idSuffix
    ? { value: `${initials}-${idSuffix}`, isPlaceholder: false }
    : { value: COACH_TOKEN_PLACEHOLDER, isPlaceholder: true };
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

function entryValueOrTrusted(
  entryValue: string | null,
  trustedValue: string | null,
): string | null {
  return entryValue?.trim() ? entryValue : trustedValue;
}

export const EMPTY_ENTRY_FIELDS: CoachEntryFields = {
  motivation: null,
  dream_outcome: null,
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
      case "dream_outcome":
        return [token, resolvedOrPlaceholder(entryValueOrTrusted(entryFields.dream_outcome, context.motivation))];
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
