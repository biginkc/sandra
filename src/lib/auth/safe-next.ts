/**
 * Open-redirect protection for user-supplied post-login destinations.
 *
 * The login flows carry a `next` value (where to land after auth) through
 * form posts and query params. Because it ultimately feeds `redirect(next)`,
 * anything that a browser could interpret as an off-site URL must be
 * rejected — not just `https://…`, but also:
 *
 * - scheme-relative forms (`//evil.com`)
 * - backslash tricks (`/\evil.example` — the WHATWG URL parser treats `\`
 *   as `/` in special schemes, so it resolves to `https://evil.example/`)
 * - control characters (CR/LF header splitting, tab-stripping parsers)
 *
 * Defense in depth: after the character-level checks, the candidate is
 * resolved against a canonical origin and must stay on that origin.
 *
 * Shared by every auth entry point so post-login destination validation
 * cannot drift between them.
 */

const CONTROL_CHARS_OR_BACKSLASH = /[\u0000-\u001f\u007f\\]/;
const CANONICAL_ORIGIN = "https://sandra.invalid";

/**
 * Returns `raw` when it is a safe same-site path, otherwise `fallback`.
 * `/login`-prefixed paths are rejected too (they would loop the login UI).
 */
export function sanitizeNextPath(raw: unknown, fallback = ""): string {
  if (typeof raw !== "string" || raw.length === 0) return fallback;
  if (!raw.startsWith("/")) return fallback;
  if (raw.startsWith("//")) return fallback;
  if (CONTROL_CHARS_OR_BACKSLASH.test(raw)) return fallback;
  if (raw.startsWith("/login")) return fallback;

  let resolved: URL;
  try {
    resolved = new URL(raw, CANONICAL_ORIGIN);
  } catch {
    return fallback;
  }
  if (resolved.origin !== CANONICAL_ORIGIN) return fallback;

  return raw;
}
