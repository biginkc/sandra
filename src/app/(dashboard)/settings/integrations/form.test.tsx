import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { IntegrationsForm } from "./form";
import type { IntegrationStatus } from "./actions";

const {
  connectDropboxSignAction,
  disconnectDropboxSignAction,
  disconnectIntegration,
  setEsignSendingEnabledAction,
  setChannelEnabledAction,
  setReminderPhoneAction,
  setTimezoneAction,
} = vi.hoisted(() => ({
  connectDropboxSignAction: vi.fn(async () => ({
    ok: true,
    data: {
      connected: true,
      canManage: true,
      sendingEnabled: false,
      testMode: true as const,
      apiKeyLastFour: "1234",
    },
  })),
  disconnectDropboxSignAction: vi.fn(async () => ({ ok: true, data: null })),
  disconnectIntegration: vi.fn(async () => ({ ok: true, data: null })),
  setEsignSendingEnabledAction: vi.fn(
    async (): Promise<
      | { ok: true; data: null }
      | { ok: false; error: { code: string; message: string } }
    > => ({ ok: true, data: null }),
  ),
  setChannelEnabledAction: vi.fn(async () => ({ ok: true, data: null })),
  setReminderPhoneAction: vi.fn(async () => ({ ok: true, data: null })),
  setTimezoneAction: vi.fn(async () => ({ ok: true, data: null })),
}));

vi.mock("@/lib/esign/actions", () => ({
  connectDropboxSignAction,
  disconnectDropboxSignAction,
  setEsignSendingEnabledAction,
}));

vi.mock("./actions", () => ({
  disconnectIntegration,
  setChannelEnabledAction,
  setReminderPhoneAction,
  setTimezoneAction,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

describe("<IntegrationsForm />", () => {
  beforeEach(() => {
    connectDropboxSignAction.mockClear();
    disconnectDropboxSignAction.mockClear();
    disconnectIntegration.mockClear();
    setChannelEnabledAction.mockClear();
    setReminderPhoneAction.mockClear();
    setTimezoneAction.mockClear();
    setEsignSendingEnabledAction.mockClear();
  });

  it("renders connect links when no integration tokens exist", () => {
    render(<IntegrationsForm initial={status()} />);

    expect(screen.getByRole("link", { name: "Connect Slack" })).toHaveAttribute(
      "href",
      "/api/oauth/slack/start",
    );
    expect(
      screen.getByRole("link", { name: "Connect Google Calendar" }),
    ).toHaveAttribute("href", "/api/oauth/google/start");
    expect(screen.getAllByText("Disconnected")).toHaveLength(3);
    expect(screen.getByText(/Test mode is always on for v1/i)).toBeVisible();
    expect(screen.queryByRole("link", { name: "Manage templates" })).toBeNull();
  });

  it("renders disconnect controls when Slack is connected", () => {
    render(
      <IntegrationsForm
        initial={status({
          slack: { connected: true, enabled: true, teamName: "BMH Group" },
        })}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Disconnect Slack" }),
    ).toBeVisible();
    expect(screen.getByText("BMH Group")).toBeVisible();
    expect(screen.queryByRole("link", { name: "Connect Slack" })).toBeNull();
    expect(
      screen.getByRole("switch", { name: "Send Slack DMs" }),
    ).toBeChecked();
  });

  it("renders connected Google identity and the manual calendar cleanup note", () => {
    render(
      <IntegrationsForm
        initial={status({
          google: {
            connected: true,
            enabled: false,
            email: "ops@example.com",
          },
        })}
      />,
    );

    expect(screen.getByText("ops@example.com")).toBeVisible();
    expect(
      screen.getByRole("switch", { name: "Create calendar events" }),
    ).not.toBeChecked();
    expect(
      screen.getByText(
        /Calendar events stay scheduled even after a task is completed/i,
      ),
    ).toBeVisible();
  });

  it("toggling Slack calls the channel preference action", async () => {
    const user = userEvent.setup();
    render(
      <IntegrationsForm
        initial={status({
          slack: { connected: true, enabled: true, teamName: "BMH Group" },
        })}
      />,
    );

    await user.click(screen.getByRole("switch", { name: "Send Slack DMs" }));

    await waitFor(() => {
      expect(setChannelEnabledAction).toHaveBeenCalledWith("slack", false);
    });
  });

  it("toggling Google Calendar calls the channel preference action", async () => {
    const user = userEvent.setup();
    render(
      <IntegrationsForm
        initial={status({
          google: {
            connected: true,
            enabled: false,
            email: "ops@example.com",
          },
        })}
      />,
    );

    await user.click(
      screen.getByRole("switch", { name: "Create calendar events" }),
    );

    await waitFor(() => {
      expect(setChannelEnabledAction).toHaveBeenCalledWith(
        "google_calendar",
        true,
      );
    });
  });

  it("changing timezone calls the timezone action", async () => {
    const user = userEvent.setup();
    render(<IntegrationsForm initial={status()} />);

    await user.selectOptions(
      screen.getByLabelText("Timezone for calendar events"),
      "America/New_York",
    );

    await waitFor(() => {
      expect(setTimezoneAction).toHaveBeenCalledWith("America/New_York");
    });
  });

  it("disconnecting Slack calls the disconnect action", async () => {
    const user = userEvent.setup();
    render(
      <IntegrationsForm
        initial={status({
          slack: { connected: true, enabled: true, teamName: "BMH Group" },
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Disconnect Slack" }));

    await waitFor(() => {
      expect(disconnectIntegration).toHaveBeenCalledWith("slack");
    });
  });
});

function status(overrides: Partial<IntegrationStatus> = {}): IntegrationStatus {
  return {
    slack: { connected: false, enabled: true, teamName: null },
    google: { connected: false, enabled: true, email: null },
    sms: { available: false, enabled: false, phone: null },
    esign: {
      connected: false,
      canManage: true,
      sendingEnabled: false,
      testMode: true,
      apiKeyLastFour: null,
    },
    timezone: "America/Chicago",
    ...overrides,
  };
}

describe("<IntegrationsForm /> — Dropbox Sign", () => {
  beforeEach(() => {
    setEsignSendingEnabledAction.mockReset();
    setEsignSendingEnabledAction.mockResolvedValue({ ok: true, data: null });
  });

  it("connects with an owner-entered API key and never renders it as text", async () => {
    const user = userEvent.setup();
    render(<IntegrationsForm initial={status()} />);

    const input = screen.getByLabelText("Primary API key");
    expect(input).toHaveAttribute("type", "password");
    expect(
      screen.getByText(/Use the Primary Key.*callback signatures/i),
    ).toBeVisible();
    await user.type(input, "secret-api-key-1234");
    await user.click(
      screen.getByRole("button", { name: "Connect Dropbox Sign" }),
    );

    await waitFor(() => {
      expect(connectDropboxSignAction).toHaveBeenCalledWith(
        "secret-api-key-1234",
      );
    });
    expect(screen.queryByDisplayValue("secret-api-key-1234")).toBeNull();
    expect(screen.getByText(/Connected ·••••1234/)).toBeVisible();
  });

  it("opens confirmation without changing the committed switch or calling the action", async () => {
    const user = userEvent.setup();
    render(
      <IntegrationsForm
        initial={status({
          esign: {
            connected: true,
            canManage: true,
            sendingEnabled: false,
            testMode: true,
            apiKeyLastFour: "5678",
          },
        })}
      />,
    );

    const toggle = screen.getByRole("switch", {
      name: "Enable contract sending",
    });
    const manageTemplates = screen.getByRole("link", {
      name: "Manage templates",
    });
    await user.click(toggle);
    expect(
      screen.getByRole("heading", { name: "Turn on contract sending?" }),
    ).toBeVisible();
    expect(screen.getByText(/Requires a verified callback/i)).toBeVisible();
    expect(toggle).not.toBeChecked();
    expect(setEsignSendingEnabledAction).not.toHaveBeenCalled();
    expect(manageTemplates).toHaveAttribute(
      "href",
      "/settings/esign-templates",
    );
  });

  it("cancels an enable with no action and returns focus to the switch", async () => {
    const user = userEvent.setup();
    render(
      <IntegrationsForm
        initial={status({
          esign: {
            connected: true,
            canManage: true,
            sendingEnabled: false,
            testMode: true,
            apiKeyLastFour: "5678",
          },
        })}
      />,
    );
    const toggle = screen.getByRole("switch", {
      name: "Enable contract sending",
    });

    await user.click(toggle);
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(toggle).toHaveFocus());
    expect(toggle).not.toBeChecked();
    expect(setEsignSendingEnabledAction).not.toHaveBeenCalled();
  });

  it("dismisses confirmation with Escape or X without calling the action", async () => {
    const user = userEvent.setup();
    render(
      <IntegrationsForm
        initial={status({
          esign: {
            connected: true,
            canManage: true,
            sendingEnabled: false,
            testMode: true,
            apiKeyLastFour: "5678",
          },
        })}
      />,
    );
    const toggle = screen.getByRole("switch", {
      name: "Enable contract sending",
    });

    await user.click(toggle);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(toggle).toHaveFocus());
    expect(setEsignSendingEnabledAction).not.toHaveBeenCalled();

    await user.click(toggle);
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(toggle).toHaveFocus());
    expect(toggle).not.toBeChecked();
    expect(setEsignSendingEnabledAction).not.toHaveBeenCalled();
  });

  it("enables sending only after explicit confirmation succeeds", async () => {
    const user = userEvent.setup();
    render(
      <IntegrationsForm
        initial={status({
          esign: {
            connected: true,
            canManage: true,
            sendingEnabled: false,
            testMode: true,
            apiKeyLastFour: "5678",
          },
        })}
      />,
    );
    const toggle = screen.getByRole("switch", {
      name: "Enable contract sending",
    });

    await user.click(toggle);
    await user.click(screen.getByRole("button", { name: "Turn on sending" }));

    await waitFor(() => {
      expect(setEsignSendingEnabledAction).toHaveBeenCalledOnce();
      expect(setEsignSendingEnabledAction).toHaveBeenCalledWith(true, true);
      expect(toggle).toBeChecked();
    });
  });

  it("keeps the committed switch unchanged when confirmation fails", async () => {
    setEsignSendingEnabledAction.mockResolvedValueOnce({
      ok: false,
      error: { code: "DATABASE", message: "Sending could not be updated." },
    });
    const user = userEvent.setup();
    render(
      <IntegrationsForm
        initial={status({
          esign: {
            connected: true,
            canManage: true,
            sendingEnabled: false,
            testMode: true,
            apiKeyLastFour: "5678",
          },
        })}
      />,
    );
    const toggle = screen.getByRole("switch", {
      name: "Enable contract sending",
    });

    await user.click(toggle);
    await user.click(screen.getByRole("button", { name: "Turn on sending" }));

    await waitFor(() => {
      expect(setEsignSendingEnabledAction).toHaveBeenCalledWith(true, true);
      expect(
        screen.queryByRole("heading", { name: "Turn on contract sending?" }),
      ).toBeNull();
    });
    expect(toggle).not.toBeChecked();
  });

  it("requires confirmation before disabling and updates only after success", async () => {
    const user = userEvent.setup();
    render(
      <IntegrationsForm
        initial={status({
          esign: {
            connected: true,
            canManage: true,
            sendingEnabled: true,
            testMode: true,
            apiKeyLastFour: "5678",
          },
        })}
      />,
    );
    const toggle = screen.getByRole("switch", {
      name: "Enable contract sending",
    });

    await user.click(toggle);
    expect(
      screen.getByRole("heading", { name: "Turn off contract sending?" }),
    ).toBeVisible();
    expect(toggle).toBeChecked();
    expect(setEsignSendingEnabledAction).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Turn off sending" }));
    await waitFor(() => {
      expect(setEsignSendingEnabledAction).toHaveBeenCalledOnce();
      expect(setEsignSendingEnabledAction).toHaveBeenCalledWith(false, true);
      expect(toggle).not.toBeChecked();
    });
  });

  it("prevents members from changing or disconnecting the org connection", () => {
    render(
      <IntegrationsForm
        initial={status({
          esign: {
            connected: true,
            canManage: false,
            sendingEnabled: true,
            testMode: true,
            apiKeyLastFour: "5678",
          },
        })}
      />,
    );

    expect(
      screen.getByRole("switch", { name: "Enable contract sending" }),
    ).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "Disconnect Dropbox Sign" }),
    ).toBeNull();
    expect(screen.queryByRole("link", { name: "Manage templates" })).toBeNull();
  });
});

describe("<IntegrationsForm /> — SMS reminders", () => {
  beforeEach(() => {
    setChannelEnabledAction.mockClear();
    setReminderPhoneAction.mockClear();
  });

  it("hides the SMS card entirely when unavailable (REP_SMS_FROM_NUMBER unset)", () => {
    render(
      <IntegrationsForm
        initial={status({
          sms: { available: false, enabled: false, phone: null },
        })}
      />,
    );

    expect(screen.queryByLabelText("Phone number")).toBeNull();
    expect(
      screen.queryByRole("switch", { name: "Send text reminders" }),
    ).toBeNull();
  });

  it("shows the SMS card when available, with the toggle disabled until a phone is saved", () => {
    render(
      <IntegrationsForm
        initial={status({
          sms: { available: true, enabled: false, phone: null },
        })}
      />,
    );

    expect(screen.getByLabelText("Phone number")).toBeVisible();
    expect(
      screen.getByRole("switch", { name: "Send text reminders" }),
    ).toBeDisabled();
  });

  it("saving a phone number calls the reminder-phone action", async () => {
    const user = userEvent.setup();
    render(
      <IntegrationsForm
        initial={status({
          sms: { available: true, enabled: false, phone: null },
        })}
      />,
    );

    await user.type(screen.getByLabelText("Phone number"), "+18165551234");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(setReminderPhoneAction).toHaveBeenCalledWith("+18165551234");
    });
  });

  it("enables the toggle once a phone is on file, and toggling calls the channel action", async () => {
    const user = userEvent.setup();
    render(
      <IntegrationsForm
        initial={status({
          sms: { available: true, enabled: false, phone: "+18165551234" },
        })}
      />,
    );

    const toggle = screen.getByRole("switch", { name: "Send text reminders" });
    expect(toggle).not.toBeDisabled();

    await user.click(toggle);

    await waitFor(() => {
      expect(setChannelEnabledAction).toHaveBeenCalledWith(
        "sms_reminder",
        true,
      );
    });
  });
});
