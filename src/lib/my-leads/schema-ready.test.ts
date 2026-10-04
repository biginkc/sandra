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
});
