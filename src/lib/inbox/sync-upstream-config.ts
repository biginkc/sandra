import "server-only";
/** Private server configuration only; browser queries never choose the upstream or token. */
export function inboxSyncUpstream(env: NodeJS.ProcessEnv) {
  const electricUrl = env.INBOX_ELECTRIC_SHAPE_URL, projectionTable = env.INBOX_ELECTRIC_PROJECTION_TABLE;
  if (!electricUrl || !projectionTable) throw Error("Missing Inbox configuration");
  const url = new URL(electricUrl);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/v1/shape") throw Error("Invalid Inbox upstream");
  const mode = env.INBOX_ELECTRIC_UPSTREAM_MODE ?? "relay";
  if (mode === "owned-local") {
    if (!["development", "test"].includes(env.NODE_ENV ?? "") || url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || !url.port) throw Error("Invalid owned local Inbox upstream");
    return { electricUrl, projectionTable };
  }
  if (mode === "owned-relay") {
    if (!["development", "test"].includes(env.NODE_ENV ?? "") || url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || !url.port || !token(env.INBOX_ELECTRIC_RELAY_TOKEN)) throw Error("Invalid owned relay Inbox upstream");
    return { electricUrl, projectionTable, upstreamHeaders: { authorization: `Bearer ${env.INBOX_ELECTRIC_RELAY_TOKEN}` } };
  }
  const relayToken = env.INBOX_ELECTRIC_RELAY_TOKEN;
  if (mode !== "relay" || url.protocol !== "https:" || !token(relayToken)) throw Error("Missing private Inbox relay configuration");
  return { electricUrl, projectionTable, upstreamHeaders: { authorization: `Bearer ${relayToken}` } };
}

function token(value: string | undefined): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{32,256}$/.test(value);
}
