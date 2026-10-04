#!/usr/bin/env node
// Operator script for the My Leads kill switches (public.my_leads_feature_flags).
//
//   op run --env-file=<file with op:// references> -- \
//     node scripts/my-leads-flags.mjs <flag> <on|off> --org <uuid>
//
// Upserts the org's row (only the named flag changes) and prints the row before and after.
// Seeding rows is a data step run here, never by a migration.
//
// Secrets: SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY are injected
// by `op run`. This script never calls the 1Password SDK, never takes a key as an argument, and
// never prints a secret.
import { pathToFileURL } from "node:url";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const FLAGS = [
  "call_next_strip",
  "post_call_prompt",
  "click_to_dial",
  "native_matcher",
  "auto_prompt",
  "callback_alert",
  "call_screen",
  "contract_card",
  "seller_reminders",
  "artifact_fetch",
  "facts_job",
  "offer_projection",
  "comp_queue",
];

export function parseArgs(argv) {
  const [flag, state, ...rest] = argv;
  if (!FLAGS.includes(flag)) throw new Error(`Unknown flag ${flag ?? "(none)"}; expected one of ${FLAGS.join(", ")}`);
  if (state !== "on" && state !== "off") throw new Error("State must be on or off");
  let org;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === "--org") {
      org = rest[i + 1];
      if (org === undefined || org.startsWith("--")) throw new Error("--org needs a value");
      i += 1;
    } else throw new Error(`Unknown argument ${rest[i]}`);
  }
  if (!org) throw new Error("--org is required");
  if (!UUID.test(org)) throw new Error("--org must be a UUID");
  return { flag, value: state === "on", org };
}

function redactor(secrets) {
  const list = secrets.filter((s) => typeof s === "string" && s.length >= 8);
  return (text) => list.reduce((t, s) => t.split(s).join("[redacted]"), String(text));
}

async function readRow(client, org) {
  const { data, error } = await client.from("my_leads_feature_flags").select("*").eq("org_id", org).maybeSingle();
  if (error) throw new Error(`read failed: ${error.message ?? JSON.stringify(error)}`);
  return data ?? null;
}

// `io` = { env, out(text), err(text), createClient(url, key) }.
export async function run(argv, io) {
  const redact = redactor([io.env.SUPABASE_SERVICE_ROLE_KEY]);
  try {
    const o = parseArgs(argv);
    const url = io.env.SUPABASE_URL ?? io.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = io.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be provided by `op run`");
    const client = io.createClient(url, key);
    const before = await readRow(client, o.org);
    const { error } = await client
      .from("my_leads_feature_flags")
      .upsert({ org_id: o.org, [o.flag]: o.value, updated_at: new Date().toISOString() }, { onConflict: "org_id" });
    if (error) throw new Error(`upsert failed: ${error.message ?? JSON.stringify(error)}`);
    const after = await readRow(client, o.org);
    io.out(`${JSON.stringify({ org: o.org, flag: o.flag, before, after }, null, 2)}\n`);
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
