/** Next may reconstruct request.url with its internal listen hostname. Host is
 * the HTTP authority the browser actually addressed; never trust forwarded-host
 * lists or use an unvalidated string as a URL origin. */
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
    return supplied.origin === origin && supplied.protocol === authority.protocol && supplied.host === authority.host;
  } catch { return false; }
}
