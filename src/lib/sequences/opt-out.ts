/**
 * Opt-out phrase rotation + auto-append logic for sequence SMS.
 *
 * Every phrase contains the word `STOP` so Sandra's existing Dialpad
 * inbound webhook (src/app/api/webhooks/dialpad/sms/route.ts) — which
 * treats `STOP` as an opt-out keyword — processes opt-outs regardless
 * of which variant the recipient saw. TCPA doesn't mandate specific
 * wording, just a clear opt-out path.
 *
 * Rotation is random by default; pass `seed` for deterministic output
 * (used by the cron tick so a retry picks the same variant and keeps
 * the send idempotent even if it double-fires).
 */

export const OPT_OUT_PHRASES: readonly string[] = [
  "Reply STOP anytime and I'll stop.",
  "Not for you? Just reply STOP.",
  "Text STOP and I won't bug you again.",
  "Reply STOP to opt out.",
  "Say STOP if this isn't a fit.",
] as const;

/** Matches `STOP` as a standalone word (won't match `STOPLIGHT`, `stopwatch`). */
const STOP_WORD_REGEX = /\bSTOP\b/i;
/** Matches the `{{opt_out}}` template variable anywhere in the body. */
const OPT_OUT_VAR_REGEX = /\{\{\s*opt_out\s*\}\}/;

/**
 * Deterministic hash → index mapping. Same input always produces the
 * same bucket. Simple djb2-variant; good enough for a 5-bucket rotation.
 */
function hashToIndex(seed: string, buckets: number): number {
  let h = 5381;
  for (let i = 0; i < seed.length; i++) {
    h = ((h << 5) + h + seed.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % buckets;
}

export function renderOptOut(opts: { seed?: string } = {}): string {
  const idx =
    opts.seed !== undefined
      ? hashToIndex(opts.seed, OPT_OUT_PHRASES.length)
      : Math.floor(Math.random() * OPT_OUT_PHRASES.length);
  return OPT_OUT_PHRASES[idx];
}

/**
 * Apply the opt-out policy for a sequence send.
 *
 *   1. `append_opt_out = false` → return body unchanged (author owns it).
 *   2. Body already contains a standalone `STOP` word → return unchanged.
 *   3. Body contains the `{{opt_out}}` template variable → return unchanged
 *      (the template engine will render it at the variable position).
 *   4. Otherwise → append a rotated variant with a single space separator.
 */
export function applyOptOut(
  body: string,
  opts: { append_opt_out: boolean; seed?: string },
): string {
  if (!opts.append_opt_out) return body;
  if (STOP_WORD_REGEX.test(body)) return body;
  if (OPT_OUT_VAR_REGEX.test(body)) return body;
  const variant = renderOptOut({ seed: opts.seed });
  // Trim trailing whitespace so the separator is always exactly one space.
  return body.replace(/\s+$/, "") + " " + variant;
}
