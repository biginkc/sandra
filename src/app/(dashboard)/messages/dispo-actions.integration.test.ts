import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  afterCallbacks,
  afterMock,
  createClient,
  createTask,
  dispatchTaskAssigned,
  dispatchTaskAssignedSlack,
  dispatchTaskCalendarEvent,
  loadIntegrationPrefs,
  revalidatePath,
  reportError,
} = vi.hoisted(() => ({
  afterCallbacks: [] as Array<() => Promise<void> | void>,
  afterMock: vi.fn((callback: () => Promise<void> | void) => {
    afterCallbacks.push(callback);
  }),
  createClient: vi.fn(),
  createTask: vi.fn(),
  dispatchTaskAssigned: vi.fn(async () => ({ inserted: 1 })),
  dispatchTaskAssignedSlack: vi.fn(async () => ({ sent: false })),
  dispatchTaskCalendarEvent: vi.fn(async () => ({ inserted: false })),
  loadIntegrationPrefs: vi.fn(async () => ({
    slackEnabled: true,
    calendarEnabled: true,
    timezone: "America/Chicago",
  })),
  revalidatePath: vi.fn(),
  reportError: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("next/server", () => ({ after: afterMock }));
vi.mock("@/lib/errors/report", () => ({ reportError }));
vi.mock("@/lib/integrations/google/dispatch", () => ({
  dispatchTaskCalendarEvent,
}));
vi.mock("@/lib/integrations/prefs", () => ({ loadIntegrationPrefs }));
vi.mock("@/lib/integrations/slack/dispatch", () => ({
  dispatchTaskAssignedSlack,
}));
vi.mock("@/lib/messaging/consent", () => ({
  recordConsentEvent: vi.fn(),
}));
vi.mock("@/lib/notifications/dispatch", () => ({ dispatchTaskAssigned }));
vi.mock("@/lib/sequences/enrollment", () => ({
  pauseContactEnrollments: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient }));
vi.mock("@/lib/tasks", () => ({
  createTask,
  dispoToTaskType: (dispo: "nurture" | "callback_requested") =>
    dispo === "callback_requested" ? "callback" : "follow_up",
}));

import { setOutreachDispo } from "./dispo-actions";

type Response = { data?: unknown; error?: { message: string } | null };

let responseQueue: Response[] = [];
let updatePayloads: unknown[] = [];

beforeEach(() => {
  responseQueue = [];
  updatePayloads = [];
  afterCallbacks.length = 0;
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.test");
  createClient.mockResolvedValue(makeSupabase("actor-1"));
  createTask.mockResolvedValue({
    ok: true,
    data: { id: "task-1" },
  });
  loadIntegrationPrefs.mockResolvedValue({
    slackEnabled: true,
    calendarEnabled: true,
    timezone: "America/Chicago",
  });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("setOutreachDispo integration dispatch fan-out", () => {
  it("task-creating dispo assigned to another user schedules all three dispatchers", async () => {
    responseQueue = [
      { data: property(), error: null },
      { error: null },
    ];
    loadIntegrationPrefs.mockResolvedValueOnce({
      slackEnabled: true,
      calendarEnabled: true,
      timezone: "America/Denver",
    });

    const result = await setOutreachDispo(
      "property-1",
      "callback_requested",
      "2026-05-10T15:00:00.000Z",
      "assignee-2",
    );

    expect(result).toEqual({ ok: true });
    expect(createTask).toHaveBeenCalledWith(expect.anything(), {
      orgId: "org-1",
      assigneeId: "assignee-2",
      relatedPropertyId: "property-1",
      type: "callback",
      title: "Callback 123 Dispatch Ln",
      dueAt: "2026-05-10T15:00:00.000Z",
      createdBy: "actor-1",
    });
    expect(loadIntegrationPrefs).toHaveBeenCalledWith(
      expect.anything(),
      "assignee-2",
    );
    expect(dispatchTaskAssigned).not.toHaveBeenCalled();
    expect(afterMock).toHaveBeenCalledTimes(1);

    await flushAfterCallbacks();

    expect(dispatchTaskAssigned).toHaveBeenCalledWith(expect.anything(), {
      taskId: "task-1",
      orgId: "org-1",
      assigneeId: "assignee-2",
      taskTitle: "Callback 123 Dispatch Ln",
      taskType: "callback",
      dueAt: "2026-05-10T15:00:00.000Z",
      propertyAddress: "123 Dispatch Ln",
    });
    expect(dispatchTaskAssignedSlack).toHaveBeenCalledWith({
      taskId: "task-1",
      assigneeId: "assignee-2",
      taskTitle: "Callback 123 Dispatch Ln",
      taskType: "callback",
      dueAt: "2026-05-10T15:00:00.000Z",
      propertyAddress: "123 Dispatch Ln",
      deepLink: "https://app.test/messages?property_id=property-1",
      timezone: "America/Denver",
      slackEnabled: true,
    });
    expect(dispatchTaskCalendarEvent).toHaveBeenCalledWith({
      taskId: "task-1",
      assigneeId: "assignee-2",
      taskTitle: "Callback 123 Dispatch Ln",
      propertyAddress: "123 Dispatch Ln",
      dueAt: "2026-05-10T15:00:00.000Z",
      timezone: "America/Denver",
      deepLink: "https://app.test/messages?property_id=property-1",
      calendarEnabled: true,
    });
  });

  it("self-assigned task-creating dispo schedules no dispatchers", async () => {
    responseQueue = [
      { data: property(), error: null },
      { error: null },
    ];

    const result = await setOutreachDispo(
      "property-1",
      "callback_requested",
      "2026-05-10T15:00:00.000Z",
      "actor-1",
    );

    expect(result).toEqual({ ok: true });
    expect(afterMock).not.toHaveBeenCalled();
    expect(loadIntegrationPrefs).not.toHaveBeenCalled();
    await flushAfterCallbacks();
    expect(dispatchTaskAssigned).not.toHaveBeenCalled();
    expect(dispatchTaskAssignedSlack).not.toHaveBeenCalled();
    expect(dispatchTaskCalendarEvent).not.toHaveBeenCalled();
  });

  it("uses captured default prefs returned by loadIntegrationPrefs", async () => {
    responseQueue = [
      { data: property(), error: null },
      { error: null },
    ];
    loadIntegrationPrefs.mockResolvedValueOnce({
      slackEnabled: true,
      calendarEnabled: true,
      timezone: "America/Chicago",
    });

    await setOutreachDispo(
      "property-1",
      "nurture",
      "2026-05-11T15:00:00.000Z",
      "assignee-2",
    );
    await flushAfterCallbacks();

    expect(dispatchTaskAssignedSlack).toHaveBeenCalledWith(
      expect.objectContaining({
        timezone: "America/Chicago",
        slackEnabled: true,
      }),
    );
    expect(dispatchTaskCalendarEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        timezone: "America/Chicago",
        calendarEnabled: true,
      }),
    );
  });

  it("one rejected dispatcher does not prevent the other dispatchers from running", async () => {
    responseQueue = [
      { data: property(), error: null },
      { error: null },
    ];
    dispatchTaskAssignedSlack.mockRejectedValueOnce(new Error("Slack down"));

    await setOutreachDispo(
      "property-1",
      "callback_requested",
      "2026-05-10T15:00:00.000Z",
      "assignee-2",
    );

    await expect(flushAfterCallbacks()).resolves.toBeUndefined();
    expect(dispatchTaskAssigned).toHaveBeenCalledTimes(1);
    expect(dispatchTaskAssignedSlack).toHaveBeenCalledTimes(1);
    expect(dispatchTaskCalendarEvent).toHaveBeenCalledTimes(1);
  });
});

function makeSupabase(userId: string) {
  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: { id: userId } },
      })),
    },
    from: vi.fn((table: string) => {
      const builder = {
        select: vi.fn(() => builder),
        update: vi.fn((payload: unknown) => {
          updatePayloads.push({ table, payload });
          return builder;
        }),
        eq: vi.fn(() => builder),
        maybeSingle: vi.fn(async () => {
          const response = responseQueue.shift();
          return { data: response?.data ?? null, error: response?.error ?? null };
        }),
        then: (
          onFulfilled: (value: { error: { message: string } | null }) => unknown,
          onRejected?: (reason: unknown) => unknown,
        ) => {
          const response = responseQueue.shift();
          return Promise.resolve({
            error: response?.error ?? null,
          }).then(onFulfilled, onRejected);
        },
      };
      return builder;
    }),
  };
}

function property() {
  return {
    id: "property-1",
    org_id: "org-1",
    address: "123 Dispatch Ln",
    homeowner_contact_id: "contact-1",
  };
}

async function flushAfterCallbacks(): Promise<void> {
  const callbacks = [...afterCallbacks];
  afterCallbacks.length = 0;
  await Promise.all(callbacks.map((callback) => callback()));
}
