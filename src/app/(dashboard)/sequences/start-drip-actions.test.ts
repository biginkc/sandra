import { beforeEach, expect, it, vi } from "vitest";

const createClient = vi.hoisted(() => vi.fn());
const startFollowUpDrip = vi.hoisted(() => vi.fn());
const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase/server", () => ({ createClient }));
vi.mock("@/lib/sequences/start-drip", () => ({ startFollowUpDrip, previewFirstSend: vi.fn(), enrollmentReason: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath }));

import { startDripForLeads } from "./actions";

beforeEach(() => {
  vi.clearAllMocks();
  createClient.mockResolvedValue({ auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) } });
  startFollowUpDrip.mockResolvedValue({ results: [{ propertyId: "p1", status: "skipped", reason: "Already in this drip" }] });
});

it("rejects more than 100 property IDs before opening a client", async () => {
  expect(await startDripForLeads("s1", Array.from({ length: 101 }, (_, index) => `p${index}`)))
    .toMatchObject({ ok: false, error: { code: "VALIDATION" } });
  expect(createClient).not.toHaveBeenCalled();
});

it("returns per-lead results and refreshes affected views", async () => {
  expect(await startDripForLeads("s1", ["p1"])).toEqual({ ok: true, data: { results: [{ propertyId: "p1", status: "skipped", reason: "Already in this drip" }] } });
  expect(startFollowUpDrip).toHaveBeenCalledWith(expect.anything(), { sequenceId: "s1", propertyIds: ["p1"], userId: "u1" });
  expect(revalidatePath).toHaveBeenCalledWith("/messages");
});
