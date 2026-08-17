import { describe, expect, it, vi } from "vitest";

import { buildEmailsOp } from "./emails-shared";

const property = {
  id: "property-1",
  org_id: "org-1",
  homeowner_contact_id: null,
  agent_contact_id: "contact-1",
  status: "new_lead",
  is_dnc_locked: false,
  motivation_level: null,
  address: "1 Main St",
  address_normalized: "1 main st",
};

describe("email update DNC write proof", () => {
  it("classifies a concurrent DNC ratchet instead of changing the email", async () => {
    const contactCalls = [
      readResult({ id: "contact-1", do_not_contact: false }),
      updateResult([]),
      readResult({ do_not_contact: true }),
    ];
    const op = buildEmailsOp("agent");

    const result = await op.apply(
      {
        supabase: { from: vi.fn(() => contactCalls.shift()) } as never,
        userId: null,
      },
      {
        rowIndex: 2,
        parsedRow: { Address: "1 Main St", Email: "new@example.com" },
        property,
      },
      { dryRun: false },
    );

    expect(result).toMatchObject({
      kind: "rejected",
      reason: "dnc-locked",
    });
  });
});

function readResult(data: Record<string, unknown> | null) {
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
