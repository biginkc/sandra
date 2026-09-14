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
  const token = env.INBOX_ELECTRIC_RELAY_TOKEN;
  if (mode !== "relay" || url.protocol !== "https:" || !token || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw Error("Missing private Inbox relay configuration");
  return { electricUrl, projectionTable, upstreamHeaders: { authorization: `Bearer ${token}` } };
}
