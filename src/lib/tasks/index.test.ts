import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  afterCallbacks,
  afterMock,
  dispatchTaskCalendarEventUpdate,
  loadIntegrationPrefs,
  recordLeadEvent,
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
  recordLeadEvent: vi.fn(async (input: unknown) => {
    void input;
  }),
}));

vi.mock("next/server", () => ({ after: afterMock }));
vi.mock("@/lib/integrations/google/dispatch", () => ({
  dispatchTaskCalendarEventUpdate,
}));
vi.mock("@/lib/integrations/prefs", () => ({ loadIntegrationPrefs }));
vi.mock("@/lib/events", () => ({
  LEAD_EVENT_TYPES: {
    TASK_CREATED: "task_created",
    TASK_COMPLETED: "task_completed",
    TASK_SNOOZED: "task_snoozed",
    TASK_REASSIGNED: "task_reassigned",
  },
  recordLeadEvent,
}));

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
  expect(responseQueue).toHaveLength(0);
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
    const fakeRow = {
      id: "task-1",
      title: "test",
      status: "open",
      type: "follow_up",
      due_at: "2026-05-08T14:00:00Z",
      assignee_id: "user-2",
      related_property_id: "prop-3",
    };
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

    const insert = calls.find((c) => c.table === "tasks" && c.op === "insert");
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
    expect(recordLeadEvent).toHaveBeenCalledWith({
      propertyId: "prop-3",
      actorType: "user",
      actorId: "user-1",
      eventType: "task_created",
      payload: {
        task_id: "task-1",
        task_type: "follow_up",
        due_at: "2026-05-08T14:00:00Z",
        assignee_id: "user-2",
      },
      sourceType: "tasks.created",
      sourceId: "task-1",
    });
    expect(recordLeadEvent.mock.calls[0]?.[0]).not.toHaveProperty(
      "payload.title",
    );
    expect(recordLeadEvent.mock.calls[0]?.[0]).not.toHaveProperty(
      "payload.description",
    );
  });

  it("inserts a property-less appointment with contact/description/endAt and nulls related_property_id", async () => {
    const fakeRow = {
      id: "task-2",
      title: "Book a call",
      status: "open",
      type: "appointment",
      related_property_id: null,
    };
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
    const insert = calls.find((c) => c.table === "tasks" && c.op === "insert");
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
    expect(recordLeadEvent).not.toHaveBeenCalled();
  });

  it("does not duplicate a property-linked appointment as task_created", async () => {
    const fakeRow = {
      id: "appointment-1",
      title: "Private appointment",
      status: "open",
      type: "appointment",
      related_property_id: "prop-3",
    };
    responseQueue = [{ data: fakeRow, error: null }];

    const result = await createTask(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      {
        orgId: "org-1",
        assigneeId: "user-2",
        relatedPropertyId: "prop-3",
        type: "appointment",
        title: "Private appointment",
        dueAt: "2026-05-08T14:00:00Z",
        endAt: "2026-05-08T14:30:00Z",
        createdBy: "user-1",
      },
    );

    expect(result.ok).toBe(true);
    expect(recordLeadEvent).not.toHaveBeenCalled();
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
    expect(
      calls.find((c) => c.table === "tasks" && c.op === "insert"),
    ).toBeUndefined();
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
    expect(
      calls.find((c) => c.table === "tasks" && c.op === "insert"),
    ).toBeUndefined();
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
    expect(
      calls.find((c) => c.table === "tasks" && c.op === "insert"),
    ).toBeUndefined();
  });
});

function taskRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "task-1",
    type: "follow_up",
    status: "open",
    due_at: "2026-05-08T14:00:00Z",
    assignee_id: "user-1",
    related_property_id: "property-3",
    contact_id: null,
    title: "Call the owner",
    end_at: null,
    ...overrides,
  };
}

describe("completeTask", () => {
  it("records a property-linked completion only after the compare-and-set succeeds", async () => {
    const previous = taskRow();
    const completed = taskRow({
      status: "completed",
      completed_by: "user-1",
    });
    responseQueue = [
      { data: previous, error: null },
      { data: completed, error: null },
    ];

    const result = await completeTask(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      "task-1",
      "user-1",
    );

    expect(result.ok).toBe(true);
    const taskCalls = calls.filter((call) => call.table === "tasks");
    expect(taskCalls).toHaveLength(2);
    expect(taskCalls[1].op).toBe("update");
    expect(taskCalls[1].filters).toEqual([
      { op: "eq", args: ["id", "task-1"] },
      { op: "eq", args: ["status", "open"] },
      { op: "eq", args: ["assignee_id", "user-1"] },
      { op: "neq", args: ["type", "appointment"] },
    ]);
    expect(taskCalls[1].updatePayload).toEqual({
      status: "completed",
      completed_at: expect.any(String),
      completed_by: "user-1",
      updated_at: expect.any(String),
    });
    expect(recordLeadEvent).toHaveBeenCalledWith({
      propertyId: "property-3",
      actorType: "user",
      actorId: "user-1",
      eventType: "task_completed",
      payload: { task_id: "task-1", from: "open", to: "completed" },
    });
  });

  it("treats an already-completed task as a no-op without another event", async () => {
    responseQueue = [{ data: taskRow({ status: "completed" }), error: null }];

    const result = await completeTask(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      "task-1",
      "user-1",
    );

    expect(result.ok).toBe(true);
    expect(calls.filter((call) => call.table === "tasks")).toHaveLength(1);
    expect(recordLeadEvent).not.toHaveBeenCalled();
  });

  it("reconciles a concurrent same-target completion without a duplicate event", async () => {
    responseQueue = [
      { data: taskRow(), error: null },
      { data: null, error: null },
      { data: taskRow({ status: "completed" }), error: null },
    ];

    const result = await completeTask(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      "task-1",
      "user-1",
    );

    expect(result.ok).toBe(true);
    expect(recordLeadEvent).not.toHaveBeenCalled();
  });

  it("refuses appointments before issuing an update", async () => {
    responseQueue = [{ data: taskRow({ type: "appointment" }), error: null }];

    const result = await completeTask(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      "task-1",
      "user-1",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("TASK_COMPLETE_UNSUPPORTED");
    expect(calls.some((call) => call.op === "update")).toBe(false);
    expect(recordLeadEvent).not.toHaveBeenCalled();
  });

  it("does not append an event when the completion update fails", async () => {
    responseQueue = [
      { data: taskRow(), error: null },
      { data: null, error: { message: "connection reset" } },
    ];

    const result = await completeTask(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      "task-1",
      "user-1",
    );

    expect(result.ok).toBe(false);
    expect(recordLeadEvent).not.toHaveBeenCalled();
  });

  it("returns TASK_COMPLETE_FAILED when the task does not exist", async () => {
    responseQueue = [{ data: null, error: null }];
    const result = await completeTask(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      "missing-task",
      "user-1",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("TASK_COMPLETE_FAILED");
    expect(recordLeadEvent).not.toHaveBeenCalled();
  });

  it("rejects a stale Slack assignee before completion and event attribution", async () => {
    responseQueue = [{ data: taskRow({ assignee_id: "user-2" }), error: null }];
    const result = await completeTask(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      "task-1",
      "user-1",
      "user-1",
    );
    expect(result.ok).toBe(false);
    expect(calls.some((call) => call.op === "update")).toBe(false);
    expect(recordLeadEvent).not.toHaveBeenCalled();
  });

  it("fails closed when the assignee changes during a Slack completion", async () => {
    responseQueue = [
      { data: taskRow({ assignee_id: "user-1" }), error: null },
      { data: null, error: null },
      { data: taskRow({ assignee_id: "user-2" }), error: null },
    ];
    const result = await completeTask(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      "task-1",
      "user-1",
      "user-1",
    );
    expect(result.ok).toBe(false);
    const update = calls.filter((call) => call.op === "update")[0];
    expect(update.filters).toContainEqual({
      op: "eq",
      args: ["assignee_id", "user-1"],
    });
    expect(recordLeadEvent).not.toHaveBeenCalled();
  });
});

describe("snoozeTask", () => {
  it("records the old and new due time, then preserves the calendar update", async () => {
    const newDue = "2026-05-09T14:00:00Z";
    responseQueue = [
      { data: taskRow(), error: null },
      { data: taskRow({ due_at: newDue }), error: null },
      { data: { address: "123 Snooze Ln" }, error: null },
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
      newDue,
      "user-9",
    );

    expect(result.ok).toBe(true);
    const update = calls.filter((call) => call.table === "tasks")[1];
    expect(update.filters).toEqual([
      { op: "eq", args: ["id", "task-1"] },
      { op: "eq", args: ["due_at", "2026-05-08T14:00:00Z"] },
      { op: "eq", args: ["status", "open"] },
      { op: "neq", args: ["type", "appointment"] },
    ]);
    expect(update.updatePayload).toEqual({
      due_at: newDue,
      snoozed_until: newDue,
      updated_at: expect.any(String),
    });
    expect(recordLeadEvent).toHaveBeenCalledWith({
      propertyId: "property-3",
      actorType: "user",
      actorId: "user-9",
      eventType: "task_snoozed",
      payload: {
        task_id: "task-1",
        from: "2026-05-08T14:00:00Z",
        to: newDue,
      },
    });
    await flushAfterCallbacks();
    expect(dispatchTaskCalendarEventUpdate).toHaveBeenCalledWith({
      taskId: "task-1",
      assigneeId: "user-1",
      taskTitle: "Call the owner",
      propertyAddress: "123 Snooze Ln",
      dueAt: newDue,
      endAt: undefined,
      timezone: "America/Denver",
      deepLink: "https://app.test/messages?property_id=property-3",
      calendarEnabled: true,
    });
  });

  it("treats the same instant in different timestamp formats as a no-op", async () => {
    const storedDueAt = "2026-05-08T14:00:00+00:00";
    const requestedDueAt = "2026-05-08T14:00:00.000Z";
    responseQueue = [
      { data: taskRow({ due_at: storedDueAt }), error: null },
    ];
    const result = await snoozeTask(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      "task-1",
      requestedDueAt,
      "user-9",
    );
    expect(result.ok).toBe(true);
    expect(calls.filter((call) => call.table === "tasks")).toHaveLength(1);
    expect(recordLeadEvent).not.toHaveBeenCalled();
    expect(afterMock).not.toHaveBeenCalled();
  });

  it("reconciles a concurrent same-target snooze without another event", async () => {
    const newDue = "2026-05-09T14:00:00.000Z";
    responseQueue = [
      { data: taskRow(), error: null },
      { data: null, error: null },
      {
        data: taskRow({ due_at: "2026-05-09T14:00:00+00:00" }),
        error: null,
      },
    ];
    const result = await snoozeTask(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      "task-1",
      newDue,
      "user-9",
    );
    expect(result.ok).toBe(true);
    expect(recordLeadEvent).not.toHaveBeenCalled();
    expect(afterMock).not.toHaveBeenCalled();
  });

  it("refuses appointments before issuing an update", async () => {
    responseQueue = [{ data: taskRow({ type: "appointment" }), error: null }];
    const result = await snoozeTask(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      "task-1",
      "2026-05-09T14:00:00Z",
      "user-9",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("TASK_SNOOZE_UNSUPPORTED");
    expect(calls.some((call) => call.op === "update")).toBe(false);
  });

  it("rejects an initially completed task without moving its calendar or recording an event", async () => {
    responseQueue = [
      { data: taskRow({ status: "completed" }), error: null },
    ];
    const result = await snoozeTask(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      "task-1",
      "2026-05-09T14:00:00Z",
      "user-9",
    );
    expect(result.ok).toBe(false);
    expect(calls.some((call) => call.op === "update")).toBe(false);
    expect(recordLeadEvent).not.toHaveBeenCalled();
    expect(afterMock).not.toHaveBeenCalled();
  });

  it("does not append an event when the snooze update fails", async () => {
    responseQueue = [
      { data: taskRow(), error: null },
      { data: null, error: { message: "connection reset" } },
    ];
    const result = await snoozeTask(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      "task-1",
      "2026-05-09T14:00:00Z",
      "user-9",
    );
    expect(result.ok).toBe(false);
    expect(recordLeadEvent).not.toHaveBeenCalled();
  });

  it("fails closed if completion wins before the snooze update", async () => {
    const newDue = "2026-05-09T14:00:00Z";
    responseQueue = [
      { data: taskRow(), error: null },
      { data: null, error: null },
      { data: taskRow({ status: "completed" }), error: null },
    ];
    const result = await snoozeTask(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      "task-1",
      newDue,
      "user-9",
    );
    expect(result.ok).toBe(false);
    const update = calls.filter((call) => call.op === "update")[0];
    expect(update.filters).toContainEqual({
      op: "eq",
      args: ["status", "open"],
    });
    expect(recordLeadEvent).not.toHaveBeenCalled();
    expect(afterMock).not.toHaveBeenCalled();
  });
});

describe("reassignTask", () => {
  it("records the old and new assignee after a compare-and-set succeeds", async () => {
    responseQueue = [
      { data: taskRow(), error: null },
      { data: taskRow({ assignee_id: "user-2" }), error: null },
    ];
    const result = await reassignTask(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      "task-1",
      "user-2",
      "user-9",
    );
    expect(result.ok).toBe(true);
    const update = calls.filter((call) => call.table === "tasks")[1];
    expect(update.filters).toEqual([
      { op: "eq", args: ["id", "task-1"] },
      { op: "eq", args: ["assignee_id", "user-1"] },
      { op: "neq", args: ["type", "appointment"] },
    ]);
    expect(update.updatePayload).toEqual({
      assignee_id: "user-2",
      updated_at: expect.any(String),
    });
    expect(recordLeadEvent).toHaveBeenCalledWith({
      propertyId: "property-3",
      actorType: "user",
      actorId: "user-9",
      eventType: "task_reassigned",
      payload: { task_id: "task-1", from: "user-1", to: "user-2" },
    });
  });

  it("treats assigning to the current owner as a no-op", async () => {
    responseQueue = [{ data: taskRow({ assignee_id: "user-2" }), error: null }];
    const result = await reassignTask(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      "task-1",
      "user-2",
      "user-9",
    );
    expect(result.ok).toBe(true);
    expect(calls.filter((call) => call.table === "tasks")).toHaveLength(1);
    expect(recordLeadEvent).not.toHaveBeenCalled();
  });

  it("reconciles a concurrent same-target reassignment without a duplicate event", async () => {
    responseQueue = [
      { data: taskRow(), error: null },
      { data: null, error: null },
      { data: taskRow({ assignee_id: "user-2" }), error: null },
    ];
    const result = await reassignTask(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      "task-1",
      "user-2",
      "user-9",
    );
    expect(result.ok).toBe(true);
    expect(recordLeadEvent).not.toHaveBeenCalled();
  });

  it("refuses appointments before issuing an update", async () => {
    responseQueue = [{ data: taskRow({ type: "appointment" }), error: null }];
    const result = await reassignTask(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      "task-1",
      "user-2",
      "user-9",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("TASK_REASSIGN_UNSUPPORTED");
    expect(calls.some((call) => call.op === "update")).toBe(false);
    expect(recordLeadEvent).not.toHaveBeenCalled();
  });

  it("does not append an event when the reassignment update fails", async () => {
    responseQueue = [
      { data: taskRow(), error: null },
      { data: null, error: { message: "connection reset" } },
    ];
    const result = await reassignTask(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      "task-1",
      "user-2",
      "user-9",
    );
    expect(result.ok).toBe(false);
    expect(recordLeadEvent).not.toHaveBeenCalled();
  });
});

async function flushAfterCallbacks(): Promise<void> {
  const callbacks = [...afterCallbacks];
  afterCallbacks.length = 0;
  await Promise.all(callbacks.map((callback) => callback()));
}
