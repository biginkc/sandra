#!/usr/bin/env node
// Operator script for the My Leads housekeeping data steps (P1e). Real-data changes never run
// from a migration; they run here, after a preview has been read and approved.
//
//   op run --env-file=<file with op:// references> -- \
//     node scripts/my-leads-housekeeping.mjs <command> --org <uuid> [options]
//
// Commands available in this release:
//   reassign        --from <uuid,uuid,...> [--target <uuid>] [--owner <uuid>] [--keep-clock]
//                   --from names the SOURCE members whose queue leads (and their open tasks) move to
//                   the target; it is required and must not include the target. The source's access
//                   status and acquisitions flag are ignored. Target/owner default to the org's single
//                   active owner with acquisitions enabled, read from memberships.
//   close-attempts  [--older-than "7 days"] (apply also needs --cutoff <timestamp printed by the preview>)
//   relabel         [--expected-assignee <uuid>] (apply also needs --cutoff <timestamp printed by the preview>)
//   retire-preflight (read-only count of open legacy follow_up/callback rows)
//   rollback        --run <uuid>
//   offer-backfill  [--owner <uuid>] (creates each pending offer's follow-up; overdue ones land at the next 09:00 Central)
//   link-backfill   (P1d: stores each stored Dialpad call's share link, admin recording URL and voicemail
//                   fields that its hangup events carry; fills only empty fields, never prints a link)
// Later phases add phone-backfill, ack-legacy-prompts to COMMANDS below as their SQL functions
// ship; they are refused until then.
//
// Runbook: rolling back a reassign to a deactivated Maria/Mel fails safe (the active-assignee guard
// trg_properties_active_assignee refuses it) and the lead is reported under notRestored, not forced.
//
// Default is a read-only preview. Applying needs BOTH --apply and --confirm <sha256 of the
// preview JSON this script printed>. The script re-runs the preview, refuses on any difference,
// then passes the preview's row-level fingerprint to the apply RPC, which locks the rows and
// recomputes it inside the mutation transaction (so rows cannot change between preview and apply).
//
// The printed preview includes the Supabase host (not a secret), so the confirm hash is tied to one
// environment. The script refuses to start unless OP_SERVICE_ACCOUNT_TOKEN is present, i.e. it was
// launched through `op run` with the BMH service account.
//
// Secrets: SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY are injected
// by `op run` from the BMH service account. This script never calls the 1Password SDK, never
// takes a key as an argument, and never prints a secret.
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const COMMANDS = {
  reassign: {
    needs: ["org", "from"],
    rpc: "fn_my_leads_housekeeping_reassign",
    args: (o) => ({
      p_org_id: o.org,
      p_target: o.target,
      p_sources: o.from,
      p_owner: o.owner,
      p_keep_clock: Boolean(o.keepClock),
    }),
    resolveIdentities: true,
  },
  "close-attempts": {
    needs: ["org"],
    rpc: "fn_my_leads_housekeeping_close_attempts",
    args: (o) => ({ p_org_id: o.org, p_older_than: o.olderThan ?? "7 days", p_cutoff: o.cutoff ?? null }),
    needsCutoffToApply: true,
  },
  relabel: {
    needs: ["org"],
    rpc: "fn_my_leads_relabel_open_next_steps",
    args: (o) => ({ p_org_id: o.org, p_expected_assignee: o.expectedAssignee ?? o.target, p_cutoff: o.cutoff ?? null }),
    needsCutoffToApply: true,
    resolveIdentities: true,
  },
  // Gives every pending offer its follow-up appointment (P1a-writers 1a.6). The actor is the owner.
  "offer-backfill": {
    needs: ["org"],
    rpc: "fn_my_leads_backfill_offer_follow_ups",
    args: (o) => ({ p_org_id: o.org, p_actor: o.owner }),
    resolveIdentities: true,
  },
  // Captures the links stored hangup events carry into empty fields only (P1d 1d.1).
  "link-backfill": { needs: ["org"], rpc: "fn_my_leads_housekeeping_link_backfill", args: (o) => ({ p_org_id: o.org }) },
  // Read-only gate for the retire migration: never applies anything.
  "retire-preflight": { needs: ["org"], rpc: "fn_my_leads_next_step_retire_preflight", args: (o) => ({ p_org_id: o.org }), readOnly: true },
  rollback: { needs: ["org", "run"], rollback: true },
};
const LATER = ["phone-backfill", "ack-legacy-prompts"];

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const o = { command, apply: false, keepClock: false };
  const value = (i, name) => {
    const v = rest[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`--${name} needs a value`);
    return v;
  };
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === "--apply") o.apply = true;
    else if (a === "--keep-clock") o.keepClock = true;
    else if (a === "--from") {
      o.from = value(i, "from").split(",").map((x) => x.trim());
      i += 1;
    } else if (["--org", "--target", "--owner", "--run", "--confirm", "--older-than", "--cutoff", "--expected-assignee"].includes(a)) {
      const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      o[key] = value(i, a.slice(2));
      i += 1;
    } else throw new Error(`Unknown argument ${a}`);
  }
  for (const k of ["org", "target", "owner", "run"]) {
    if (o[k] !== undefined && !UUID.test(o[k])) throw new Error(`--${k} must be a UUID`);
  }
  if (o.from !== undefined) {
    if (o.from.some((id) => !UUID.test(id))) throw new Error("--from must be a comma-separated list of UUIDs");
    o.from = [...new Set(o.from.map((id) => id.toLowerCase()))].sort();
  }
  return o;
}

export function canonicalJson(value) {
  const sort = (v) => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])]));
    }
    return v;
  };
  return JSON.stringify(sort(value), null, 2);
}

export const sha256Hex = (text) => createHash("sha256").update(text).digest("hex");

function redactor(secrets) {
  const list = secrets.filter((s) => typeof s === "string" && s.length >= 8);
  return (text) => list.reduce((t, s) => t.split(s).join("[redacted]"), String(text));
}

async function rpc(client, name, args) {
  const { data, error } = await client.rpc(name, args);
  if (error) throw new Error(`${name} failed: ${error.message ?? JSON.stringify(error)}`);
  return data;
}

async function resolveIdentities(client, o) {
  if (o.target && o.owner) return o;
  const { data, error } = await client
    .from("memberships")
    .select("user_id")
    .eq("org_id", o.org)
    .eq("role", "owner")
    .eq("acquisitions_enabled", true)
    .eq("access_status", "active");
  if (error) throw new Error(`could not resolve the owner: ${error.message}`);
  if (!data || data.length !== 1) {
    throw new Error("target/owner not given and the org does not have exactly one active acquisitions owner; pass --target and --owner");
  }
  return { ...o, target: o.target ?? data[0].user_id, owner: o.owner ?? data[0].user_id };
}

// Human-readable per-source counts on stderr (not part of the hashed preview). Emails are looked up
// best-effort through the auth admin API; a failure only means the id is shown alone.
async function printSourceSummary(client, o, preview, io) {
  const leads = new Map((preview.leads ?? []).map((l) => [l.from, l.count]));
  const tasks = new Map((preview.tasks?.byAssignee ?? []).map((t) => [t.assignee, t]));
  for (const id of o.from) {
    let email = "";
    try {
      const { data } = (await client.auth?.admin?.getUserById(id)) ?? {};
      email = data?.user?.email ? ` (${data.user.email})` : "";
    } catch { /* id only */ }
    const t = tasks.get(id);
    io.err(`source ${id}${email}: ${leads.get(id) ?? 0} leads, ${t?.nonAppointment ?? 0} tasks, ${t?.appointments ?? 0} appointments\n`);
  }
}

// Runs one command. `io` = { env, out(text), err(text), createClient(url, key) }.
export async function run(argv, io) {
  const redact = redactor([io.env.SUPABASE_SERVICE_ROLE_KEY, io.env.OP_SERVICE_ACCOUNT_TOKEN]);
  try {
    let o = parseArgs(argv);
    if (LATER.includes(o.command)) {
      throw new Error(`${o.command} is not available in this release (its SQL function has not shipped)`);
    }
    const spec = COMMANDS[o.command];
    if (!spec) throw new Error(`Unknown command ${o.command ?? "(none)"}; expected ${Object.keys(COMMANDS).join(", ")}`);
    for (const k of spec.needs) if (!o[k]) throw new Error(`--${k} is required for ${o.command}`);
    if (o.confirm && !o.apply) throw new Error("--confirm only makes sense with --apply");
    if (!io.env.OP_SERVICE_ACCOUNT_TOKEN) {
      throw new Error("OP_SERVICE_ACCOUNT_TOKEN is not set; run through `op run` with the BMH service account");
    }
    const url = io.env.SUPABASE_URL ?? io.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = io.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be provided by `op run`");
    let host;
    try { host = new URL(url).host; } catch { throw new Error("SUPABASE_URL is not a valid URL"); }
    if (o.apply && spec.needsCutoffToApply && !o.cutoff) {
      throw new Error("--apply needs --cutoff <timestamp from the preview>");
    }
    const client = io.createClient(url, key);
    if (spec.resolveIdentities) o = await resolveIdentities(client, o);

    if (o.command === "reassign" && o.from.includes(o.target.toLowerCase())) {
      throw new Error("--from must not include the target; the target's own leads never move");
    }

    const preview = async () => {
      if (spec.rollback) return rpc(client, "fn_my_leads_housekeeping_run_info", { p_run: o.run, p_org_id: o.org });
      if (spec.readOnly) return rpc(client, spec.rpc, spec.args(o));
      return rpc(client, spec.rpc, { ...spec.args(o), p_apply: false });
    };
    const previewJson = { supabaseHost: host, ...(await preview()) };
    const printed = canonicalJson(previewJson);
    const hash = sha256Hex(printed);

    if (spec.readOnly) {
      if (o.apply) throw new Error(`${o.command} is read-only and cannot be applied`);
      io.out(`${printed}\n`);
      return 0;
    }
    if (!o.apply) {
      io.out(`${printed}\n`);
      if (o.command === "reassign") await printSourceSummary(client, o, previewJson, io);
      const cutoffFlag = spec.needsCutoffToApply && previewJson.cutoff ? ` --cutoff ${previewJson.cutoff}` : "";
      io.err(`preview only. To apply, re-run with: --apply${cutoffFlag} --confirm ${hash}\n`);
      return 0;
    }
    if (!o.confirm) throw new Error(`--apply needs --confirm <sha256 of the preview>; the current preview hashes to ${hash}`);
    if (o.confirm.toLowerCase() !== hash) {
      throw new Error("--confirm does not match the current preview; nothing was applied. Review the new preview and confirm again");
    }
    const fingerprint = previewJson.fingerprint;
    if (typeof fingerprint !== "string" || fingerprint.length < 32) throw new Error("preview carried no fingerprint; refusing to apply");
    const result = spec.rollback
      ? await rpc(client, "fn_my_leads_housekeeping_rollback", { p_run: o.run, p_org_id: o.org, p_fingerprint: fingerprint })
      : await rpc(client, spec.rpc, { ...spec.args(o), p_apply: true, p_fingerprint: fingerprint });
    io.out(`${canonicalJson(result)}\n`);
    if (result?.runId) io.err(`run id: ${result.runId}\n`);
    return 0;
  } catch (error) {
    io.err(`${redact(error?.message ?? error)}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { createClient } = await import("@supabase/supabase-js");
  const code = await run(process.argv.slice(2), {
    env: process.env,
    out: (t) => process.stdout.write(t),
    err: (t) => process.stderr.write(t),
    createClient: (url, key) => createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }),
  });
  process.exit(code);
}
