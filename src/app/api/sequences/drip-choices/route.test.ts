import { afterEach, beforeEach, expect, it, vi } from "vitest";

const createClient = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase/server", () => ({ createClient }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { listDripChoices } from "@/app/(dashboard)/sequences/actions";
import { GET } from "./route";

type Seq = { id: string; name: string; created_by: string };
type Step = { sequence_id: string; step_index: number; delay_after_previous_minutes: number; action_type: string };

// An RLS-scoped client: each user only ever sees their own org's rows.
function clientFor(userId: string | null, sequences: Seq[], steps: Step[]) {
  return {
    auth: { getUser: async () => ({ data: { user: userId ? { id: userId } : null } }) },
    from: (table: string) => table === "sequences"
      ? { select: () => ({ eq: () => ({ is: () => ({ order: async () => ({ data: [...sequences].sort((a, b) => a.name.localeCompare(b.name)), error: null }) }) }) }) }
      : { select: () => ({ in: (_c: string, ids: string[]) => ({ order: async () => ({ data: steps.filter((s) => ids.includes(s.sequence_id)).sort((a, b) => a.step_index - b.step_index), error: null }) }) }) },
  };
}

const orgA: [Seq[], Step[]] = [
  [{ id: "b", name: "Bravo", created_by: "u-a" }, { id: "a", name: "Alpha", created_by: "u-a" },
    { id: "c", name: "Canary drip", created_by: "canary-user" }, { id: "late", name: "No first step", created_by: "u-a" }],
  [{ sequence_id: "a", step_index: 0, delay_after_previous_minutes: 30, action_type: "send_sms" },
    { sequence_id: "a", step_index: 1, delay_after_previous_minutes: 2880, action_type: "send_sms" },
    { sequence_id: "b", step_index: 0, delay_after_previous_minutes: 60, action_type: "change_status" },
    { sequence_id: "b", step_index: 1, delay_after_previous_minutes: 1440, action_type: "send_sms" },
    { sequence_id: "c", step_index: 0, delay_after_previous_minutes: 0, action_type: "send_sms" },
    { sequence_id: "late", step_index: 1, delay_after_previous_minutes: 0, action_type: "send_sms" }],
];
const orgB: [Seq[], Step[]] = [
  [{ id: "z", name: "Org B only", created_by: "u-b" }],
  [{ sequence_id: "z", step_index: 0, delay_after_previous_minutes: 0, action_type: "send_sms" }],
];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-20T15:00:00.000Z"));
  process.env.SEQUENCE_CANARY_USER_ID = "canary-user";
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.SEQUENCE_CANARY_USER_ID;
  vi.clearAllMocks();
});

it("returns exactly what listDripChoices returns: same rows, order, canary exclusion and first send", async () => {
  createClient.mockResolvedValue(clientFor("u-a", ...orgA));
  const action = await listDripChoices();
  const response = await GET();
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toEqual(action);
  expect(body.data.map((c: { id: string }) => c.id)).toEqual(["a", "b"]);
  expect(body.data[0].firstSend).not.toBeNull();
});

it("401s when signed out", async () => {
  createClient.mockResolvedValue(clientFor(null, ...orgA));
  const response = await GET();
  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } });
});

it("forbids shared caching and never returns another account's list", async () => {
  createClient.mockResolvedValueOnce(clientFor("u-a", ...orgA)).mockResolvedValueOnce(clientFor("u-b", ...orgB));
  const first = await GET();
  const second = await GET();
  for (const response of [first, second]) {
    const cache = response.headers.get("cache-control") ?? "";
    expect(cache).toContain("private");
    expect(cache).toContain("no-store");
    expect(cache).not.toMatch(/public|s-maxage/);
  }
  expect((await first.json()).data.map((c: { id: string }) => c.id)).toEqual(["a", "b"]);
  expect((await second.json()).data.map((c: { id: string }) => c.id)).toEqual(["z"]);
});
