import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { isHotHold, isKnownHoldReason, parseHotHoldReasons } from "./holds";
import type { OpenHold, PipelineRun } from "@/app/(dashboard)/messages-v2/types";

const root = join(__dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

/** Every reason literal the responder / inbound pipeline writes as a flag or run reason. */
function emittedReasons(source: string): string[] {
  const out = new Set<string>();
  const literal = /(?:\breason\s*=|\breason:|\bflagReason:)\s*"([a-z][a-z0-9_:]*)"/g;
  for (const m of source.matchAll(literal)) out.add(m[1]!);
  // Template reasons: the fixed prefix before `${` is what must be recognised.
  const template = /(?:\breason\s*=|\breason:|\bflagReason:)\s*`([a-z][a-z0-9_:]*:)\$\{/g;
  for (const m of source.matchAll(template)) out.add(`${m[1]}x`);
  // Third argument of markPropertyNeedsAttention(supabase, id, "literal"...).
  const flagCall = /markPropertyNeedsAttention\(\s*[\w.]+,\s*[\w.]+,\s*"([a-z][a-z0-9_:]*)"/g;
  for (const m of source.matchAll(flagCall)) out.add(m[1]!);
  return [...out];
}

describe("isKnownHoldReason", () => {
  it("accepts the reasons named in the review", () => {
    for (const v of [
      "rep_sms_human_takeover",
      "send_timeout_unparseable",
      "generate_error",
      "provider_billing",
      "provider_auth",
      "dead_letter_failed:send_timeout:abc",
      "dead_letter_failed:send_timeout:abc:backed",
      "send_timeout:abc:backed",
      "escalated",
      "jev_below_threshold:new_lead",
    ]) {
      expect(isKnownHoldReason(v), v).toBe(true);
    }
  });
  it("rejects unknown, empty-tail and bare-suffix values", () => {
    for (const v of ["made_up", "dead_letter_failed:", ":backed", "PRICE_OR_OFFER", "keyword: x", "price quoted"]) {
      expect(isKnownHoldReason(v), v).toBe(false);
    }
  });
  it("accepts every reason literal the code emits", () => {
    const emitted = [
      ...emittedReasons(read("src/lib/ai-responder/dispatch.ts")),
      ...emittedReasons(read("src/lib/messaging/inbound.ts")),
      ...emittedReasons(read("src/lib/ai-responder/retry.ts")),
    ];
    expect(emitted.length).toBeGreaterThan(20);
    const unknown = emitted.filter((r) => !isKnownHoldReason(r));
    expect(unknown).toEqual([]);
  });
});

describe("wildcard hot entries", () => {
  const hold = (flag_reason: string) => ({ flag_reason, sources: ["needs_attention"] }) as unknown as OpenHold<PipelineRun>;
  it("accepts prefix and :backed suffix wildcards, rejects others", () => {
    const warn = () => {};
    expect(parseHotHoldReasons({ HOLD_ALERT_HOT_REASONS: "dead_letter_failed:*,*:backed,foo:*,*bar,a*b" }, warn)).toEqual([
      "dead_letter_failed:*",
      "*:backed",
    ]);
  });
  it("matches by prefix and suffix, not substring", () => {
    const hot = ["dead_letter_failed:*", "*:backed"];
    expect(isHotHold(hold("dead_letter_failed:send_timeout:1"), hot)).toBe(true);
    expect(isHotHold(hold("send_timeout:1:backed"), hot)).toBe(true);
    expect(isHotHold(hold("x_dead_letter_failed:y"), hot)).toBe(false);
    expect(isHotHold(hold("send_timeout:1"), hot)).toBe(false);
  });
});
