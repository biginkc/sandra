import { describe, expect, it } from "vitest";

import { ALL_OFF } from "@/lib/sms-classification/routing-v2/flags";

import { ArgError, guardTarget, isLocalSupabaseUrl, last4, parseArgs } from "./args";
import { BackfillItemError, BackfillRefusal, backfillPriorKind, backfillRecorderPresent, checkFlags, errorCode, keywordHoldLikely, treatmentFor, wouldDo } from "./run";
import { adminClientTargetUrl } from "@/lib/supabase/admin";

const ORG = "00000000-0000-0000-0000-000000000bbb";
const on = { ...ALL_OFF, questions_live: true, replies: true, drips: true };

describe("args + production guard", () => {
  it("defaults: dry-run, 60 days, full treatment up to 14 days, 60/min", () => {
    expect(parseArgs(["--org", ORG])).toMatchObject({ mode: "dry_run", maxAgeDays: 60, textMaxAgeDays: 14, ratePerMinute: 60, forceFlags: false });
  });
  it("one mode only, a valid org, bounded ages", () => {
    expect(() => parseArgs(["--org", ORG, "--apply", "--classify-only"])).toThrow(ArgError);
    expect(() => parseArgs(["--org", "nope"])).toThrow(ArgError);
    expect(() => parseArgs(["--org", ORG, "--max-age-days", "90"])).toThrow(ArgError);
    expect(() => parseArgs(["--org", ORG, "--max-age-days", "10", "--text-max-age-days", "14"])).toThrow(ArgError);
    expect(parseArgs(["--org", ORG, "--apply", "--limit", "50", "--resume", "bf-abc"])).toMatchObject({ mode: "apply", limit: 50, runId: "bf-abc", resume: true });
  });
  it("refuses a non-local Supabase unless --i-know-this-is-prod AND a run id", () => {
    const prodUrl = "https://copflsklaefwzipsrjqz.supabase.co";
    expect(() => guardTarget(parseArgs(["--org", ORG]), prodUrl, "2026-10-31T00:00:00Z")).toThrow(/i-know-this-is-prod/);
    expect(() => guardTarget(parseArgs(["--org", ORG, "--i-know-this-is-prod"]), prodUrl, "2026-10-31T00:00:00Z")).toThrow(/run-id/);
    expect(guardTarget(parseArgs(["--org", ORG, "--i-know-this-is-prod", "--run-id", "bf-prod-1"]), prodUrl, "x")).toEqual({ runId: "bf-prod-1", prod: true });
    expect(() => guardTarget(parseArgs(["--org", ORG]), undefined, "x")).toThrow(/i-know-this-is-prod/);
    expect(guardTarget(parseArgs(["--org", ORG]), "http://127.0.0.1:56831", "2026-10-31T12:34:56Z")).toEqual({ runId: "bf-20261031123456", prod: false });
  });
  it("only loopback counts as local; phones print as last 4", () => {
    expect(isLocalSupabaseUrl("http://localhost:54321")).toBe(true);
    expect(isLocalSupabaseUrl("http://127.0.0.1.evil.com")).toBe(false);
    expect(last4("+1 (816) 555-0142")).toBe("…0142");
  });
});

describe("texting cutoff guard, claim names, error codes", () => {
  it("--text-max-age-days above 14 needs --i-know-this-widens-texting", () => {
    expect(() => parseArgs(["--org", ORG, "--text-max-age-days", "20"])).toThrow(/widens-texting/);
    expect(parseArgs(["--org", ORG, "--text-max-age-days", "20", "--i-know-this-widens-texting"]).textMaxAgeDays).toBe(20);
    expect(parseArgs(["--org", ORG, "--text-max-age-days", "7"]).textMaxAgeDays).toBe(7);
  });
  it("the moved-aside claim name is unique per claim row (one run id, many modes / resumes)", () => {
    expect(backfillPriorKind("bf-1", "c1")).toBe("sms_ai_responder_v1:backfill_prior:bf-1:c1");
    expect(backfillPriorKind("bf-1", "c1")).not.toBe(backfillPriorKind("bf-1", "c2"));
  });
  it("error codes are a closed mapping: no raw error text ever passes through", () => {
    expect(errorCode(new Error("Key (x)=(abc) already exists"))).toBe("unexpected_error");
    expect(errorCode(new Error("Jane Doe <jane@example.com> said hi"))).toBe("unexpected_error");
    expect(errorCode(new BackfillItemError("claim_in_progress"))).toBe("claim_in_progress");
  });
  it("--rate is capped at 60 per minute", () => {
    expect(() => parseArgs(["--org", ORG, "--rate", "61"])).toThrow(/at most 60/);
    expect(parseArgs(["--org", ORG, "--rate", "30"]).ratePerMinute).toBe(30);
  });
  it("the guard checks the URL the admin client really uses (a hosted TEST url under VITEST is prod)", () => {
    const saved = { t: process.env.TEST_SUPABASE_URL, p: process.env.NEXT_PUBLIC_SUPABASE_URL };
    try {
      process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
      process.env.TEST_SUPABASE_URL = "https://example-staging.supabase.co";
      const target = adminClientTargetUrl();
      expect(target).toBe("https://example-staging.supabase.co");
      expect(() => guardTarget(parseArgs(["--org", ORG]), target, "x")).toThrow(/i-know-this-is-prod/);
    } finally {
      if (saved.t === undefined) delete process.env.TEST_SUPABASE_URL; else process.env.TEST_SUPABASE_URL = saved.t;
      if (saved.p === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL; else process.env.NEXT_PUBLIC_SUPABASE_URL = saved.p;
    }
  });
});

describe("flags gate", () => {
  it("dry-run never refuses", () => expect(checkFlags({ flags: ALL_OFF, engineOk: false }, "dry_run", false).refuse).toBeNull());
  it("questions_live off or wrong engine is never forceable (the dispatch would run today's engine)", () => {
    expect(checkFlags({ flags: ALL_OFF, engineOk: true }, "apply", true).refuse).toMatch(/questions_live/);
    expect(checkFlags({ flags: on, engineOk: false }, "classify_only", true).refuse).toMatch(/nine_questions/);
  });
  it("replies / drips off: refused unless --force-flags, which is logged", () => {
    const off = { flags: { ...on, drips: false }, engineOk: true };
    expect(checkFlags(off, "apply", false).refuse).toMatch(/drips off/);
    expect(checkFlags(off, "apply", true)).toEqual({ refuse: null, warnings: [expect.stringMatching(/force-flags.*drips/)] });
    expect(checkFlags({ flags: on, engineOk: true }, "apply", false)).toEqual({ refuse: null, warnings: [] });
  });
});

describe("age split (Jarrad 2026-10-31)", () => {
  it("<= 14 whole days = full treatment; older = sort only", () => {
    expect(treatmentFor(0, 14)).toBe("full");
    expect(treatmentFor(14.9, 14)).toBe("full");
    expect(treatmentFor(15, 14)).toBe("sort_only");
    expect(treatmentFor(59, 14)).toBe("sort_only");
    expect(treatmentFor(3, 2)).toBe("sort_only");
  });

  type Step = { kind: string; reason?: string; whenTimeOnlyOff?: boolean };
  const dec = (road: string, steps: Step[], status = "decided") => ({ status, road, failure_reason: null, action: { road, steps } });
  const HOT_YES: Step = { kind: "alert", reason: "hot_yes", whenTimeOnlyOff: true };
  // Shapes from actions.ts: the yes roads carry ONLY the time-only hot alert.
  const book = dec("book_appointment", [HOT_YES, { kind: "reply" }, { kind: "drip" }]);
  const reactionBook = dec("reaction+book_appointment", [HOT_YES, { kind: "drip" }]);
  const driving = dec("driving_reply+book_appointment", [HOT_YES, { kind: "reply" }, { kind: "drip" }]);

  it("sort-only never replies or drips; hot roads hold; closes close (time-only off: yes roads alert)", () => {
    expect(wouldDo(book, "full", false)).toMatchObject({ wouldReply: true, wouldDrip: true, wouldAlert: true, wouldHold: false });
    expect(wouldDo(book, "sort_only", false)).toEqual({ wouldReply: false, wouldDrip: false, wouldAlert: true, wouldHold: true, wouldClose: false });
    expect(wouldDo(dec("wrong_number_close", [{ kind: "wrong_number_close" }]), "sort_only", true)).toMatchObject({ wouldReply: false, wouldClose: true, wouldHold: false });
    expect(wouldDo(dec("not_interested_drip", [{ kind: "reply" }, { kind: "drip" }]), "sort_only", true)).toMatchObject({ wouldReply: false, wouldDrip: false, wouldClose: true });
    expect(wouldDo(dec("maybe_later_drip", [{ kind: "reply" }, { kind: "drip" }]), "sort_only", true)).toEqual({ wouldReply: false, wouldDrip: false, wouldAlert: false, wouldHold: false, wouldClose: false });
    expect(wouldDo(dec("stop", [{ kind: "hold" }]), "sort_only", true)).toMatchObject({ wouldHold: true, wouldReply: false });
    // Price too high has no alert of its own live; sort-only adds "Named a price" (never time-only).
    expect(wouldDo(dec("price_check", [{ kind: "reply" }]), "sort_only", true)).toMatchObject({ wouldHold: true, wouldReply: false, wouldAlert: true });
    expect(wouldDo(dec("price_check", [{ kind: "reply" }, { kind: "alert", reason: "named_price" }]), "full", true)).toMatchObject({ wouldReply: true, wouldAlert: true });
  });

  it("alert only when a time is picked: the yes roads' hot alert is not projected while it is in force", () => {
    for (const d of [book, reactionBook, driving]) {
      expect(wouldDo(d, "sort_only", true)).toEqual({ wouldReply: false, wouldDrip: false, wouldAlert: false, wouldHold: true, wouldClose: false });
      expect(wouldDo(d, "sort_only", false)).toMatchObject({ wouldAlert: true, wouldHold: true });
    }
    expect(wouldDo(book, "full", true)).toEqual({ wouldReply: true, wouldDrip: true, wouldAlert: false, wouldHold: false, wouldClose: false });
    expect(wouldDo(reactionBook, "full", true)).toMatchObject({ wouldDrip: true, wouldAlert: false });
    expect(wouldDo(reactionBook, "full", false)).toMatchObject({ wouldDrip: true, wouldAlert: true });
    // A road with a non-time-only alert still alerts when time-only is in force.
    const callMe = dec("ALERT_call_me", [{ kind: "alert", reason: "call_me" }]);
    expect(wouldDo(callMe, "full", true)).toMatchObject({ wouldAlert: true });
    expect(wouldDo(callMe, "sort_only", true)).toMatchObject({ wouldAlert: true, wouldHold: true });
    // Mixed steps: the plain alert still goes.
    expect(wouldDo(dec("book_appointment", [HOT_YES, { kind: "alert", reason: "x" }]), "full", true)).toMatchObject({ wouldAlert: true });
  });

  it("full treatment: the driving reply never goes to an old text (holds with its alerts instead)", () => {
    expect(wouldDo(driving, "full", false)).toEqual({ wouldReply: false, wouldDrip: false, wouldAlert: true, wouldHold: true, wouldClose: false });
    expect(wouldDo(driving, "full", true)).toEqual({ wouldReply: false, wouldDrip: false, wouldAlert: false, wouldHold: true, wouldClose: false });
  });
});

describe("classify-only keyword pre-check", () => {
  it("names texts the up-front keyword hold would catch; a price-only text is not one", () => {
    expect(keywordHoldLikely("My mother died last week", null)).toBe(true);
    expect(keywordHoldLikely("Sounds good, call me tomorrow", null)).toBe(false);
  });
});

describe("apply preflight: the backfill recorder migration must be applied", () => {
  const db = (result: { data: unknown; error: { code?: string; message: string } | null }) => ({ rpc: async () => result });
  it("present: the empty probe returns newer_inbound", async () => {
    expect(await backfillRecorderPresent(db({ data: "newer_inbound", error: null }))).toBe(true);
  });
  it("absent: function-not-found means refuse --apply", async () => {
    expect(await backfillRecorderPresent(db({ data: null, error: { code: "PGRST202", message: "Could not find the function public.routing_v2_backfill_record_live_decision" } }))).toBe(false);
    expect(await backfillRecorderPresent(db({ data: null, error: { code: "42883", message: "function does not exist" } }))).toBe(false);
  });
  it("any other error: refuse to guess", async () => {
    await expect(backfillRecorderPresent(db({ data: null, error: { code: "08006", message: "connection failure" } }))).rejects.toBeInstanceOf(BackfillRefusal);
  });
});
