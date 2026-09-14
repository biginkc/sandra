/** Next may reconstruct request.url with its internal listen hostname. Host is
 * the HTTP authority the browser actually addressed; never trust forwarded-host
 * lists or use an unvalidated string as a URL origin.
 *
 * Sec-Fetch-Site is set by the browser itself and cannot be forged by page
 * script or a cross-origin request, so `same-origin` is sufficient proof on
 * its own and is checked first. Everything below only runs when the browser
 * didn't send that guarantee (header absent, `same-site`, or `none` — plus
 * any non-browser client, which never sends Sec-Fetch-Site at all).
 *
 * Host (and Origin, for non-browser clients) is attacker-controllable, so
 * matching Origin against Host alone is not proof of same-origin — a request
 * can carry a forged `Host: evil.test` alongside `Origin: https://evil.test`
 * and satisfy that check trivially. The Host/Origin agreement below is only a
 * *consistency* check; trust additionally requires the agreed origin to match
 * the app's own configured origin (`NEXT_PUBLIC_SITE_URL`, matching the
 * canonical-origin convention already used by `webhookBaseUrl`), or — outside
 * production only — a localhost/127.0.0.1 dev origin.
 *
 * NEXT_PUBLIC_SITE_URL is NOT reliable as "the origin this request was
 * actually served from" (login/actions.ts treats it the same way) — it won't
 * match a Vercel preview deployment's *.vercel.app host, or any prod alias
 * that differs from the configured one. That's fine here only because a real
 * browser request in those cases already carries Sec-Fetch-Site and is
 * accepted above; this fallback exists solely to fail closed for the
 * non-browser clients Sec-Fetch-Site can't vouch for. */
function trustedOrigin(origin: string): boolean {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (configured) {
    try { if (new URL(configured).origin === origin) return true; } catch { /* fall through */ }
  }
  if (process.env.NODE_ENV !== "production") {
    try {
      const hostname = new URL(origin).hostname;
      if (hostname === "localhost" || hostname === "127.0.0.1") return true;
    } catch { return false; }
  }
  return false;
}
export function isInboxSameOrigin(request: Request): boolean {
  const secFetchSite = request.headers.get("sec-fetch-site");
  if (secFetchSite === "cross-site") return false;
  if (secFetchSite === "same-origin") return true;
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    const url = new URL(request.url);
    if (!["http:", "https:"].includes(url.protocol)) return false;
    const host = request.headers.get("host");
    if (host !== null && (!host || /[\s,/@\\?#]/.test(host))) return false;
    const authority = host ? new URL(`${url.protocol}//${host}`) : url;
    const supplied = new URL(origin);
    const consistent = supplied.origin === origin && supplied.protocol === authority.protocol && supplied.host === authority.host;
    return consistent && trustedOrigin(origin);
  } catch { return false; }
}
