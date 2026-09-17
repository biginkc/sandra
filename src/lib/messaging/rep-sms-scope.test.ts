import { afterEach, describe, expect, it, vi } from "vitest";

import { AuthorizationError, ConfigurationError } from "@/lib/errors/classes";
import {
  assertSendilloOrganizationScope,
  SENDILLO_ORG_SCOPE_DENIED_MESSAGE,
  SENDILLO_ORG_SCOPE_MISSING_MESSAGE,
} from "./rep-sms-scope";

const originalProvider = process.env.MESSAGING_PROVIDER;
const originalApiKey = process.env.SENDILLO_API_KEY;
const originalOrgId = process.env.SENDILLO_ORG_ID;

afterEach(() => {
  vi.unstubAllEnvs();
  if (originalProvider === undefined) delete process.env.MESSAGING_PROVIDER;
  else process.env.MESSAGING_PROVIDER = originalProvider;
  if (originalApiKey === undefined) delete process.env.SENDILLO_API_KEY;
  else process.env.SENDILLO_API_KEY = originalApiKey;
  if (originalOrgId === undefined) delete process.env.SENDILLO_ORG_ID;
  else process.env.SENDILLO_ORG_ID = originalOrgId;
});
describe("Sendillo organization scope", () => {
  it("keeps the mock provider independent of production-only scope config", () => {
    vi.stubEnv("MESSAGING_PROVIDER", "mock");
    assertSendilloOrganizationScope("test-org", "mock");
  });

  it("fails closed when Sendillo is active but its tenant scope is missing", () => {
    vi.stubEnv("MESSAGING_PROVIDER", "sendillo");
    vi.stubEnv("SENDILLO_ORG_ID", "");

    expect(() => assertSendilloOrganizationScope("org-1", "sendillo")).toThrow(
      new ConfigurationError(SENDILLO_ORG_SCOPE_MISSING_MESSAGE),
    );
  });

  it("rejects a context from an organization other than the configured tenant", () => {
    vi.stubEnv("MESSAGING_PROVIDER", "sendillo");
    vi.stubEnv("SENDILLO_ORG_ID", "org-1");

    expect(() => assertSendilloOrganizationScope("org-2", "sendillo")).toThrow(
      new AuthorizationError(SENDILLO_ORG_SCOPE_DENIED_MESSAGE),
    );
  });

  it("accepts the configured tenant and implicit Sendillo configuration", () => {
    vi.stubEnv("MESSAGING_PROVIDER", "sendillo");
    vi.stubEnv("SENDILLO_ORG_ID", "org-1");
    expect(() => assertSendilloOrganizationScope(" org-1 ", "sendillo")).not.toThrow();

    vi.stubEnv("MESSAGING_PROVIDER", "");
    vi.stubEnv("SENDILLO_API_KEY", "configured-key");
    expect(() => assertSendilloOrganizationScope("org-1")).not.toThrow();
  });

  it("still fences a stale context when the application is configured for Sendillo", () => {
    vi.stubEnv("MESSAGING_PROVIDER", "sendillo");
    vi.stubEnv("SENDILLO_ORG_ID", "org-1");

    expect(() => assertSendilloOrganizationScope("org-2", "mock")).toThrow(
      SENDILLO_ORG_SCOPE_DENIED_MESSAGE,
    );
  });
});
