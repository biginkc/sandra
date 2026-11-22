import dns from "node:dns";

/**
 * Hard guard (Jarrad 2026-10-31: no live Jev/Haiku calls unless questions/prompts change).
 * - Keys: TYPESAFE_API_KEY / ANTHROPIC_API_KEY / ANTHROPIC_API_KEY_SANDRA must be unset or the stub sentinel;
 *   otherwise the run fails (values are never printed).
 * - Network: every Jev/Anthropic request must be served by the in-process fetch stub. Any request the stub does not
 *   serve (e.g. a non-Haiku Anthropic model) and any DNS lookup of those hosts (a client that bypasses globalThis.fetch)
 *   THROWS and increments LIVE.attempts.
 * - Receipts: finishNoLiveClassifier() writes the classifier line to every receipt of this run and fails when
 *   attempts > 0.
 */
export const STUB_SENTINEL = "stress-stub";
export const CLASSIFIER_HOSTS = ["api.typesafe.ai", "api.anthropic.com"];
export const LIVE = { attempts: 0, installed: false };

export function liveClassifierAttempt(what: string): never {
  LIVE.attempts++;
  throw new Error(`stress: live classifier call blocked (${what})`);
}

export function assertNoRealClassifierKeys(): void {
  for (const k of ["TYPESAFE_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY_SANDRA"]) {
    const v = process.env[k];
    if (v !== undefined && v !== "" && v !== STUB_SENTINEL) throw new Error(`stress: ${k} is set to a non-stub value; unset it (value not printed)`);
  }
}

export function installNoLiveClassifier(): void {
  if (LIVE.installed) return;
  LIVE.installed = true;
  const blocked = (host: unknown) => typeof host === "string" && CLASSIFIER_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  const origLookup = dns.lookup;
  (dns as unknown as { lookup: unknown }).lookup = function (host: string, ...rest: unknown[]) {
    if (blocked(host)) { LIVE.attempts++; const cb = rest.find((r) => typeof r === "function") as ((e: Error) => void) | undefined; const e = new Error(`stress: live classifier DNS lookup blocked (${host})`); if (cb) return cb(e); throw e; }
    return (origLookup as (...a: unknown[]) => unknown).call(dns, host, ...rest);
  };
  const origP = dns.promises.lookup;
  (dns.promises as unknown as { lookup: unknown }).lookup = async (host: string, ...rest: unknown[]) => {
    if (blocked(host)) liveClassifierAttempt(`dns ${host}`);
    return (origP as (...a: unknown[]) => Promise<unknown>).call(dns.promises, host, ...rest);
  };
}

export const CLASSIFIER_SOURCES = "stubbed (recorded v7 probs.json/newq*.json + haiku_cache_v3.json + stub rules)";
