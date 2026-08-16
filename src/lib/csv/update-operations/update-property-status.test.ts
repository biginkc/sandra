import { describe, expect, it, vi } from "vitest";

import type { PropertyForMatch } from "../match-by-address";
import { updatePropertyStatusOp } from "./update-property-status";

const baseProperty: PropertyForMatch = {
  id: "property-1",
  homeowner_contact_id: null,
  agent_contact_id: null,
  status: "new_lead",
  is_dnc_locked: false,
  motivation_level: null,
  address: "1 Main St",
  address_normalized: "1 main st",
};

describe("CSV property-status DNC guard", () => {
  it("rejects a matched locked row in preview without attempting a write", async () => {
    const from = vi.fn();
    const result = await updatePropertyStatusOp.apply(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { supabase: { from } as any, userId: null },
      {
        rowIndex: 2,
        parsedRow: { Address: "1 Main St", Status: "contacted" },
        property: { ...baseProperty, is_dnc_locked: true },
      },
      { dryRun: true },
    );

    expect(result).toMatchObject({ kind: "rejected", reason: "dnc-locked" });
    expect(from).not.toHaveBeenCalled();
  });

  it("reports a DNC race when the guarded update changes zero rows", async () => {
    const result = Promise.resolve({ data: null, error: null });
    const query = {
      update: vi.fn(),
      eq: vi.fn(),
      select: vi.fn(),
      maybeSingle: vi.fn().mockReturnValue(result),
    };
    query.update.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    query.select.mockReturnValue(query);

    const row = await updatePropertyStatusOp.apply(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { supabase: { from: vi.fn(() => query) } as any, userId: null },
      {
        rowIndex: 3,
        parsedRow: { Address: "1 Main St", Status: "contacted" },
        property: baseProperty,
      },
      { dryRun: false },
    );

    expect(row).toMatchObject({ kind: "rejected", reason: "dnc-locked" });
    expect(query.eq).toHaveBeenCalledWith("is_dnc_locked", false);
  });
});
