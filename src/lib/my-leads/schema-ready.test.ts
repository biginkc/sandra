import { beforeEach, describe, expect, it, vi } from "vitest";

const { createAdminClient } = vi.hoisted(() => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient }));

import {
  clearSchemaReadyCache,
  REQUIREMENTS,
  schemaReady,
  setSchemaReadyClock,
} from "./schema-ready";

const req = REQUIREMENTS.next_step_write;
const allReady = {
  functions: Object.fromEntries(req.functions.map((f) => [f, true])),
  columns: Object.fromEntries(req.columns.map((c) => [c, true])),
};

function probeReturns(...results: Array<{ data: unknown; error: unknown } | Error>) {
  const rpc = vi.fn();
  for (const r of results) {
    if (r instanceof Error) rpc.mockRejectedValueOnce(r);
    else rpc.mockResolvedValueOnce(r);
  }
  createAdminClient.mockReturnValue({ rpc });
  return rpc;
}

describe("schemaReady", () => {
  let t = 0;
  beforeEach(() => {
    createAdminClient.mockReset();
    clearSchemaReadyCache();
    t = 1_000;
    setSchemaReadyClock(() => t);
  });

  it("passes the exact functions and columns of the feature to the probe", async () => {
    const rpc = probeReturns({ data: allReady, error: null });
    expect(await schemaReady("next_step_write")).toBe(true);
    expect(rpc).toHaveBeenCalledWith("fn_my_leads_schema_probe", {
      p_functions: req.functions,
      p_columns: req.columns,
    });
  });

  it("is false when the function or a column is missing (preceding schema)", async () => {
    probeReturns({
      data: {
        functions: { [req.functions[0]]: false },
        columns: { "tasks.mode": false, "tasks.location": false, "tasks.next_step_kind": false },
      },
      error: null,
    });
    expect(await schemaReady("next_step_write")).toBe(false);
    clearSchemaReadyCache();
    probeReturns({
      data: { functions: allReady.functions, columns: { ...allReady.columns, "tasks.mode": false } },
      error: null,
    });
    expect(await schemaReady("next_step_write")).toBe(false);
  });

  it("caches true for the life of the process", async () => {
    const rpc = probeReturns({ data: allReady, error: null });
    await schemaReady("next_step_write");
    t += 10 * 60_000;
    expect(await schemaReady("next_step_write")).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("caches false for 30 s then re-checks and picks up a landed migration", async () => {
    const rpc = probeReturns(
      { data: { functions: {}, columns: {} }, error: null },
      { data: allReady, error: null },
    );
    expect(await schemaReady("next_step_write")).toBe(false);
    t += 29_000;
    expect(await schemaReady("next_step_write")).toBe(false);
    expect(rpc).toHaveBeenCalledTimes(1);
    t += 2_000;
    expect(await schemaReady("next_step_write")).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("treats a missing probe RPC, an error, a throw, or junk as false", async () => {
    probeReturns({ data: null, error: { message: "function fn_my_leads_schema_probe does not exist" } });
    expect(await schemaReady("next_step_write")).toBe(false);
    clearSchemaReadyCache();
    probeReturns(new Error("network"));
    expect(await schemaReady("next_step_write")).toBe(false);
    clearSchemaReadyCache();
    probeReturns({ data: "nope", error: null });
    expect(await schemaReady("next_step_write")).toBe(false);
    clearSchemaReadyCache();
    createAdminClient.mockImplementation(() => {
      throw new Error("no env");
    });
    expect(await schemaReady("next_step_write")).toBe(false);
  });

  it.each(["lead_note_idempotency", "post_call_support"] as const)("%s needs the lead_notes idempotency column", async (feature) => {
    expect(REQUIREMENTS[feature].columns).toContain("lead_notes.idempotency_key");
    const needed = REQUIREMENTS[feature];
    const ready = {
      functions: Object.fromEntries(needed.functions.map((f) => [f, true])),
      columns: Object.fromEntries(needed.columns.map((c) => [c, true])),
    };
    probeReturns({ data: ready, error: null });
    expect(await schemaReady(feature)).toBe(true);
    clearSchemaReadyCache();
    probeReturns({ data: { ...ready, columns: { ...ready.columns, "lead_notes.idempotency_key": false } }, error: null });
    expect(await schemaReady(feature)).toBe(false);
  });

  it("seller_reminders needs the three outbox functions and the switch column; missing any reads as not ready", async () => {
    const needed = REQUIREMENTS.seller_reminders;
    expect(needed.functions).toHaveLength(3);
    expect(needed.columns).toContain("seller_reminder_settings.enabled");
    const ready = {
      functions: Object.fromEntries(needed.functions.map((f) => [f, true])),
      columns: Object.fromEntries(needed.columns.map((c) => [c, true])),
    };
    probeReturns({ data: ready, error: null });
    expect(await schemaReady("seller_reminders")).toBe(true);
    clearSchemaReadyCache();
    probeReturns({ data: { ...ready, functions: { ...ready.functions, [needed.functions[1]]: false } }, error: null });
    expect(await schemaReady("seller_reminders")).toBe(false);
  });

  it("artifact_fetch needs the claim, record and link functions and the flag column; missing any reads as not ready", async () => {
    const needed = REQUIREMENTS.artifact_fetch;
    expect(needed.functions).toHaveLength(3);
    expect(needed.columns).toContain("my_leads_feature_flags.artifact_fetch");
    const ready = {
      functions: Object.fromEntries(needed.functions.map((f) => [f, true])),
      columns: Object.fromEntries(needed.columns.map((c) => [c, true])),
    };
    probeReturns({ data: ready, error: null });
    expect(await schemaReady("artifact_fetch")).toBe(true);
    clearSchemaReadyCache();
    probeReturns({ data: { ...ready, functions: { ...ready.functions, [needed.functions[0]]: false } }, error: null });
    expect(await schemaReady("artifact_fetch")).toBe(false);
  });

  it("intent_timeout needs the timeout function and the failed_at marker column", async () => {
    const needed = REQUIREMENTS.intent_timeout;
    expect(needed.functions).toEqual(["public.fn_fail_stale_dialpad_intents(integer,integer)"]);
    expect(needed.columns).toEqual(["dialpad_call_intents.failed_at"]);
    probeReturns({ data: { functions: { [needed.functions[0]]: true }, columns: { [needed.columns[0]]: false } }, error: null });
    expect(await schemaReady("intent_timeout")).toBe(false);
  });
});
