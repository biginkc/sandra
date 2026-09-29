#!/usr/bin/env tsx
/** Production sequence smoke using the permanent owner-provisioned fixture. */

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";

import type { Database } from "../src/lib/supabase/types";
import { cleanupAllCanaries, cleanupCanary } from "./sequence-canary-cleanup";
import { fixtureIds, preflightFixture } from "./sequence-canary-fixture";

// ---------- env bootstrap ---------------------------------------------------

function loadLocalEnv(file: string): Record<string, string> {
  const p = path.resolve(process.cwd(), file);
  if (!fs.existsSync(p)) return {};
  const raw = fs.readFileSync(p, "utf8");
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

const env = { ...loadLocalEnv(".env.local"), ...process.env };
const URL = env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const ids = fixtureIds(env);
if (!URL || !KEY) {
  console.error("Missing URL or service key");
  process.exit(2);
}
if (URL.includes("ncsngxlcyxylaeskiteu")) {
  console.error(
    "URL points at the TEST project — this smoke is meant for prod. Aborting.",
  );
  process.exit(2);
}

const supabase = createClient<Database>(URL, KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ---------- run ------------------------------------------------------------

const TS = new Date().toISOString().replace(/[:.]/g, "-");
const UNIQUE_BODY = `PROD-SMOKE ${TS}`;

async function main() {
  const orgId = await preflightFixture(supabase, ids);
  if (process.argv.includes("--cleanup-only")) {
    console.log(`[smoke] cleaned ${await cleanupAllCanaries(supabase, ids.userId, ids.propertyId)} canary sequences`);
    return;
  }
  let sequenceId: string | null = null;
  try {
    console.log(`[smoke] start   ${TS}`);

    // Seed sequence (no opt-out append — body already carries the STOP word
    // via our test string so we're not hiding it from the seller-side
    // audit trail).
    const { data: seq, error: seqErr } = await supabase
      .from("sequences")
      .insert({
        org_id: orgId,
        name: `SMOKE TEST — safe to delete ${TS}`,
        description: "One-off prod smoke; script deletes this when it exits",
        append_opt_out: false,
        created_by: ids.userId,
      })
      .select("id")
      .single();
    if (seqErr || !seq) throw seqErr ?? new Error("seq insert failed");
    sequenceId = seq.id;
    console.log(`[smoke] seq     ${seq.id}`);

    const { data: step, error: stepErr } = await supabase
      .from("sequence_steps")
      .insert({
        sequence_id: seq.id,
        step_index: 0,
        delay_after_previous_minutes: 0,
        action_type: "send_sms",
        template_body: `Mel with BMH. ${UNIQUE_BODY} - Reply STOP.`,
      })
      .select("id")
      .single();
    if (stepErr || !step) throw stepErr ?? new Error("step insert failed");

    // Enroll (next_run_at = now so the next cron tick picks it up)
    const { data: enrollment, error: enrErr } = await supabase
      .from("sequence_enrollments")
      .insert({
        org_id: orgId,
        sequence_id: seq.id,
        property_id: ids.propertyId,
        contact_id: ids.contactId,
        status: "active",
        current_step_index: 0,
        next_run_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (enrErr || !enrollment) throw enrErr ?? new Error("enrollment insert failed");
    console.log(`[smoke] enrol   ${enrollment.id}`);
    console.log(
      `[smoke] waiting up to 6 min for the Vercel cron to fire and deliver to Twilio...`,
    );

    // Poll test_sms_log for the specific body.
    const deadline = Date.now() + 6 * 60_000;
    let matched: { id: string; received_at: string } | null = null;
    while (Date.now() < deadline) {
      const { data: rows, error: pollError } = await supabase
        .from("test_sms_log")
        .select("id, received_at, body")
        .ilike("body", `%${UNIQUE_BODY}%`)
        .order("received_at", { ascending: false })
        .limit(1);
      if (pollError) throw pollError;
      if (rows && rows.length > 0) {
        matched = rows[0];
        break;
      }
      await new Promise((r) => setTimeout(r, 15_000));
      process.stdout.write(".");
    }
    process.stdout.write("\n");

    if (!matched) {
      console.error("[smoke] FAILED — no test_sms_log row with matching body");
      throw new Error("No matching test_sms_log row");
    }

    console.log(`[smoke] PASS    test_sms_log row ${matched.id}`);
    console.log(`[smoke]         received_at = ${matched.received_at}`);

    // Verify enrollment advanced
    const { data: after, error: afterError } = await supabase
      .from("sequence_enrollments")
      .select("status, completed_at")
      .eq("id", enrollment.id)
      .single();
    if (afterError || !after || after.status !== "completed") throw afterError ?? new Error(`Enrollment did not complete: ${after?.status}`);
    console.log(`[smoke]         enrollment.status = ${after.status}`);
  } finally {
    if (sequenceId) {
      await cleanupCanary(supabase, sequenceId, ids.userId, ids.propertyId);
      console.log("[smoke] cleaned");
    }
  }
}

main().catch((err) => {
  console.error("[smoke] ERROR", err);
  process.exitCode = 1;
});
