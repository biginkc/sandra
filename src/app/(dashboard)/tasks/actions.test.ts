import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  completeTaskLib,
  createClient,
  reassignTaskLib,
  revalidatePath,
  snoozeTaskLib,
} = vi.hoisted(() => ({
  completeTaskLib: vi.fn(),
  createClient: vi.fn(),
  reassignTaskLib: vi.fn(),
  revalidatePath: vi.fn(),
  snoozeTaskLib: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("@/lib/supabase/server", () => ({ createClient }));
vi.mock("@/lib/tasks", () => ({
  completeTask: completeTaskLib,
  reassignTask: reassignTaskLib,
  snoozeTask: snoozeTaskLib,
}));

import { reassignTaskAction, snoozeTaskAction } from "./actions";

function cookieClient(userId: string | null) {
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: userId ? { id: userId } : null },
      }),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  createClient.mockResolvedValue(cookieClient("actor-1"));
  snoozeTaskLib.mockResolvedValue({ ok: true, data: { id: "task-1" } });
  reassignTaskLib.mockResolvedValue({ ok: true, data: { id: "task-1" } });
});

describe("task action actor propagation", () => {
  it("does not snooze when there is no authenticated actor", async () => {
    createClient.mockResolvedValue(cookieClient(null));

    const result = await snoozeTaskAction("task-1", "2026-09-02T15:00:00.000Z");

    expect(result).toEqual({
      ok: false,
      error: { code: "UNAUTHENTICATED", message: "Not signed in" },
    });
    expect(snoozeTaskLib).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("forwards the current user as the snooze actor and revalidates success", async () => {
    const client = cookieClient("actor-1");
    createClient.mockResolvedValue(client);

    const result = await snoozeTaskAction("task-1", "2026-09-02T15:00:00.000Z");

    expect(result.ok).toBe(true);
    expect(snoozeTaskLib).toHaveBeenCalledWith(
      client,
      "task-1",
      "2026-09-02T15:00:00.000Z",
      "actor-1",
    );
    expect(revalidatePath).toHaveBeenCalledWith("/dashboard");
  });

  it("forwards the current user—not the target assignee—as the reassignment actor", async () => {
    const client = cookieClient("actor-1");
    createClient.mockResolvedValue(client);

    const result = await reassignTaskAction("task-1", "assignee-2");

    expect(result.ok).toBe(true);
    expect(reassignTaskLib).toHaveBeenCalledWith(
      client,
      "task-1",
      "assignee-2",
      "actor-1",
    );
    expect(revalidatePath).toHaveBeenCalledWith("/dashboard");
  });

  it("does not revalidate when the task helper rejects the mutation", async () => {
    snoozeTaskLib.mockResolvedValue({
      ok: false,
      error: { code: "TASK_SNOOZE_FAILED", message: "conflict" },
    });

    const result = await snoozeTaskAction("task-1", "2026-09-02T15:00:00.000Z");

    expect(result.ok).toBe(false);
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
