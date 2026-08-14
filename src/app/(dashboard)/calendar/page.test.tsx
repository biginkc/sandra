import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createClient,
  fetchAssigneeEmails,
  fetchCalendarAppointments,
  fetchOrgRoster,
  getCallerMemberships,
  loadIntegrationPrefs,
} = vi.hoisted(() => ({
  createClient: vi.fn(),
  fetchAssigneeEmails: vi.fn(async () => ({})),
  fetchCalendarAppointments: vi.fn(),
  fetchOrgRoster: vi.fn(),
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
vi.mock("./queries", () => ({
  fetchAssigneeEmails,
  fetchCalendarAppointments,
  fetchOrgRoster,
}));
// The `_components` lane's real CalendarView is a "use client" component
// that reads next/navigation hooks — irrelevant to what this page-level
// test is verifying (the error/empty/degraded-roster branching in
// page.tsx itself), so it's stubbed to a plain marker that surfaces the
// props this test cares about.
vi.mock("./_components/calendar-view", () => ({
  CalendarView: (props: {
    appointments: unknown[];
    assignees: Record<string, string>;
    assigneeLabels: Record<string, string>;
  }) => (
    <div data-testid="calendar-view-stub">
      <span data-testid="appointment-count">{props.appointments.length}</span>
      <span data-testid="assignee-count">{Object.keys(props.assignees).length}</span>
      {Object.entries(props.assigneeLabels).map(([id, label]) => (
        <span key={id} data-testid={`assignee-label-${id}`}>
          {label}
        </span>
      ))}
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
    fetchOrgRoster.mockResolvedValue({
      ok: true,
      labelsDegraded: false,
      roster: [{ id: "user-1", label: "owner@bmh.com" }],
    });

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
    expect(fetchOrgRoster).not.toHaveBeenCalled();
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
    fetchOrgRoster.mockResolvedValue({
      ok: true,
      labelsDegraded: false,
      roster: [{ id: "user-1", label: "owner@bmh.com" }],
    });

    const jsx = await CalendarPage({ searchParams: Promise.resolve({}) });
    render(jsx);

    expect(screen.queryByText(/Calendar couldn't load/i)).not.toBeInTheDocument();
    expect(screen.getByTestId("calendar-view-stub")).toBeInTheDocument();
    expect(screen.getByTestId("appointment-count")).toHaveTextContent("0");
  });
});

describe("CalendarPage — roster identity load failure", () => {
  it("renders the same explicit retry state as an appointments failure, never a viewer-only fallback", async () => {
    mockUser("user-1", "owner@bmh.com");
    fetchCalendarAppointments.mockResolvedValue({ ok: true, rows: [] });
    fetchOrgRoster.mockResolvedValue({ ok: false });

    const jsx = await CalendarPage({
      searchParams: Promise.resolve({ week: "2026-05-03" }),
    });
    render(jsx);

    // Identity unknown → the filter and ownership attribution are
    // untrustworthy, so this is a full-page retry state, not a degraded
    // "your own appointments only" view (Codex round 3 — that fallback is
    // gone).
    expect(screen.getByText(/Calendar couldn't load/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /retry/i })).toHaveAttribute(
      "href",
      "/calendar?week=2026-05-03",
    );
    expect(screen.queryByTestId("calendar-view-stub")).not.toBeInTheDocument();
    expect(screen.queryByText(/showing your own appointments only/i)).not.toBeInTheDocument();
  });
});

describe("CalendarPage — roster labels degraded (identity known, emails unresolved)", () => {
  it("renders the full roster with fallback labels, controls intact, and a muted names-unavailable note", async () => {
    mockUser("user-1", "owner@bmh.com");
    fetchCalendarAppointments.mockResolvedValue({ ok: true, rows: [] });
    fetchOrgRoster.mockResolvedValue({
      ok: true,
      labelsDegraded: true,
      roster: [
        { id: "user-1", label: "owner@bmh.com" },
        { id: "rep-2", label: "Teammate (rep-2)" },
      ],
    });

    const jsx = await CalendarPage({ searchParams: Promise.resolve({}) });
    render(jsx);

    // The primary content still renders — a labels-only degradation never
    // fails the page, and no teammate is dropped from the roster.
    expect(screen.getByTestId("calendar-view-stub")).toBeInTheDocument();
    expect(screen.getByTestId("assignee-count")).toHaveTextContent("2");
    expect(screen.getByText(/names are unavailable/i)).toBeInTheDocument();
  });
});

describe("CalendarPage — appointment owned by an inactive/former assignee (Codex round 4)", () => {
  it("resolves a former-teammate label for an assignee off the active roster, without adding them to the filter roster", async () => {
    mockUser("user-1", "owner@bmh.com");
    fetchCalendarAppointments.mockResolvedValue({
      ok: true,
      rows: [
        {
          id: "appt-1",
          title: "Walkthrough",
          description: null,
          due_at: "2026-05-05T15:00:00.000Z",
          end_at: "2026-05-05T15:30:00.000Z",
          status: "completed",
          outcome: "held",
          assignee_id: "rep-suspended",
          property_id: null,
          address: null,
          city: null,
          state: null,
          contact_id: null,
          contact_name: null,
        },
      ],
    });
    // The suspended rep is NOT on the active roster — only user-1 is.
    fetchOrgRoster.mockResolvedValue({
      ok: true,
      labelsDegraded: false,
      roster: [{ id: "user-1", label: "owner@bmh.com" }],
    });
    // No email resolvable for the suspended id — falls back to the
    // id-prefix label rather than dropping the attribution.
    fetchAssigneeEmails.mockResolvedValue({});

    const jsx = await CalendarPage({ searchParams: Promise.resolve({}) });
    render(jsx);

    // Filter/roster stays active-roster-only (just the owner).
    expect(screen.getByTestId("assignee-count")).toHaveTextContent("1");
    // But the label map used for per-row attribution covers the inactive
    // assignee too, with a "Former teammate" fallback carrying the id
    // prefix — never silently dropped.
    expect(screen.getByTestId("assignee-label-rep-suspended")).toHaveTextContent(
      "Former teammate (rep-susp)",
    );
    expect(fetchAssigneeEmails).toHaveBeenCalledWith(["rep-suspended"]);
  });

  it("prefers a resolved email over the fallback label when one is available for the inactive assignee", async () => {
    mockUser("user-1", "owner@bmh.com");
    fetchCalendarAppointments.mockResolvedValue({
      ok: true,
      rows: [
        {
          id: "appt-1",
          title: "Walkthrough",
          description: null,
          due_at: "2026-05-05T15:00:00.000Z",
          end_at: "2026-05-05T15:30:00.000Z",
          status: "open",
          outcome: null,
          assignee_id: "rep-former",
          property_id: null,
          address: null,
          city: null,
          state: null,
          contact_id: null,
          contact_name: null,
        },
      ],
    });
    fetchOrgRoster.mockResolvedValue({
      ok: true,
      labelsDegraded: false,
      roster: [{ id: "user-1", label: "owner@bmh.com" }],
    });
    fetchAssigneeEmails.mockResolvedValue({ "rep-former": "former@bmh.com" });

    const jsx = await CalendarPage({ searchParams: Promise.resolve({}) });
    render(jsx);

    expect(screen.getByTestId("assignee-count")).toHaveTextContent("1");
    expect(screen.getByTestId("assignee-label-rep-former")).toHaveTextContent(
      "former@bmh.com",
    );
  });
});
