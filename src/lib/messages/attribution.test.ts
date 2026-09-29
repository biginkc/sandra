import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/types";
import { findAttributedOutboundMessageId } from "./attribution";

vi.mock("./threading", () => ({
  listCandidatePropertyThreadsForInboundContact: async () => [
    { propertyId: "property-1" },
  ],
}));

function client(input: {
  campaigns: Array<{ id: string; sent_at: string | null; created_at: string }>;
  runs: Array<{ message_id: string }>;
  drips: Array<{ id: string; sent_at: string | null; created_at: string }>;
}) {
  const from = vi.fn((table: string) => {
    let byMessageId = false;
    const query = {
      select: () => query,
      eq: () => query,
      in: (column: string) => { if (table === "messages" && column === "id") byMessageId = true; return query; },
      not: () => query,
      order: async () => ({ data: input.campaigns, error: null }),
      then: (resolve: (value: unknown) => void) =>
        resolve({ data: table === "sequence_enrollments"
          ? [{ id: "enrollment-1" }]
          : table === "sequence_step_runs" ? input.runs : byMessageId ? input.drips : input.campaigns, error: null }),
    };
    return query;
  });
  return { supabase: { from } as unknown as SupabaseClient<Database> };
}

describe("findAttributedOutboundMessageId", () => {
  const campaign = { id: "campaign", sent_at: "2026-09-01T10:00:00Z", created_at: "2026-09-01T09:00:00Z" };
  const drip = { id: "drip", sent_at: "2026-09-01T11:00:00Z", created_at: "2026-09-01T10:30:00Z" };
  it("attributes the newest sent drip when it follows a campaign", async () => {
    const { supabase } = client({ campaigns: [campaign], runs: [{ message_id: "drip" }], drips: [drip] });
    expect(await findAttributedOutboundMessageId(supabase, { contactId: "contact" })).toBe("drip");
  });
  it("keeps campaign attribution when the campaign is newest", async () => {
    const { supabase } = client({ campaigns: [{ ...campaign, sent_at: "2026-09-01T12:00:00Z" }], runs: [{ message_id: "drip" }], drips: [drip] });
    expect(await findAttributedOutboundMessageId(supabase, { contactId: "contact" })).toBe("campaign");
  });
  it("leaves unrelated non-campaign messages unattributed", async () => {
    const { supabase } = client({ campaigns: [], runs: [], drips: [] });
    expect(await findAttributedOutboundMessageId(supabase, { contactId: "contact" })).toBeNull();
  });
});
