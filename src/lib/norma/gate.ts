import { readNormaGateConfig, type NormaEnv, type NormaGateConfig } from "./config";

export type NormaGateResult =
  | { open: true }
  | { open: false; reason: "dispatch_disabled" | "number_not_allowed" };

/**
 * Section 0 gate. Pure; the single `dispatchNormaCall` enforces it before the
 * claim, and the request action pre-checks it so a closed gate creates no
 * request. Dispatch must be explicitly enabled; until NORMA_SELLER_RELEASE is
 * set the destination must be on the allowlist.
 */
export function evaluateNormaGate(
  phoneE164: string,
  config: NormaGateConfig = readNormaGateConfig(),
): NormaGateResult {
  if (!config.dispatchEnabled) return { open: false, reason: "dispatch_disabled" };
  if (!config.sellerRelease && !config.allowedNumbers.includes(phoneE164)) {
    return { open: false, reason: "number_not_allowed" };
  }
  return { open: true };
}

export function evaluateNormaGateFromEnv(phoneE164: string, env?: NormaEnv): NormaGateResult {
  return evaluateNormaGate(phoneE164, readNormaGateConfig(env));
}
