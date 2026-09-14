import { createHmac, timingSafeEqual } from "node:crypto";

export const CANARY_COOKIE = "sandra_sentry_canary";

export function canaryCookieValue(secret: string, now = Date.now()): string {
  const expires = Math.floor(now / 1000) + 300;
  const signature = createHmac("sha256", secret)
    .update(`sandra-sentry-canary-v1:${expires}`).digest("hex");
  return `${expires}.${signature}`;
}

export function validCanaryCookie(value: string | undefined, secret: string, now = Date.now()): boolean {
  if (!value || !/^\d{10}\.[a-f0-9]{64}$/.test(value)) return false;
  const [expiry, signature] = value.split(".");
  const expires = Number(expiry);
  if (expires <= Math.floor(now / 1000) || expires > Math.floor(now / 1000) + 300) return false;
  const expected = createHmac("sha256", secret)
    .update(`sandra-sentry-canary-v1:${expires}`).digest("hex");
  return timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"));
}
