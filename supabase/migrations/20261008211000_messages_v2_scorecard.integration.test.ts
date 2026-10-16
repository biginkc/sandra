import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Messages v2 Phase 3: fn_messages_v2_scorecard (20261008211000). Local-only:
 * replays the 20261008140000..20261008211000 chain inside a rolled-back
 * transaction, seeds runs / decisions / reviews / lead_events at known ages,
 * and asserts the per-outcome counts, agreement verdicts, samples, and that
 * the function is SECURITY INVOKER (another org's member sees zeros).
 */
const db = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });
const CHAIN = readdirSync(__dirname)
  .filter((f) => /^20261008\d{6}_.*\.sql$/.test(f) && f >= "20261008140000" && f <= "20261008211000_zz")
  .sort()
  .map((f) =>
    readFileSync(path.join(__dirname, f), "utf8").replace(/^begin;$/m, "").replace(/^commit;$/m, ""),
  );

let orgId: string;
let otherOrgId: string;
let ownerId: string;
let outsiderId: string;
let reviewerId: string;

beforeAll(async () => {
  await db.connect();
});
afterAll(async () => {
  await db.end();
});

const ago = (hours: number) => `now() - interval '${hours} hours'`;

async function addUser(org: string, role: "owner" | "member"): Promise<string> {
  const id = randomUUID();
  await db.query(`insert into auth.users (id, email) values ($1, $2)`, [id, `u-${id}@test.local`]);
  await db.query(
    `insert into public.memberships (org_id, user_id, role, access_status) values ($1, $2, $3, 'active')`,
    [org, id, role],
  );
  return id;
}

type Seed = {
  outcome: string;
  conf: number | null;
  ageHours: number;
  org?: string;
  provider?: string;
};

/** Inserts an sms_classification_runs row and returns {runId, propertyId}. */
async function seedRun(s: Seed) {
  const runId = randomUUID();
  const propertyId = randomUUID();
  const conversationId = randomUUID();
  const messageId = randomUUID();
  const decision = JSON.stringify({
    outcome: s.outcome,
    ...(s.conf === null ? {} : { nativeConfidence: s.conf }),
  });
  await db.query(
    `insert into public.sms_classification_runs
       (id, org_id, property_id, conversation_id, source_inbound_message_id, state_hash,
        schema_version, policy_version, provider, model, decision, resolved_outcome, created_at)
     values ($1,$2,$3,$4,$5,$6,'s','p',$7,'m',$8::jsonb,$9, ${ago(s.ageHours)})`,
    [runId, s.org ?? orgId, propertyId, conversationId, messageId, randomUUID(), s.provider ?? "jev", decision, s.outcome],
  );
  return { runId, propertyId, conversationId, messageId };
}

async function seedReview(
  r: Awaited<ReturnType<typeof seedRun>>,
  disposition: string,
  status: "pending" | "confirmed" | "superseded" | "auto_accepted",
  extra: { correctedTo?: string; correctedHoursAfter?: number; runAgeHours: number } ,
) {
  const resolved = status === "pending" ? "null" : "now()";
  const reviewedBy = status === "confirmed" ? `'${reviewerId}'` : "null";
  const superseded = status === "superseded" ? "'property_outcome_changed'" : "null";
  const corrected = extra.correctedTo
    ? `, '${extra.correctedTo}', ${ago(extra.runAgeHours - (extra.correctedHoursAfter ?? 1))}, '${reviewerId}'`
    : ", null, null, null";
  await db.query(
    `insert into public.ai_disposition_reviews
       (org_id, property_id, conversation_id, source_inbound_message_id, disposition, ai_reason,
        status, resolved_at, reviewed_by, superseded_reason, classification_run_id,
        corrected_disposition, corrected_at, corrected_by)
     values ($1,$2,$3,$4,$5,'r',$6,${resolved},${reviewedBy},${superseded},$7 ${corrected})`,
    [orgId, r.propertyId, r.conversationId, r.messageId, disposition, status, r.runId],
  );
}

async function seedDecision(
  r: Awaited<ReturnType<typeof seedRun>>,
  outcome: string,
  status: "pending" | "confirmed" | "corrected" | "superseded",
  by: "system" | "human",
) {
  const id = randomUUID();
  const resolvedOutcome = status === "pending" || status === "superseded" ? "null" : status === "corrected" ? "'wrong_number'" : `'${outcome}'`;
  const resolvedAt = status === "pending" ? "null" : "now()";
  const resolvedBy = status !== "pending" && status !== "superseded" && by === "human" ? `'${reviewerId}'` : "null";
  const superseded = status === "superseded" ? "'new_ai_decision'" : "null";
  await db.query(
    `insert into public.jev_lead_decisions
       (id, org_id, property_id, conversation_id, source_inbound_message_id, classification_run_id,
        proposed_outcome, status, resolved_outcome, resolved_at, resolved_by, superseded_reason)
     values ($1,$2,$3,$4,$5,$6,$7,$8,${resolvedOutcome},${resolvedAt},${resolvedBy},${superseded})`,
    [id, orgId, r.propertyId, r.conversationId, r.messageId, r.runId, outcome, status],
  );
  return id;
}

async function leadEvent(
  propertyId: string,
  type: string,
  actor: "user" | "ai" | "system",
  payload: object,
  hoursAgo: number,
  source?: [string, string],
) {
  await db.query(
    `insert into public.lead_events (org_id, property_id, actor_type, actor_id, event_type, payload, source_type, source_id, created_at)
     values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8, ${ago(hoursAgo)})`,
    [orgId, propertyId, actor, actor === "user" ? reviewerId : null, type, JSON.stringify(payload), source?.[0] ?? null, source?.[1] ?? null],
  );
}

beforeEach(async () => {
  await db.query("begin");
  for (const sql of CHAIN) await db.query(sql);
  orgId = randomUUID();
  otherOrgId = randomUUID();
  await db.query("insert into public.organizations (id, name) values ($1, $2), ($3, $4)", [
    orgId, `Scorecard ${orgId}`, otherOrgId, `Other ${otherOrgId}`,
  ]);
  await db.query("set local session_replication_role = replica");
  ownerId = await addUser(orgId, "owner");
  reviewerId = await addUser(orgId, "member");
  outsiderId = await addUser(otherOrgId, "owner");
  await db.query(
    `insert into public.jev_outcome_thresholds (org_id, outcome, min_confidence, automation_enabled)
     values ($1,'nurture',0.900,true), ($1,'new_lead',0.950,false)`,
    [orgId],
  );
});
afterEach(async () => {
  await db.query("rollback");
});

async function scorecard(days = 7, asUserId?: string) {
  if (asUserId) {
    await db.query("savepoint s");
    await db.query("set local role authenticated");
    await db.query("select set_config('request.jwt.claim.sub', $1, true)", [asUserId]);
  }
  try {
    const res = await db.query("select * from public.fn_messages_v2_scorecard($1, $2)", [orgId, days]);
    return Object.fromEntries(res.rows.map((r) => [r.outcome as string, r]));
  } finally {
    if (asUserId) {
      await db.query("reset role");
      await db.query("release savepoint s");
    }
  }
}

describe("fn_messages_v2_scorecard", () => {
  it("returns one row per thresholded outcome, zero-filled, with threshold + automation state", async () => {
    const rows = await scorecard();
    expect(Object.keys(rows).sort()).toEqual(
      ["new_lead", "not_interested", "nurture", "opted_out", "wrong_number"],
    );
    expect(rows.nurture).toMatchObject({ runs: "0", threshold: "0.900", automation_enabled: true });
    expect(rows.new_lead).toMatchObject({ threshold: "0.950", automation_enabled: false });
    expect(rows.opted_out).toMatchObject({ threshold: null, automation_enabled: null, samples: [] });
  });

  it("nurture/new_lead path: auto vs held, 72h maturity, corrections, human dispo overrides", async () => {
    // A: auto, 5d old, untouched -> settled, agreed
    const a = await seedRun({ outcome: "nurture", conf: 0.95, ageHours: 120 });
    await seedDecision(a, "nurture", "confirmed", "system");
    // B: auto, 5d old, human sets a different dispo 24h later -> settled, disagreed
    const b = await seedRun({ outcome: "nurture", conf: 0.91, ageHours: 120 });
    await seedDecision(b, "nurture", "confirmed", "system");
    await leadEvent(b.propertyId, "dispo_set", "user", { from: "nurture", to: "not_interested" }, 96);
    // B2: human dispo_set to the SAME outcome is not a disagreement
    const b2 = await seedRun({ outcome: "nurture", conf: 0.92, ageHours: 120 });
    await seedDecision(b2, "nurture", "confirmed", "system");
    await leadEvent(b2.propertyId, "dispo_set", "user", { from: null, to: "nurture" }, 96);
    // B3: human override AFTER the 72h window does not count
    const b3 = await seedRun({ outcome: "nurture", conf: 0.93, ageHours: 150 });
    await seedDecision(b3, "nurture", "confirmed", "system");
    await leadEvent(b3.propertyId, "dispo_set", "user", { from: "nurture", to: "not_interested" }, 20);
    // C: auto, 1d old -> auto_applied but not settled
    const c = await seedRun({ outcome: "nurture", conf: 0.97, ageHours: 24 });
    await seedDecision(c, "nurture", "confirmed", "system");
    // C2: auto, 1d old, already corrected -> settled as disagreement (no need to wait 72h)
    const c2 = await seedRun({ outcome: "nurture", conf: 0.9, ageHours: 24 });
    const c2d = await seedDecision(c2, "nurture", "corrected", "human");
    await leadEvent(c2.propertyId, "jev_lead_decision_corrected", "user",
      { decision_id: c2d, previous_resolved_outcome: "nurture", corrected_outcome: "wrong_number" }, 20);
    // D: held, human confirmed -> held_decided, agreed
    const d = await seedRun({ outcome: "nurture", conf: 0.8, ageHours: 100 });
    const dd = await seedDecision(d, "nurture", "confirmed", "human");
    await leadEvent(d.propertyId, "jev_lead_decision_confirmed", "user", { decision_id: dd }, 90,
      ["jev_lead_decisions.confirmed", dd]);
    // E: held, human corrected (was pending) -> held_decided, disagreed
    const e = await seedRun({ outcome: "nurture", conf: 0.7, ageHours: 100 });
    const ed = await seedDecision(e, "nurture", "corrected", "human");
    await leadEvent(e.propertyId, "jev_lead_decision_corrected", "user",
      { decision_id: ed, previous_resolved_outcome: null, corrected_outcome: "wrong_number" }, 90);
    // F: held, still pending -> held, undecided
    const f = await seedRun({ outcome: "nurture", conf: 0.6, ageHours: 10 });
    await seedDecision(f, "nurture", "pending", "system");
    // G: superseded -> counted as a run only
    const g = await seedRun({ outcome: "nurture", conf: 0.6, ageHours: 10 });
    await seedDecision(g, "nurture", "superseded", "system");

    const n = (await scorecard()).nurture;
    expect(n).toMatchObject({
      runs: "10",
      auto_applied: "6", // A B B2 B3 C C2
      held: "3", // D E F
      auto_settled: "5", // A B B2 B3 C2
      auto_agreed: "3", // A B2 B3
      held_decided: "2",
      held_agreed: "1",
    });
    // samples: every verdict-bearing run with a confidence, as [conf, agreed, route]
    // where route is "a" (auto-applied) or "h" (held), so the two are never blended.
    const samples = (n.samples as Array<[number, number, string]>).sort((x, y) => x[0] - y[0]);
    expect(samples).toEqual([
      [0.7, 0, "h"], [0.8, 1, "h"], [0.9, 0, "a"], [0.91, 0, "a"], [0.92, 1, "a"], [0.93, 1, "a"], [0.95, 1, "a"],
    ]);
  });

  it("nurture is a parking step: a human dispo_set to needs_sequence after a nurture run agrees (auto and held)", async () => {
    // auto nurture, user sets needs_sequence 24h after -> still agreed
    const a = await seedRun({ outcome: "nurture", conf: 0.95, ageHours: 120 });
    await seedDecision(a, "nurture", "confirmed", "system");
    await leadEvent(a.propertyId, "dispo_set", "user", { from: "nurture", to: "needs_sequence" }, 96);
    // auto nurture, user sets a different dispo -> still a disagreement
    const b = await seedRun({ outcome: "nurture", conf: 0.94, ageHours: 120 });
    await seedDecision(b, "nurture", "confirmed", "system");
    await leadEvent(b.propertyId, "dispo_set", "user", { from: "nurture", to: "not_interested" }, 96);
    // held nurture confirmed by a human, then needs_sequence -> agreed
    const c = await seedRun({ outcome: "nurture", conf: 0.8, ageHours: 100 });
    const cd = await seedDecision(c, "nurture", "confirmed", "human");
    await leadEvent(c.propertyId, "jev_lead_decision_confirmed", "user", { decision_id: cd }, 90,
      ["jev_lead_decisions.confirmed", cd]);
    await leadEvent(c.propertyId, "dispo_set", "user", { from: "nurture", to: "needs_sequence" }, 80);
    expect((await scorecard()).nurture).toMatchObject({
      auto_settled: "2",
      auto_agreed: "1",
      held_decided: "1",
      held_agreed: "1",
    });
  });

  it("new_lead ignores human dispo_set events (they are not a verdict on a promotion)", async () => {
    const a = await seedRun({ outcome: "new_lead", conf: 0.97, ageHours: 120 });
    await seedDecision(a, "new_lead", "confirmed", "system");
    await leadEvent(a.propertyId, "dispo_set", "user", { from: null, to: "callback_requested" }, 96);
    expect((await scorecard()).new_lead).toMatchObject({ auto_settled: "1", auto_agreed: "1" });
  });

  it("review path: auto_accepted corrections inside/outside 72h, held, superseded", async () => {
    // auto_accepted, corrected 10h after the run -> disagree
    const a = await seedRun({ outcome: "wrong_number", conf: 0.96, ageHours: 120 });
    await seedReview(a, "wrong_number", "auto_accepted", { correctedTo: "nurture", correctedHoursAfter: 10, runAgeHours: 120 });
    // auto_accepted, corrected 100h after -> outside window -> agree
    const b = await seedRun({ outcome: "wrong_number", conf: 0.97, ageHours: 140 });
    await seedReview(b, "wrong_number", "auto_accepted", { correctedTo: "nurture", correctedHoursAfter: 100, runAgeHours: 140 });
    // auto_accepted, uncorrected, mature -> agree
    const c = await seedRun({ outcome: "wrong_number", conf: 0.98, ageHours: 100 });
    await seedReview(c, "wrong_number", "auto_accepted", { runAgeHours: 100 });
    // held pending
    const d = await seedRun({ outcome: "wrong_number", conf: 0.5, ageHours: 5 });
    await seedReview(d, "wrong_number", "pending", { runAgeHours: 5 });
    // held confirmed -> agree
    const e = await seedRun({ outcome: "wrong_number", conf: 0.6, ageHours: 50 });
    await seedReview(e, "wrong_number", "confirmed", { runAgeHours: 50 });
    // held, superseded by a human changing the dispo -> held + disagree
    const f = await seedRun({ outcome: "wrong_number", conf: 0.55, ageHours: 50 });
    await seedReview(f, "wrong_number", "superseded", { runAgeHours: 50 });
    await leadEvent(f.propertyId, "dispo_set", "user", { from: null, to: "not_interested" }, 40);
    // superseded with no human override -> counted as run only
    const g = await seedRun({ outcome: "wrong_number", conf: 0.55, ageHours: 50 });
    await seedReview(g, "wrong_number", "superseded", { runAgeHours: 50 });
    // run with no review/decision row at all (shadow)
    await seedRun({ outcome: "wrong_number", conf: 0.99, ageHours: 50 });

    expect((await scorecard()).wrong_number).toMatchObject({
      runs: "8",
      auto_applied: "3",
      held: "3",
      auto_settled: "3",
      auto_agreed: "2",
      held_decided: "2",
      held_agreed: "1",
    });
  });

  it("review path: an auto_accepted run corrected at +24h then again at +100h stays disagreed (corrected_at is overwritten)", async () => {
    const a = await seedRun({ outcome: "wrong_number", conf: 0.96, ageHours: 140 });
    // corrected_at holds the LAST correction (+100h, outside the 72h window)
    await seedReview(a, "wrong_number", "auto_accepted", { correctedTo: "nurture", correctedHoursAfter: 100, runAgeHours: 140 });
    const rev = await db.query(
      "select id from public.ai_disposition_reviews where classification_run_id = $1",
      [a.runId],
    );
    const reviewId = rev.rows[0].id as string;
    await leadEvent(a.propertyId, "ai_disposition_review_corrected", "user", { review_id: reviewId, corrected_disposition: "nurture" }, 140 - 24);
    await leadEvent(a.propertyId, "ai_disposition_review_corrected", "user", { review_id: reviewId, corrected_disposition: "not_interested" }, 140 - 100);

    expect((await scorecard()).wrong_number).toMatchObject({
      runs: "1",
      auto_applied: "1",
      auto_settled: "1",
      auto_agreed: "0",
    });
  });

  it("review path: a human dispo_set to the mapped disposition (dnc) is not an override of Jev's opted_out", async () => {
    // superseded dnc review, human set dnc -> same as the review, so no verdict (run only)
    const a = await seedRun({ outcome: "opted_out", conf: 0.97, ageHours: 120 });
    await seedReview(a, "dnc", "superseded", { runAgeHours: 120 });
    await leadEvent(a.propertyId, "dispo_set", "user", { from: null, to: "dnc" }, 100);
    // a different human disposition inside 72h still is an override -> held disagreement
    const b = await seedRun({ outcome: "opted_out", conf: 0.97, ageHours: 120 });
    await seedReview(b, "dnc", "superseded", { runAgeHours: 120 });
    await leadEvent(b.propertyId, "dispo_set", "user", { from: null, to: "nurture" }, 100);
    expect((await scorecard()).opted_out).toMatchObject({
      runs: "2",
      held: "1",
      held_decided: "1",
      held_agreed: "0",
    });
  });

  it("window, provider, org and outcome filters", async () => {
    await seedRun({ outcome: "opted_out", conf: 0.9, ageHours: 24 * 8 }); // outside 7d
    await seedRun({ outcome: "opted_out", conf: 0.9, ageHours: 24, provider: "legacy" });
    await seedRun({ outcome: "opted_out", conf: 0.9, ageHours: 24, org: otherOrgId });
    await seedRun({ outcome: "dnc", conf: 0.9, ageHours: 24 });
    await seedRun({ outcome: "opted_out", conf: 0.9, ageHours: 24 });
    expect((await scorecard(7)).opted_out.runs).toBe("1");
    expect((await scorecard(30)).opted_out.runs).toBe("2");
    expect((await scorecard(30)).dnc).toBeUndefined();
  });

  it("a run without a numeric native confidence counts but yields no sample", async () => {
    const a = await seedRun({ outcome: "not_interested", conf: null, ageHours: 100 });
    await seedReview(a, "not_interested", "auto_accepted", { runAgeHours: 100 });
    expect((await scorecard()).not_interested).toMatchObject({ runs: "1", auto_settled: "1", samples: [] });
  });

  it("is SECURITY INVOKER: another org's member sees zeros, own org's owner sees data", async () => {
    const a = await seedRun({ outcome: "nurture", conf: 0.95, ageHours: 120 });
    await seedDecision(a, "nurture", "confirmed", "system");
    expect((await scorecard(7, ownerId)).nurture.runs).toBe("1");
    expect((await scorecard(7, outsiderId)).nurture.runs).toBe("0");
  });

  it("is not executable by anon", async () => {
    await db.query("savepoint s");
    await db.query("set local role anon");
    await expect(db.query("select * from public.fn_messages_v2_scorecard($1, 7)", [orgId])).rejects.toThrow(
      /permission denied/,
    );
    await db.query("rollback to savepoint s");
    await db.query("reset role");
  });
});
