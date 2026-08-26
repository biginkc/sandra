import { COACH_TOKENS, type CoachCallContext, type CoachToken, type ResolvedToken, type ResolvedTokens } from "./types";

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
 * {county_first2_upper}-{lead_id_last4}, falling back to
 * {county_first2_upper}-{seller_phone_last4} when the lead id is unusable,
 * per closr-script-v0.json's file_number_rule.
 */
export function resolveFileNumber(context: CoachCallContext): ResolvedToken {
  const prefix = countyPrefix(context.propertyCounty);
  if (!prefix) return { value: COACH_TOKEN_PLACEHOLDER, isPlaceholder: true };

  const idTail = last4Alnum(context.leadId);
  if (idTail && idTail.length === 4) {
    return { value: `${prefix}-${idTail}`, isPlaceholder: false };
  }

  const phoneTail = last4Alnum(context.sellerPhoneE164);
  if (phoneTail && phoneTail.length === 4) {
    return { value: `${prefix}-${phoneTail}`, isPlaceholder: false };
  }

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

/** Fills every token the script can reference from live call context. Never
 * returns a blank string for a missing value — callers render `isPlaceholder`
 * tokens as a subtle chip instead. */
export function resolveCoachTokens(context: CoachCallContext): ResolvedTokens {
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
        return [token, resolvedOrPlaceholder(context.motivation)];
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
 * Tokens the script defines but the resolver doesn't cover (e.g.
 * {cold_caller_name}, {closing_date}) pass through as literal text. */
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
