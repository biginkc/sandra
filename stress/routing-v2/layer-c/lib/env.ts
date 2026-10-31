import { execSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Layer C environment guard + receipts. Refuses to run unless the API is :59461 and the DB is
 * :59462 (the stress stack this run owns). Never prints keys.
 */
export const STACK_API_PORT = "59461";
export const STACK_DB_PORT = "59462";
export const SCRATCH = "/private/tmp/claude-502/-Users-jarradhenry-Sites-BMH-apps-Sandra/ee57f63d-e424-4187-9c5b-cd16541b6f53/scratchpad";
export const RECEIPTS = path.join(SCRATCH, "build-plan/receipts/stress-7e6b4c8aa64e");
export const RECEIPTS2 = "/Users/jarradhenry/Sites/BMH apps/Sandra/_claude_worktrees/routing-v2-evidence/receipts/stress-7e6b4c8aa64e";
export const FINAL = path.join(SCRATCH, "final");
export const EXPECTED_HEAD = process.env.STRESS_EXPECTED_HEAD ?? "7e6b4c8aa64e37f3e40918b64094e9142736e717";

export function headSha(): string {
  return execSync("git rev-parse HEAD", { cwd: path.resolve(__dirname, "../../../.."), encoding: "utf8" }).trim();
}

export function assertStack(): void {
  const api = process.env.TEST_SUPABASE_URL ?? "";
  const db = process.env.TEST_SUPABASE_DB_URL ?? "";
  if (!api.includes(`127.0.0.1:${STACK_API_PORT}`)) throw new Error(`TEST_SUPABASE_URL is not the stress stack (:${STACK_API_PORT})`);
  if (!db.includes(`127.0.0.1:${STACK_DB_PORT}`)) throw new Error(`TEST_SUPABASE_DB_URL is not the stress stack (:${STACK_DB_PORT})`);
  if (!process.env.TEST_SUPABASE_SERVICE_ROLE_KEY) throw new Error("TEST_SUPABASE_SERVICE_ROLE_KEY missing");
  if (headSha() !== EXPECTED_HEAD) throw new Error(`HEAD ${headSha()} != ${EXPECTED_HEAD}`);
  // Stub keys only: every provider host is intercepted by the in-process fetch stub.
  process.env.MESSAGING_PROVIDER = "mock";
  process.env.TYPESAFE_API_KEY = "stress-stub";
  process.env.ANTHROPIC_API_KEY = "stress-stub";
  process.env.ANTHROPIC_API_KEY_SANDRA = "stress-stub";
  process.env.DEALMACHINE_API_KEY = "stress-stub";
  process.env.NEXT_PUBLIC_SUPABASE_URL = api;
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY;
  process.env.CRON_SECRET = "stress-cron";
}

export class Receipt {
  readonly file: string;
  readonly file2: string;
  constructor(name: string) {
    mkdirSync(RECEIPTS, { recursive: true });
    mkdirSync(RECEIPTS2, { recursive: true });
    this.file = path.join(RECEIPTS, name);
    this.file2 = path.join(RECEIPTS2, name);
    writeFileSync(this.file, `${headSha()}\n`);
    writeFileSync(this.file2, `${headSha()}\n`);
    this.line(`# ${name} — routing v2 stress Layer C — ${new Date().toISOString()} — stack api :${STACK_API_PORT} db :${STACK_DB_PORT}`);
  }
  line(...parts: unknown[]): void {
    const s = parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ");
    appendFileSync(this.file, s + "\n");
    appendFileSync(this.file2, s + "\n");
  }
  check(name: string, pass: boolean, detail: unknown): boolean {
    this.line(`${pass ? "PASS" : "FAIL"} ${name} ::`, detail);
    return pass;
  }
}

export function pct(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i]!;
}
