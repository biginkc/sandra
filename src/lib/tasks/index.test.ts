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
  reassignTask,
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
