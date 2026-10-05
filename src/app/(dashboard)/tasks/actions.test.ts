import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  completeTaskLib,
  createClient,
  reassignTaskLib,
  revalidatePath,
} = vi.hoisted(() => ({
  completeTaskLib: vi.fn(),
  createClient: vi.fn(),
  reassignTaskLib: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("@/lib/supabase/server", () => ({ createClient }));
vi.mock("@/lib/tasks", () => ({
  completeTask: completeTaskLib,
  reassignTask: reassignTaskLib,
}));

import * as taskActions from "./actions";
import { reassignTaskAction } from "./actions";

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
  reassignTaskLib.mockResolvedValue({ ok: true, data: { id: "task-1" } });
});

describe("task action actor propagation", () => {
  it("no longer exposes a snooze action (retired with the follow-up/callback types)", () => {
    expect("snoozeTaskAction" in taskActions).toBe(false);
  });

  it("does not reassign when there is no authenticated actor", async () => {
    createClient.mockResolvedValue(cookieClient(null));

    const result = await reassignTaskAction("task-1", "assignee-2");

    expect(result).toEqual({
      ok: false,
      error: { code: "UNAUTHENTICATED", message: "Not signed in" },
    });
    expect(reassignTaskLib).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
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
    reassignTaskLib.mockResolvedValue({
      ok: false,
      error: { code: "TASK_REASSIGN_FAILED", message: "conflict" },
    });

    const result = await reassignTaskAction("task-1", "assignee-2");

    expect(result.ok).toBe(false);
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
