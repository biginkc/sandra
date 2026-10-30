import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));

import { PROPERTY_TYPE_OPTIONS, V2_QUESTION_IDS } from "./questions";
import { runRoutingV2Shadow, scheduleRoutingV2Shadow, shadowFailureReason } from "./shadow";

const ON = { routing_v2_flags: { shadow: true }, classifier_provider: "jev", classifier_engine: "nine_questions", classifier_mode: "automatic" };

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
    const { client, calls } = stub((table, op) =>
      table === "ai_responder_configs" ? { data: ON, error: null } : table === "routing_v2_shadow_decisions" && op === "select" ? { data: null, error: null } : { data: [], error: null },
    );
    expect(await runRoutingV2Shadow(client, INPUT, { fetch, typesafeApiKey: "k" })).toBe("decided");
    expect(fetch).toHaveBeenCalledTimes(1);
    const inserts = calls.filter((c) => c.op === "insert");
    expect(inserts.map((c) => c.table)).toEqual(["routing_v2_shadow_decisions"]);
    expect(inserts[0].payload).toMatchObject({ status: "decided", road: "ALERT_call_me", haiku_eligibility: null });
  });

  it("never throws into the live path: Jev failure is logged and swallowed", async () => {
    const fetch = vi.fn(async () => new Response("boom", { status: 401 }));
    const { client, calls } = stub((table, op) =>
      table === "ai_responder_configs" ? { data: ON, error: null } : table === "routing_v2_shadow_decisions" && op === "select" ? { data: null, error: null } : { data: [], error: null },
    );
    expect(await runRoutingV2Shadow(client, INPUT, { fetch, typesafeApiKey: "k" })).toBe("failed");
    expect(calls.find((c) => c.op === "insert")?.payload).toMatchObject({ status: "failed" });
  });

  it.each([
    [() => new Response("echo: homeowner said SECRET", { status: 502 }), "jev_http_502"],
    [() => new Response("echo: homeowner said SECRET", { status: 400 }), "jev_http_400"],
    [() => new Response("not json SECRET", { status: 200 }), "jev_invalid_response"],
    [() => { throw Object.assign(new Error("aborted SECRET"), { name: "AbortError" }); }, "jev_timeout"],
    [() => { throw new TypeError("fetch failed SECRET"); }, "jev_network_error"],
  ])("stores only a sanitized failure category, never raw error text (%#)", async (respond, reason) => {
    const fetch = vi.fn(async () => respond());
    const { client, calls } = stub((table, op) =>
      table === "ai_responder_configs" ? { data: ON, error: null } : table === "routing_v2_shadow_decisions" && op === "select" ? { data: null, error: null } : { data: [], error: null },
    );
    expect(await runRoutingV2Shadow(client, INPUT, { fetch, typesafeApiKey: "k" })).toBe("failed");
    const payload = calls.find((c) => c.op === "insert")?.payload as Record<string, unknown>;
    expect(payload.failure_reason).toBe(reason);
    expect(JSON.stringify(payload)).not.toContain("SECRET");
  });

  it("a database failure is stored as db_error", () => {
    expect(shadowFailureReason(new Error("relation messages SECRET"))).toBe("db_error");
  });

  it("never throws even when the database itself throws", async () => {
    const fetch = vi.fn();
    const { client } = stub(() => new Error("db down"));
    await expect(runRoutingV2Shadow(client, INPUT, { fetch, typesafeApiKey: "k" })).resolves.toBe("off");
    const flagOn = stub((table) => (table === "ai_responder_configs" ? { data: ON, error: null } : new Error("db down")));
    await expect(runRoutingV2Shadow(flagOn.client, INPUT, { fetch, typesafeApiKey: "k" })).resolves.toBe("failed");
  });

  it("an incomplete Jev answer fails closed (no decision)", async () => {
    const answers = jevAnswers();
    delete answers.asked_stop;
    const fetch = vi.fn(async () => new Response(JSON.stringify({ answers }), { status: 200 }));
    const { client, calls } = stub((table, op) =>
      table === "ai_responder_configs" ? { data: ON, error: null } : table === "routing_v2_shadow_decisions" && op === "select" ? { data: null, error: null } : { data: [], error: null },
    );
    expect(await runRoutingV2Shadow(client, INPUT, { fetch, typesafeApiKey: "k" })).toBe("failed");
    const payload = calls.find((c) => c.op === "insert")?.payload as Record<string, unknown>;
    expect(payload.status).toBe("failed");
    expect(String(payload.failure_reason)).toContain("asked_stop");
    expect(payload).not.toHaveProperty("road");
  });

  it("only shadows orgs on the automatic nine-questions engine", async () => {
    const fetch = vi.fn();
    for (const cfg of [
      { ...ON, classifier_mode: "shadow" },
      { ...ON, classifier_engine: "outcome_v1" },
      { ...ON, classifier_provider: "openai" },
    ]) {
      const { client } = stub((table) => (table === "ai_responder_configs" ? { data: cfg, error: null } : { data: null, error: null }));
      expect(await runRoutingV2Shadow(client, INPUT, { fetch, typesafeApiKey: "k" })).toBe("off");
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("skips Jev when a shadow row already exists for this inbound (retry / deferral / redelivery)", async () => {
    const fetch = vi.fn();
    const { client, calls } = stub((table, op) =>
      table === "ai_responder_configs"
        ? { data: ON, error: null }
        : table === "routing_v2_shadow_decisions" && op === "select"
          ? { data: { id: "existing" }, error: null }
          : { data: [], error: null },
    );
    expect(await runRoutingV2Shadow(client, INPUT, { fetch, typesafeApiKey: "k" })).toBe("skipped");
    expect(fetch).not.toHaveBeenCalled();
    expect(calls.filter((c) => c.op === "insert")).toEqual([]);
  });

  it("does not call Jev when the existing-row check itself fails", async () => {
    const fetch = vi.fn();
    const { client } = stub((table, op) =>
      table === "ai_responder_configs" ? { data: ON, error: null } : table === "routing_v2_shadow_decisions" && op === "select" ? { data: null, error: { message: "boom" } } : { data: [], error: null },
    );
    expect(await runRoutingV2Shadow(client, INPUT, { fetch, typesafeApiKey: "k" })).toBe("failed");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("resolves the org from the property when the caller has no org id", async () => {
    const fetch = vi.fn();
    const { client, calls } = stub((table) =>
      table === "properties" ? { data: { org_id: "o2" }, error: null } : { data: { routing_v2_flags: { shadow: false } }, error: null },
    );
    const noOrg = { ...INPUT, orgId: null };
    expect(await runRoutingV2Shadow(client, noOrg, { fetch, typesafeApiKey: "k" })).toBe("off");
    expect(calls.map((c) => c.table)).toEqual(["properties", "ai_responder_configs"]);
  });
});

describe("scheduleRoutingV2Shadow (inline webhook path)", () => {
  it("returns immediately: a hanging shadow never holds the caller", async () => {
    const tasks: Array<() => Promise<void>> = [];
    const neverFetch = vi.fn(() => new Promise<Response>(() => {}));
    const { client } = stub((table, op) =>
      table === "ai_responder_configs" ? { data: ON, error: null } : table === "routing_v2_shadow_decisions" && op === "select" ? { data: null, error: null } : { data: [], error: null },
    );
    const ret = scheduleRoutingV2Shadow(client, INPUT, { fetch: neverFetch, typesafeApiKey: "k" }, (t) => {
      tasks.push(t);
    });
    expect(ret).toBeUndefined();
    expect(tasks).toHaveLength(1); // deferred to after(), not run inline
    expect(neverFetch).not.toHaveBeenCalled();
    void tasks[0](); // runs (and hangs) after the response; nothing awaits it
  });

  it("falls back to a detached run when after() is unavailable, and never throws", () => {
    const { client } = stub(() => new Error("db down"));
    expect(() =>
      scheduleRoutingV2Shadow(client, INPUT, { fetch: vi.fn(), typesafeApiKey: "k" }, () => {
        throw new Error("after() outside request scope");
      }),
    ).not.toThrow();
  });
});
