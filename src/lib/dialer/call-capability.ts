import { createHmac, timingSafeEqual } from "node:crypto";

const MAX_CAPABILITY_LENGTH = 1_024;
const MIN_CAPABILITY_KEY_LENGTH = 32;
const MAX_CAPABILITY_KEY_LENGTH = 512;

function validRef(value: unknown, maxLength = 200): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maxLength
  );
}

export function capabilityKey(value: string | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized?.startsWith("v1:")) return null;
  const key = normalized.slice(3);
  return key.length >= MIN_CAPABILITY_KEY_LENGTH &&
    key.length <= MAX_CAPABILITY_KEY_LENGTH
    ? key
    : null;
}

/**
 * Opens a browser-held, caller-bound Jitter call capability without exposing
 * the provider call UUID to the client or accepting an unsealed reference.
 */
export function openCallCapability(value: unknown, userId: string): string | null {
  if (!validRef(value, MAX_CAPABILITY_LENGTH)) return null;
  const currentKey = capabilityKey(process.env.SOFTPHONE_CAPABILITY_KEY);
  if (!currentKey) return null;
  const previousKey = capabilityKey(process.env.SOFTPHONE_CAPABILITY_KEY_PREVIOUS);
  const [version, payload, signature, extra] = value.split(".");
  if (version !== "v1" || !payload || !signature || extra !== undefined)
    return null;

  let actual: Buffer;
  try {
    actual = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }

  const verified = [currentKey, previousKey]
    .filter((candidate): candidate is string => Boolean(candidate))
    .slice(0, 2)
    .some((candidate) => {
      const expected = createHmac("sha256", candidate)
        .update(`sandra-softphone:call:${payload}`)
        .digest();
      return (
        actual.length === expected.length && timingSafeEqual(actual, expected)
      );
    });
  if (!verified) return null;

  try {
    const decoded = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as unknown;
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded))
      return null;
    const candidate = decoded as {
      type?: unknown;
      callId?: unknown;
      userId?: unknown;
    };
    return candidate.type === "call" &&
      candidate.userId === userId &&
      validRef(candidate.callId)
      ? candidate.callId
      : null;
  } catch {
    return null;
  }
}
