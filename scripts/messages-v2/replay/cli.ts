import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { ReplayExport } from "./schema";

export const REPLAY_DIR = path.resolve(process.cwd(), "tmp/replay");
export const DEFAULT_LOCAL_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54329/postgres";

export const DEFAULT_REPLAY_WEBHOOK_SECRET = "replay-local-webhook-secret";

export function fail(message: string): never {
  console.error(`replay: ${message}`);
  process.exit(1);
}

/** postgres URL with the password removed, safe to print. */
export function redactDbUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "(unparseable url)";
  }
}

/** Stable per-machine salt for phone masking; created once, never committed (tmp/ is gitignored). */
export function loadMaskSalt(env: NodeJS.ProcessEnv = process.env): string {
  if (env.REPLAY_MASK_SALT && env.REPLAY_MASK_SALT.length >= 8) return env.REPLAY_MASK_SALT;
  const file = path.join(REPLAY_DIR, ".mask-salt");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  mkdirSync(REPLAY_DIR, { recursive: true });
  const salt = randomBytes(32).toString("hex");
  writeFileSync(file, `${salt}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return salt;
}

export function exportPathFor(batchId: string): string {
  return path.join(REPLAY_DIR, `${batchId}.json`);
}

export function loadExport(file: string): ReplayExport {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as ReplayExport;
  if (parsed.version !== 1 || !parsed.batchId || !parsed.tables) {
    throw new Error(`${file} is not a replay export (version 1)`);
  }
  return parsed;
}

export const BATCH_ID_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
export function assertBatchId(id: string): string {
  if (!BATCH_ID_RE.test(id)) throw new Error(`invalid batch id "${id}" (a-z, 0-9, _ . - ; max 64)`);
  return id;
}
