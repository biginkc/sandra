import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createClient, insertContact } = vi.hoisted(() => ({
  createClient: vi.fn(),
  insertContact: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({ createClient }));
vi.mock("node:fs", () => ({ default: { existsSync: () => false } }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.invalid");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "fake-local-test-key");
  vi.stubEnv("SEQUENCE_SMOKE_RECIPIENT_E164", "+12025550123");
  vi.stubEnv("SEQUENCE_SMOKE_RECIPIENT_LINE_TYPE", "mobile");
  vi.stubEnv("SEQUENCE_SMOKE_RECIPIENT_OWNED", "true");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  createClient.mockImplementation(() => ({
    from(table: string) {
      const query = {
        select: () => query,
        limit: () => query,
        insert(payload: unknown) {
          if (table === "contacts") insertContact(payload);
          return query;
        },
        single: async () => table === "contacts"
          // Stop the smoke at this mocked boundary, before consent/enrollment.
          ? { data: null, error: new Error("Local test stops after contact fixture") }
          : { data: { id: `${table}-test-id` }, error: null },
      };
      return query;
    },
  }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("production sequence smoke recipient fixture", () => {
  it("inserts the explicitly configured owned recipient with its verified line type", async () => {
    await import("../../../scripts/smoke-sequences-prod");
    await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(1));
    expect(insertContact).toHaveBeenCalledExactlyOnceWith({
      first_name: "Smoke",
      last_name: "Prod",
      phone_1: "+12025550123",
      phone_1_type: "mobile",
    });
  });

  it.each([
    ["SEQUENCE_SMOKE_RECIPIENT_E164", ""],
    ["SEQUENCE_SMOKE_RECIPIENT_E164", "202-555-0123"],
    ["SEQUENCE_SMOKE_RECIPIENT_E164", "+00000000000"],
    ["SEQUENCE_SMOKE_RECIPIENT_LINE_TYPE", ""],
    ["SEQUENCE_SMOKE_RECIPIENT_LINE_TYPE", "unknown"],
    ["SEQUENCE_SMOKE_RECIPIENT_LINE_TYPE", "landline"],
    ["SEQUENCE_SMOKE_RECIPIENT_OWNED", ""],
    ["SEQUENCE_SMOKE_RECIPIENT_OWNED", "false"],
  ])("rejects %s=%j before creating a database client", async (name, value) => {
    vi.stubEnv(name, value);
    await expect(import("../../../scripts/smoke-sequences-prod")).rejects.toThrow(name);
    expect(createClient).not.toHaveBeenCalled();
    expect(insertContact).not.toHaveBeenCalled();
  });
});
