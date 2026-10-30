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
});
