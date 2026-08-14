import { beforeEach, describe, expect, it, vi } from "vitest";

const { createAdminClient, formatNotification, loadIntegrationPrefs } = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  formatNotification: vi.fn(() => ({ title: "Task assigned", body: "You have a new task" })),
  loadIntegrationPrefs: vi.fn(async (_client?: unknown, _userId?: string) => ({
    slackEnabled: true,
    calendarEnabled: true,
    timezone: "America/Denver",
  })),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient,
}));

vi.mock("@/lib/integrations/prefs", () => ({
  loadIntegrationPrefs,
}));

vi.mock("./format", () => ({
  formatNotification,
}));

vi.mock("@/lib/errors/report", () => ({
  reportError: vi.fn(),
}));

import { dispatchTaskAssigned } from "./dispatch";

// Distinct marker object so we can assert loadIntegrationPrefs was called
// with the ADMIN client's return value, not the caller-supplied `supabase`.
const adminClientMarker = { __brand: "admin-client" };
// A different marker for the caller-supplied client — must never reach
// loadIntegrationPrefs, since prefs RLS is self-only and the assigning
// user's client can't read a teammate's row.
const callerClientMarker = { __brand: "caller-client" };

function createTaskAssignedSupabaseStub() {
  const insert = vi.fn(async () => ({ error: null }));
  const from = vi.fn((table: string) => {
    expect(table).toBe("notifications");
    return { insert };
  });
  return { supabase: { ...callerClientMarker, from }, from, insert };
}

describe("dispatchTaskAssigned", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createAdminClient.mockReturnValue(adminClientMarker);
    loadIntegrationPrefs.mockResolvedValue({
      slackEnabled: true,
      calendarEnabled: true,
      timezone: "America/Denver",
    });
    formatNotification.mockReturnValue({
      title: "Task assigned",
      body: "You have a new task",
    });
  });

  it("loads the assignee's prefs via the ADMIN client, not the caller-supplied client", async () => {
    const { supabase } = createTaskAssignedSupabaseStub();

    await dispatchTaskAssigned(supabase as never, {
      taskId: "task-1",
      orgId: "org-1",
      assigneeId: "assignee-1",
      taskTitle: "Follow up on 123 Main St",
      taskType: "follow_up",
      dueAt: "2026-08-20T15:00:00.000Z",
    });

    expect(createAdminClient).toHaveBeenCalledTimes(1);
    expect(loadIntegrationPrefs).toHaveBeenCalledTimes(1);
    expect(loadIntegrationPrefs).toHaveBeenCalledWith(adminClientMarker, "assignee-1");
    // The only client loadIntegrationPrefs was called with is the admin
    // marker — asserting the single call's first arg rules out the
    // caller-supplied client sneaking in.
    expect(loadIntegrationPrefs.mock.calls[0][0]).not.toBe(callerClientMarker);
    expect(loadIntegrationPrefs.mock.calls[0][0]).not.toBe(supabase);
  });

  it("stamps the assignee's resolved timezone onto the format payload", async () => {
    const { supabase } = createTaskAssignedSupabaseStub();

    await dispatchTaskAssigned(supabase as never, {
      taskId: "task-1",
      orgId: "org-1",
      assigneeId: "assignee-1",
      taskTitle: "Follow up on 123 Main St",
      taskType: "follow_up",
      dueAt: "2026-08-20T15:00:00.000Z",
      propertyAddress: "123 Main St",
    });

    expect(formatNotification).toHaveBeenCalledWith(
      "task_assigned",
      expect.objectContaining({
        timezone: "America/Denver",
        taskTitle: "Follow up on 123 Main St",
        taskType: "follow_up",
        dueAt: "2026-08-20T15:00:00.000Z",
        propertyAddress: "123 Main St",
      }),
    );
  });

  it("inserts one notification row for the assignee using the formatted title/body", async () => {
    const { supabase, insert } = createTaskAssignedSupabaseStub();

    const result = await dispatchTaskAssigned(supabase as never, {
      taskId: "task-1",
      orgId: "org-1",
      assigneeId: "assignee-1",
      taskTitle: "Follow up on 123 Main St",
      taskType: "follow_up",
      dueAt: "2026-08-20T15:00:00.000Z",
    });

    expect(result).toEqual({ inserted: 1, conflict: false });
    expect(insert).toHaveBeenCalledWith([
      expect.objectContaining({
        org_id: "org-1",
        user_id: "assignee-1",
        event_type: "task_assigned",
        entity_type: "task",
        entity_id: "task-1",
        title: "Task assigned",
        body: "You have a new task",
      }),
    ]);
  });

  it("resolves a different timezone per assignee (uses the prefs it loaded, not a hardcoded default)", async () => {
    loadIntegrationPrefs.mockResolvedValue({
      slackEnabled: true,
      calendarEnabled: true,
      timezone: "America/Los_Angeles",
    });
    const { supabase } = createTaskAssignedSupabaseStub();

    await dispatchTaskAssigned(supabase as never, {
      taskId: "task-2",
      orgId: "org-1",
      assigneeId: "assignee-2",
      taskTitle: "Call back",
      taskType: "callback",
      dueAt: "2026-08-21T15:00:00.000Z",
    });

    expect(formatNotification).toHaveBeenCalledWith(
      "task_assigned",
      expect.objectContaining({ timezone: "America/Los_Angeles" }),
    );
  });
});
