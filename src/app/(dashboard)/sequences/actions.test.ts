import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoist `createClient` mock so it's installed before `actions.ts` imports it.
const {
  createClient,
  enrollLead,
  recordLeadEvent,
  resumeEnrollment,
  revalidatePath,
} = vi.hoisted(() => ({
  createClient: vi.fn(),
  enrollLead: vi.fn(),
  recordLeadEvent: vi.fn().mockResolvedValue(undefined),
  resumeEnrollment: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient,
}));

vi.mock("next/cache", () => ({
  revalidatePath,
}));

vi.mock("@/lib/errors/report", () => ({
  reportError: vi.fn(),
}));
vi.mock("@/lib/sequences/enrollment", () => ({
  enrollLead,
  resumeEnrollment,
}));
vi.mock("@/lib/events", () => ({
  LEAD_EVENT_TYPES: { SEQUENCE_CANCELED: "sequence_canceled" },
  recordLeadEvent,
}));

import {
  archiveSequence,
  cancelEnrollment,
  createSequence,
  deleteSequenceStep,
  enrollLeadInSequence,
  resumeEnrollmentAction,
  updateSequence,
  upsertSequenceStep,
} from "./actions";

type InsertedRow = {
  org_id: string;
  name: string;
  description: string | null;
  append_opt_out: boolean;
  created_by: string | null;
};

type StubResult<T> = {
  data: T | null;
  error: { code?: string; message: string } | null;
};
type StubUser = { id?: string | null; email?: string | null } | null;
type GuardedActionResult =
  { ok: true } | { ok: false; error: { code: string } };

function makeSupabase(opts: {
  org: StubResult<{ id: string }>;
  user: StubResult<{ user: StubUser }>;
  insertResult: StubResult<{ id: string }>;
  insertCapture: { rows: InsertedRow[] };
}) {
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue(opts.user),
    },
    from: vi.fn((table: string) => {
      if (table === "organizations") {
        return {
          select: () => ({
            limit: () => ({
              maybeSingle: () => Promise.resolve(opts.org),
            }),
          }),
        };
      }
      if (table === "sequences") {
        return {
          insert: (row: InsertedRow) => {
            opts.insertCapture.rows.push(row);
            return {
              select: () => ({
                single: () => Promise.resolve(opts.insertResult),
              }),
            };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    }),
  };
}

beforeEach(() => {
  createClient.mockReset();
  vi.stubEnv("ADMIN_EMAILS", "admin@bmhgroupkc.com");
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("createSequence", () => {
  it("returns VALIDATION when name is whitespace", async () => {
    const result = await createSequence({ name: "   " });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
    expect(createClient).not.toHaveBeenCalled();
  });

  it("returns VALIDATION when name exceeds 120 chars", async () => {
    const result = await createSequence({ name: "x".repeat(121) });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toMatch(/121 characters/);
    }
  });

  it("returns NO_ORG when no organization exists", async () => {
    const insertCapture = { rows: [] as InsertedRow[] };
    createClient.mockResolvedValue(
      makeSupabase({
        org: { data: null, error: null },
        user: {
          data: { user: { id: "u-1", email: "admin@bmhgroupkc.com" } },
          error: null,
        },
        insertResult: { data: { id: "s-1" }, error: null },
        insertCapture,
      }),
    );
    const result = await createSequence({ name: "Hi" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NO_ORG");
    }
    expect(insertCapture.rows).toHaveLength(0);
  });

  it("inserts with trimmed name + default append_opt_out=true and returns the new id", async () => {
    const insertCapture = { rows: [] as InsertedRow[] };
    createClient.mockResolvedValue(
      makeSupabase({
        org: { data: { id: "org-1" }, error: null },
        user: {
          data: { user: { id: "user-1", email: "admin@bmhgroupkc.com" } },
          error: null,
        },
        insertResult: { data: { id: "seq-42" }, error: null },
        insertCapture,
      }),
    );

    const result = await createSequence({
      name: "  RTL smoke  ",
      description: "created by vitest",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({ id: "seq-42" });
    }
    expect(insertCapture.rows).toHaveLength(1);
    expect(insertCapture.rows[0]).toEqual({
      org_id: "org-1",
      name: "RTL smoke",
      description: "created by vitest",
      append_opt_out: true,
      created_by: "user-1",
    });
  });

  it("respects an explicit append_opt_out=false", async () => {
    const insertCapture = { rows: [] as InsertedRow[] };
    createClient.mockResolvedValue(
      makeSupabase({
        org: { data: { id: "org-1" }, error: null },
        user: {
          data: { user: { id: null, email: "admin@bmhgroupkc.com" } },
          error: null,
        },
        insertResult: { data: { id: "seq-43" }, error: null },
        insertCapture,
      }),
    );

    const result = await createSequence({
      name: "no opt-out",
      append_opt_out: false,
    });

    expect(result.ok).toBe(true);
    expect(insertCapture.rows[0].append_opt_out).toBe(false);
    expect(insertCapture.rows[0].created_by).toBeNull();
  });

  it("maps Postgres unique-violation 23505 to DUPLICATE_NAME", async () => {
    const insertCapture = { rows: [] as InsertedRow[] };
    createClient.mockResolvedValue(
      makeSupabase({
        org: { data: { id: "org-1" }, error: null },
        user: {
          data: { user: { id: "u-1", email: "admin@bmhgroupkc.com" } },
          error: null,
        },
        insertResult: {
          data: null,
          error: { code: "23505", message: "duplicate key" },
        },
        insertCapture,
      }),
    );

    const result = await createSequence({ name: "First touch new lead" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("DUPLICATE_NAME");
      expect(result.error.message).toMatch(/already exists/);
    }
  });
});

describe("sequence admin guard", () => {
  function makeForbiddenSupabase(user: StubUser) {
    return {
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user }, error: null }),
      },
      from: vi.fn(() => {
        throw new Error("admin guard should return before table access");
      }),
    };
  }

  async function expectForbidden(
    user: StubUser,
    action: () => Promise<GuardedActionResult>,
  ) {
    const supabase = makeForbiddenSupabase(user);
    createClient.mockResolvedValue(supabase);

    const result = await action();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("FORBIDDEN");
    }
    expect(supabase.from).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  }

  describe.each([
    ["non-admin", { id: "user-2", email: "va@bmhgroupkc.com" }],
    ["unauthenticated user", null],
  ] satisfies Array<[string, StubUser]>)("%s", (_label, user) => {
    it("blocks sequence creation before table access", async () => {
      await expectForbidden(user, () =>
        createSequence({ name: "Blocked create" }),
      );
    });

    it("blocks sequence metadata updates before table access", async () => {
      await expectForbidden(user, () =>
        updateSequence("seq-1", { name: "Blocked update" }),
      );
    });

    it("blocks archiving before table access", async () => {
      await expectForbidden(user, () => archiveSequence("seq-1"));
    });

    it("blocks step upserts before table access", async () => {
      await expectForbidden(user, () =>
        upsertSequenceStep({
          sequence_id: "seq-1",
          step_index: 0,
          delay_after_previous_minutes: 0,
          action_type: "send_sms",
          template_body: "Hello",
        }),
      );
    });

    it("blocks step deletion before table access", async () => {
      await expectForbidden(user, () => deleteSequenceStep("step-1", "seq-1"));
    });
  });
});

describe("lead sequence lifecycle actions", () => {
  function makeLifecycleClient(opts: {
    userId?: string | null;
    enrollment?: {
      id: string;
      property_id: string;
      sequence_id: string;
      status: string;
    } | null;
    loadError?: { message: string } | null;
    updated?: { id: string } | null;
    updateError?: { message: string } | null;
  }) {
    const builder: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const method of ["select", "eq", "in"]) {
      builder[method] = vi.fn(() => builder);
    }
    builder.maybeSingle = vi
      .fn()
      .mockResolvedValueOnce({
        data: opts.enrollment ?? null,
        error: opts.loadError ?? null,
      })
      .mockResolvedValueOnce({
        data: opts.updated ?? null,
        error: opts.updateError ?? null,
      });
    builder.update = vi.fn(() => builder);
    return {
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: opts.userId ? { id: opts.userId } : null },
        }),
      },
      from: vi.fn(() => builder),
    };
  }

  it("forwards the authenticated actor into a confirmed enrollment", async () => {
    createClient.mockResolvedValue(makeLifecycleClient({ userId: "user-1" }));
    enrollLead.mockResolvedValue({
      status: "enrolled",
      enrollmentId: "enrollment-1",
    });

    const result = await enrollLeadInSequence("sequence-1", "property-1");

    expect(result).toEqual({
      ok: true,
      data: { enrollmentId: "enrollment-1" },
    });
    expect(enrollLead).toHaveBeenCalledWith(expect.anything(), {
      sequenceId: "sequence-1",
      propertyId: "property-1",
      enrolledByUserId: "user-1",
    });
  });

  it("records only an actually persisted cancellation", async () => {
    createClient.mockResolvedValue(
      makeLifecycleClient({
        userId: "user-1",
        enrollment: {
          id: "enrollment-1",
          property_id: "property-1",
          sequence_id: "sequence-1",
          status: "paused",
        },
        updated: { id: "enrollment-1" },
      }),
    );

    expect(await cancelEnrollment("enrollment-1")).toEqual({
      ok: true,
      data: null,
    });
    expect(recordLeadEvent).toHaveBeenCalledWith({
      propertyId: "property-1",
      actorType: "user",
      actorId: "user-1",
      eventType: "sequence_canceled",
      payload: {
        enrollment_id: "enrollment-1",
        sequence_id: "sequence-1",
      },
      sourceType: "sequence_enrollments.canceled",
      sourceId: "enrollment-1",
    });
  });

  it("does not record a completed cancellation no-op", async () => {
    createClient.mockResolvedValue(
      makeLifecycleClient({
        userId: "user-1",
        enrollment: {
          id: "enrollment-1",
          property_id: "property-1",
          sequence_id: "sequence-1",
          status: "completed",
        },
      }),
    );

    expect(await cancelEnrollment("enrollment-1")).toEqual({
      ok: true,
      data: null,
    });
    expect(recordLeadEvent).not.toHaveBeenCalled();
  });

  it("does not record a cancellation that loses the compare-and-set race", async () => {
    createClient.mockResolvedValue(
      makeLifecycleClient({
        userId: "user-1",
        enrollment: {
          id: "enrollment-1",
          property_id: "property-1",
          sequence_id: "sequence-1",
          status: "active",
        },
        updated: null,
      }),
    );

    expect(await cancelEnrollment("enrollment-1")).toEqual({
      ok: true,
      data: null,
    });
    expect(recordLeadEvent).not.toHaveBeenCalled();
  });

  it("passes the authenticated actor into resume and blocks unauthenticated actions", async () => {
    createClient.mockResolvedValueOnce(
      makeLifecycleClient({ userId: "user-1" }),
    );
    resumeEnrollment.mockResolvedValue({ status: "resumed" });

    expect(await resumeEnrollmentAction("enrollment-1")).toEqual({
      ok: true,
      data: null,
    });
    expect(resumeEnrollment).toHaveBeenCalledWith(
      expect.anything(),
      "enrollment-1",
      { actorType: "user", actorId: "user-1" },
    );

    createClient.mockResolvedValueOnce(makeLifecycleClient({ userId: null }));
    expect(await cancelEnrollment("enrollment-1")).toMatchObject({
      ok: false,
      error: { code: "UNAUTHENTICATED" },
    });
    expect(recordLeadEvent).not.toHaveBeenCalled();
  });
});
