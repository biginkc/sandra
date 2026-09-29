#!/usr/bin/env tsx
/**
 * Sequences V1 — full-stack production smoke.
 *
 * Proves the pipe end-to-end in prod:
 *   1. Seeds a throwaway sequence (1 step, 0 delay, send_sms) in prod Supabase.
 *   2. Seeds a contact with phone_1 = +18148097074 (our Twilio test
 *      receiver, wired up during Tier 1).
 *   3. Seeds a consent_events opt_in + a property linked to the contact.
 *   4. Creates an active enrollment with next_run_at = now.
 *   5. Waits up to 6 minutes for the Vercel sequence-tick cron to fire
 *      (scheduled every 5 min on the Pro plan).
 *   6. Polls `test_sms_log` until the Twilio webhook persists the
 *      incoming SMS from Dialpad.
 *   7. Cleans up: deletes the enrollment, sequence, property, consent
 *      events, messages, contact. Leaves the test_sms_log row for
 *      audit.
 *
 * Cost: ~$0.005 for one outbound Dialpad SMS + pennies for the Twilio
 * inbound receive. Single run is effectively free on credit balances.
 *
 * Usage:
 *   npm run smoke:sequences-prod
 *
 * Required env (from `.env.local` or the shell):
 *   SUPABASE_SERVICE_ROLE_KEY   — prod service-role key
 *   NEXT_PUBLIC_SUPABASE_URL    — prod URL
 *   SEQUENCE_CANARY_USER_ID     — dedicated auth.users UUID, also set in the app
 *
 * Safe tags the script writes so you can find stragglers manually:
 *   sequences.name      = "SMOKE TEST — safe to delete ${ts}"
 *   properties.address  = "E2E PROD SMOKE ${ts}"
 *   contacts.first_name = "Smoke"
 */

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";

import type { Database } from "../src/lib/supabase/types";
import { cleanupAllCanaries, cleanupCanary } from "./sequence-canary-cleanup";

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
const CANARY_USER_ID = env.SEQUENCE_CANARY_USER_ID;

if (!URL || !KEY || !CANARY_USER_ID || !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(CANARY_USER_ID)) {
  console.error(
    "Missing URL, service key, or valid SEQUENCE_CANARY_USER_ID",
  );
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

const TWILIO_NUMBER = "+18148097074";
const TS = new Date().toISOString().replace(/[:.]/g, "-");
const UNIQUE_BODY = `PROD-SMOKE ${TS}`;

async function main() {
  if (process.argv.includes("--cleanup-only")) {
    console.log(`[smoke] cleaned ${await cleanupAllCanaries(supabase, CANARY_USER_ID!) } canary sequences`);
    return;
  }
  let sequenceId: string | null = null;
  try {
    console.log(`[smoke] start   ${TS}`);

    // Resolve org
    const { data: org, error: orgError } = await supabase
      .from("organizations")
      .select("id")
      .limit(1)
      .single();
    if (orgError || !org) throw orgError ?? new Error("no organization in prod");

    // Seed sequence (no opt-out append — body already carries the STOP word
    // via our test string so we're not hiding it from the seller-side
    // audit trail).
    const { data: seq, error: seqErr } = await supabase
      .from("sequences")
      .insert({
        org_id: org.id,
        name: `SMOKE TEST — safe to delete ${TS}`,
        description: "One-off prod smoke; script deletes this when it exits",
        append_opt_out: false,
        created_by: CANARY_USER_ID,
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

    // Seed contact + consent
    const { data: contact, error: contactErr } = await supabase
      .from("contacts")
      .insert({
        first_name: "Smoke",
        last_name: `Prod ${TS}`,
        phone_1: TWILIO_NUMBER,
      })
      .select("id")
      .single();
    if (contactErr || !contact) throw contactErr ?? new Error("contact insert failed");

    const { error: consentErr } = await supabase.from("consent_events").insert({
      contact_id: contact.id,
      channel: "sms",
      event_type: "opt_in_marketing_written",
      source: "e2e-prod-smoke",
    });
    if (consentErr) throw consentErr;

    // Seed a tagged property. Runtime quiet-hour rules determine send time.
    const { data: property, error: propErr } = await supabase
      .from("properties")
      .insert({
        address: `E2E PROD SMOKE ${TS}`,
        state: "MO",
        status: "new_lead",
        homeowner_contact_id: contact.id,
      })
      .select("id")
      .single();
    if (propErr || !property) throw propErr ?? new Error("property insert failed");
    console.log(`[smoke] prop    ${property.id}`);

    // Enroll (next_run_at = now so the next cron tick picks it up)
    const { data: enrollment, error: enrErr } = await supabase
      .from("sequence_enrollments")
      .insert({
        org_id: org.id,
        sequence_id: seq.id,
        property_id: property.id,
        contact_id: contact.id,
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
      await cleanupCanary(supabase, sequenceId, CANARY_USER_ID!);
      console.log("[smoke] cleaned");
    }
  }
}

main().catch((err) => {
  console.error("[smoke] ERROR", err);
  process.exitCode = 1;
});
