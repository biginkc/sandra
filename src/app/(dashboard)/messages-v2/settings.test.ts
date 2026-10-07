import { describe, expect, it } from "vitest";

import type { LooseSupabase } from "./queries";
import { ensureMessagesV2Settings } from "./settings";

function fakeAdmin(error: unknown = null) {
  const calls: Array<{ table: string; row: unknown; opts: unknown }> = [];
  const client = {
    from(table: string) {
      return {
        upsert(row: unknown, opts: unknown) {
          calls.push({ table, row, opts });
          return Promise.resolve({ error });
        },
      };
    },
    rpc: () => Promise.resolve({}),
  } as unknown as LooseSupabase;
  return { client, calls };
}

describe("ensureMessagesV2Settings", () => {
  it("seeds the cutover with insert-on-conflict-do-nothing (an existing cutover is never moved)", async () => {
    const { client, calls } = fakeAdmin();
    const ok = await ensureMessagesV2Settings(client, "org-1", "2026-10-08T12:00:00.000Z");
    expect(ok).toBe(true);
    expect(calls).toEqual([
      {
        table: "messages_v2_settings",
        row: { org_id: "org-1", backlog_before: "2026-10-08T12:00:00.000Z" },
        opts: { onConflict: "org_id", ignoreDuplicates: true },
      },
    ]);
  });

  it("reports a failed seed", async () => {
    const { client } = fakeAdmin({ message: "boom" });
    expect(await ensureMessagesV2Settings(client, "org-1")).toBe(false);
  });
});
