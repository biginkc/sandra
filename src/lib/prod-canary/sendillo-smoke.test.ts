import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  payloads: [] as Array<{ data: { messageId: string; body: string } }>,
  cleanupError: false,
  wrongBody: false,
  consentError: false,
  seeded: false,
  suppressionDeleted: false,
  missingSuppression: false,
  suppressionDeleteNoop: false,
  contactDeleted: false,
  deletedTables: [] as string[],
  existingContact: false,
  existingSuppression: false,
  allowlisted: true,
  clientUrl: "http://127.0.0.1:54321",
  inserts: [] as Array<{ table: string; payload: Record<string, unknown> }>,
}));

vi.mock("../../../scripts/canary-helpers", () => {
  function from(table: string) {
    let deleting = false;
    let inserting = false;
    const result = () => {
      if (deleting) {
        if (
          !(state.cleanupError && table === "contacts") &&
          !(state.suppressionDeleteNoop && table === "sms_phone_suppressions")
        )
          state.deletedTables.push(table);
        if (table === "sms_phone_suppressions" && !state.suppressionDeleteNoop)
          state.suppressionDeleted = true;
        if (table === "contacts") state.contactDeleted = true;
        return {
          data: null,
          error:
            state.cleanupError && table === "contacts"
              ? { message: "cleanup unavailable" }
              : null,
        };
      }
      if (!inserting && state.deletedTables.includes(table))
        return { data: [], error: null };
      if (inserting) {
        state.seeded = true;
        return {
          data: { id: table === "contacts" ? "contact" : "property" },
          error: null,
        };
      }
      if (table === "contacts")
        return {
          data: !state.seeded
            ? state.existingContact
              ? [{ id: "existing" }]
              : []
            : [{ sms_opted_out: true }],
          error: null,
        };
      if (table === "sms_phone_suppressions")
        return {
          data: state.existingSuppression
            ? [{ id: "existing-suppression" }]
            : state.seeded &&
                !state.missingSuppression &&
                !state.suppressionDeleted &&
                state.payloads[0]?.data.body === "STOP"
              ? [
                  {
                    id: "suppression",
                    first_contact_id: "contact",
                    provider: "sendillo",
                  },
                ]
              : [],
          error: null,
        };
      if (table === "consent_events" && state.consentError)
        return { data: null, error: { message: "consent query unavailable" } };
      if (table === "consent_events")
        return {
          data: [{ id: "consent", event_type: "opt_out" }],
          error: null,
        };
      if (table === "sequence_enrollments")
        return { data: [{ status: "opted_out" }], error: null };
      if (table === "memberships")
        return { data: [{ org_id: "org" }], error: null };
      if (table === "notifications")
        return {
          data:
            state.payloads[0]?.data.body === "STOP"
              ? []
              : [{ id: "notification", entity_id: "inbound", user_id: "user" }],
          error: null,
        };
      const event = state.payloads[0]?.data;
      return {
        data: [
          {
            id: "inbound",
            provider: "sendillo",
            direction: "inbound",
            status: "received",
            external_id: event?.messageId,
            body: state.wrongBody ? "wrong body" : event?.body,
            property_id: "property",
            contact_id: "contact",
            conversation_id: "conversation",
          },
        ],
        error: null,
      };
    };
    const query = {
      select: () => query,
      eq: () => query,
      order: () => query,
      limit: () => query,
      in: () => query,
      contains: () => query,
      insert: (payload: Record<string, unknown>) => {
        state.inserts.push({ table, payload });
        inserting = true;
        return query;
      },
      delete: () => {
        deleting = true;
        return query;
      },
      single: async () => {
        const r = result();
        return { ...r, data: Array.isArray(r.data) ? r.data[0] : r.data };
      },
      maybeSingle: async () => {
        const r = result();
        return { ...r, data: Array.isArray(r.data) ? r.data[0] : r.data };
      },
      then: (resolve: (value: unknown) => unknown) =>
        Promise.resolve(result()).then(resolve),
    };
    return query;
  }
  return {
    env: {
      PROD_EMAIL: "canary@example.test",
      SENDILLO_FROM_NUMBER: "+12025550101",
      PROD_CANARY_SMS_TO: "+12025550102",
      get PROD_CANARY_SMS_ALLOWLIST() {
        return state.allowlisted ? "+12025550102" : "";
      },
    },
    prodSupabase: () => ({
      supabaseUrl: state.clientUrl,
      from,
      auth: {
        admin: {
          listUsers: async () => ({
            data: { users: [{ id: "user", email: "canary@example.test" }] },
            error: null,
          }),
        },
      },
    }),
    fireSendilloInboundWebhook: async (
      payload: (typeof state.payloads)[number],
    ) => {
      state.payloads.push(structuredClone(payload));
      vi.advanceTimersByTime(1000);
      return 200;
    },
    pollUntil: async (fn: () => Promise<unknown>) => {
      const value = await fn();
      if (value === null) throw new Error("condition not met");
      return value;
    },
  };
});

import { runSendilloWebhookSmoke } from "../../../scripts/smoke-sendillo-webhook-prod";

beforeEach(() => {
  vi.useFakeTimers();
  state.payloads.length = 0;
  state.cleanupError = false;
  state.wrongBody = false;
  state.consentError = false;
  state.seeded = false;
  state.suppressionDeleted = false;
  state.missingSuppression = false;
  state.suppressionDeleteNoop = false;
  state.contactDeleted = false;
  state.deletedTables.length = 0;
  state.existingContact = false;
  state.existingSuppression = false;
  state.allowlisted = true;
  state.clientUrl = "http://127.0.0.1:54321";
  state.inserts.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("Sendillo smoke result integrity (mocked I/O)", () => {
  it("replays the identical payload and returns success after cleanup", async () => {
    const report = await runSendilloWebhookSmoke();
    expect(state.payloads).toHaveLength(2);
    expect(state.payloads[1]).toEqual(state.payloads[0]);
    expect(report).toMatchObject({ status: "PASS" });
  });

  it("does not return a successful result when cleanup fails", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    state.cleanupError = true;
    await expect(runSendilloWebhookSmoke()).rejects.toThrow(
      "cleanup failed: contacts: cleanup unavailable",
    );
    expect(output).not.toHaveBeenCalled();
  });

  it("rejects persistence of a different message body", async () => {
    state.wrongBody = true;
    await expect(runSendilloWebhookSmoke()).rejects.toThrow(
      "Unexpected inbound row shape",
    );
    expect(state.payloads).toHaveLength(1);
  });
  it("reports a STOP query error instead of a missing-side-effect timeout", async () => {
    vi.stubEnv("SENDILLO_SMOKE_MODE", "stop");
    vi.resetModules();
    state.consentError = true;
    const { runSendilloWebhookSmoke: runStop } = await import(
      "../../../scripts/smoke-sendillo-webhook-prod"
    );
    await expect(runStop({ disposableLocalStop: true })).rejects.toMatchObject({
      message: "consent query unavailable",
    });
  });

  it("requires an allowlisted owned number before creating fixtures", async () => {
    state.allowlisted = false;
    await expect(runSendilloWebhookSmoke()).rejects.toThrow(
      "PROD_CANARY_SMS_ALLOWLIST",
    );
    expect(state.inserts).toHaveLength(0);
    expect(state.payloads).toHaveLength(0);
  });

  it.each(["existingContact", "existingSuppression"] as const)(
    "rejects %s without writes or webhook calls",
    async (field) => {
      state[field] = true;
      await expect(runSendilloWebhookSmoke()).rejects.toThrow(/already/);
      expect(state.inserts).toHaveLength(0);
      expect(state.payloads).toHaveLength(0);
    },
  );

  it("creates the isolated contact with an explicit mobile phone type", async () => {
    await runSendilloWebhookSmoke();
    expect(
      state.inserts.find((row) => row.table === "contacts")?.payload,
    ).toMatchObject({
      phone_1: "+12025550102",
      phone_1_type: "mobile",
      org_id: "org",
    });
  });

  it("requires durable phone suppression for STOP and removes its owned suppression", async () => {
    vi.stubEnv("SENDILLO_SMOKE_MODE", "stop");
    vi.resetModules();
    const { runSendilloWebhookSmoke: runStop } = await import(
      "../../../scripts/smoke-sendillo-webhook-prod"
    );
    await expect(runStop({ disposableLocalStop: true })).resolves.toMatchObject(
      { status: "PASS", mode: "stop" },
    );
    expect(state.suppressionDeleted).toBe(true);
  });

  it.each(["missingSuppression", "suppressionDeleteNoop"] as const)(
    "rejects STOP with %s",
    async (field) => {
      vi.stubEnv("SENDILLO_SMOKE_MODE", "stop");
      vi.resetModules();
      state[field] = true;
      const { runSendilloWebhookSmoke: runStop } = await import(
        "../../../scripts/smoke-sendillo-webhook-prod"
      );
      await expect(runStop({ disposableLocalStop: true })).rejects.toThrow(
        field === "missingSuppression"
          ? "condition not met"
          : "suppression cleanup not verified",
      );
      if (field === "suppressionDeleteNoop")
        expect(state.contactDeleted).toBe(false);
    },
  );

  it("blocks STOP on production before creating any fixtures", async () => {
    vi.stubEnv("SENDILLO_SMOKE_MODE", "stop");
    vi.resetModules();
    state.clientUrl = "https://copflsklaefwzipsrjqz.supabase.co";
    const { runSendilloWebhookSmoke: runStop } = await import(
      "../../../scripts/smoke-sendillo-webhook-prod"
    );
    await expect(runStop({ disposableLocalStop: true })).rejects.toThrow(
      "production lead history cannot be cleaned",
    );
    expect(state.inserts).toHaveLength(0);
    expect(state.payloads).toHaveLength(0);
  });
});
