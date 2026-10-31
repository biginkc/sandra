import { describe, expect, it } from "vitest";

import { ALL_OFF } from "@/lib/sms-classification/routing-v2/flags";

import { ArgError, guardTarget, isLocalSupabaseUrl, last4, parseArgs } from "./args";
import { checkFlags, keywordHoldLikely, treatmentFor, wouldDo } from "./run";

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

  const dec = (road: string, steps: Array<{ kind: string }>, status = "decided") => ({ status, road, failure_reason: null, action: { road, steps } });
  const book = dec("book_appointment", [{ kind: "alert" }, { kind: "reply" }, { kind: "drip" }]);

  it("sort-only never replies or drips; hot roads alert + hold; closes close", () => {
    expect(wouldDo(book, "full")).toMatchObject({ wouldReply: true, wouldDrip: true, wouldAlert: true, wouldHold: false });
    expect(wouldDo(book, "sort_only")).toEqual({ wouldReply: false, wouldDrip: false, wouldAlert: true, wouldHold: true, wouldClose: false });
    expect(wouldDo(dec("wrong_number_close", [{ kind: "wrong_number_close" }]), "sort_only")).toMatchObject({ wouldReply: false, wouldClose: true, wouldHold: false });
    expect(wouldDo(dec("not_interested_drip", [{ kind: "reply" }, { kind: "drip" }]), "sort_only")).toMatchObject({ wouldReply: false, wouldDrip: false, wouldClose: true });
    expect(wouldDo(dec("maybe_later_drip", [{ kind: "reply" }, { kind: "drip" }]), "sort_only")).toEqual({ wouldReply: false, wouldDrip: false, wouldAlert: false, wouldHold: false, wouldClose: false });
    expect(wouldDo(dec("stop", [{ kind: "hold" }]), "sort_only")).toMatchObject({ wouldHold: true, wouldReply: false });
    expect(wouldDo(dec("price_check", [{ kind: "reply" }]), "sort_only")).toMatchObject({ wouldHold: true, wouldReply: false });
  });

  it("full treatment: the driving reply never goes to an old text (holds with its alerts instead)", () => {
    const driving = dec("driving_reply+book_appointment", [{ kind: "alert" }, { kind: "reply" }, { kind: "drip" }]);
    expect(wouldDo(driving, "full")).toEqual({ wouldReply: false, wouldDrip: false, wouldAlert: true, wouldHold: true, wouldClose: false });
  });
});

describe("classify-only keyword pre-check", () => {
  it("names texts the up-front keyword hold would catch; a price-only text is not one", () => {
    expect(keywordHoldLikely("My mother died last week", null)).toBe(true);
    expect(keywordHoldLikely("Sounds good, call me tomorrow", null)).toBe(false);
  });
});
