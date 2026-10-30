import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));

import { PROPERTY_TYPE_OPTIONS, V2_QUESTION_IDS } from "./questions";
import { runRoutingV2Shadow } from "./shadow";

type Call = { table: string; op: string; payload?: unknown };

/** Minimal chainable Supabase stub: every query resolves to `respond(table)`. */
function stub(respond: (table: string, op: string) => { data: unknown; error: unknown } | Error) {
  const calls: Call[] = [];
  const client = {
    from(table: string) {
      let op = "select";
      let payload: unknown;
      const result = () => {
        calls.push({ table, op, payload });
        const r = respond(table, op);
        return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
      };
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "neq", "lte", "order", "limit"]) q[m] = () => q;
      q.maybeSingle = result;
      q.insert = (p: unknown) => { op = "insert"; payload = p; return result(); };
      q.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => result().then(ok, bad);
      return q;
    },
  };
  return { client: client as never, calls };
}

const INPUT = { orgId: "o", propertyId: "p", contactId: "c", conversationId: "cv", inboundMessageId: "m", inboundBody: "Call me tomorrow" };

function jevAnswers(overrides: Record<string, number> = {}) {
  const answers: Record<string, unknown> = {};
  for (const id of V2_QUESTION_IDS) answers[id] = { choice: "x", noul: overrides[id] ?? 0.02 };
  answers.property_type = { choice: "didnt_say", probabilities: Object.fromEntries(PROPERTY_TYPE_OPTIONS.map((o) => [o, o === "didnt_say" ? 0.9 : 0.02])) };
  return answers;
}

describe("routing v2 shadow hook", () => {
  it("is a no-op when the flag is off: no Jev call, no write", async () => {
    const fetch = vi.fn();
    const { client, calls } = stub(() => ({ data: { routing_v2_flags: { shadow: false } }, error: null }));
    expect(await runRoutingV2Shadow(client, INPUT, { fetch, typesafeApiKey: "k" })).toBe("off");
    expect(fetch).not.toHaveBeenCalled();
    expect(calls.filter((c) => c.op === "insert")).toEqual([]);
  });

  it("is off when the column does not exist yet", async () => {
    const fetch = vi.fn();
    const { client } = stub(() => ({ data: null, error: { message: "column routing_v2_flags does not exist" } }));
    expect(await runRoutingV2Shadow(client, INPUT, { fetch, typesafeApiKey: "k" })).toBe("off");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("writes the v2 decision to the shadow log only", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ answers: jevAnswers({ asked_call: 0.9 }), model: "jev" }), { status: 200 }));
    const { client, calls } = stub((table) =>
      table === "ai_responder_configs" ? { data: { routing_v2_flags: { shadow: true } }, error: null } : { data: [], error: null },
    );
    expect(await runRoutingV2Shadow(client, INPUT, { fetch, typesafeApiKey: "k" })).toBe("decided");
    expect(fetch).toHaveBeenCalledTimes(1);
    const inserts = calls.filter((c) => c.op === "insert");
    expect(inserts.map((c) => c.table)).toEqual(["routing_v2_shadow_decisions"]);
    expect(inserts[0].payload).toMatchObject({ status: "decided", road: "ALERT_call_me", haiku_eligibility: null });
  });

  it("never throws into the live path: Jev failure is logged and swallowed", async () => {
    const fetch = vi.fn(async () => new Response("boom", { status: 401 }));
    const { client, calls } = stub((table) =>
      table === "ai_responder_configs" ? { data: { routing_v2_flags: { shadow: true } }, error: null } : { data: [], error: null },
    );
    expect(await runRoutingV2Shadow(client, INPUT, { fetch, typesafeApiKey: "k" })).toBe("failed");
    expect(calls.find((c) => c.op === "insert")?.payload).toMatchObject({ status: "failed" });
  });

  it("never throws even when the database itself throws", async () => {
    const fetch = vi.fn();
    const { client } = stub(() => new Error("db down"));
    await expect(runRoutingV2Shadow(client, INPUT, { fetch, typesafeApiKey: "k" })).resolves.toBe("off");
    const flagOn = stub((table) => (table === "ai_responder_configs" ? { data: { routing_v2_flags: { shadow: true } }, error: null } : new Error("db down")));
    await expect(runRoutingV2Shadow(flagOn.client, INPUT, { fetch, typesafeApiKey: "k" })).resolves.toBe("failed");
  });

  it("an incomplete Jev answer fails closed (no decision)", async () => {
    const answers = jevAnswers();
    delete answers.asked_stop;
    const fetch = vi.fn(async () => new Response(JSON.stringify({ answers }), { status: 200 }));
    const { client, calls } = stub((table) =>
      table === "ai_responder_configs" ? { data: { routing_v2_flags: { shadow: true } }, error: null } : { data: [], error: null },
    );
    expect(await runRoutingV2Shadow(client, INPUT, { fetch, typesafeApiKey: "k" })).toBe("failed");
    const payload = calls.find((c) => c.op === "insert")?.payload as Record<string, unknown>;
    expect(payload.status).toBe("failed");
    expect(String(payload.failure_reason)).toContain("asked_stop");
    expect(payload).not.toHaveProperty("road");
  });

  describe("PR-D Haiku (flags.haiku)", () => {
    const on = (haiku: boolean) =>
      stub((table) =>
        table === "ai_responder_configs" ? { data: { routing_v2_flags: { shadow: true, haiku } }, error: null } : { data: [], error: null },
      );
    const jev = (over: Record<string, number>) => new Response(JSON.stringify({ answers: jevAnswers(over), model: "jev" }), { status: 200 });
    const haikuMsg = (text: string) =>
      new Response(JSON.stringify({ content: [{ type: "text", text }], usage: { input_tokens: 900, output_tokens: 15 } }), { status: 200 });
    const deps = (fetch: unknown) => ({ fetch: fetch as never, typesafeApiKey: "k", anthropicApiKey: "a", haikuSleep: async () => {} });

    it("flag off: an eligible decision does not call Haiku and writes no haiku column", async () => {
      const fetch = vi.fn().mockResolvedValueOnce(jev({ asked_stop: 0.65 }));
      const { client, calls } = on(false);
      expect(await runRoutingV2Shadow(client, INPUT, deps(fetch))).toBe("decided");
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(calls.find((c) => c.op === "insert")?.payload).not.toHaveProperty("haiku");
    });

    it("flag on + eligible: records Haiku's pick and the held stop alert, record only", async () => {
      const fetch = vi.fn().mockResolvedValueOnce(jev({ asked_stop: 0.65 })).mockResolvedValueOnce(haikuMsg('{"road":"asked_stop","confidence":0.9}'));
      const { client, calls } = on(true);
      expect(await runRoutingV2Shadow(client, INPUT, deps(fetch))).toBe("decided");
      expect(fetch).toHaveBeenCalledTimes(2);
      const inserts = calls.filter((c) => c.op === "insert");
      expect(inserts.map((c) => c.table)).toEqual(["routing_v2_shadow_decisions"]);
      expect(inserts[0].payload).toMatchObject({
        road: "stop",
        haiku_eligibility: "decider_band",
        haiku: { asked: true, option: "asked_stop", confidence: 0.9, input_tokens: 900, output_tokens: 15, final_road: "stop", final_by: "haiku", hold: true, alert: "Possible stop request — please check" },
      });
      const body = JSON.parse(String((fetch.mock.calls[1] as unknown as [string, RequestInit])[1].body));
      expect(body.messages[0].content).toContain("SELLER: Call me tomorrow");
    });

    it("flag on + Haiku failure: records the failure reason and escalation, still decided", async () => {
      const fetch = vi.fn().mockResolvedValueOnce(jev({})).mockResolvedValue(new Response("x", { status: 500 }));
      const { client, calls } = on(true);
      expect(await runRoutingV2Shadow(client, INPUT, deps(fetch))).toBe("decided");
      expect(calls.find((c) => c.op === "insert")?.payload).toMatchObject({
        haiku: { asked: true, failure_reason: "haiku_invalid:http_500", attempts: 2, final_road: null, final_by: "haiku_failed", hold: true, alert: "Haiku error — please check" },
      });
    });

    it("flag on + confident Jev answer: no Haiku call", async () => {
      const fetch = vi.fn().mockResolvedValueOnce(jev({ asked_who: 0.91, inbound_call: 0.51 }));
      const { client, calls } = on(true);
      expect(await runRoutingV2Shadow(client, INPUT, deps(fetch))).toBe("decided");
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(calls.find((c) => c.op === "insert")?.payload).toMatchObject({ road: "who_reply_drip", haiku: { asked: false, final_road: "who_reply_drip" } });
    });
  });
});
