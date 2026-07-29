const LOCAL_HUGO_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Account management is security-sensitive. Production must use HTTPS; local
 * development may use HTTP only on a loopback host.
 */
export function parseHugoUrl(
  configured: string | undefined,
  environment = process.env.NODE_ENV,
): string | null {
  const candidate = configured?.trim();
  if (!candidate) return null;

  try {
    const url = new URL(candidate);
    const isSecure = url.protocol === "https:";
    const isLocalDevelopment =
      environment !== "production" &&
      url.protocol === "http:" &&
      LOCAL_HUGO_HOSTS.has(url.hostname);
    return isSecure || isLocalDevelopment ? url.toString() : null;
  } catch {
    return null;
  }
}
