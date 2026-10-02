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
  /** Bland's `pathway_version` is an integer, not the agent semver. */
  pathwayVersion: number;
  fromNumber: string;
  webhookUrl: string;
  timeoutMs: number;
};

/**
 * The LIVE pathway's integer version (agent snapshot 0.0.4). Staging 0.0.17 has
 * no published integer version, so the pin defaults to 3 until a human changes
 * NORMA_BLAND_PATHWAY_VERSION.
 */
export const DEFAULT_NORMA_PATHWAY_VERSION = 3;
export const DEFAULT_BLAND_BASE_URL = "https://api.bland.ai";
export const DEFAULT_BLAND_TIMEOUT_MS = 10_000;

/** Returns null (never throws) when any required value is missing/invalid. */
export function readNormaBlandConfig(env: NormaEnv = process.env): NormaBlandConfig | null {
  const apiKey = env.BLAND_API_KEY?.trim();
  const pathwayId = env.NORMA_BLAND_PATHWAY_ID?.trim();
  const fromNumber = env.NORMA_BLAND_FROM_NUMBER?.trim();
  const webhookUrl = env.NORMA_BLAND_WEBHOOK_URL?.trim();
  const versionText = env.NORMA_BLAND_PATHWAY_VERSION?.trim();
  const version = versionText ? Number(versionText) : DEFAULT_NORMA_PATHWAY_VERSION;
  if (!apiKey || !pathwayId || !fromNumber || !webhookUrl) return null;
  if (!Number.isInteger(version) || version < 0) return null;
  if (!/^https:\/\//.test(webhookUrl)) return null;
  const timeout = Number(env.NORMA_BLAND_TIMEOUT_MS);
  return {
    apiKey,
    baseUrl: (env.NORMA_BLAND_BASE_URL?.trim() || DEFAULT_BLAND_BASE_URL).replace(/\/+$/, ""),
    pathwayId,
    pathwayVersion: version,
    fromNumber,
    webhookUrl,
    timeoutMs: Number.isFinite(timeout) && timeout >= 1000 ? timeout : DEFAULT_BLAND_TIMEOUT_MS,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The pilot callback owner. Null when unset or malformed (callers fail clearly). */
export function readNormaCallbackAssigneeId(env: NormaEnv = process.env): string | null {
  const value = env.NORMA_CALLBACK_ASSIGNEE_ID?.trim();
  return value && UUID.test(value) ? value : null;
}
