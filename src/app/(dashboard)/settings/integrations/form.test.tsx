import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { IntegrationsForm } from "./form";
import type { IntegrationStatus } from "./actions";

const {
  disconnectIntegration,
  setChannelEnabledAction,
  setReminderPhoneAction,
  setTimezoneAction,
} = vi.hoisted(() => ({
  disconnectIntegration: vi.fn(async () => ({ ok: true, data: null })),
  setChannelEnabledAction: vi.fn(async () => ({ ok: true, data: null })),
  setReminderPhoneAction: vi.fn(async () => ({ ok: true, data: null })),
  setTimezoneAction: vi.fn(async () => ({ ok: true, data: null })),
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
    disconnectIntegration.mockClear();
    setChannelEnabledAction.mockClear();
    setReminderPhoneAction.mockClear();
    setTimezoneAction.mockClear();
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
    expect(screen.getAllByText("Disconnected")).toHaveLength(2);
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
    expect(screen.getByRole("switch", { name: "Send Slack DMs" })).toBeChecked();
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

function status(
  overrides: Partial<IntegrationStatus> = {},
): IntegrationStatus {
  return {
    slack: { connected: false, enabled: true, teamName: null },
    google: { connected: false, enabled: true, email: null },
    sms: { available: false, enabled: false, phone: null },
    timezone: "America/Chicago",
    ...overrides,
  };
}

describe("<IntegrationsForm /> — SMS reminders", () => {
  beforeEach(() => {
    setChannelEnabledAction.mockClear();
    setReminderPhoneAction.mockClear();
  });

  it("hides the SMS card entirely when unavailable (REP_SMS_FROM_NUMBER unset)", () => {
    render(<IntegrationsForm initial={status({ sms: { available: false, enabled: false, phone: null } })} />);

    expect(screen.queryByLabelText("Phone number")).toBeNull();
    expect(screen.queryByRole("switch", { name: "Send text reminders" })).toBeNull();
  });

  it("shows the SMS card when available, with the toggle disabled until a phone is saved", () => {
    render(
      <IntegrationsForm
        initial={status({ sms: { available: true, enabled: false, phone: null } })}
      />,
    );

    expect(screen.getByLabelText("Phone number")).toBeVisible();
    expect(screen.getByRole("switch", { name: "Send text reminders" })).toBeDisabled();
  });

  it("saving a phone number calls the reminder-phone action", async () => {
    const user = userEvent.setup();
    render(
      <IntegrationsForm
        initial={status({ sms: { available: true, enabled: false, phone: null } })}
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
        initial={status({ sms: { available: true, enabled: false, phone: "+18165551234" } })}
      />,
    );

    const toggle = screen.getByRole("switch", { name: "Send text reminders" });
    expect(toggle).not.toBeDisabled();

    await user.click(toggle);

    await waitFor(() => {
      expect(setChannelEnabledAction).toHaveBeenCalledWith("sms_reminder", true);
    });
  });
});
