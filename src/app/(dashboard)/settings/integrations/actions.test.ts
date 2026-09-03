import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "user-1", email: "owner@bmhgroupkc.com" } as { id: string; email: string } | null,
  esignStatus: {
    ok: true as const,
    data: {
      connected: false,
      canManage: false,
      sendingEnabled: false,
      disconnectPending: false,
      testMode: null as boolean | null,
      apiKeyLastFour: null as string | null,
      embeddedTemplateManagementEnabled: false,
      liveSendLimit: null as { monthlyLimit: number; usedThisMonth: number; remainingThisMonth: number } | null,
    },
  },
  membership: {
    ok: true as const,
    membership: { user_id: "user-1", org_id: "org-1", role: "owner" as const },
  },
  webhookBase: "https://sandra-sooty.vercel.app",
}));

vi.mock("@slack/web-api", () => ({ WebClient: vi.fn() }));
vi.mock("googleapis", () => ({ google: { auth: { OAuth2: vi.fn() } } }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/notifications/rep-sms", () => ({
  checkRepSmsFromNumberReady: vi.fn(),
}));
vi.mock("@/lib/integrations/tokens/store", () => ({
  deleteOAuthTokens: vi.fn(),
  getDecryptedToken: vi.fn(),
}));
vi.mock("@/lib/integrations/prefs", () => ({
  loadIntegrationPrefs: async () => ({
    slackEnabled: false,
    calendarEnabled: false,
    smsRemindersEnabled: false,
    reminderPhone: null,
    timezone: "America/Chicago",
  }),
  setChannelEnabled: vi.fn(),
  setReminderPhone: vi.fn(),
  setTimezone: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: mocks.user } }) },
    from: () => ({
      select: () => ({
        eq: async () => ({ data: [], error: null }),
      }),
    }),
  }),
}));
vi.mock("@/lib/esign/actions", () => ({
  getEsignConnectionStatus: async () => mocks.esignStatus,
}));
vi.mock("@/lib/esign/credentials", () => ({
  callbackPathSecretForOrg: (orgId: string) => ({
    reveal: () => `secret-for-${orgId}`,
  }),
}));
vi.mock("@/lib/auth/memberships", () => ({
  getSingleActiveMembership: async () => mocks.membership,
}));
vi.mock("@/app/(dashboard)/admin/webhooks/url", () => ({
  webhookBaseUrl: () => mocks.webhookBase,
}));

import { getIntegrationStatus } from "./actions";

describe("getIntegrationStatus — esignCallbackUrl", () => {
  beforeEach(() => {
    mocks.user = { id: "user-1", email: "owner@bmhgroupkc.com" };
    mocks.webhookBase = "https://sandra-sooty.vercel.app";
    mocks.membership = {
      ok: true,
      membership: { user_id: "user-1", org_id: "org-1", role: "owner" },
    };
  });

  it("returns the callback URL for a connected owner", async () => {
    mocks.esignStatus = {
      ok: true,
      data: {
        connected: true,
        canManage: true,
        sendingEnabled: false,
        disconnectPending: false,
        testMode: true,
        apiKeyLastFour: "1234",
        embeddedTemplateManagementEnabled: false,
        liveSendLimit: null,
      },
    };

    const result = await getIntegrationStatus();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.esignCallbackUrl).toBe(
      "https://sandra-sooty.vercel.app/api/webhooks/esign/secret-for-org-1",
    );
  });

  it("returns null for a connected non-owner (member)", async () => {
    mocks.esignStatus = {
      ok: true,
      data: {
        connected: true,
        canManage: false,
        sendingEnabled: false,
        disconnectPending: false,
        testMode: true,
        apiKeyLastFour: "1234",
        embeddedTemplateManagementEnabled: false,
        liveSendLimit: null,
      },
    };

    const result = await getIntegrationStatus();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.esignCallbackUrl).toBeNull();
  });

  it("returns null when Dropbox Sign is not connected, even for an owner", async () => {
    mocks.esignStatus = {
      ok: true,
      data: {
        connected: false,
        canManage: true,
        sendingEnabled: false,
        disconnectPending: false,
        testMode: null,
        apiKeyLastFour: null,
        embeddedTemplateManagementEnabled: false,
        liveSendLimit: null,
      },
    };

    const result = await getIntegrationStatus();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.esignCallbackUrl).toBeNull();
  });
});
