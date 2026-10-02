import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoist `createClient` mock so it's installed before `actions.ts` imports it.
const {
  createClient,
  enrollLead,
  resumeEnrollment,
  revalidatePath,
  recordLeadEvent,
  hasOpenNormaRequest,
} = vi.hoisted(() => ({
  hasOpenNormaRequest: vi.fn(),
  createClient: vi.fn(),
  enrollLead: vi.fn(),
  resumeEnrollment: vi.fn(),
  revalidatePath: vi.fn(),
  recordLeadEvent: vi.fn(),
}));

vi.mock("@/lib/norma", () => ({ hasOpenNormaRequest, NORMA_HOLD_MESSAGE: "Norma hold" }));
vi.mock("@/lib/supabase/server", () => ({
  createClient,
}));

vi.mock("next/cache", () => ({
  revalidatePath,
}));

vi.mock("@/lib/errors/report", () => ({
  reportError: vi.fn(),
}));
vi.mock("@/lib/events", () => ({ LEAD_EVENT_TYPES: { SEQUENCE_PAUSED: "sequence_paused" }, recordLeadEvent }));
vi.mock("@/lib/sequences/enrollment", () => ({
  enrollLead,
  resumeEnrollment,
}));
import {
  archiveSequence,
  cancelEnrollment,
  changeDripAction,
  createSequence,
  enrollLeadInSequence,
  pauseEnrollmentAction,
  resumeEnrollmentAction,
  restoreSequence,
  updateSequence,
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

  });
});

describe("archive and restore sequence", () => {
  it.each([true, false])("preserves active=%s through archive and restore", async (active) => {
    const sequence = { id: "seq-1", active, archived_at: null as string | null };
    const update = vi.fn((patch: { active?: boolean; archived_at: string | null }) => ({
      eq: vi.fn(async (column: string, id: string) => {
        expect([column, id]).toEqual(["id", sequence.id]);
        Object.assign(sequence, patch);
        return { error: null };
      }),
    }));
    createClient.mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { email: "admin@bmhgroupkc.com" } } }) },
      from: vi.fn(() => ({ update })),
    });

    expect((await archiveSequence(sequence.id)).ok).toBe(true);
    expect(sequence.archived_at).not.toBeNull();
    expect(sequence.active).toBe(active);
    expect((await restoreSequence(sequence.id)).ok).toBe(true);
    expect(sequence).toMatchObject({ active, archived_at: null });
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls.every(([patch]) => !("active" in patch))).toBe(true);
  });
});

describe("lead sequence lifecycle actions", () => {
  beforeEach(() => hasOpenNormaRequest.mockResolvedValue(false));

  it("refuses to change a drip while a Norma request holds the lead, before cancelling the old one", async () => {
    const rpc = vi.fn();
    const client = { auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "u1" } } }) },
      from: vi.fn(() => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { property_id: "p1", sequence_id: "old", status: "active" }, error: null }) }) }) })),
      rpc };
    createClient.mockResolvedValue(client);
    hasOpenNormaRequest.mockResolvedValue(true);
    expect(await changeDripAction("e1", "new")).toEqual({ ok: false, error: { code: "NORMA_HOLD", message: "Norma hold" } });
    expect(rpc).not.toHaveBeenCalled();
    expect(enrollLead).not.toHaveBeenCalled();
  });

  it("pauses only the targeted active enrollment with manual reason", async () => {
    const select = vi.fn().mockResolvedValue({ data: [{ property_id: "p1", sequence_id: "s1" }], error: null });
    const status = vi.fn(() => ({ select }));
    const id = vi.fn(() => ({ eq: status }));
    const update = vi.fn(() => ({ eq: id }));
    const client = { auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "u1" } } }) }, from: vi.fn(() => ({ update })) };
    createClient.mockResolvedValue(client);
    expect(await pauseEnrollmentAction("e1")).toEqual({ ok: true, data: null });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ status: "paused", pause_reason: "manual" }));
    expect(id).toHaveBeenCalledWith("id", "e1");
    expect(status).toHaveBeenCalledWith("status", "active");
    expect(recordLeadEvent).toHaveBeenCalledWith(expect.objectContaining({ propertyId: "p1", actorId: "u1", eventType: "sequence_paused" }));
  });

  it("changes drips only after an audited cancel and uses enrollLead guards", async () => {
    const order: string[] = [];
    const client = { auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "u1" } } }) },
      from: vi.fn(() => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { property_id: "p1", sequence_id: "old", status: "active" }, error: null }) }) }) })),
      rpc: vi.fn().mockImplementation(() => { order.push("cancel"); return Promise.resolve({ data: [{ outcome: "canceled" }], error: null }); }) };
    createClient.mockResolvedValue(client);
    enrollLead.mockImplementation(() => { order.push("enroll"); return Promise.resolve({ status: "enrolled", enrollmentId: "e2", sequenceLabel: "New" }); });
    expect(await changeDripAction("e1", "new")).toEqual({ ok: true, data: { propertyId: "p1", status: "enrolled", reason: "Enrolled" } });
    expect(order).toEqual(["cancel", "enroll"]);
    expect(enrollLead).toHaveBeenCalledWith(client, { propertyId: "p1", sequenceId: "new", enrolledByUserId: "u1" });
    enrollLead.mockResolvedValueOnce({ status: "no_phone" });
    expect(await changeDripAction("e1", "new")).toEqual({ ok: true, data: { propertyId: "p1", status: "skipped", reason: "Previous drip stopped. Lead has no phone number." } });
    enrollLead.mockRejectedValueOnce(new Error("enroll failed"));
    expect(await changeDripAction("e1", "new")).toEqual({ ok: true, data: { propertyId: "p1", status: "failed", reason: "Previous drip stopped. Could not enroll this lead." } });
    client.rpc.mockResolvedValueOnce({ data: [{ outcome: "not_active" }], error: null });
    order.length = 0;
    expect(await changeDripAction("e1", "new")).toMatchObject({ ok: false, error: { code: "CANCEL_FAILED" } });
    expect(order).toEqual([]);
  });
  function makeLifecycleClient(opts: {
    userId?: string | null;
    enrollment?: {
      id: string;
      property_id: string;
      sequence_id: string;
      status: string;
    } | null;
    loadError?: { message: string } | null;
    rpcResult?: {
      data: Array<{ outcome: string }> | null;
      error: { message: string } | null;
    };
  }) {
    return {
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: opts.userId ? { id: opts.userId } : null },
        }),
      },
      rpc: vi.fn().mockResolvedValue(
        opts.rpcResult ?? { data: [{ outcome: "canceled" }], error: null },
      ),
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

  it("cancels through the audited RPC with the authenticated actor", async () => {
    const client = makeLifecycleClient({
      userId: "user-1",
      rpcResult: { data: [{ outcome: "canceled" }], error: null },
    });
    createClient.mockResolvedValue(client);

    expect(await cancelEnrollment("enrollment-1")).toEqual({
      ok: true,
      data: null,
    });
    expect(client.rpc).toHaveBeenCalledWith("cancel_sequence_enrollment", {
      p_enrollment_id: "enrollment-1",
      p_actor_user_id: "user-1",
    });
  });

  it("treats already terminal and missing cancellations as idempotent", async () => {
    createClient.mockResolvedValue(
      makeLifecycleClient({
        userId: "user-1",
        rpcResult: { data: [{ outcome: "not_active" }], error: null },
      }),
    );

    expect(await cancelEnrollment("enrollment-1")).toEqual({
      ok: true,
      data: null,
    });

    createClient.mockResolvedValue(
      makeLifecycleClient({
        userId: "user-1",
        rpcResult: { data: [{ outcome: "not_found" }], error: null },
      }),
    );
    expect(await cancelEnrollment("missing")).toEqual({
      ok: true,
      data: null,
    });
  });

  it("returns a cancellation error for an unauthorized RPC outcome", async () => {
    createClient.mockResolvedValue(
      makeLifecycleClient({
        userId: "user-1",
        rpcResult: { data: [{ outcome: "not_authorized" }], error: null },
      }),
    );

    expect(await cancelEnrollment("enrollment-1")).toMatchObject({
      ok: false,
      error: { code: "CANCEL_FAILED" },
    });
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
  });
});
