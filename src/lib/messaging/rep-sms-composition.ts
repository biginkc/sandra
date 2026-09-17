/**
 * The composition contract for Maria's human SMS workflow.
 *
 * This module deliberately contains no database or provider code.  Keeping
 * the approved copy and the validation here gives the browser a useful
 * preview while leaving the server as the authority for the final body.
 */

export const REP_SMS_COMPOSITION_POLICY_VERSION = 1 as const;
export const REP_SMS_PERSONA = "Mel" as const;
export const REP_SMS_ASSISTANT = "Maria" as const;

export type RepSmsIntroduction = {
  id: string;
  version: number;
  body: string;
};

/** Stable IDs are persisted with the message audit.  Never pick a variant at
 * random: a retry of one request must preserve the text the rep reviewed. */
export const REP_SMS_INTRODUCTIONS: readonly RepSmsIntroduction[] = [
  {
    id: "mel-maria-assistant-1",
    version: 1,
    body: "Hey, this is Mel, Maria's assistant.",
  },
  {
    id: "mel-maria-assistant-2",
    version: 1,
    body: "Hi, Mel here. I'm Maria's assistant.",
  },
  {
    id: "mel-maria-assistant-3",
    version: 1,
    body: "Hello, this is Mel, Maria's assistant. I'm helping coordinate with Maria.",
  },
] as const;

export type RepSmsTemplate = {
  id: string;
  version: number;
  label: string;
  /** Templates contain the editable remainder only. */
  remainder: string;
  origin: "curated";
};

export const REP_SMS_TEMPLATES: readonly RepSmsTemplate[] = [
  {
    id: "no-answer-callback-time",
    version: 1,
    label: "Find a callback time",
    remainder: "Maria wasn't able to reach you. What time would work for her to call you back?",
    origin: "curated",
  },
  {
    id: "no-answer-availability",
    version: 1,
    label: "Ask for availability",
    remainder: "When would be a good time for you and Maria to connect about the property?",
    origin: "curated",
  },
  {
    id: "no-answer-coordinate-time",
    version: 1,
    label: "Offer text coordination",
    remainder: "I'm helping coordinate a time for you and Maria to connect. Feel free to text a time that works for you.",
    origin: "curated",
  },
] as const;

export const DEFAULT_REP_SMS_INTRODUCTION = REP_SMS_INTRODUCTIONS[0];

export type RepSmsCompositionInput = {
  introId?: string | null;
  introVersion?: number | string | null;
  templateId?: string | null;
  templateVersion?: number | string | null;
  /** The remainder shown immediately after choosing the template. */
  initialRemainder?: string | null;
  /** The final editable remainder submitted by the client. */
  remainder?: string | null;
  /** Compatibility alias for callers that submit the editable text as body. */
  body?: string | null;
  /** A previously rendered initial body may be supplied for audit comparison. */
  initialBody?: string | null;
};

export type RepSmsComposition = {
  policyVersion: typeof REP_SMS_COMPOSITION_POLICY_VERSION;
  introId: string;
  introVersion: number;
  templateId: string | null;
  templateVersion: number | null;
  templateOrigin: "curated" | "manual";
  initialRemainder: string;
  remainder: string;
  initialBody: string;
  finalBody: string;
};

export class RepSmsCompositionError extends Error {
  constructor(
    readonly code:
      | "unknown_introduction"
      | "stale_introduction"
      | "unknown_template"
      | "stale_template"
      | "missing_remainder"
      | "duplicate_introduction"
      | "invalid_body",
    message: string,
  ) {
    super(message);
    this.name = "RepSmsCompositionError";
  }
}

function sameVersion(actual: number | string | null | undefined, expected: number, required: boolean): boolean {
  return (actual == null && !required) || String(actual) === String(expected);
}

function cleanRemainder(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function hasApprovedIntroduction(value: string): boolean {
  const normalized = value.trim().toLocaleLowerCase();
  return REP_SMS_INTRODUCTIONS.some((intro) =>
    normalized.includes(intro.body.toLocaleLowerCase()),
  );
}

/**
 * The first composer shipped before the structured composition contract and
 * submitted the already rendered full body as `body`. Recognize that exact
 * approved prefix at the server boundary so it cannot be prefixed a second
 * time. Arbitrary text that merely mentions Mel remains an editable
 * remainder and is validated below as usual.
 */
function splitLegacyFullBody(value: string): {
  introduction: RepSmsIntroduction;
  remainder: string;
} | null {
  const candidate = value.trim();
  for (const introduction of REP_SMS_INTRODUCTIONS) {
    if (candidate === introduction.body) {
      return { introduction, remainder: "" };
    }
    if (candidate.startsWith(`${introduction.body}\n`)) {
      return {
        introduction,
        remainder: candidate.slice(introduction.body.length).trim(),
      };
    }
  }
  return null;
}

function joinBody(introduction: RepSmsIntroduction, remainder: string): string {
  const body = `${introduction.body}\n\n${remainder}`.trim();
  if (!body || body.length > 1600) {
    throw new RepSmsCompositionError(
      "invalid_body",
      "The SMS must contain an approved introduction and fit within 1600 characters.",
    );
  }
  return body;
}

/**
 * Resolve a client composition against the server-owned copy catalog.
 * `initialBody` is accepted for an audit comparison, but never trusted as
 * the sent body.  The returned `finalBody` is always rebuilt from the
 * approved introduction and the editable remainder.
 */
export function composeRepSms(input: RepSmsCompositionInput): RepSmsComposition {
  const legacyBody = cleanRemainder(input.remainder ?? input.body);
  const legacySplit = splitLegacyFullBody(legacyBody);
  const introduction = input.introId
    ? REP_SMS_INTRODUCTIONS.find((candidate) => candidate.id === input.introId)
    : legacySplit?.introduction ?? DEFAULT_REP_SMS_INTRODUCTION;
  if (!introduction) {
    throw new RepSmsCompositionError(
      "unknown_introduction",
      "Choose an approved Mel introduction.",
    );
  }
  if (!sameVersion(input.introVersion, introduction.version, Boolean(input.introId))) {
    throw new RepSmsCompositionError(
      "stale_introduction",
      "That introduction changed. Refresh the composer and choose it again.",
    );
  }

  const template = input.templateId
    ? REP_SMS_TEMPLATES.find((candidate) => candidate.id === input.templateId)
    : null;
  if (input.templateId && !template) {
    throw new RepSmsCompositionError(
      "unknown_template",
      "Choose an approved texting template.",
    );
  }
  if (template && !sameVersion(input.templateVersion, template.version, true)) {
    throw new RepSmsCompositionError(
      "stale_template",
      "That template changed. Refresh the composer and choose it again.",
    );
  }

  const splitRemainder = legacySplit?.introduction.id === introduction.id
    ? legacySplit.remainder
    : null;
  const initialCandidate = input.initialRemainder ?? template?.remainder ?? splitRemainder ?? input.body ?? input.remainder;
  const remainderCandidate = input.remainder && !splitRemainder
    ? input.remainder
    : input.body && !splitRemainder
      ? input.body
      : splitRemainder ?? initialCandidate;
  const initialRemainder = cleanRemainder(initialCandidate);
  const remainder = cleanRemainder(remainderCandidate);
  if (!initialRemainder || !remainder) {
    throw new RepSmsCompositionError(
      "missing_remainder",
      "Add a message after the Mel introduction before sending.",
    );
  }
  if (hasApprovedIntroduction(remainder)) {
    throw new RepSmsCompositionError(
      "duplicate_introduction",
      "Keep the approved introduction in its read-only section; remove the duplicate from the message.",
    );
  }

  const initialBody = joinBody(introduction, initialRemainder);
  const finalBody = joinBody(introduction, remainder);
  return {
    policyVersion: REP_SMS_COMPOSITION_POLICY_VERSION,
    introId: introduction.id,
    introVersion: introduction.version,
    templateId: template?.id ?? null,
    templateVersion: template?.version ?? null,
    templateOrigin: template ? "curated" : "manual",
    initialRemainder,
    remainder,
    initialBody,
    finalBody,
  };
}

/** Explicit alias for server action callers and tests. */
export const composeRepSmsBody = composeRepSms;

export function getRepSmsIntroduction(id: string): RepSmsIntroduction | null {
  return REP_SMS_INTRODUCTIONS.find((introduction) => introduction.id === id) ?? null;
}

export function getRepSmsTemplate(id: string): RepSmsTemplate | null {
  return REP_SMS_TEMPLATES.find((template) => template.id === id) ?? null;
}
