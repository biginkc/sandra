import { afterEach, expect, it, vi } from "vitest";

const createClient = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase/server", () => ({ createClient }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { listDripChoices } from "./actions";
import { previewFirstSend } from "@/lib/sequences/start-drip";

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

it("previews the cumulative delay through the first SMS and omits it for status-only drips", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-28T13:00:00.000Z"));
  const sequences = [{ id: "mixed", name: "Mixed" }, { id: "status-only", name: "Status only" }];
  const steps = [
    { sequence_id: "mixed", step_index: 0, delay_after_previous_minutes: 60, action_type: "change_status" },
    { sequence_id: "mixed", step_index: 1, delay_after_previous_minutes: 10020, action_type: "send_sms" },
    { sequence_id: "status-only", step_index: 0, delay_after_previous_minutes: 60, action_type: "change_status" },
  ];
  createClient.mockResolvedValue({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    from: (table: string) => table === "sequences"
      ? { select: () => ({ eq: () => ({ is: () => ({ order: async () => ({ data: sequences, error: null }) }) }) }) }
      : { select: () => ({ in: () => ({ order: async () => ({ data: steps, error: null }) }) }) },
  });

  expect(await listDripChoices()).toEqual({ ok: true, data: [
    { id: "mixed", name: "Mixed", textCount: 1, days: 7, firstSend: previewFirstSend(10080, "America/Chicago") },
    { id: "status-only", name: "Status only", textCount: 0, days: 1, firstSend: null },
  ] });
});
