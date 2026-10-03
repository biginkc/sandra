import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SlackPreviewsClient } from "./client";

const fetchMock = vi.fn();

vi.stubGlobal("fetch", fetchMock);

function response(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function installation(overrides: Partial<{
  id: string;
  teamName: string | null;
  appId: string;
  status: "active" | "revoked";
  currentVersion: number;
  policyMode: "legacy" | "eligible_internal_channels" | "disabled";
  policyEnabled: boolean;
  accountLinked: boolean;
}> = {}) {
  return {
    id: "installation-1",
    teamName: "BMH Group Slack",
    appId: "A123456",
    status: "active" as const,
    currentVersion: 2,
    policyMode: "disabled" as const,
    policyEnabled: false,
    accountLinked: true,
    ...overrides,
  };
}

function policyResponse(
  overrides: Partial<{
    orgId: string | null;
    canManage: boolean;
    installations: ReturnType<typeof installation>[];
  }> = {},
) {
  return {
    orgId: "org-1",
    canManage: true,
    installations: [installation()],
    ...overrides,
  };
}

describe("SlackPreviewsClient", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(response(policyResponse()));
  });

  it("loads owner status and enables previews with the acknowledgement", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(response(policyResponse()));
    fetchMock.mockResolvedValueOnce(
      response({ ok: true, mode: "eligible_internal_channels", policyRevision: 2 }),
    );

    render(<SlackPreviewsClient orgId="org-1" />);

    expect(await screen.findByText("Workspace connected")).toBeVisible();
    const enabled = screen.getByRole("switch", { name: "Enable Slack lead previews" });
    expect(enabled).not.toBeChecked();
    await user.click(screen.getByRole("checkbox", { name: "Acknowledge Slack sharing" }));
    await user.click(enabled);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[0][0]).toBe("/api/integrations/slack/policy?orgId=org-1");
    expect(fetchMock.mock.calls[1][0]).toBe("/api/integrations/slack/policy");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      installationId: "installation-1",
      orgId: "org-1",
      enabled: true,
      sharingPolicyAcknowledged: true,
    });
    expect(await screen.findByText("Slack lead previews enabled.")).toBeVisible();
    expect(enabled).toBeChecked();
  });

  it("requires the acknowledgement before an owner can enable previews", async () => {
    const user = userEvent.setup();
    render(<SlackPreviewsClient />);

    const enabled = await screen.findByRole("switch", { name: "Enable Slack lead previews" });
    await user.click(enabled);

    expect(await screen.findByText("Review and accept the sharing acknowledgement before enabling previews.")).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(enabled).not.toBeChecked();
  });

  it("renders an enabled policy and allows an owner to disable it", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(response(policyResponse({
      installations: [installation({ policyMode: "eligible_internal_channels", policyEnabled: true })],
    })));
    fetchMock.mockResolvedValueOnce(response({ ok: true, mode: "disabled", policyRevision: 5 }));

    render(<SlackPreviewsClient />);
    const enabled = await screen.findByRole("switch", { name: "Enable Slack lead previews" });
    expect(enabled).toBeChecked();
    await user.click(enabled);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({
      installationId: "installation-1",
      orgId: "org-1",
      enabled: false,
      sharingPolicyAcknowledged: false,
    });
    expect(await screen.findByText("Slack lead previews disabled.")).toBeVisible();
    expect(enabled).not.toBeChecked();
  });

  it("shows legacy previews as automatic sharing off and can disable them explicitly", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(response(policyResponse({
      installations: [installation({ policyMode: "legacy" })],
    })));
    fetchMock.mockResolvedValueOnce(response({ ok: true, mode: "disabled", policyRevision: 6 }));
    render(<SlackPreviewsClient />);

    const enabled = await screen.findByRole("switch", { name: "Enable Slack lead previews" });
    expect(enabled).not.toBeChecked();
    expect(screen.getByText(/Legacy previews remain limited to Slack channels that were previously approved/i)).toBeVisible();
    expect(screen.getByText(/Automatic sharing is currently off/i)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Disable all previews" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({
      installationId: "installation-1",
      orgId: "org-1",
      enabled: false,
      sharingPolicyAcknowledged: false,
    });
    expect(await screen.findByText("Slack lead previews disabled.")).toBeVisible();
    expect(enabled).not.toBeChecked();
  });

  it("lets a non-owner connect their account and view status without managing the policy", async () => {
    fetchMock.mockResolvedValueOnce(response(policyResponse({
      canManage: false,
      installations: [installation({ accountLinked: false })],
    })));

    render(<SlackPreviewsClient />);

    expect(await screen.findByText("Your account not connected")).toBeVisible();
    expect(screen.getByRole("switch", { name: "Enable Slack lead previews" })).toBeDisabled();
    expect(screen.getByText("Only organization owners can change this setting.")).toBeVisible();
    expect(screen.getByRole("link", { name: "Connect Slack for previews" })).toHaveAttribute(
      "href",
      "/api/oauth/slack/start?preview=1&return_to=%2Fsettings%2Fintegrations%2Fslack-previews&org_id=org-1",
    );
  });

  it("uses the verified organization when loading and connecting a selected workspace", async () => {
    fetchMock.mockResolvedValueOnce(response(policyResponse({
      installations: [
        installation({ id: "installation-1", teamName: "First organization", accountLinked: false }),
        installation({ id: "installation-2", teamName: null, accountLinked: false }),
      ],
    })));

    render(<SlackPreviewsClient orgId="org-1" />);

    expect(await screen.findByRole("combobox", { name: "Slack workspace" })).toHaveValue("installation-1");
    await userEvent.setup().selectOptions(screen.getByRole("combobox", { name: "Slack workspace" }), "installation-2");
    expect(screen.getByRole("link", { name: "Connect Slack for previews" })).toHaveAttribute(
      "href",
      "/api/oauth/slack/start?preview=1&return_to=%2Fsettings%2Fintegrations%2Fslack-previews&org_id=org-1",
    );
    expect(screen.queryByText("A123456")).toBeNull();
  });

  it("keeps a read failure safe and offers a retry", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network detail must stay private"));
    render(<SlackPreviewsClient />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Slack preview settings are temporarily unavailable.");
    expect(screen.queryByText("network detail must stay private")).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
    expect(screen.queryByRole("switch", { name: "Enable Slack lead previews" })).toBeNull();
  });

  it("retains the safe current state when saving fails", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(response(policyResponse()));
    fetchMock.mockResolvedValueOnce(response({ error: "Could not save this setting." }, 503));
    render(<SlackPreviewsClient />);

    const enabled = await screen.findByRole("switch", { name: "Enable Slack lead previews" });
    await user.click(screen.getByRole("checkbox", { name: "Acknowledge Slack sharing" }));
    await user.click(enabled);

    expect(await screen.findByText("Could not update Slack preview settings. Please try again.")).toBeVisible();
    expect(screen.queryByText("Could not save this setting.")).toBeNull();
    expect(enabled).not.toBeChecked();
  });

  it("does not show enabled after the server returns disabled for an enable request", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(response(policyResponse()));
    fetchMock.mockResolvedValueOnce(response({ ok: true, mode: "disabled", policyRevision: 3 }));
    render(<SlackPreviewsClient />);

    const enabled = await screen.findByRole("switch", { name: "Enable Slack lead previews" });
    await user.click(screen.getByRole("checkbox", { name: "Acknowledge Slack sharing" }));
    await user.click(enabled);

    expect(await screen.findByText("Could not update Slack preview settings. Please try again.")).toBeVisible();
    expect(enabled).not.toBeChecked();
    expect(screen.queryByText("Slack lead previews enabled.")).toBeNull();
  });

  it("does not show disabled after the server returns enabled for a disable request", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(response(policyResponse({
      installations: [installation({ policyMode: "eligible_internal_channels", policyEnabled: true })],
    })));
    fetchMock.mockResolvedValueOnce(response({ ok: true, mode: "eligible_internal_channels", policyRevision: 4 }));
    render(<SlackPreviewsClient />);

    const enabled = await screen.findByRole("switch", { name: "Enable Slack lead previews" });
    await user.click(enabled);

    expect(await screen.findByText("Could not update Slack preview settings. Please try again.")).toBeVisible();
    expect(enabled).toBeChecked();
    expect(screen.queryByText("Slack lead previews disabled.")).toBeNull();
  });

  it("keeps the current state when the server response has no valid mode", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(response(policyResponse()));
    fetchMock.mockResolvedValueOnce(response({ ok: true, policyRevision: 5 }));
    render(<SlackPreviewsClient />);

    const enabled = await screen.findByRole("switch", { name: "Enable Slack lead previews" });
    await user.click(screen.getByRole("checkbox", { name: "Acknowledge Slack sharing" }));
    await user.click(enabled);

    expect(await screen.findByText("Could not update Slack preview settings. Please try again.")).toBeVisible();
    expect(enabled).not.toBeChecked();
  });
});
