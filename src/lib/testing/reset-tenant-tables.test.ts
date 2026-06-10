import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/types";
import { resetTenantTables } from "../../../tests/integration/reset";

describe("resetTenantTables", () => {
  it("pages through auth users before pruning orphan memberships", async () => {
    const deleteIn = vi.fn().mockResolvedValue({ error: null });
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const listUsers = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          users: [{ id: "user-page-1" }],
          aud: "authenticated",
          nextPage: 2,
          lastPage: 2,
          total: 2,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          users: [{ id: "user-page-2" }],
          aud: "authenticated",
          nextPage: null,
          lastPage: 2,
          total: 2,
        },
        error: null,
      });

    let membershipSelectCalls = 0;

    const client = {
      auth: {
        admin: {
          listUsers,
        },
      },
      rpc: vi.fn().mockResolvedValue({ error: null }),
      from: vi.fn((table: string) => {
        if (table === "memberships") {
          return {
            select: vi.fn((_columns: string) => {
              membershipSelectCalls += 1;
              if (membershipSelectCalls === 1) {
                return Promise.resolve({
                  data: [
                    {
                      user_id: "user-page-2",
                      org_id: "org-1",
                      role: "member",
                    },
                  ],
                  error: null,
                });
              }

              return {
                in: vi.fn((_column: string, values: string[]) => {
                  expect(values).toEqual(["user-page-2"]);
                  return Promise.resolve({
                    data: [
                      {
                        user_id: "user-page-2",
                        org_id: "org-1",
                        role: "member",
                      },
                    ],
                    error: null,
                  });
                }),
              };
            }),
            delete: vi.fn(() => ({
              in: deleteIn,
            })),
          };
        }

        if (table === "lists") {
          return {
            upsert,
          };
        }

        throw new Error(`Unexpected table: ${table}`);
      }),
    } as unknown as SupabaseClient<Database>;

    await expect(resetTenantTables(client)).resolves.toBeUndefined();

    expect(listUsers).toHaveBeenCalledTimes(2);
    expect(listUsers).toHaveBeenNthCalledWith(1, { page: 1, perPage: 200 });
    expect(listUsers).toHaveBeenNthCalledWith(2, { page: 2, perPage: 200 });
    expect(deleteIn).not.toHaveBeenCalled();
    expect(upsert).toHaveBeenCalledTimes(1);
  });
});
