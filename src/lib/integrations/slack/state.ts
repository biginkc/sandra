import { createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_MAX_AGE_SEC = 600;

export function signOAuthState(opts: {
  userId: string;
  secret: string;
  now?: number;
}): string {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const payload = `${opts.userId}.${now}`;
  const hmac = createHmac("sha256", opts.secret).update(payload).digest("hex");
  return `${payload}.${hmac}`;
}

export function verifyOAuthState(opts: {
  state: string;
  secret: string;
  expectedUserId: string;
  now?: number;
  maxAgeSec?: number;
}): boolean {
  const parts = opts.state.split(".");
  if (parts.length !== 3) return false;

  const [userId, timestampString, hmacHex] = parts;
  if (userId !== opts.expectedUserId) return false;

  const timestamp = Number(timestampString);
  if (!Number.isFinite(timestamp)) return false;

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const maxAgeSec = opts.maxAgeSec ?? DEFAULT_MAX_AGE_SEC;
  if (now - timestamp > maxAgeSec || timestamp > now + 60) return false;

  const expected = createHmac("sha256", opts.secret)
    .update(`${userId}.${timestampString}`)
    .digest("hex");
  const actualBuffer = Buffer.from(hmacHex, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  if (actualBuffer.length !== expectedBuffer.length || actualBuffer.length === 0) {
    return false;
  }

  return timingSafeEqual(actualBuffer, expectedBuffer);
}
