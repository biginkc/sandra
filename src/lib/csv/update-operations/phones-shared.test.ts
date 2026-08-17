import { describe, expect, it, vi } from "vitest";

import { buildPhonesOp } from "./phones-shared";

const property = {
  id: "property-1",
  org_id: "org-1",
  homeowner_contact_id: "contact-1",
  agent_contact_id: null,
  status: "new_lead",
  is_dnc_locked: false,
  motivation_level: null,
  address: "1 Main St",
  address_normalized: "1 main st",
};

describe("phone update DNC write proof", () => {
  it("rejects a zero-row ratchet when the contact was concurrently deleted", async () => {
    const contactCalls = [
      readResult({ do_not_contact: false }),
      updateResult([]),
      readResult(null),
    ];
    const op = buildPhonesOp("homeowner");

    const result = await op.apply(
      {
        supabase: { from: vi.fn(() => contactCalls.shift()) } as never,
        userId: null,
      },
      {
        rowIndex: 4,
        parsedRow: {
          Address: "1 Main St",
          "Phone 1": "8165550100",
          "Phone 1 Type": "DO NOT CALL",
        },
        property,
      },
      { dryRun: false },
    );

    expect(result).toMatchObject({
      kind: "rejected",
      reason: "db-error",
      detail:
        "DNC ratchet was not confirmed because the contact no longer exists.",
    });
  });

  it("accepts a zero-row ratchet only when a reread proves DNC is already true", async () => {
    const contactCalls = [
      readResult({ do_not_contact: false }),
      updateResult([]),
      readResult({ do_not_contact: true }),
    ];
    const op = buildPhonesOp("homeowner");

    const result = await op.apply(
      {
        supabase: { from: vi.fn(() => contactCalls.shift()) } as never,
        userId: null,
      },
      {
        rowIndex: 0,
        parsedRow: {
          Address: "1 Main St",
          "Phone 1": "8165550100",
          "Phone 1 Type": "DO NOT CALL",
        },
        property,
      },
      { dryRun: false },
    );

    expect(result).toMatchObject({
      kind: "updated",
      after: { do_not_contact: true },
    });
  });

  it("reports an already-DNC repeat row as unchanged rather than a new update", async () => {
    const from = vi.fn(() => readResult({ do_not_contact: true }));
    const op = buildPhonesOp("homeowner");

    const result = await op.apply(
      { supabase: { from } as never, userId: null },
      {
        rowIndex: 0,
        parsedRow: {
          Address: "1 Main St",
          "Phone 1": "8165550100",
          "Phone 1 Type": "DO NOT CALL",
        },
        property,
      },
      { dryRun: false },
    );

    expect(result).toEqual({
      kind: "unchanged",
      rowIndex: 0,
      address: "1 Main St",
      reason: "no-change",
    });
    expect(from).toHaveBeenCalledTimes(1);
  });
});

function readResult(data: { do_not_contact: boolean } | null) {
  const builder: Record<string, ReturnType<typeof vi.fn>> = {};
  builder.select = vi.fn(() => builder);
  builder.eq = vi.fn(() => builder);
  builder.maybeSingle = vi.fn(() => Promise.resolve({ data, error: null }));
  return builder;
}

function updateResult(data: Array<{ id: string }>) {
  const builder: Record<string, ReturnType<typeof vi.fn>> = {};
  builder.update = vi.fn(() => builder);
  builder.eq = vi.fn(() => builder);
  builder.select = vi.fn(() => Promise.resolve({ data, error: null }));
  return builder;
}
