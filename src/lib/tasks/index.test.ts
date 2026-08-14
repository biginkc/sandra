import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  afterCallbacks,
  afterMock,
  dispatchTaskCalendarEventUpdate,
  loadIntegrationPrefs,
} = vi.hoisted(() => ({
  afterCallbacks: [] as Array<() => Promise<void> | void>,
  afterMock: vi.fn((callback: () => Promise<void> | void) => {
    afterCallbacks.push(callback);
  }),
  dispatchTaskCalendarEventUpdate: vi.fn(async () => ({
    inserted: true,
    eventId: "event-1",
  })),
  loadIntegrationPrefs: vi.fn(async () => ({
    slackEnabled: true,
    calendarEnabled: true,
    timezone: "America/Chicago",
  })),
}));

vi.mock("next/server", () => ({ after: afterMock }));
vi.mock("@/lib/integrations/google/dispatch", () => ({
  dispatchTaskCalendarEventUpdate,
}));
vi.mock("@/lib/integrations/prefs", () => ({ loadIntegrationPrefs }));

import {
  completeTask,
  createTask,
  dispoToTaskType,
  reassignTask,
  snoozeTask,
} from "./index";

type Response = { data: unknown; error: { message: string } | null };

type CallRecord = {
  table: string;
  op: "select" | "insert" | "update";
  insertPayload?: unknown;
  updatePayload?: unknown;
  filters: Array<{ op: string; args: unknown[] }>;
};

let responseQueue: Response[] = [];
let calls: CallRecord[] = [];

function makeBuilder(record: CallRecord): Record<string, unknown> {
  const builder: Record<string, unknown> = {};

  const thenable = {
    then(
      onFulfilled: (v: Response) => unknown,
      onRejected?: (r: unknown) => unknown,
    ) {
      const resp = responseQueue.shift();
      if (!resp) {
        return Promise.reject(
          new Error(
            `tasks.test: no mock response queued for ${record.table}.${record.op}`,
          ),
        ).then(onFulfilled, onRejected);
      }
      return Promise.resolve(resp).then(onFulfilled, onRejected);
    },
  };

  builder.select = () => builder;
  builder.insert = (payload: unknown) => {
    record.insertPayload = payload;
    record.op = "insert";
    return builder;
  };
  builder.update = (payload: unknown) => {
    record.updatePayload = payload;
    record.op = "update";
    return builder;
  };
  builder.eq = (...args: unknown[]) => {
    record.filters.push({ op: "eq", args });
    return builder;
  };
  builder.neq = (...args: unknown[]) => {
    record.filters.push({ op: "neq", args });
    return builder;
  };
  builder.single = () => thenable;
  builder.maybeSingle = () => thenable;
  builder.then = thenable.then;

  return builder;
}

function makeSupabase() {
  return {
    from: vi.fn((table: string) => {
      const record: CallRecord = { table, op: "select", filters: [] };
      calls.push(record);
      return makeBuilder(record);
    }),
  };
}

beforeEach(() => {
  responseQueue = [];
  calls = [];
  afterCallbacks.length = 0;
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.test");
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("dispoToTaskType", () => {
  it("maps callback_requested → 'callback'", () => {
    expect(dispoToTaskType("callback_requested")).toBe("callback");
  });

  it("maps nurture → 'follow_up'", () => {
    expect(dispoToTaskType("nurture")).toBe("follow_up");
  });
});

describe("createTask", () => {
  it("inserts the row with all input fields and returns ok(task)", async () => {
    const fakeRow = { id: "task-1", title: "test", status: "open" };
    responseQueue = [{ data: fakeRow, error: null }];

    const result = await createTask(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      {
        orgId: "org-1",
        assigneeId: "user-2",
        relatedPropertyId: "prop-3",
        type: "follow_up",
        title: "Follow up on 123 Main",
        dueAt: "2026-05-08T14:00:00Z",
        createdBy: "user-1",
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual(fakeRow);

    const insert = calls.find(
      (c) => c.table === "tasks" && c.op === "insert",
    );
    expect(insert).toBeDefined();
    const payload = insert!.insertPayload as Record<string, unknown>;
    expect(payload.org_id).toBe("org-1");
    expect(payload.assignee_id).toBe("user-2");
    expect(payload.related_property_id).toBe("prop-3");
    expect(payload.type).toBe("follow_up");
    expect(payload.title).toBe("Follow up on 123 Main");
    expect(payload.due_at).toBe("2026-05-08T14:00:00Z");
    expect(payload.created_by).toBe("user-1");
    // Migration-added columns must be entirely absent (not merely null) from
    // a legacy follow_up payload — the conditional spreads only ride along
    // when their inputs are actually provided, so old-schema-compatible
    // inserts keep working during the post-deploy pre-migration window.
    expect("contact_id" in payload).toBe(false);
    expect("description" in payload).toBe(false);
    expect("end_at" in payload).toBe(false);
    expect("calendar_chain_id" in payload).toBe(false);
  });

  it("inserts a property-less appointment with contact/description/endAt and nulls related_property_id", async () => {
    const fakeRow = { id: "task-2", title: "Book a call", status: "open" };
    responseQueue = [{ data: fakeRow, error: null }];

    const result = await createTask(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      {
        orgId: "org-1",
        assigneeId: "user-2",
        contactId: "contact-9",
        type: "appointment",
        title: "Book a call",
        description: "Discuss offer terms",
        dueAt: "2026-05-08T14:00:00Z",
        endAt: "2026-05-08T14:30:00Z",
        createdBy: "user-1",
      },
    );

    expect(result.ok).toBe(true);
    const insert = calls.find(
      (c) => c.table === "tasks" && c.op === "insert",
    );
    const payload = insert!.insertPayload as Record<string, unknown>;
    expect(payload.related_property_id).toBeNull();
    expect(payload.contact_id).toBe("contact-9");
    expect(payload.description).toBe("Discuss offer terms");
    expect(payload.end_at).toBe("2026-05-08T14:30:00Z");
    expect(payload.type).toBe("appointment");
    // calendar_chain_id rides along too — the DB's chain invariant requires
    // every appointment to carry one, generated here at creation.
    expect(typeof payload.calendar_chain_id).toBe("string");
    expect((payload.calendar_chain_id as string).length).toBeGreaterThan(0);
  });

  it("returns err with TASK_CREATE_FAILED when supabase errors", async () => {
    responseQueue = [{ data: null, error: { message: "rls denied" } }];

    const result = await createTask(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      {
        orgId: "org-1",
        assigneeId: "user-2",
        relatedPropertyId: "prop-3",
        type: "callback",
        title: "Call back",
        dueAt: "2026-05-08T14:00:00Z",
        createdBy: "user-1",
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("TASK_CREATE_FAILED");
    expect(result.error.message).toBe("rls denied");
  });

  it("returns err(TASK_CREATE_INVALID) for an appointment with no endAt, issuing no insert", async () => {
    const result = await createTask(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      {
        orgId: "org-1",
        assigneeId: "user-2",
        type: "appointment",
        title: "Book a call",
        dueAt: "2026-05-08T14:00:00Z",
        createdBy: "user-1",
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("TASK_CREATE_INVALID");
    expect(result.error.message).toBe(
      "Appointments require an end time after their start time.",
    );
    expect(calls.find((c) => c.table === "tasks" && c.op === "insert")).toBeUndefined();
  });

  it("returns err(TASK_CREATE_INVALID) for an appointment with endAt <= dueAt, issuing no insert", async () => {
    const result = await createTask(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      {
        orgId: "org-1",
        assigneeId: "user-2",
        type: "appointment",
        title: "Book a call",
        dueAt: "2026-05-08T14:00:00Z",
        endAt: "2026-05-08T14:00:00Z",
        createdBy: "user-1",
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("TASK_CREATE_INVALID");
    expect(calls.find((c) => c.table === "tasks" && c.op === "insert")).toBeUndefined();
  });

  it("returns err(TASK_CREATE_INVALID) for a follow_up carrying endAt, issuing no insert", async () => {
    const result = await createTask(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      {
        orgId: "org-1",
        assigneeId: "user-2",
        relatedPropertyId: "prop-3",
        type: "follow_up",
        title: "Follow up",
        dueAt: "2026-05-08T14:00:00Z",
        endAt: "2026-05-08T14:30:00Z",
        createdBy: "user-1",
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("TASK_CREATE_INVALID");
    expect(calls.find((c) => c.table === "tasks" && c.op === "insert")).toBeUndefined();
  });
});

describe("completeTask", () => {
  it("flips status to completed and stamps completed_at + completed_by, excluding appointments via the atomic predicate", async () => {
    const fakeRow = {
      id: "task-1",
      status: "completed",
      completed_at: "2026-05-06T18:00:00Z",
      completed_by: "user-1",
    };
    responseQueue = [{ data: fakeRow, error: null }];

    const result = await completeTask(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      "task-1",
      "user-1",
    );

    expect(result.ok).toBe(true);
    const taskCalls = calls.filter((c) => c.table === "tasks");
    expect(taskCalls).toHaveLength(1);
    const update = taskCalls[0];
    expect(update.op).toBe("update");
    const payload = update.updatePayload as Record<string, unknown>;
    expect(payload.status).toBe("completed");
    expect(payload.completed_by).toBe("user-1");
    expect(typeof payload.completed_at).toBe("string");
    expect(typeof payload.updated_at).toBe("string");

    expect(update.filters).toEqual([
      { op: "eq", args: ["id", "task-1"] },
      { op: "neq", args: ["type", "appointment"] },
    ]);
  });

  it("refuses to complete an appointment — UPDATE excludes it (neq predicate), follow-up read confirms type, returns TASK_COMPLETE_UNSUPPORTED", async () => {
    responseQueue = [
      // UPDATE's neq predicate excludes the row: zero rows back.
      { data: null, error: null },
      // Follow-up type read distinguishes appointment from missing.
      { data: { type: "appointment" }, error: null },
    ];

    const result = await completeTask(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      "task-1",
      "user-1",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TASK_COMPLETE_UNSUPPORTED");
    }
    const taskCalls = calls.filter((c) => c.table === "tasks");
    expect(taskCalls).toHaveLength(2);
    expect(taskCalls[0].op).toBe("update");
    expect(taskCalls[0].filters).toEqual([
      { op: "eq", args: ["id", "task-1"] },
      { op: "neq", args: ["type", "appointment"] },
    ]);
    expect(taskCalls[1].op).toBe("select");
  });

  it("fails closed when the UPDATE errors — no follow-up read, no fall-through write", async () => {
    responseQueue = [{ data: null, error: { message: "connection reset" } }];

    const result = await completeTask(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      "task-1",
      "user-1",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TASK_COMPLETE_FAILED");
      expect(result.error.message).toBe("connection reset");
    }
    // The error short-circuits before any follow-up read.
    const taskCalls = calls.filter((c) => c.table === "tasks");
    expect(taskCalls).toHaveLength(1);
    expect(taskCalls[0].op).toBe("update");
  });

  it("returns TASK_COMPLETE_FAILED when the task doesn't exist (UPDATE and follow-up read both empty)", async () => {
    responseQueue = [
      { data: null, error: null },
      { data: null, error: null },
    ];

    const result = await completeTask(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      "missing-task",
      "user-1",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TASK_COMPLETE_FAILED");
    }
    const taskCalls = calls.filter((c) => c.table === "tasks");
    expect(taskCalls).toHaveLength(2);
  });
});

describe("snoozeTask", () => {
  it("bumps due_at and snoozed_until forward, leaves status unchanged, omits end_at, and issues no pre-read for a non-appointment row", async () => {
    responseQueue = [
      // The UPDATE itself carries .neq("type", "appointment") and returns
      // the row directly — no pre-read before it.
      { data: { id: "task-1", due_at: "2026-05-09T14:00:00Z" }, error: null },
    ];

    const result = await snoozeTask(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      "task-1",
      "2026-05-09T14:00:00Z",
    );

    expect(result.ok).toBe(true);
    // Exactly one tasks call: the UPDATE. No pre-read fired.
    const taskCalls = calls.filter((c) => c.table === "tasks");
    expect(taskCalls).toHaveLength(1);
    const update = taskCalls[0];
    expect(update.op).toBe("update");
    const payload = update.updatePayload as Record<string, unknown>;
    expect(payload.due_at).toBe("2026-05-09T14:00:00Z");
    expect(payload.snoozed_until).toBe("2026-05-09T14:00:00Z");
    expect(payload.status).toBeUndefined();
    expect(payload.end_at).toBeUndefined();
    expect(update.filters).toEqual([
      { op: "eq", args: ["id", "task-1"] },
      { op: "neq", args: ["type", "appointment"] },
    ]);
  });

  it("refuses to snooze an appointment — UPDATE excludes it (neq predicate), follow-up read confirms type, returns TASK_SNOOZE_UNSUPPORTED", async () => {
    responseQueue = [
      // UPDATE's neq predicate excludes the row: zero rows back.
      { data: null, error: null },
      // Follow-up type read distinguishes appointment from missing.
      { data: { type: "appointment" }, error: null },
    ];

    const result = await snoozeTask(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      "task-1",
      "2026-05-10T16:00:00Z",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TASK_SNOOZE_UNSUPPORTED");
    }
    const taskCalls = calls.filter((c) => c.table === "tasks");
    expect(taskCalls).toHaveLength(2);
    expect(taskCalls[0].op).toBe("update");
    expect(taskCalls[0].filters).toEqual([
      { op: "eq", args: ["id", "task-1"] },
      { op: "neq", args: ["type", "appointment"] },
    ]);
    expect(taskCalls[1].op).toBe("select");
  });

  it("fails closed when the UPDATE errors — no follow-up read, no fall-through write", async () => {
    responseQueue = [{ data: null, error: { message: "connection reset" } }];

    const result = await snoozeTask(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      "task-1",
      "2026-05-10T16:00:00Z",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TASK_SNOOZE_FAILED");
      expect(result.error.message).toBe("connection reset");
    }
    // The error short-circuits before any follow-up read.
    const taskCalls = calls.filter((c) => c.table === "tasks");
    expect(taskCalls).toHaveLength(1);
    expect(taskCalls[0].op).toBe("update");
  });

  it("returns TASK_SNOOZE_FAILED when the task doesn't exist (UPDATE and follow-up read both empty)", async () => {
    responseQueue = [
      { data: null, error: null },
      { data: null, error: null },
    ];

    const result = await snoozeTask(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      "missing-task",
      "2026-05-10T16:00:00Z",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TASK_SNOOZE_FAILED");
    }
    const taskCalls = calls.filter((c) => c.table === "tasks");
    expect(taskCalls).toHaveLength(2);
  });

  it("schedules a Google Calendar update when snooze changes due_at", async () => {
    responseQueue = [
      {
        data: {
          id: "task-1",
          assignee_id: "user-2",
          related_property_id: "property-3",
          title: "Call the owner",
          due_at: "2026-05-09T14:00:00Z",
        },
        error: null,
      },
      {
        data: { address: "123 Snooze Ln" },
        error: null,
      },
    ];
    loadIntegrationPrefs.mockResolvedValueOnce({
      slackEnabled: true,
      calendarEnabled: true,
      timezone: "America/Denver",
    });

    const result = await snoozeTask(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      "task-1",
      "2026-05-09T14:00:00Z",
    );

    expect(result.ok).toBe(true);
    expect(loadIntegrationPrefs).toHaveBeenCalledWith(
      expect.anything(),
      "user-2",
    );
    expect(afterMock).toHaveBeenCalledTimes(1);

    await flushAfterCallbacks();

    expect(dispatchTaskCalendarEventUpdate).toHaveBeenCalledWith({
      taskId: "task-1",
      assigneeId: "user-2",
      taskTitle: "Call the owner",
      propertyAddress: "123 Snooze Ln",
      dueAt: "2026-05-09T14:00:00Z",
      timezone: "America/Denver",
      deepLink: "https://app.test/messages?property_id=property-3",
      calendarEnabled: true,
    });
  });

  it("schedules a title-only calendar update and a thread deep link for a contact-only task (no property)", async () => {
    responseQueue = [
      {
        data: {
          id: "task-1",
          assignee_id: "user-2",
          related_property_id: null,
          contact_id: "contact-9",
          title: "Call the owner",
          due_at: "2026-05-09T14:00:00Z",
        },
        error: null,
      },
    ];
    loadIntegrationPrefs.mockResolvedValueOnce({
      slackEnabled: true,
      calendarEnabled: true,
      timezone: "America/Denver",
    });

    const result = await snoozeTask(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      "task-1",
      "2026-05-09T14:00:00Z",
    );

    expect(result.ok).toBe(true);
    // No property lookup should fire — only the tasks update call.
    expect(calls.filter((c) => c.table === "properties")).toHaveLength(0);
    await flushAfterCallbacks();

    expect(dispatchTaskCalendarEventUpdate).toHaveBeenCalledWith({
      taskId: "task-1",
      assigneeId: "user-2",
      taskTitle: "Call the owner",
      propertyAddress: "Call the owner",
      dueAt: "2026-05-09T14:00:00Z",
      timezone: "America/Denver",
      deepLink: "https://app.test/messages?thread=contact-9",
      calendarEnabled: true,
    });
  });

  it("falls back to the base URL deep link for a fully unlinked personal block", async () => {
    responseQueue = [
      {
        data: {
          id: "task-1",
          assignee_id: "user-2",
          related_property_id: null,
          contact_id: null,
          title: "Block 2pm-3pm",
          due_at: "2026-05-09T14:00:00Z",
        },
        error: null,
      },
    ];
    loadIntegrationPrefs.mockResolvedValueOnce({
      slackEnabled: true,
      calendarEnabled: true,
      timezone: "America/Denver",
    });

    await snoozeTask(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      "task-1",
      "2026-05-09T14:00:00Z",
    );
    await flushAfterCallbacks();

    expect(dispatchTaskCalendarEventUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        propertyAddress: "Block 2pm-3pm",
        deepLink: "https://app.test",
      }),
    );
  });
});

describe("reassignTask", () => {
  it("updates assignee_id and bumps updated_at, excluding appointments via the atomic predicate", async () => {
    responseQueue = [
      {
        data: { id: "task-1", assignee_id: "user-2" },
        error: null,
      },
    ];

    const result = await reassignTask(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      "task-1",
      "user-2",
    );

    expect(result.ok).toBe(true);
    const taskCalls = calls.filter((c) => c.table === "tasks");
    expect(taskCalls).toHaveLength(1);
    const update = taskCalls[0];
    expect(update.op).toBe("update");
    const payload = update.updatePayload as Record<string, unknown>;
    expect(payload.assignee_id).toBe("user-2");
    expect(typeof payload.updated_at).toBe("string");
    expect(update.filters).toEqual([
      { op: "eq", args: ["id", "task-1"] },
      { op: "neq", args: ["type", "appointment"] },
    ]);
  });

  it("refuses to reassign an appointment — UPDATE excludes it (neq predicate), follow-up read confirms type, returns TASK_REASSIGN_UNSUPPORTED", async () => {
    responseQueue = [
      // UPDATE's neq predicate excludes the row: zero rows back.
      { data: null, error: null },
      // Follow-up type read distinguishes appointment from missing.
      { data: { type: "appointment" }, error: null },
    ];

    const result = await reassignTask(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      "task-1",
      "user-2",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TASK_REASSIGN_UNSUPPORTED");
    }
    const taskCalls = calls.filter((c) => c.table === "tasks");
    expect(taskCalls).toHaveLength(2);
    expect(taskCalls[0].op).toBe("update");
    expect(taskCalls[0].filters).toEqual([
      { op: "eq", args: ["id", "task-1"] },
      { op: "neq", args: ["type", "appointment"] },
    ]);
    expect(taskCalls[1].op).toBe("select");
  });

  it("fails closed when the UPDATE errors — no follow-up read, no fall-through write", async () => {
    responseQueue = [{ data: null, error: { message: "connection reset" } }];

    const result = await reassignTask(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      "task-1",
      "user-bogus",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TASK_REASSIGN_FAILED");
      expect(result.error.message).toBe("connection reset");
    }
    // The error short-circuits before any follow-up read.
    const taskCalls = calls.filter((c) => c.table === "tasks");
    expect(taskCalls).toHaveLength(1);
    expect(taskCalls[0].op).toBe("update");
  });

  it("returns TASK_REASSIGN_FAILED when the task doesn't exist (UPDATE and follow-up read both empty)", async () => {
    responseQueue = [
      { data: null, error: null },
      { data: null, error: null },
    ];

    const result = await reassignTask(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      "missing-task",
      "user-2",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TASK_REASSIGN_FAILED");
      expect(result.error.message).toBe("Failed to reassign task");
    }
    const taskCalls = calls.filter((c) => c.table === "tasks");
    expect(taskCalls).toHaveLength(2);
  });
});

async function flushAfterCallbacks(): Promise<void> {
  const callbacks = [...afterCallbacks];
  afterCallbacks.length = 0;
  await Promise.all(callbacks.map((callback) => callback()));
}
