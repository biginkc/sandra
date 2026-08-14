import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createClient,
  fetchCalendarAppointments,
  fetchOrgAssigneeEmails,
  getCallerMemberships,
  loadIntegrationPrefs,
} = vi.hoisted(() => ({
  createClient: vi.fn(),
  fetchCalendarAppointments: vi.fn(),
  fetchOrgAssigneeEmails: vi.fn(),
  getCallerMemberships: vi.fn(),
  loadIntegrationPrefs: vi.fn(async () => ({
    slackEnabled: true,
    calendarEnabled: true,
    timezone: "America/Chicago",
  })),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient }));
vi.mock("@/lib/auth/memberships", () => ({ getCallerMemberships }));
vi.mock("@/lib/integrations/prefs", () => ({ loadIntegrationPrefs }));
vi.mock("./queries", () => ({ fetchCalendarAppointments, fetchOrgAssigneeEmails }));
// The `_components` lane's real CalendarView is a "use client" component
// that reads next/navigation hooks — irrelevant to what this page-level
// test is verifying (the error/empty/degraded-roster branching in
// page.tsx itself), so it's stubbed to a plain marker that surfaces the
// props this test cares about.
vi.mock("./_components/calendar-view", () => ({
  CalendarView: (props: { appointments: unknown[]; assignees: Record<string, string> }) => (
    <div data-testid="calendar-view-stub">
      <span data-testid="appointment-count">{props.appointments.length}</span>
      <span data-testid="assignee-count">{Object.keys(props.assignees).length}</span>
    </div>
  ),
}));

import CalendarPage from "./page";

function mockUser(userId = "user-1", email = "owner@bmh.com") {
  createClient.mockResolvedValue({
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: userId, email } } }),
    },
  });
  getCallerMemberships.mockResolvedValue([
    { user_id: userId, org_id: "org-1", role: "owner" },
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();
  loadIntegrationPrefs.mockResolvedValue({
    slackEnabled: true,
    calendarEnabled: true,
    timezone: "America/Chicago",
  });
});

describe("CalendarPage — appointments load failure", () => {
  it("renders an explicit retry state, never the empty-week UI, on a query failure", async () => {
    mockUser();
    fetchCalendarAppointments.mockResolvedValue({ ok: false });
    fetchOrgAssigneeEmails.mockResolvedValue({ ok: true, emails: { "user-1": "owner@bmh.com" } });

    const jsx = await CalendarPage({
      searchParams: Promise.resolve({ week: "2026-05-03" }),
    });
    render(jsx);

    expect(screen.getByText(/Calendar couldn't load/i)).toBeInTheDocument();
    const retryLink = screen.getByRole("link", { name: /retry/i });
    expect(retryLink).toHaveAttribute("href", "/calendar?week=2026-05-03");
    // The failure path must not mount CalendarView at all — no risk of it
    // rendering an empty week for what was actually a load failure.
    expect(screen.queryByTestId("calendar-view-stub")).not.toBeInTheDocument();
    // A load failure short-circuits before the roster fetch even runs.
    expect(fetchOrgAssigneeEmails).not.toHaveBeenCalled();
  });

  it("preserves the assignee and view params on the retry link", async () => {
    mockUser();
    fetchCalendarAppointments.mockResolvedValue({ ok: false });

    const jsx = await CalendarPage({
      searchParams: Promise.resolve({ week: "2026-05-03", assignee: "all", view: "agenda" }),
    });
    render(jsx);

    expect(screen.getByRole("link", { name: /retry/i })).toHaveAttribute(
      "href",
      "/calendar?week=2026-05-03&assignee=all&view=agenda",
    );
  });
});

describe("CalendarPage — genuinely empty week", () => {
  it("renders CalendarView with zero appointments, not the error state", async () => {
    mockUser();
    fetchCalendarAppointments.mockResolvedValue({ ok: true, rows: [] });
    fetchOrgAssigneeEmails.mockResolvedValue({ ok: true, emails: { "user-1": "owner@bmh.com" } });

    const jsx = await CalendarPage({ searchParams: Promise.resolve({}) });
    render(jsx);

    expect(screen.queryByText(/Calendar couldn't load/i)).not.toBeInTheDocument();
    expect(screen.getByTestId("calendar-view-stub")).toBeInTheDocument();
    expect(screen.getByTestId("appointment-count")).toHaveTextContent("0");
  });
});

describe("CalendarPage — roster (assignee email) load failure", () => {
  it("degrades to a viewer-only roster and a muted note instead of failing the page", async () => {
    mockUser("user-1", "owner@bmh.com");
    fetchCalendarAppointments.mockResolvedValue({ ok: true, rows: [] });
    fetchOrgAssigneeEmails.mockResolvedValue({ ok: false });

    const jsx = await CalendarPage({ searchParams: Promise.resolve({}) });
    render(jsx);

    // The primary content (appointments) still renders — a roster failure
    // is not treated as a whole-page failure.
    expect(screen.getByTestId("calendar-view-stub")).toBeInTheDocument();
    expect(screen.getByText(/couldn't load the team roster/i)).toBeInTheDocument();
    // Viewer-only fallback roster: just the caller, keyed by their own id.
    expect(screen.getByTestId("assignee-count")).toHaveTextContent("1");
  });
});
