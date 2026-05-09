import { createHmac, timingSafeEqual } from "node:crypto";

const FIVE_MINUTES_S = 60 * 5;

export function verifySlackSignature(opts: {
  signingSecret: string;
  timestamp: string | null;
  signature: string | null;
  rawBody: string;
  now?: number;
}): boolean {
  if (!opts.timestamp || !opts.signature) return false;

  const timestamp = Number(opts.timestamp);
  if (!Number.isFinite(timestamp)) return false;

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > FIVE_MINUTES_S) return false;

  const base = `v0:${opts.timestamp}:${opts.rawBody}`;
  const expected = `v0=${createHmac("sha256", opts.signingSecret)
    .update(base)
    .digest("hex")}`;

  const expectedBuffer = Buffer.from(expected, "utf8");
  const actualBuffer = Buffer.from(opts.signature, "utf8");
  if (expectedBuffer.length !== actualBuffer.length) return false;

  return timingSafeEqual(expectedBuffer, actualBuffer);
}
