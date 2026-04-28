import { beforeEach, describe, expect, it } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { resetTenantTables } from "@tests/integration/reset";

const supabase = createTestClient();

/**
 * Validates the schema + query behavior the `requestSkipTrace` action
 * relies on. The action itself takes the supabase session via
 * `createClient()` and is awkward to test in isolation; this file
 * pins down the filter contract so a regression on the column or
 * default value would fail loudly here before reaching the action.
 */
describe("skip_trace_disabled column", () => {
  beforeEach(async () => {
    await resetTenantTables(supabase);
  });

  it("defaults to false for new properties", async () => {
    const { data: prop } = await supabase
      .from("properties")
      .insert({ address: "1 Default Ln", state: "MO" })
      .select("skip_trace_disabled")
      .single();
    expect(prop?.skip_trace_disabled).toBe(false);
  });

  it("filters disabled properties from a bulk skip-trace selection", async () => {
    const { data: enabled } = await supabase
      .from("properties")
      .insert({ address: "1 Enabled Ln", state: "MO" })
      .select("id")
      .single();
    const { data: disabled } = await supabase
      .from("properties")
      .insert({
        address: "2 Disabled Ln",
        state: "MO",
        skip_trace_disabled: true,
      })
      .select("id")
      .single();

    // Mirrors the action's filter: SELECT id, org_id, skip_trace_disabled
    // WHERE id IN (selection) → keep only rows where !skip_trace_disabled.
    const selection = [enabled!.id, disabled!.id];
    const { data: rows } = await supabase
      .from("properties")
      .select("id, skip_trace_disabled")
      .in("id", selection);
    const eligible = (rows ?? [])
      .filter((p) => !p.skip_trace_disabled)
      .map((p) => p.id);
    expect(eligible).toEqual([enabled!.id]);
  });

  it("toggles back to false (re-enable)", async () => {
    const { data: prop } = await supabase
      .from("properties")
      .insert({
        address: "1 Toggle Ln",
        state: "MO",
        skip_trace_disabled: true,
      })
      .select("id")
      .single();

    await supabase
      .from("properties")
      .update({ skip_trace_disabled: false })
      .eq("id", prop!.id);

    const { data: after } = await supabase
      .from("properties")
      .select("skip_trace_disabled")
      .eq("id", prop!.id)
      .single();
    expect(after?.skip_trace_disabled).toBe(false);
  });
});
