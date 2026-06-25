import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import type { Database } from "@/lib/supabase/types";

import { listUnknownSenders } from "./list-unknown-senders";

function makeSupabase(
  rows: Array<{
    from_address: string | null;
    to_address: string | null;
    body: string;
    created_at: string;
    dismissed_at: string | null;
  }>,
): SupabaseClient<Database> {
  const rangeCalls: Array<[number, number]> = [];
  const query = {
    select: () => query,
    eq: () => query,
    is: () => query,
    not: () => query,
    order: () => query,
    range: (from: number, to: number) => {
      rangeCalls.push([from, to]);
      return Promise.resolve({
        data: rows.slice(from, to + 1),
        error: null,
      });
    },
  };

  return {
    from: () => query,
    __rangeCalls: rangeCalls,
  } as unknown as SupabaseClient<Database>;
}

describe("listUnknownSenders", () => {
  it("classifies a sender by the latest unmatched row before filtering active buckets", async () => {
    const supabase = makeSupabase([
      {
        from_address: "+15550000001",
        to_address: null,
        body: "latest dismissed",
        created_at: "2026-06-24T12:00:00Z",
        dismissed_at: "2026-06-24T12:01:00Z",
      },
      {
        from_address: "+15550000002",
        to_address: null,
        body: "latest active",
        created_at: "2026-06-24T11:00:00Z",
        dismissed_at: null,
      },
      {
        from_address: "+15550000002",
        to_address: null,
        body: "older dismissed",
        created_at: "2026-06-24T10:00:00Z",
        dismissed_at: "2026-06-24T10:01:00Z",
      },
      {
        from_address: "+15550000001",
        to_address: null,
        body: "older active",
        created_at: "2026-06-24T09:00:00Z",
        dismissed_at: null,
      },
    ]);

    await expect(listUnknownSenders(supabase, {})).resolves.toEqual([
      expect.objectContaining({
        fromAddress: "+15550000002",
        latestBody: "latest active",
        messageCount: 2,
        isDismissed: false,
      }),
    ]);

    await expect(
      listUnknownSenders(supabase, { includeDismissed: true }),
    ).resolves.toEqual([
      expect.objectContaining({
        fromAddress: "+15550000001",
        latestBody: "latest dismissed",
        messageCount: 2,
        isDismissed: true,
      }),
      expect.objectContaining({
        fromAddress: "+15550000002",
        latestBody: "latest active",
        messageCount: 2,
        isDismissed: false,
      }),
    ]);
  });

  it("pages unknown sender rows past Supabase's default single-page cap", async () => {
    const rows = Array.from({ length: 1001 }, (_, i) => ({
      from_address: `+1555${String(i).padStart(7, "0")}`,
      to_address: null,
      body: `body ${i}`,
      created_at: new Date(Date.UTC(2026, 5, 24, 12, 0, 0) - i).toISOString(),
      dismissed_at: null,
    }));
    const supabase = makeSupabase(rows);

    const senders = await listUnknownSenders(supabase, {});

    expect(senders).toHaveLength(1001);
    expect(
      (supabase as unknown as { __rangeCalls: Array<[number, number]> })
        .__rangeCalls,
    ).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
  });
});
