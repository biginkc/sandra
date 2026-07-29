const LOCAL_HUGO_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Account management is security-sensitive. Production must use HTTPS; local
 * development may use HTTP only on a loopback host.
 */
export function parseHugoUrl(
  configured: string | undefined,
  environment = process.env.NODE_ENV,
): string | null {
  if (!configured || /[\u0000-\u001F\u007F]/.test(configured)) return null;

  const candidate = configured?.trim();
  if (!candidate) return null;

  try {
    const hasSecurePrefix = candidate.startsWith("https://");
    const hasHttpPrefix = candidate.startsWith("http://");
    if (!hasSecurePrefix && !hasHttpPrefix) return null;

    const url = new URL(candidate);
    if (url.username || url.password) return null;

    const isSecure = hasSecurePrefix && url.protocol === "https:";
    const isLocalDevelopment =
      environment !== "production" &&
      hasHttpPrefix &&
      url.protocol === "http:" &&
      LOCAL_HUGO_HOSTS.has(url.hostname);
    return isSecure || isLocalDevelopment ? url.toString() : null;
  } catch {
    return null;
  }
}
