import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Safety model for the Messages v2 production-replay harness. Every check here
 * is fail-closed and runs BEFORE the harness touches a database or the network.
 * See docs/messages-v2-replay.md.
 */

/** Sandra production Supabase project (README.md / MIGRATION-NOTES.md). */
export const PROD_PROJECT_REF = "copflsklaefwzipsrjqz";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const HOSTED_SUPABASE_HOST = /^([a-z0-9]{20})\.supabase\.(?:co|in)$/;
const REF_IN_TEXT = /\b([a-z0-9]{20})(?=\.supabase\.(?:co|in)\b)/g;

export class ReplaySafetyError extends Error {
  constructor(message: string) {
    super(`replay safety: ${message}`);
    this.name = "ReplaySafetyError";
  }
}

function parseUrl(raw: string, what: string): URL {
  try {
    return new URL(raw);
  } catch {
    throw new ReplaySafetyError(`${what} is not a valid URL`);
  }
}

/** The replay may only talk to a Sandra server on this machine. */
export function assertLocalBaseUrl(raw: string): URL {
  const url = parseUrl(raw, "base URL");
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new ReplaySafetyError("base URL must be http(s)");
  }
  if (url.username || url.password) {
    throw new ReplaySafetyError("base URL must not carry credentials");
  }
  if (!LOCAL_HOSTS.has(url.hostname)) {
    throw new ReplaySafetyError(
      `base URL host "${url.hostname}" is not localhost/127.0.0.1; refusing to target a non-local server`,
    );
  }
  return url;
}

/**
 * Production refs: the built-in constant plus any project ref found in the
 * production env files / Vercel pull, so a rotated project is still blocked.
 */
export function readProdRefs(
  cwd: string,
  read: (file: string) => string = (f) => readFileSync(f, "utf8"),
): string[] {
  const refs = new Set<string>([PROD_PROJECT_REF]);
  for (const rel of [".env.production", ".env.production.local", ".vercel/.env.production.local"]) {
    let text: string;
    try {
      text = read(path.join(cwd, rel));
    } catch {
      continue;
    }
    for (const m of text.matchAll(REF_IN_TEXT)) refs.add(m[1]);
  }
  return [...refs];
}

export type SupabaseTarget = { kind: "local" | "hosted"; ref: string | null; host: string };

type RefOpts = { prodRefs: readonly string[]; allowProjectRef?: string | null };

function refuseIfProd(raw: string, prodRefs: readonly string[]): void {
  if (prodRefs.length === 0) {
    throw new ReplaySafetyError("no production ref list available; refusing (fail closed)");
  }
  for (const ref of prodRefs) {
    if (raw.includes(ref)) {
      throw new ReplaySafetyError("target references the production Supabase project; refusing");
    }
  }
}

/** Supabase API URL: local stack, or an explicitly allowed non-production hosted project. */
export function assertSafeSupabaseUrl(raw: string, opts: RefOpts): SupabaseTarget {
  refuseIfProd(raw, opts.prodRefs);
  const url = parseUrl(raw, "Supabase URL");
  if (LOCAL_HOSTS.has(url.hostname)) {
    return { kind: "local", ref: null, host: url.host };
  }
  const m = HOSTED_SUPABASE_HOST.exec(url.hostname);
  if (!m) {
    throw new ReplaySafetyError(
      `Supabase host "${url.hostname}" is neither local nor a recognised hosted project; refusing`,
    );
  }
  if (opts.allowProjectRef !== m[1]) {
    throw new ReplaySafetyError(
      `hosted project ${m[1]} requires an explicit --allow-project-ref ${m[1]}`,
    );
  }
  return { kind: "hosted", ref: m[1], host: url.host };
}

/** Postgres connection string for seed/run/wipe: loopback, or an allowed hosted test project. */
export function assertSafeDbUrl(raw: string, opts: RefOpts): void {
  refuseIfProd(raw, opts.prodRefs);
  const url = parseUrl(raw, "database URL");
  if (!["postgres:", "postgresql:"].includes(url.protocol) || url.hash) {
    throw new ReplaySafetyError("database URL must be a postgres:// URL");
  }
  // A query string can override the host (?host=...), so it is never allowed.
  if (url.search) {
    throw new ReplaySafetyError("database URL must not carry query parameters");
  }
  if (LOCAL_HOSTS.has(url.hostname)) return;
  const allow = opts.allowProjectRef;
  if (allow && url.hostname === `db.${allow}.supabase.co`) return;
  throw new ReplaySafetyError(
    `database host "${url.hostname}" is not loopback and not the explicitly allowed project; refusing`,
  );
}

const FORBIDDEN_CREDENTIALS = [
  "SENDILLO_API_KEY",
  "TWILIO_AUTH_TOKEN",
  "DIALPAD_API_KEY",
] as const;

/** Force the stub and LLM-hold flags for this process (and its children). */
export type EnvLike = Record<string, string | undefined>;

export function applyStubEnv(env: EnvLike): void {
  env.SMS_PROVIDER_STUB = "1";
  env.AI_RESPONDER_LLM_AUTOSEND = "0";
}

/** The harness process must hold no way to reach a seller-SMS provider. */
export function assertHarnessEnv(env: EnvLike): void {
  if (env.SMS_PROVIDER_STUB !== "1") {
    throw new ReplaySafetyError("SMS_PROVIDER_STUB=1 must be set");
  }
  for (const name of FORBIDDEN_CREDENTIALS) {
    if ((env[name] ?? "").trim() !== "") {
      throw new ReplaySafetyError(`${name} is set in the harness process; unset it`);
    }
  }
}

export type Handshake = {
  replayStub: boolean;
  sendilloApiKeyPresent: boolean;
  llmAutosend: string | null;
  supabaseHost: string | null;
};

/**
 * The Sandra server under test proves for itself that it is stubbed. The
 * harness cannot see another process's env, so it trusts nothing it cannot ask.
 */
export function assertHandshake(
  body: unknown,
  expected: { supabaseHost: string },
): asserts body is Handshake {
  if (!body || typeof body !== "object") {
    throw new ReplaySafetyError("server handshake missing or malformed; is SMS_PROVIDER_STUB=1 on the server?");
  }
  const h = body as Partial<Handshake>;
  if (h.replayStub !== true) throw new ReplaySafetyError("server is not running with the SMS provider stub");
  if (h.sendilloApiKeyPresent !== false) {
    throw new ReplaySafetyError("server process has a Sendillo API key set; refusing");
  }
  if (h.llmAutosend !== "0") {
    throw new ReplaySafetyError("server has AI_RESPONDER_LLM_AUTOSEND != 0 (LLM autosend must be off)");
  }
  if (h.supabaseHost !== expected.supabaseHost) {
    throw new ReplaySafetyError(
      `server Supabase host (${String(h.supabaseHost)}) differs from the harness target (${expected.supabaseHost})`,
    );
  }
}
