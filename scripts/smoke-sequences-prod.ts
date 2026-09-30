#!/usr/bin/env tsx
/** Production sequence smoke using the permanent owner-provisioned fixture. */

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

import type { Database } from "../src/lib/supabase/types";
import { cleanupAllCanaries, cleanupCanary } from "./sequence-canary-cleanup";
import { assertCanaryReceipt, assertDeliveryWebhook, fixtureIds, preflightFixture, SENDILLO_SENDER, type FixtureIds } from "./sequence-canary-fixture";

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

// ---------- run ------------------------------------------------------------

export async function runSequenceSmoke(supabase: ReturnType<typeof createClient<Database>>, ids: FixtureIds, cleanupOnly = false, expectedSender = process.env.SENDILLO_FROM_NUMBER) {
  if (cleanupOnly) {
    console.log(`[smoke] cleaned ${await cleanupAllCanaries(supabase, ids.userId, ids.propertyId)} canary sequences`);
    return;
  }
  const orgId = await preflightFixture(supabase, ids);
  if (expectedSender !== SENDILLO_SENDER) {
    throw new Error("SENDILLO_FROM_NUMBER must be the approved Sendillo sender");
  }
  const TS = new Date().toISOString().replace(/[:.]/g, "-");
  const UNIQUE_BODY = `PROD-SMOKE ${TS} ${randomUUID()}`;
  const sentBody = `Mel with BMH. ${UNIQUE_BODY} - Reply STOP.`;
  let sequenceId: string | null = null;
  const evidence: Record<string, string | null> = { sequenceId: null, enrollmentId: null, stepId: null,
    claimId: null, messageId: null, externalId: null, webhookEventId: null };
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
    evidence.sequenceId = seq.id;
    console.log(`[smoke] seq     ${seq.id}`);

    const { data: step, error: stepErr } = await supabase
      .from("sequence_steps")
      .insert({
        sequence_id: seq.id,
        step_index: 0,
        delay_after_previous_minutes: 0,
        action_type: "send_sms",
        template_body: sentBody,
      })
      .select("id")
      .single();
    if (stepErr || !step) throw stepErr ?? new Error("step insert failed");
    evidence.stepId = step.id;
    console.log(`[smoke] step    ${step.id}`);

    // Enroll (next_run_at = now so the next cron tick picks it up)
    await preflightFixture(supabase, ids);
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
    evidence.enrollmentId = enrollment.id;
    console.log(`[smoke] enrol   ${enrollment.id}`);
    console.log(`[smoke] sent body = ${sentBody}`);
    async function waitFor<T>(label: string, deadline: number, read: () => Promise<T | null>): Promise<T> {
      while (Date.now() < deadline) {
        const result = await read();
        if (result) return result;
        await new Promise((resolve) => setTimeout(resolve, 15_000));
      }
      throw new Error(`Canary ${label} timed out`);
    }
    const claim = await waitFor("accepted claim", Date.now() + 12 * 60_000, async () => {
      const { data, error } = await supabase.from("sequence_step_runs")
        .select("id,step_id,enrollment_id,attempt_outcome,message_id").eq("enrollment_id", enrollment.id).eq("step_id", step.id).limit(2);
      if (error) throw error;
      if ((data?.length ?? 0) > 1) throw new Error("Multiple canary claims");
      const row = data?.[0];
      if (row && !["not_attempted", "accepted"].includes(row.attempt_outcome)) throw new Error(`Canary claim failed: ${row.attempt_outcome}`);
      return row?.attempt_outcome === "accepted" && row.message_id ? row : null;
    });
    console.log(`[smoke] claim   ${claim.id} message ${claim.message_id}`);
    const messageId = claim.message_id!;
    evidence.claimId = claim.id;
    evidence.messageId = messageId;
    const sent = await waitFor("sent_at", Date.now() + 2 * 60_000, async () => {
      const { data, error } = await supabase.from("messages")
        .select("id,body,to_address,from_address,provider,external_id,status,sent_at,delivered_at").eq("id", messageId).single();
      if (error || !data) throw error ?? new Error("Canary message missing");
      if (["failed", "undelivered", "canceled"].includes(data.status)) throw new Error(`Canary message failed: ${data.status}`);
      return data.sent_at ? data : null;
    });
    const deliveryDeadline = new Date(sent.sent_at!).getTime() + 3 * 60_000;
    const delivered = await waitFor("delivery", deliveryDeadline, async () => {
      const { data, error } = await supabase.from("messages")
        .select("id,body,to_address,from_address,provider,external_id,status,sent_at,delivered_at").eq("id", messageId).single();
      if (error || !data) throw error ?? new Error("Canary message missing");
      if (["failed", "undelivered", "canceled"].includes(data.status)) throw new Error(`Canary message failed: ${data.status}`);
      return data.status === "delivered" ? data : null;
    });
    evidence.externalId = delivered.external_id;
    assertCanaryReceipt(delivered, sentBody);
    const webhook = await waitFor("webhook", deliveryDeadline, async () => {
      const { data, error } = await supabase.from("webhook_events")
        .select("id,provider,external_id,event_type,signature_verified,processing_status")
        .eq("org_id", orgId).eq("provider", "sendillo").eq("external_id", delivered.external_id!)
        .eq("event_type", "sms_status_delivered").limit(2);
      if (error) throw error;
      if ((data?.length ?? 0) > 1) throw new Error("Multiple matching canary webhooks");
      const row = data?.[0];
      if (row && (row.signature_verified !== true || row.processing_status === "failed")) throw new Error("Canary webhook authentication or processing failed");
      return row?.processing_status === "processed" ? row : null;
    });
    evidence.webhookEventId = webhook.id;
    assertDeliveryWebhook(webhook, delivered.external_id!);
    const { data: after, error: afterError } = await supabase.from("sequence_enrollments")
      .select("status,completed_at").eq("id", enrollment.id).single();
    if (afterError || !after || after.status !== "completed" || !after.completed_at) {
      throw afterError ?? new Error(`Enrollment did not complete: ${after?.status}`);
    }
    console.log("[smoke] PASS", JSON.stringify({ enrollmentId: enrollment.id, stepId: step.id, claimId: claim.id,
      messageId, externalId: delivered.external_id, webhookEventId: webhook.id, sentAt: delivered.sent_at,
      deliveredAt: delivered.delivered_at, completedAt: after.completed_at }));
  } finally {
    console.log("[smoke] evidence before cleanup", JSON.stringify(evidence));
    if (sequenceId) {
      await cleanupCanary(supabase, sequenceId, ids.userId, ids.propertyId);
      console.log("[smoke] cleaned");
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const env = { ...loadLocalEnv(".env.local"), ...process.env };
  const URL = env.NEXT_PUBLIC_SUPABASE_URL;
  const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
  const ids = fixtureIds(env);
  if (!URL || !KEY) {
    console.error("Missing URL or service key");
    process.exit(2);
  }
  if (URL.includes("ncsngxlcyxylaeskiteu")) {
    console.error("URL points at the TEST project — this smoke is meant for prod. Aborting.");
    process.exit(2);
  }
  const supabase = createClient<Database>(URL, KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  runSequenceSmoke(supabase, ids, process.argv.includes("--cleanup-only"), env.SENDILLO_FROM_NUMBER).catch((err) => {
    console.error("[smoke] ERROR", err);
    process.exitCode = 1;
  });
}
