import { createHmac, timingSafeEqual } from "node:crypto";

export const CANARY_COOKIE = "sandra_sentry_canary";

export function canaryCookieValue(secret: string): string {
  return createHmac("sha256", secret).update("sandra-sentry-preview-canary-v1").digest("hex");
}

export function validCanaryCookie(value: string | undefined, secret: string): boolean {
  if (!value || !/^[a-f0-9]{64}$/.test(value)) return false;
  return timingSafeEqual(Buffer.from(value, "hex"), Buffer.from(canaryCookieValue(secret), "hex"));
}
