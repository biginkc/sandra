/** Next may reconstruct request.url with its internal listen hostname. Host is
 * the HTTP authority the browser actually addressed; never trust forwarded-host
 * lists or use an unvalidated string as a URL origin.
 *
 * Host (and Origin, for non-browser clients) is attacker-controllable, so
 * matching Origin against Host alone is not proof of same-origin — a request
 * can carry a forged `Host: evil.test` alongside `Origin: https://evil.test`
 * and satisfy that check trivially. The Host/Origin agreement above is only a
 * *consistency* check; trust additionally requires the agreed authority to
 * match the app's own configured origin (`NEXT_PUBLIC_SITE_URL`, matching the
 * canonical-origin convention already used by `webhookBaseUrl`), or — outside
 * production only — a localhost/127.0.0.1 dev origin. When neither Sec-Fetch-Site
 * nor a positively-confirmed trusted origin is available, fail closed. */
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
  if (request.headers.get("sec-fetch-site") === "cross-site") return false;
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
