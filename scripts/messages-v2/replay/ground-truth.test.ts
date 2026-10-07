import { describe, expect, it } from "vitest";

import { PROP, inbound, makeExport } from "./compare-fixtures";
import { deriveGroundTruth } from "./ground-truth";

const M = (n: number) => `0000000${n}-0000-4000-8000-000000000000`;
const AT = "2026-09-10T10:00:00.000Z"; // well over 72h before export
const review = (n: number, o: Record<string, unknown>) => ({ id: `r${n}`, source_inbound_message_id: M(n), disposition: "not_interested", status: "confirmed", corrected_disposition: null, corrected_at: null, ...o });
const set = (to: string, createdAt: string) => ({ property_id: PROP, to_dispo: to, created_at: createdAt });

function truth(humanEvents: Partial<NonNullable<ReturnType<typeof makeExport>["reference"]["humanEvents"]>>, msgs = [1], at = AT) {
  const exp = makeExport({
    inbound: msgs.map((n) => inbound(M(n), "x", at)),
    reference: { pipelineRuns: [], outboundInWindow: [], humanEvents: { runs: [], reviews: [], decisions: [], dispoSets: [], ...humanEvents } },
  });
  return deriveGroundTruth(exp);
}

describe("deriveGroundTruth", () => {
  it("uses the corrected disposition when a human changed it", () => {
    const t = truth({ reviews: [review(1, { corrected_disposition: "wrong_number", corrected_at: AT })] });
    expect(t.get(M(1))).toEqual({ label: "wrong_number", kind: "explicit", source: "review_corrected" });
  });
  it("a confirmed review means the human kept Jev's label", () => {
    expect(truth({ reviews: [review(1, { disposition: "opted_out" })] }).get(M(1))?.label).toBe("opted_out");
  });
  it("a human dispo change within 72h overrides a confirmed review, but nurture -> needs_sequence is not an override", () => {
    const override = truth({ reviews: [review(1, {})], dispoSets: [set("wrong_number", "2026-09-10T20:00:00.000Z")] });
    expect(override.get(M(1))).toMatchObject({ label: "wrong_number", source: "dispo_set_override" });
    const parking = truth({ reviews: [review(1, { disposition: "nurture" })], dispoSets: [set("needs_sequence", "2026-09-10T20:00:00.000Z")] });
    expect(parking.get(M(1))).toMatchObject({ label: "nurture", source: "review_confirmed" });
  });
  it("ignores a dispo change after the 72h window", () => {
    const t = truth({ reviews: [review(1, {})], dispoSets: [set("wrong_number", "2026-09-14T10:00:00.000Z")] });
    expect(t.get(M(1))?.label).toBe("not_interested");
  });
  it("auto-applied and uncorrected is implicit agreement, but only once 72h old", () => {
    const old = truth({ reviews: [review(1, { status: "auto_accepted" })] });
    expect(old.get(M(1))).toMatchObject({ label: "not_interested", kind: "implicit" });
    const fresh = truth({ reviews: [review(1, { status: "auto_accepted" })] }, [1], "2026-10-06T10:00:00.000Z");
    expect(fresh.has(M(1))).toBe(false);
  });
  it("messages with no human decision get no truth (pending review, nothing at all)", () => {
    const t = truth({ reviews: [review(1, { status: "pending" })] }, [1, 2]);
    expect(t.size).toBe(0);
  });
  it("with no Jev review the first human dispo_set is the label; other dispositions become 'other'", () => {
    expect(truth({ dispoSets: [set("not_interested", "2026-09-10T12:00:00.000Z")] }).get(M(1))?.label).toBe("not_interested");
    expect(truth({ dispoSets: [set("callback_requested", "2026-09-10T12:00:00.000Z")] }).get(M(1))?.label).toBe("other");
  });
  it("lead decisions: corrected wins, human-confirmed keeps Jev's label, auto-confirmed is implicit", () => {
    const d = (o: Record<string, unknown>) => ({ id: "d", source_inbound_message_id: M(1), proposed_outcome: "new_lead", status: "confirmed", resolved_outcome: null, auto_resolved: false, ...o });
    expect(truth({ decisions: [d({ status: "corrected", resolved_outcome: "not_interested" })] }).get(M(1))?.label).toBe("not_interested");
    expect(truth({ decisions: [d({})] }).get(M(1))).toMatchObject({ label: "new_lead", kind: "explicit" });
    expect(truth({ decisions: [d({ auto_resolved: true })] }).get(M(1))).toMatchObject({ label: "new_lead", kind: "implicit" });
  });
  it("is empty for an older export without human events", () => {
    const exp = makeExport({ inbound: [inbound(M(1), "x", AT)] });
    delete exp.reference.humanEvents;
    expect(deriveGroundTruth(exp).size).toBe(0);
  });
});
