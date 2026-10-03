/**
 * Env-driven Norma configuration. Every flag defaults to the safe value:
 * dispatch is OFF and real sellers are NOT released until a human sets the
 * variables. Read lazily (never at import) so tests can set env per case.
 */
export type NormaEnv = Record<string, string | undefined>;

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

export function envFlag(value: string | undefined): boolean {
  return TRUE_VALUES.has((value ?? "").trim().toLowerCase());
}

export type NormaGateConfig = {
  dispatchEnabled: boolean;
  sellerRelease: boolean;
  allowedNumbers: string[];
};

export function readNormaGateConfig(env: NormaEnv = process.env): NormaGateConfig {
  return {
    dispatchEnabled: envFlag(env.NORMA_DISPATCH_ENABLED),
    sellerRelease: envFlag(env.NORMA_SELLER_RELEASE),
    allowedNumbers: (env.NORMA_ALLOWED_NUMBERS ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => /^\+[1-9][0-9]{7,14}$/.test(entry)),
  };
}

export type NormaBlandConfig = {
  apiKey: string;
  baseUrl: string;
  pathwayId: string;
  /**
   * Optional integer pin for Bland's `pathway_version`. Null omits the field so
   * Bland uses the published production version (docs: defaults to production).
   */
  pathwayVersion: number | null;
  /** Bland voice for the call (NORMA_BLAND_VOICE). Required: the pathway id alone does not choose one. */
  voice: string;
  fromNumber: string;
  webhookUrl: string;
  timeoutMs: number;
  /** Bland `wait_for_greeting`: wait for the person to speak first (NORMA_BLAND_WAIT_FOR_GREETING, default true). */
  waitForGreeting: boolean;
  /** Bland `background_track` (NORMA_BLAND_BACKGROUND_TRACK, default "office"). */
  backgroundTrack: NormaBackgroundTrack;
};

export const BACKGROUND_TRACKS = ["office", "cafe", "restaurant", "none"] as const;
export type NormaBackgroundTrack = (typeof BACKGROUND_TRACKS)[number];
export const DEFAULT_BACKGROUND_TRACK: NormaBackgroundTrack = "office";

const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

/** Env values that mean "do not send pathway_version" (Bland production). */
const OMIT_PATHWAY_VERSION = new Set(["production", "latest"]);

export const DEFAULT_BLAND_BASE_URL = "https://api.bland.ai";
export const DEFAULT_BLAND_TIMEOUT_MS = 10_000;

/**
 * null omits `pathway_version`. "invalid" fails config so a bad pin never dials.
 * Unset, blank, "production", and "latest" omit the field.
 */
function parsePathwayVersion(raw: string | undefined): number | null | "invalid" {
  const text = (raw ?? "").trim();
  if (!text || OMIT_PATHWAY_VERSION.has(text.toLowerCase())) return null;
  const version = Number(text);
  if (!Number.isInteger(version) || version < 0) return "invalid";
  return version;
}

/** Returns null (never throws) when any required value is missing/invalid. */
export function readNormaBlandConfig(env: NormaEnv = process.env): NormaBlandConfig | null {
  const apiKey = env.BLAND_API_KEY?.trim();
  const pathwayId = env.NORMA_BLAND_PATHWAY_ID?.trim();
  const fromNumber = env.NORMA_BLAND_FROM_NUMBER?.trim();
  const webhookUrl = env.NORMA_BLAND_WEBHOOK_URL?.trim();
  const voice = env.NORMA_BLAND_VOICE?.trim();
  const pathwayVersion = parsePathwayVersion(env.NORMA_BLAND_PATHWAY_VERSION);
  // No voice, no call: dispatch refuses (closed as rejected before the claim) rather than let Bland pick.
  if (!apiKey || !pathwayId || !fromNumber || !webhookUrl || !voice) return null;
  if (pathwayVersion === "invalid") return null;
  if (!/^https:\/\//.test(webhookUrl)) return null;
  const trackText = env.NORMA_BLAND_BACKGROUND_TRACK?.trim().toLowerCase();
  const backgroundTrack = trackText ? BACKGROUND_TRACKS.find((t) => t === trackText) : DEFAULT_BACKGROUND_TRACK;
  // An invalid track fails config like any other invalid value, so nothing dials.
  if (!backgroundTrack) return null;
  const greetingText = env.NORMA_BLAND_WAIT_FOR_GREETING?.trim().toLowerCase();
  const waitForGreeting = !(greetingText && FALSE_VALUES.has(greetingText));
  const timeout = Number(env.NORMA_BLAND_TIMEOUT_MS);
  return {
    apiKey,
    baseUrl: (env.NORMA_BLAND_BASE_URL?.trim() || DEFAULT_BLAND_BASE_URL).replace(/\/+$/, ""),
    pathwayId,
    pathwayVersion,
    voice,
    fromNumber,
    webhookUrl,
    timeoutMs: Number.isFinite(timeout) && timeout >= 1000 ? timeout : DEFAULT_BLAND_TIMEOUT_MS,
    waitForGreeting,
    backgroundTrack,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The pilot callback owner. Null when unset or malformed (callers fail clearly). */
export function readNormaCallbackAssigneeId(env: NormaEnv = process.env): string | null {
  const value = env.NORMA_CALLBACK_ASSIGNEE_ID?.trim();
  return value && UUID.test(value) ? value : null;
}
