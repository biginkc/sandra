import { afterEach, describe, expect, it, vi } from "vitest";

const { reportError } = vi.hoisted(() => ({ reportError: vi.fn() }));
vi.mock("@/lib/errors/report", () => ({ reportError }));

import {
  finishRun,
  recordStep,
  resumeRun,
  sanitizeStepDetail,
  startRun,
  updateRun,
} from "./record";

type Call = { table: string; op: string; payload?: unknown; filter?: unknown };

function fakeAdmin(opts: {
  insertError?: { code?: string; message: string };
  insertRow?: { id: string; org_id: string } | null;
  existingRun?: { id: string; org_id: string } | null;
  maxSeq?: number | null;
  stepError?: { message: string };
  throwOn?: string;
  heldStep?: boolean;
} = {}) {
  const calls: Call[] = [];
  const admin = {
    from(table: string) {
      const builder: Record<string, unknown> = {};
      let op = "";
      let payload: unknown;
      const filters: unknown[] = [];
      const done = () => {
        calls.push({ table, op, payload, filter: filters });
      };
      builder.insert = (p: unknown) => {
        op = "insert";
        payload = p;
        if (opts.throwOn === "insert") throw new Error("boom");
        if (table === "pipeline_run_steps") {
          done();
          return Promise.resolve({ error: opts.stepError ?? null });
        }
        return builder;
      };
      builder.update = (p: unknown) => {
        op = "update";
        payload = p;
        if (opts.throwOn === "update") throw new Error("boom");
        return builder;
      };
      builder.select = () => {
        if (!op) op = "select";
        return builder;
      };
      builder.eq = (c: string, v: unknown) => {
        filters.push([c, v]);
        if (op === "update") {
          done();
          // Awaitable (updateRun) and chainable (finishRun's guarded update).
          type Chain = Promise<unknown> & { eq: () => Chain; select: () => Promise<unknown> };
          const chain: Chain = Object.assign(
            Promise.resolve({ error: null }),
            {
              eq: () => chain,
              select: () => Promise.resolve({ data: [{ id: "run-1" }], error: null }),
            },
          );
          return chain;
        }
        return builder;
      };
      builder.order = () => builder;
      builder.limit = () => builder;
      builder.maybeSingle = () => {
        done();
        if (table === "pipeline_run_steps") {
          if (filters.some((f) => (f as unknown[])[0] === "result")) {
            return Promise.resolve({ data: opts.heldStep ? { seq: 2 } : null, error: null });
          }
          return Promise.resolve({
            data: opts.maxSeq == null ? null : { seq: opts.maxSeq },
            error: null,
          });
        }
        return Promise.resolve({ data: opts.existingRun ?? null, error: null });
      };
      builder.single = () => {
        done();
        if (opts.insertError) {
          return Promise.resolve({ data: null, error: opts.insertError });
        }
        return Promise.resolve({
          data: opts.insertRow ?? { id: "run-1", org_id: "org-1" },
          error: null,
        });
      };
      return builder;
    },
  };
  return { admin: admin as never, calls };
}

describe("startRun", () => {
  const input = {
    orgId: "org-1",
    inboundMessageId: "msg-1",
    propertyId: "p-1",
    contactId: "c-1",
    conversationId: "conv-1",
    mode: "legacy" as const,
    inboundPreview: "x".repeat(300),
  };

  it("inserts a run and returns a context with seq 0", async () => {
    const { admin, calls } = fakeAdmin();
    const ctx = await startRun(admin, input);
    expect(ctx).toEqual({ runId: "run-1", orgId: "org-1", seq: 0 });
    const payload = calls[0].payload as Record<string, unknown>;
    expect(payload.inbound_message_id).toBe("msg-1");
    expect((payload.inbound_preview as string).length).toBe(160);
    expect(payload.mode).toBe("legacy");
  });

  it("resumes the existing run when the inbound message already has one", async () => {
    const { admin } = fakeAdmin({
      insertError: { code: "23505", message: "duplicate key" },
      existingRun: { id: "run-0", org_id: "org-1" },
      maxSeq: 4,
    });
    const ctx = await startRun(admin, input);
    expect(ctx).toEqual({ runId: "run-0", orgId: "org-1", seq: 4 });
  });

  it("returns null and never throws on failure", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { admin } = fakeAdmin({ insertError: { message: "db down" } });
    await expect(startRun(admin, input)).resolves.toBeNull();
    const t = fakeAdmin({ throwOn: "insert" });
    await expect(startRun(t.admin, input)).resolves.toBeNull();
    err.mockRestore();
  });
});

describe("recordStep", () => {
  it("is a no-op for a missing context", async () => {
    const { admin, calls } = fakeAdmin();
    await recordStep(admin, null, { kind: "gate", name: "x", result: "pass" });
    await recordStep(admin, undefined, { kind: "gate", name: "x", result: "pass" });
    expect(calls).toHaveLength(0);
  });

  it("issues increasing seq numbers, even without awaiting", async () => {
    const { admin, calls } = fakeAdmin();
    const ctx = { runId: "run-1", orgId: "org-1", seq: 0 };
    await Promise.all([
      recordStep(admin, ctx, { kind: "gate", name: "a", result: "pass" }),
      recordStep(admin, ctx, { kind: "jev", name: "b", result: "pass", detail: { n: 1 } }),
    ]);
    const seqs = calls.map((c) => (c.payload as { seq: number }).seq);
    expect(seqs).toEqual([1, 2]);
    expect(ctx.seq).toBe(2);
    expect((calls[0].payload as { org_id: string }).org_id).toBe("org-1");
  });

  it("swallows insert errors and thrown errors", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const ctx = { runId: "r", orgId: "o", seq: 0 };
    await expect(
      recordStep(fakeAdmin({ stepError: { message: "x" } }).admin, ctx, { kind: "gate", name: "a", result: "pass" }),
    ).resolves.toBeUndefined();
    await expect(
      recordStep(fakeAdmin({ throwOn: "insert" }).admin, ctx, { kind: "gate", name: "a", result: "pass" }),
    ).resolves.toBeUndefined();
    err.mockRestore();
  });
});

describe("sanitizeStepDetail", () => {
  it("drops body-ish keys and phone-like strings, keeps enums and numbers", () => {
    expect(
      sanitizeStepDetail({
        outcome: "interested",
        probabilities: { interested: 0.9 },
        body: "secret text",
        message_body: "x",
        outbound_message_id: "m-1",
        phone: "+15551234567",
        note: "call 913-555-1234 now",
        threshold: 0.8,
        ids: ["a"],
      }),
    ).toEqual({
      outcome: "interested",
      probabilities: { interested: 0.9 },
      outbound_message_id: "m-1",
      threshold: 0.8,
      ids: ["a"],
    });
  });
});

describe("finishRun / updateRun / resumeRun", () => {
  it("finishRun writes terminal fields and ignores null ctx", async () => {
    const { admin, calls } = fakeAdmin();
    await finishRun(admin, null, { status: "closed" });
    expect(calls).toHaveLength(0);
    await finishRun(admin, { runId: "run-1", orgId: "o", seq: 3 }, {
      status: "replied",
      finalOutcome: "ai_replied",
      reason: "sent",
      claimId: "cl-1",
      outboundMessageId: "m-2",
      classificationRunId: "cr-1",
    });
    const p = calls[0].payload as Record<string, unknown>;
    expect(p).toMatchObject({
      status: "replied",
      final_outcome: "ai_replied",
      reason: "sent",
      claim_id: "cl-1",
      outbound_message_id: "m-2",
      classification_run_id: "cr-1",
    });
    expect(typeof p.completed_at).toBe("string");
  });

  it("updateRun sends only provided fields", async () => {
    const { admin, calls } = fakeAdmin();
    await updateRun(admin, { runId: "run-1", orgId: "o", seq: 0 }, { mode: "shadow" });
    expect(calls[0].payload).toEqual({ mode: "shadow" });
  });

  it("never throws", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      finishRun(fakeAdmin({ throwOn: "update" }).admin, { runId: "r", orgId: "o", seq: 0 }, { status: "error" }),
    ).resolves.toBeUndefined();
    err.mockRestore();
  });

  it("resumeRun continues the seq counter from the stored max", async () => {
    const { admin } = fakeAdmin({ existingRun: { id: "run-9", org_id: "org-1" }, maxSeq: 7 });
    expect(await resumeRun(admin, "run-9")).toEqual({ runId: "run-9", orgId: "org-1", seq: 7 });
    const held = fakeAdmin({ existingRun: { id: "run-9", org_id: "org-1" }, maxSeq: 7, heldStep: true });
    expect(await resumeRun(held.admin, "run-9")).toEqual({ runId: "run-9", orgId: "org-1", seq: 7, held: true });
    const none = fakeAdmin({ existingRun: null });
    expect(await resumeRun(none.admin, "gone")).toBeNull();
    expect(await resumeRun(none.admin, null)).toBeNull();
  });
});

describe("seam hardening", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    reportError.mockClear();
  });

  it("routes failures through reportError", async () => {
    const { admin } = fakeAdmin({ insertError: { message: "db down" } });
    await startRun(admin, { orgId: "o", inboundMessageId: "m" });
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "db down" }),
      expect.objectContaining({ tags: expect.objectContaining({ surface: "pipeline_runs", stage: "start" }) }),
    );
  });

  it("PIPELINE_RUNS_ENABLED=0 makes startRun a no-op returning null", async () => {
    vi.stubEnv("PIPELINE_RUNS_ENABLED", "0");
    const { admin, calls } = fakeAdmin();
    expect(await startRun(admin, { orgId: "o", inboundMessageId: "m" })).toBeNull();
    expect(calls).toHaveLength(0);
    vi.stubEnv("PIPELINE_RUNS_ENABLED", "1");
    expect(await startRun(admin, { orgId: "o", inboundMessageId: "m" })).not.toBeNull();
  });

  it("keeps UUIDs and ISO timestamps but still drops real-looking phones", () => {
    expect(
      sanitizeStepDetail({
        id: "3f2b8c1e-5a7d-4e9f-8b6a-1c2d3e4f5a6b",
        at: "2026-10-08T14:27:00.000Z",
        day: "2026-10-08",
        phone_text: "reach me at (913) 555-1234",
        intl: "+1 913-555-1234",
        mixed: "3f2b8c1e-5a7d-4e9f-8b6a-1c2d3e4f5a6b 9135551234",
      }),
    ).toEqual({
      id: "3f2b8c1e-5a7d-4e9f-8b6a-1c2d3e4f5a6b",
      at: "2026-10-08T14:27:00.000Z",
      day: "2026-10-08",
    });
  });
});

describe("seam integrity (fix round 2)", () => {
  afterEach(() => reportError.mockClear());

  /** Stateful fake: enforces unique (run_id, seq) and a guarded status update. */
  function statefulAdmin(initial: { steps: number[]; status: string }) {
    const state = { steps: [...initial.steps], status: initial.status, inserted: [] as Array<{ seq: number; name: string }> };
    const admin = {
      from(table: string) {
        if (table === "pipeline_run_steps") {
          return {
            insert: async (row: { seq: number; name: string }) => {
              if (state.steps.includes(row.seq)) return { error: { code: "23505", message: "dup" } };
              state.steps.push(row.seq);
              state.inserted.push({ seq: row.seq, name: row.name });
              return { error: null };
            },
            select: () => ({
              eq: () => ({
                order: () => ({
                  limit: () => ({
                    maybeSingle: async () => ({
                      data: state.steps.length ? { seq: Math.max(...state.steps) } : null,
                      error: null,
                    }),
                  }),
                }),
              }),
            }),
          };
        }
        const filters: Record<string, unknown> = {};
        const chain = {
          update: () => chain,
          eq: (c: string, v: unknown) => {
            filters[c] = v;
            return chain;
          },
          select: async () => {
            if (filters.status === "running" && state.status === "running") {
              state.status = "terminal";
              return { data: [{ id: "run-1" }], error: null };
            }
            return { data: [], error: null };
          },
        };
        return chain;
      },
    };
    return { admin: admin as never, state };
  }

  it("retries on a seq collision from a concurrent resume and lands on a free seq", async () => {
    // Stored steps already reach 5 although this process thinks it is at 2.
    const { admin, state } = statefulAdmin({ steps: [1, 2, 3, 4, 5], status: "running" });
    const ctx = { runId: "run-1", orgId: "o", seq: 1 };
    await recordStep(admin, ctx, { kind: "gate", name: "late", result: "pass" });
    expect(state.inserted).toEqual([{ seq: 6, name: "late" }]);
    expect(ctx.seq).toBe(6);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("does not overwrite a terminal status; records terminal_conflict instead", async () => {
    const { admin, state } = statefulAdmin({ steps: [1], status: "terminal" });
    const ctx = { runId: "run-1", orgId: "o", seq: 1 };
    await finishRun(admin, ctx, { status: "replied" });
    expect(state.status).toBe("terminal");
    expect(state.inserted).toEqual([{ seq: 2, name: "terminal_conflict" }]);
  });

  it("stamps a running run exactly once", async () => {
    const { admin, state } = statefulAdmin({ steps: [], status: "running" });
    const ctx = { runId: "run-1", orgId: "o", seq: 0 };
    await finishRun(admin, ctx, { status: "replied" });
    await finishRun(admin, ctx, { status: "skipped" });
    expect(state.inserted.map((s) => s.name)).toEqual(["terminal_conflict"]);
  });
});
