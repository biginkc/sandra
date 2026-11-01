/**
 * Routing v2 backfill CLI arguments + the production guard (pure; unit-tested).
 */
import { DEFAULT_MAX_AGE_DAYS, DEFAULT_RATE_PER_MINUTE, DEFAULT_TEXT_MAX_AGE_DAYS, type BackfillMode } from "./run";

export const PROD_PROJECT_REF = "copflsklaefwzipsrjqz";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/;

export type ParsedArgs = {
  mode: BackfillMode;
  orgId: string;
  runId: string | null;
  resume: boolean;
  limit?: number;
  maxAgeDays: number;
  /** Full-treatment cutoff: replies older than this (whole days) are sort-only. */
  textMaxAgeDays: number;
  batchMaxAgeDays?: number;
  ratePerMinute: number;
  forceFlags: boolean;
  iKnowThisIsProd: boolean;
  /** Needed for --text-max-age-days above 14 (Jarrad's cutoff for sending to old texts). */
  iKnowThisWidensTexting: boolean;
  outDir: string | null;
};

export class ArgError extends Error {}

function num(flag: string, v: string | undefined, { min, integer }: { min: number; integer?: boolean }): number {
  const n = Number(v);
  if (v === undefined || !Number.isFinite(n) || n < min || (integer && !Number.isInteger(n))) throw new ArgError(`${flag} needs a number >= ${min}`);
  return n;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const out: ParsedArgs = {
    mode: "dry_run", orgId: "", runId: null, resume: false, maxAgeDays: DEFAULT_MAX_AGE_DAYS, textMaxAgeDays: DEFAULT_TEXT_MAX_AGE_DAYS,
    ratePerMinute: DEFAULT_RATE_PER_MINUTE, forceFlags: false, iKnowThisIsProd: false, iKnowThisWidensTexting: false, outDir: null,
  };
  const modes = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--dry-run": modes.add("dry_run"); break;
      case "--classify-only": modes.add("classify_only"); break;
      case "--apply": modes.add("apply"); break;
      case "--org": out.orgId = next() ?? ""; break;
      case "--run-id": out.runId = next() ?? null; break;
      case "--resume": out.runId = next() ?? null; out.resume = true; break;
      case "--limit": out.limit = num(a, next(), { min: 1, integer: true }); break;
      case "--max-age-days": out.maxAgeDays = num(a, next(), { min: 1 }); break;
      case "--text-max-age-days": out.textMaxAgeDays = num(a, next(), { min: 0, integer: true }); break;
      case "--batch-max-age-days": out.batchMaxAgeDays = num(a, next(), { min: 0 }); break;
      case "--rate": out.ratePerMinute = num(a, next(), { min: 1 }); break;
      case "--force-flags": out.forceFlags = true; break;
      case "--i-know-this-is-prod": out.iKnowThisIsProd = true; break;
      case "--i-know-this-widens-texting": out.iKnowThisWidensTexting = true; break;
      case "--out": out.outDir = next() ?? null; break;
      default: throw new ArgError(`unknown argument ${a}`);
    }
  }
  if (modes.size > 1) throw new ArgError("pick one of --dry-run, --classify-only, --apply");
  if (modes.size === 1) out.mode = [...modes][0] as BackfillMode;
  if (!UUID.test(out.orgId)) throw new ArgError("--org <uuid> is required");
  if (out.runId !== null && !RUN_ID.test(out.runId)) throw new ArgError("run id: 3-64 letters, digits, - or _");
  if (out.maxAgeDays > DEFAULT_MAX_AGE_DAYS) throw new ArgError(`--max-age-days is at most ${DEFAULT_MAX_AGE_DAYS}`);
  if (out.textMaxAgeDays > out.maxAgeDays) throw new ArgError("--text-max-age-days cannot exceed --max-age-days");
  if (out.textMaxAgeDays > DEFAULT_TEXT_MAX_AGE_DAYS && !out.iKnowThisWidensTexting) {
    throw new ArgError(`--text-max-age-days above ${DEFAULT_TEXT_MAX_AGE_DAYS} sends replies to older texts; pass --i-know-this-widens-texting`);
  }
  return out;
}

/** Loopback only = not production. Any hosted Supabase URL is treated as production. */
export function isLocalSupabaseUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

/** Refuse production unless --i-know-this-is-prod AND an explicit run id. Returns the run id to use. */
export function guardTarget(args: ParsedArgs, supabaseUrl: string | undefined, nowIso: string): { runId: string; prod: boolean } {
  const prod = !isLocalSupabaseUrl(supabaseUrl);
  if (prod) {
    if (!args.iKnowThisIsProd) throw new ArgError("refusing: the Supabase URL is not local; pass --i-know-this-is-prod to run against production");
    if (!args.runId) throw new ArgError("refusing: production runs need an explicit --run-id (or --resume <run_id>)");
  }
  if (args.resume && !args.runId) throw new ArgError("--resume needs the run id");
  return { runId: args.runId ?? `bf-${nowIso.replace(/[^0-9]/g, "").slice(0, 14)}`, prod };
}

/** Last 4 digits only, for any log line that must name a phone. */
export function last4(phone: string | null | undefined): string {
  const d = (phone ?? "").replace(/\D/g, "");
  return d.length >= 4 ? `…${d.slice(-4)}` : "…";
}
