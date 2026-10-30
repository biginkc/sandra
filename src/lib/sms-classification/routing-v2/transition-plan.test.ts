import { describe, expect, it } from "vitest";
import { compileV2Transition, V2_SEQUENCE_KEYS } from "./transition-plan";
import { ALL_OFF } from "./flags";
import { hotTextKey } from "@/lib/hot-sellers/hot";
const input = { propertyId: "11111111-1111-4111-8111-111111111111", contactId: "contact", inboundMessageId: "inbound",
  flags: { ...ALL_OFF, questions_live: true, replies: true, drips: true, canaryPercent: 100 } };
describe("atomic v2 transition intent", () => {
  it("puts the reply and drip in one transaction plan", () => {
    const plan = compileV2Transition({ road: "who_reply_drip", steps: [{ kind: "reply", key: "identity" }, { kind: "drip", drip: "Asked who is texting", skipFirstStep: true }] }, input);
    expect(plan).toMatchObject({ sequence_key: "asked_who", skip_first_step: true, outbox: [{ kind: "reply", payload: { key: "identity" } }] });
    expect(Object.keys(V2_SEQUENCE_KEYS)).toHaveLength(9);
  });
  it("drips-off keeps a yes alert even with time-only selected", () => {
    const action = { road: "book_appointment" as const, steps: [{ kind: "alert" as const, reason: "hot_yes" as const, whenTimeOnlyOff: true as const }, { kind: "drip" as const, drip: "Book appointment" as const }] };
    const plan = compileV2Transition(action, { ...input, flags: { ...input.flags, drips: false, alert_on_time_only: true } });
    expect(plan.sequence_key).toBeNull();
    expect(plan.outbox[0]?.payload.dedupe_key).toBe(hotTextKey("inbound"));
    expect(compileV2Transition(action, { ...input, flags: { ...input.flags, alert_on_time_only: true } }).outbox[0]?.payload.when_time_only_off).toBe(true);
  });
  it("dedupes hot and call alerts on their shared delivery identity", () => {
    expect(compileV2Transition({ road: "ALERT_call_me", steps: [{ kind: "alert", reason: "call_me" }, { kind: "alert", reason: "hot_yes" }] }, input).outbox).toHaveLength(1);
  });
  it("replies-off produces no reply or phone-close effect", () => {
    const plan = compileV2Transition({ road: "wrong_number_close", steps: [{ kind: "reply", key: "wrong_number" }, { kind: "wrong_number_close" }] }, { ...input, flags: { ...input.flags, replies: false } });
    expect(plan).toMatchObject({ outbox: [], hold_reason: null, wrong_number_close: false });
  });
  it("replies-off never silently drops an owner alert or hold (N1): the caller must hold for a person", () => {
    const off = { ...input, flags: { ...input.flags, replies: false } };
    expect(() => compileV2Transition({ road: "possible_stop", steps: [{ kind: "hold", reason: "asked_stop" }, { kind: "alert", reason: "possible_stop" }] }, off)).toThrow("alert_needs_replies_slice");
    expect(() => compileV2Transition({ road: "ALERT_call_me", steps: [{ kind: "alert", reason: "call_me" }, { kind: "stop_drip", whenTimeOnlyOn: true }] }, { ...off, flags: { ...off.flags, alert_on_time_only: true } })).toThrow("alert_needs_replies_slice");
  });
  it("rejects hold+send and multiple drips instead of silently losing an effect", () => {
    expect(() => compileV2Transition({ road: "stop", steps: [{ kind: "hold", reason: "asked_stop" }, { kind: "reply", key: "said_yes" }] }, input)).toThrow("hold_has_automatic_send");
    expect(() => compileV2Transition({ road: "book_appointment", steps: [{ kind: "drip", drip: "Book appointment" }, { kind: "drip", drip: "Maybe later" }] }, input)).toThrow("multiple_drips");
  });
});
