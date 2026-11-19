import { describe, expect, it } from "vitest";

import { hotHandoffKey, hotTextKey } from "@/lib/hot-sellers/hot";

import { attachHotAlertTimes, hotAlertKeyForRun } from "./hot-alert-times";
import type { LooseSupabase } from "./queries";
import type { PipelineRunStep, RunWithSteps } from "./types";

const assign = (status?: string): PipelineRunStep => ({
  id: "s", run_id: "r", org_id: "o", seq: 1, kind: "action", name: "assign_hot_lead", result: "applied",
  detail: status ? { status } : {}, created_at: "",
});
const run = (id: string, inbound: string, status?: string): RunWithSteps => ({
  id, org_id: "o", inbound_message_id: inbound, property_id: "prop-1", contact_id: null, conversation_id: null,
  status: "closed", mode: "automatic", final_outcome: null, reason: null, classification_run_id: null, claim_id: null,
  outbound_message_id: null, inbound_preview: "x", started_at: "", completed_at: null, steps: [assign(status)],
});

function fakeDb(rows: Array<{ hold_key: string; channel: string; sent_at: string }>): LooseSupabase {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  chain.select = self; chain.eq = self;
  chain.in = async (_c: string, keys: string[]) => ({ data: rows.filter((r) => keys.includes(r.hold_key)), error: null });
  return { from: () => chain } as unknown as LooseSupabase;
}

describe("hot alert keys and times", () => {
  it("keys: a hand-off run is keyed hot_handoff:<inbound>, an already_owned run hot_text:<inbound>, rep-owned or no inbound -> none", () => {
    expect(hotAlertKeyForRun(run("a", "m1"))).toBe(hotHandoffKey("m1"));
    expect(hotAlertKeyForRun({ ...run("d", "m4"), inbound_message_id: null } as never)).toBeNull();
    expect(hotAlertKeyForRun(run("b", "m2", "already_owned"))).toBe(hotTextKey("m2"));
    expect(hotAlertKeyForRun(run("c", "m3", "owned_by_someone_else"))).toBeNull();
  });

  it("a later already_owned run never shows the original hand-off time", async () => {
    const db = fakeDb([
      { hold_key: hotHandoffKey("m1"), channel: "slack", sent_at: "2026-10-15T10:00:00Z" },
      { hold_key: hotHandoffKey("m1"), channel: "sms", sent_at: "2026-10-15T10:00:05Z" },
    ]);
    const out = await attachHotAlertTimes(db, "o", [run("first", "m1"), run("later", "m2", "already_owned")]);
    expect(out[0]!.hotAlertSentAt).toBe("2026-10-15T10:00:05Z");
    expect(out[1]!.hotAlertSentAt ?? null).toBeNull();
  });

  it("the already_owned run shows its own time once both of ITS alerts are sent", async () => {
    const db = fakeDb([
      { hold_key: hotTextKey("m2"), channel: "slack", sent_at: "2026-10-15T12:00:00Z" },
      { hold_key: hotTextKey("m2"), channel: "sms", sent_at: "2026-10-15T12:00:03Z" },
    ]);
    const out = await attachHotAlertTimes(db, "o", [run("later", "m2", "already_owned")]);
    expect(out[0]!.hotAlertSentAt).toBe("2026-10-15T12:00:03Z");
  });
});
