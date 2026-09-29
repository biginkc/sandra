export function makeRest(apiUrl, anonKey, serviceKey) {
  const tokens = new Map([['anon', anonKey], ['service_role', serviceKey]]);
  function setToken(actor, token) { tokens.set(actor, token); }
  async function request(actor, method, resource, body, options = {}) {
    if (!resource.startsWith('/rest/v1/')) throw new Error('REST_PATH_REFUSED');
    const token = tokens.get(actor);
    if (!token) throw new Error(`NO_ACTOR_TOKEN ${actor}`);
    const headers = { apikey: anonKey, authorization: `Bearer ${token}`, ...options.headers };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(`${apiUrl}${resource}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    const raw = await response.text();
    let data; try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
    return { status: response.status, data, code: data && typeof data === 'object' ? data.code : undefined };
  }
  return { setToken, request };
}
