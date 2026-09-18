import { afterEach, describe, expect, it, vi } from "vitest";
import { inboxPilotAllowlist, isInboxPilotRequest, isInboxPilotUser } from "./pilot-cohort";

afterEach(() => vi.unstubAllEnvs());

describe("inboxPilotAllowlist", () => {
  it("is empty by default (nobody)", () => {
    vi.stubEnv("INBOX_WORKSPACE_PILOT_USER_IDS", undefined);
    expect(inboxPilotAllowlist().size).toBe(0);
  });
  it("parses a comma-separated exact-match list and trims whitespace", () => {
    vi.stubEnv("INBOX_WORKSPACE_PILOT_USER_IDS", " user-1, user-2 ,,user-3");
    expect(inboxPilotAllowlist()).toEqual(new Set(["user-1", "user-2", "user-3"]));
  });
});

describe("isInboxPilotUser", () => {
  it("denies when the allowlist is empty", () => {
    vi.stubEnv("INBOX_WORKSPACE_PILOT_USER_IDS", undefined);
    expect(isInboxPilotUser("user-1")).toBe(false);
  });
  it("denies null/undefined ids even with a populated allowlist", () => {
    vi.stubEnv("INBOX_WORKSPACE_PILOT_USER_IDS", "user-1");
    expect(isInboxPilotUser(null)).toBe(false);
    expect(isInboxPilotUser(undefined)).toBe(false);
  });
  it("requires an exact match, not a prefix/substring", () => {
    vi.stubEnv("INBOX_WORKSPACE_PILOT_USER_IDS", "user-1");
    expect(isInboxPilotUser("user-10")).toBe(false);
    expect(isInboxPilotUser("user-1")).toBe(true);
  });
  // MUTATION: switching the Set membership check to a substring/prefix test
  // makes the "not a prefix/substring" case above fail.
});

describe("isInboxPilotRequest", () => {
  it("resolves the pilot id via Supabase Auth, never a domain RPC", async () => {
    vi.stubEnv("INBOX_WORKSPACE_PILOT_USER_IDS", "user-1");
    const rpc = vi.fn();
    const client = { auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "user-1" } } }) }, rpc };
    expect(await isInboxPilotRequest(client)).toBe(true);
    expect(rpc).not.toHaveBeenCalled();
  });
  it("denies a user absent from the allowlist", async () => {
    vi.stubEnv("INBOX_WORKSPACE_PILOT_USER_IDS", "user-1");
    const client = { auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "someone-else" } } }) } };
    expect(await isInboxPilotRequest(client)).toBe(false);
  });
  it("denies when there is no authenticated user", async () => {
    vi.stubEnv("INBOX_WORKSPACE_PILOT_USER_IDS", "user-1");
    const client = { auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) } };
    expect(await isInboxPilotRequest(client)).toBe(false);
  });
});

describe("rollout bypass resistance", () => {
  it("does not let an environment mode bypass the allowlist", async () => {
    vi.stubEnv("INBOX_WORKSPACE_ROLLOUT_MODE", "all");
    vi.stubEnv("INBOX_WORKSPACE_PILOT_USER_IDS", "pilot-user");
    const client = { auth: { getUser: async () => ({ data: { user: { id: "non-pilot" } } }) } };
    expect(await isInboxPilotRequest(client)).toBe(false);
  });
});
