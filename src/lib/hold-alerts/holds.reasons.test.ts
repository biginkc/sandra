import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { isKnownHoldReason } from "./holds";

const root = join(__dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

/** Every reason literal the responder / inbound pipeline writes as a flag or run reason. */
function emittedReasons(source: string): string[] {
  const out = new Set<string>();
  // `nine_questions:<answer>` is the run OUTCOME reason (and the review's ai_reason), never a
  // hold: it is written beside `outcome: "auto_closed"` / to the disposition review. Leave it out.
  source = source.replace(/"nine_questions:[a-z_]*"|`nine_questions:\$\{[^`]*\}`/g, '""');
  const literal = /(?:\breason\s*=|\breason:|\bflagReason:)\s*"([a-z][a-z0-9_:]*)"/g;
  for (const m of source.matchAll(literal)) out.add(m[1]!);
  // Template reasons: the fixed prefix before `${` is what must be recognised.
  const template = /(?:\breason\s*=|\breason:|\bflagReason:)\s*`([a-z][a-z0-9_:]*:)\$\{/g;
  for (const m of source.matchAll(template)) out.add(`${m[1]}x`);
  // Third argument of markPropertyNeedsAttention(supabase, id, "literal"...).
  const flagCall = /markPropertyNeedsAttention\(\s*[\w.]+,\s*[\w.]+,\s*"([a-z][a-z0-9_:]*)"/g;
  for (const m of source.matchAll(flagCall)) out.add(m[1]!);
  // Reasons handed to the nine-question engine's hold helper: nineHoldAndComplete(supabase, a, <reason>).
  const nineHold = /nineHoldAndComplete\(\s*[\w.]+,\s*[\w.]+,\s*(?:"([a-z][a-z0-9_:]*)"|`([a-z][a-z0-9_:]*)\$\{)/g;
  for (const m of source.matchAll(nineHold)) out.add(m[1] ?? `${m[2]}x`);
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

describe("needs-confirm hold reasons (no automated DNC decisions)", () => {
  it("registers every HOLD_* constant dispatch.ts exports", () => {
    const src = read("src/lib/ai-responder/dispatch.ts");
    const consts = [...src.matchAll(/export const HOLD_[A-Z_]+ = "([a-z_]+)";/g)].map((m) => m[1]!);
    expect(consts.sort()).toEqual([
      "jev_dnc_needs_confirm",
      "jev_opted_out_needs_confirm",
      "jev_wrong_number_all_needs_confirm",
      "model_dnc_needs_confirm",
      "model_opt_out_needs_confirm",
    ]);
    for (const c of consts) expect(isKnownHoldReason(c), c).toBe(true);
  });
});
