import { beforeEach, describe, expect, it, vi } from "vitest";

import { OAuthSecret } from "@/lib/integrations/tokens/store";

const { createAdminClient } = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
}));
const { getDecryptedToken } = vi.hoisted(() => ({
  getDecryptedToken: vi.fn(),
}));
const { loadIntegrationPrefs } = vi.hoisted(() => ({
  loadIntegrationPrefs: vi.fn(),
}));
const { completeTask } = vi.hoisted(() => ({
  completeTask: vi.fn(),
}));
const { reportError } = vi.hoisted(() => ({ reportError: vi.fn() }));
const { webClientConstructor, conversationsOpen, chatPostMessage, chatUpdate } =
  vi.hoisted(() => ({
    webClientConstructor: vi.fn(),
    conversationsOpen: vi.fn(),
    chatPostMessage: vi.fn(),
    chatUpdate: vi.fn(),
  }));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient }));
vi.mock("@/lib/integrations/tokens/store", async () => {
  const actual = await vi.importActual<typeof import("@/lib/integrations/tokens/store")>(
    "@/lib/integrations/tokens/store",
  );
  return { ...actual, getDecryptedToken };
});
vi.mock("@/lib/integrations/prefs", () => ({ loadIntegrationPrefs }));
vi.mock("@/lib/tasks", () => ({ completeTask }));
vi.mock("@/lib/errors/report", () => ({ reportError }));
vi.mock("@slack/web-api", () => ({
  WebClient: function MockWebClient(token: string, options?: unknown) {
    webClientConstructor(token, options);
    return {
      conversations: { open: conversationsOpen },
      chat: { postMessage: chatPostMessage, update: chatUpdate },
    };
  },
}));

import {
  completeTaskFromSlack,
  dispatchAppointmentReminderSlack,
  dispatchTaskAssignedSlack,
  refreshSlackMessage,
} from "./dispatch";

type SelectRow = Record<string, unknown> | null;
type SupabaseMockOptions = {
  userOAuthRow?: SelectRow;
  taskRow?: SelectRow;
  propertyRow?: SelectRow;
  updateError?: { message: string } | null;
};

function makeSupabase(opts: SupabaseMockOptions = {}) {
  const updates: Array<{ table: string; payload: unknown }> = [];

  function responseFor(table: string) {
    if (table === "user_oauth_tokens") return opts.userOAuthRow ?? null;
    if (table === "tasks") return opts.taskRow ?? null;
    if (table === "properties") return opts.propertyRow ?? null;
    return null;
  }

  return {
    updates,
    from(table: string) {
      const builder = {
        select: vi.fn(() => builder),
        update: vi.fn((payload: unknown) => {
          updates.push({ table, payload });
          return builder;
        }),
        eq: vi.fn(() => builder),
        maybeSingle: vi.fn(async () => ({
          data: responseFor(table),
          error: null,
        })),
        single: vi.fn(async () => ({
          data: opts.taskRow ?? { id: "task-1" },
          error: null,
        })),
        then: (
          onFulfilled: (value: { error: { message: string } | null }) => unknown,
          onRejected?: (reason: unknown) => unknown,
        ) =>
          Promise.resolve({ error: opts.updateError ?? null }).then(
            onFulfilled,
            onRejected,
          ),
      };
      return builder;
    },
  };
}

const dispatchInput = {
  taskId: "11111111-1111-4111-8111-111111111111",
  assigneeId: "user-1",
  taskTitle: "Call the owner",
  taskType: "callback",
  dueAt: "2026-05-10T15:00:00.000Z",
  propertyAddress: "123 Slack Test Ln",
  deepLink: "https://sandra-sooty.vercel.app/tasks/11111111-1111-4111-8111-111111111111",
  timezone: "America/Chicago",
};

describe("slack/dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createAdminClient.mockReturnValue(makeSupabase());
    loadIntegrationPrefs.mockResolvedValue({
      slackEnabled: true,
      calendarEnabled: true,
      timezone: "America/Chicago",
    });
    getDecryptedToken.mockResolvedValue({
      accessToken: new OAuthSecret("xoxb-test"),
      refreshToken: null,
      expiresAt: null,
      scopes: ["chat:write"],
      externalAccountId: "U_TEST",
    });
    conversationsOpen.mockResolvedValue({ channel: { id: "D123" } });
    chatPostMessage.mockResolvedValue({ ts: "1710000000.000100" });
    chatUpdate.mockResolvedValue({ ok: true });
    completeTask.mockResolvedValue({ ok: true, data: { id: dispatchInput.taskId } });
  });

  it("dispatchTaskAssignedSlack short-circuits when user pref disabled", async () => {
    loadIntegrationPrefs.mockResolvedValueOnce({
      slackEnabled: false,
      calendarEnabled: true,
      timezone: "America/Chicago",
    });

    await expect(dispatchTaskAssignedSlack(dispatchInput)).resolves.toEqual({
      sent: false,
      reason: "pref_disabled",
    });
    expect(getDecryptedToken).not.toHaveBeenCalled();
  });

  it("dispatchTaskAssignedSlack short-circuits when no bot token row", async () => {
    getDecryptedToken.mockResolvedValueOnce(null);

    await expect(dispatchTaskAssignedSlack(dispatchInput)).resolves.toEqual({
      sent: false,
      reason: "no_token",
    });
    expect(conversationsOpen).not.toHaveBeenCalled();
  });

  it("dispatchTaskAssignedSlack calls conversations.open then chat.postMessage", async () => {
    await dispatchTaskAssignedSlack(dispatchInput);

    expect(conversationsOpen).toHaveBeenCalledWith({ users: "U_TEST" });
    expect(chatPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "D123",
        text: "Task assigned: Call the owner",
      }),
    );
  });

  it("dispatchTaskAssignedSlack updates tasks.slack_channel_id + slack_message_ts after successful post", async () => {
    const supabase = makeSupabase();
    createAdminClient.mockReturnValueOnce(supabase);

    await expect(dispatchTaskAssignedSlack(dispatchInput)).resolves.toEqual({
      sent: true,
      channel: "D123",
      messageTs: "1710000000.000100",
    });
    expect(supabase.updates).toContainEqual({
      table: "tasks",
      payload: {
        slack_channel_id: "D123",
        slack_message_ts: "1710000000.000100",
      },
    });
  });

  it("dispatchTaskAssignedSlack truncates taskTitle longer than 60 chars", async () => {
    await dispatchTaskAssignedSlack({
      ...dispatchInput,
      taskTitle: "A".repeat(61),
    });

    expect(chatPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: `Task assigned: ${"A".repeat(57)}...`,
      }),
    );
  });

  it("dispatchTaskAssignedSlack formats dueLabel from input.timezone even when prefs.timezone disagrees", async () => {
    vi.useFakeTimers();
    try {
      // now = 2026-08-15 01:00 CDT / 2026-08-14 23:00 PDT — Chicago's
      // calendar day is already the 15th; LA's is still the 14th.
      vi.setSystemTime(new Date("2026-08-15T06:00:00Z"));

      // slackEnabled intentionally omitted so loadIntegrationPrefs is still
      // called (for the slackEnabled flag) — its timezone must NOT leak
      // into the dueLabel.
      loadIntegrationPrefs.mockResolvedValueOnce({
        slackEnabled: true,
        calendarEnabled: true,
        timezone: "America/Los_Angeles",
      });

      await dispatchTaskAssignedSlack({
        ...dispatchInput,
        timezone: "America/Chicago",
        // 2026-08-15T07:30:00Z = 02:30 CDT (still Chicago's 15th, "today")
        // but 00:30 PDT (LA's 15th — one day after LA's "now" of the 14th,
        // "tomorrow"). Chicago and LA disagree on the label for this pair,
        // so this proves which zone actually drove the label.
        dueAt: "2026-08-15T07:30:00Z",
      });

      expect(chatPostMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          blocks: expect.arrayContaining([
            expect.objectContaining({
              type: "context",
              elements: expect.arrayContaining([
                expect.objectContaining({
                  text: expect.stringContaining("Due today"),
                }),
              ]),
            }),
          ]),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("dispatchTaskAssignedSlack does not call loadIntegrationPrefs at all when slackEnabled is passed explicitly", async () => {
    await dispatchTaskAssignedSlack({
      ...dispatchInput,
      slackEnabled: true,
    });

    expect(loadIntegrationPrefs).not.toHaveBeenCalled();
  });

  it("dispatchTaskAssignedSlack degrades a garbage input.timezone to America/Chicago via normalizeTimeZone", async () => {
    vi.useFakeTimers();
    try {
      // Same fixture as the input.timezone test above: Chicago reads
      // "today" for this now/dueAt pair, so a garbage zone that degrades
      // to Chicago must produce the same label.
      vi.setSystemTime(new Date("2026-08-15T06:00:00Z"));

      await dispatchTaskAssignedSlack({
        ...dispatchInput,
        slackEnabled: true,
        timezone: "Not/A_Real_Zone",
        dueAt: "2026-08-15T07:30:00Z",
      });

      expect(chatPostMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          blocks: expect.arrayContaining([
            expect.objectContaining({
              type: "context",
              elements: expect.arrayContaining([
                expect.objectContaining({
                  text: expect.stringContaining("Due today"),
                }),
              ]),
            }),
          ]),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("dispatchTaskAssignedSlack still sends using input.timezone when the (unused) prefs load would have failed", async () => {
    // slackEnabled supplied short-circuits the `??` before
    // loadIntegrationPrefs is ever awaited, so a rejection here must never
    // surface — proving the send path doesn't depend on prefs succeeding.
    loadIntegrationPrefs.mockRejectedValueOnce(new Error("prefs unavailable"));

    await expect(
      dispatchTaskAssignedSlack({
        ...dispatchInput,
        slackEnabled: true,
        timezone: "America/Denver",
      }),
    ).resolves.toEqual({
      sent: true,
      channel: "D123",
      messageTs: "1710000000.000100",
    });
    expect(loadIntegrationPrefs).not.toHaveBeenCalled();
    expect(chatPostMessage).toHaveBeenCalled();
  });

  it("dispatchTaskAssignedSlack on chat.postMessage rejection reportErrors and does not throw", async () => {
    chatPostMessage.mockRejectedValueOnce(new Error("Slack unavailable"));

    await expect(dispatchTaskAssignedSlack(dispatchInput)).resolves.toEqual({
      sent: false,
      reason: "error",
    });
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { surface: "slack_task_dispatch" } }),
    );
  });

  const reminderInput = {
    taskId: "22222222-2222-4222-8222-222222222222",
    assigneeId: "user-1",
    taskTitle: "Walkthrough with seller",
    dueAt: "2026-08-15T20:00:00.000Z",
    timezone: "America/Chicago",
    deepLink: "https://sandra-sooty.vercel.app/tasks/22222222-2222-4222-8222-222222222222",
  };

  it("dispatchAppointmentReminderSlack short-circuits when pref disabled", async () => {
    loadIntegrationPrefs.mockResolvedValueOnce({
      slackEnabled: false,
      calendarEnabled: true,
      timezone: "America/Chicago",
    });

    await expect(dispatchAppointmentReminderSlack(reminderInput)).resolves.toEqual({
      sent: false,
      reason: "pref_disabled",
    });
    expect(getDecryptedToken).not.toHaveBeenCalled();
  });

  it("dispatchAppointmentReminderSlack short-circuits when no bot token row", async () => {
    getDecryptedToken.mockResolvedValueOnce(null);

    await expect(dispatchAppointmentReminderSlack(reminderInput)).resolves.toEqual({
      sent: false,
      reason: "no_token",
    });
    expect(conversationsOpen).not.toHaveBeenCalled();
  });

  // Codex round 6 (finding 2): the reminder sweep is budget-bound (45s
  // phase budget, route.ts) — an unbounded WebClient (no timeout, 10
  // SDK-internal retries over ~30 minutes by default) can blow through it
  // on a single call. Scoped to this path only; dispatchTaskAssignedSlack
  // (the seller-facing send) must be untouched — asserted separately below.
  it("dispatchAppointmentReminderSlack constructs its WebClient with an explicit timeout and zero SDK retries", async () => {
    await dispatchAppointmentReminderSlack(reminderInput);

    expect(webClientConstructor).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ timeout: expect.any(Number), retryConfig: { retries: 0 } }),
    );
  });

  it("dispatchTaskAssignedSlack (seller-facing) does NOT get the reminder path's timeout/retry override", async () => {
    await dispatchTaskAssignedSlack(dispatchInput);

    expect(webClientConstructor).toHaveBeenCalledWith(expect.any(String), undefined);
  });

  it("dispatchAppointmentReminderSlack posts appointment-reminder blocks with the time-of-day in the assignee's zone", async () => {
    await dispatchAppointmentReminderSlack(reminderInput);

    expect(chatPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "D123",
        text: expect.stringContaining("Appointment in 30 min: Walkthrough with seller at"),
        blocks: expect.arrayContaining([
          expect.objectContaining({ type: "header" }),
          expect.objectContaining({ type: "context" }),
        ]),
      }),
    );
  });

  it("dispatchAppointmentReminderSlack never includes a Mark Done action block", async () => {
    await dispatchAppointmentReminderSlack(reminderInput);

    const call = chatPostMessage.mock.calls[0]?.[0] as { blocks: { type: string }[] };
    expect(call.blocks.some((block) => block.type === "actions")).toBe(false);
  });

  it("dispatchAppointmentReminderSlack does not call loadIntegrationPrefs when slackEnabled is passed explicitly", async () => {
    await dispatchAppointmentReminderSlack({ ...reminderInput, slackEnabled: true });

    expect(loadIntegrationPrefs).not.toHaveBeenCalled();
  });

  it("dispatchAppointmentReminderSlack on chat.postMessage rejection reportErrors and does not throw", async () => {
    chatPostMessage.mockRejectedValueOnce(new Error("Slack unavailable"));

    await expect(dispatchAppointmentReminderSlack(reminderInput)).resolves.toEqual({
      sent: false,
      reason: "error",
    });
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { surface: "slack_appointment_reminder_dispatch" } }),
    );
  });

  it("completeTaskFromSlack returns auth when no Sandra user maps to the Slack user", async () => {
    createAdminClient.mockReturnValueOnce(makeSupabase({ userOAuthRow: null }));

    await expect(
      completeTaskFromSlack({
        taskId: dispatchInput.taskId,
        slackUserId: "U_MISSING",
        teamId: "T_TEST",
      }),
    ).resolves.toEqual({ ok: false, reason: "auth" });
  });

  it("completeTaskFromSlack returns not_assignee when the task belongs to another user", async () => {
    createAdminClient.mockReturnValueOnce(
      makeSupabase({
        userOAuthRow: { user_id: "user-1" },
        taskRow: { id: dispatchInput.taskId, assignee_id: "user-2", status: "open" },
      }),
    );

    await expect(
      completeTaskFromSlack({
        taskId: dispatchInput.taskId,
        slackUserId: "U_TEST",
        teamId: "T_TEST",
      }),
    ).resolves.toEqual({ ok: false, reason: "not_assignee" });
  });

  it("completeTaskFromSlack is idempotent for already-completed tasks", async () => {
    createAdminClient.mockReturnValueOnce(
      makeSupabase({
        userOAuthRow: { user_id: "user-1" },
        taskRow: { id: dispatchInput.taskId, assignee_id: "user-1", status: "completed" },
      }),
    );

    await expect(
      completeTaskFromSlack({
        taskId: dispatchInput.taskId,
        slackUserId: "U_TEST",
        teamId: "T_TEST",
      }),
    ).resolves.toEqual({ ok: true });
    expect(completeTask).not.toHaveBeenCalled();
  });

  it("completeTaskFromSlack calls completeTask with the resolvedUserId", async () => {
    const supabase = makeSupabase({
      userOAuthRow: { user_id: "user-1" },
      taskRow: { id: dispatchInput.taskId, assignee_id: "user-1", status: "open" },
    });
    createAdminClient.mockReturnValueOnce(supabase);

    await expect(
      completeTaskFromSlack({
        taskId: dispatchInput.taskId,
        slackUserId: "U_TEST",
        teamId: "T_TEST",
      }),
    ).resolves.toEqual({ ok: true });
    expect(completeTask).toHaveBeenCalledWith(
      supabase,
      dispatchInput.taskId,
      "user-1",
    );
  });

  it("refreshSlackMessage calls chat.update with the stored channel/messageTs", async () => {
    createAdminClient.mockReturnValueOnce(
      makeSupabase({
        taskRow: {
          id: dispatchInput.taskId,
          assignee_id: "user-1",
          title: "Call owner",
          related_property_id: "property-1",
        },
        propertyRow: { address: "123 Slack Test Ln" },
      }),
    );

    await expect(
      refreshSlackMessage({
        channel: "D123",
        messageTs: "1710000000.000100",
        taskId: dispatchInput.taskId,
        doneByUserName: "Jarrad",
      }),
    ).resolves.toEqual({ ok: true });
    expect(chatUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "D123",
        ts: "1710000000.000100",
        text: "Marked done",
      }),
    );
  });

  it("refreshSlackMessage on Slack error reportErrors and never throws", async () => {
    createAdminClient.mockReturnValueOnce(
      makeSupabase({
        taskRow: {
          id: dispatchInput.taskId,
          assignee_id: "user-1",
          title: "Call owner",
          related_property_id: "property-1",
        },
        propertyRow: { address: "123 Slack Test Ln" },
      }),
    );
    chatUpdate.mockRejectedValueOnce(new Error("Slack update failed"));

    await expect(
      refreshSlackMessage({
        channel: "D123",
        messageTs: "1710000000.000100",
        taskId: dispatchInput.taskId,
        doneByUserName: "Jarrad",
      }),
    ).resolves.toEqual({ ok: false });
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { surface: "slack_task_refresh" } }),
    );
  });
});
