import { beforeEach, describe, expect, it, vi } from "vitest";

const { createAdminClient } = vi.hoisted(() => ({ createAdminClient: vi.fn() }));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient }));

import { listSlackPreviewInstallations } from "./unfurl-store";

describe("Slack preview installation metadata", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the actual policy mode while retaining the compatibility boolean", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [
        { installation_id: "legacy", team_name: "Legacy workspace", app_id: "A_LEGACY", status: "active", installation_version: 1, policy_mode: "legacy", policy_enabled: false, account_linked: true },
        { installation_id: "automatic", team_name: "Automatic workspace", app_id: "A_AUTO", status: "active", installation_version: 2, policy_mode: "eligible_internal_channels", policy_enabled: true, account_linked: false },
        { installation_id: "disabled", team_name: null, app_id: "A_DISABLED", status: "revoked", installation_version: 3, policy_mode: "disabled", policy_enabled: false, account_linked: false },
      ],
      error: null,
    });
    createAdminClient.mockReturnValue({ rpc });

    await expect(listSlackPreviewInstallations({ orgId: "org-1", userId: "user-1" })).resolves.toEqual([
      { id: "legacy", teamName: "Legacy workspace", appId: "A_LEGACY", status: "active", currentVersion: 1, policyMode: "legacy", policyEnabled: false, accountLinked: true },
      { id: "automatic", teamName: "Automatic workspace", appId: "A_AUTO", status: "active", currentVersion: 2, policyMode: "eligible_internal_channels", policyEnabled: true, accountLinked: false },
      { id: "disabled", teamName: null, appId: "A_DISABLED", status: "revoked", currentVersion: 3, policyMode: "disabled", policyEnabled: false, accountLinked: false },
    ]);
    expect(rpc).toHaveBeenCalledWith("list_slack_preview_installations", { p_org_id: "org-1", p_user_id: "user-1" });
  });

  it("fails closed when the RPC returns an unknown policy mode", async () => {
    createAdminClient.mockReturnValue({ rpc: vi.fn().mockResolvedValue({
      data: [{ installation_id: "unknown", team_name: "Unknown", app_id: "A_UNKNOWN", status: "active", installation_version: 1, policy_mode: "future_mode", policy_enabled: true, account_linked: true }],
      error: null,
    }) });

    await expect(listSlackPreviewInstallations({ orgId: "org-1", userId: "user-1" })).resolves.toEqual([]);
  });
});
