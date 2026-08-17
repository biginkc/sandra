import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
  fetchDashboardSendilloSmsHealth: vi.fn(),
  fetchDashboardSummary: vi.fn(),
  fetchMyTasks: vi.fn(),
  getStoredSkipTraceBalance: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: mocks.createClient,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: mocks.createAdminClient,
}));
vi.mock("@/lib/skip-trace/balance", () => ({
  getStoredSkipTraceBalance: mocks.getStoredSkipTraceBalance,
}));
vi.mock("@/lib/auth/allowlist", () => ({
  isAdminEmail: vi.fn(() => true),
}));
vi.mock("./queries", () => ({
  fetchDashboardSendilloSmsHealth: mocks.fetchDashboardSendilloSmsHealth,
  fetchDashboardSummary: mocks.fetchDashboardSummary,
  fetchMyTasks: mocks.fetchMyTasks,
}));

vi.mock("@/components/page", () => ({
  Page: ({ children }: { children: React.ReactNode }) => (
    <main>{children}</main>
  ),
}));
vi.mock("@/components/page-header", () => ({
  PageHeader: () => <header data-testid="page-header" />,
}));

function marker(name: string) {
  return function Marker() {
    return <div data-overview-marker={name}>{name}</div>;
  };
}

vi.mock("./_components/needs-attention-strip", () => ({
  NeedsAttentionStrip: marker("needs-attention"),
}));
vi.mock("./_components/tasks-panel", () => ({
  TasksPanel: marker("my-tasks"),
}));
vi.mock("./_components/threads-needing-attention", () => ({
  ThreadsNeedingAttention: marker("threads-needing-attention"),
}));
vi.mock("./_components/kpi-cards", () => ({
  KpiRowOne: marker("kpi-row-one"),
  KpiRowTwo: marker("kpi-row-two"),
}));
vi.mock("./_components/skip-trace-credits", () => ({
  SkipTraceCredits: marker("skip-trace-credits"),
}));
vi.mock("./_components/sendillo-health-card", () => ({
  SendilloHealthCard: marker("sendillo-health"),
}));
vi.mock("./_components/quick-actions", () => ({
  QuickActions: marker("quick-actions"),
}));
vi.mock("./_components/activity-feed", () => ({
  ActivityFeed: marker("activity"),
}));

import DashboardPage from "./page";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createClient.mockResolvedValue({
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: { id: "user-1", email: "owner@example.com" } },
      }),
    },
  });
  mocks.createAdminClient.mockReturnValue({
    auth: {
      admin: {
        listUsers: vi.fn().mockResolvedValue({ data: { users: [] } }),
      },
    },
  });
  mocks.getStoredSkipTraceBalance.mockResolvedValue({ available: false });
  mocks.fetchDashboardSendilloSmsHealth.mockResolvedValue({
    status: "unavailable",
  });
  mocks.fetchMyTasks.mockResolvedValue({
    status: "success",
    overdue: [],
    today: [],
    upcoming: [],
    timezone: "America/Chicago",
  });
  mocks.fetchDashboardSummary.mockResolvedValue({
    total_leads: 12,
    new_this_week: 2,
    not_in_drip: 3,
    hot_leads: { numerator: 1, denominator: 12 },
    skip_trace_coverage: { numerator: 8, denominator: 12 },
    assigned: [],
    needs_attention: {
      escalated_unhandled: 1,
      stale_conversations: 2,
      sequence_ended_no_followup: 3,
      unassigned: 4,
    },
    threads_needing_attention: [],
    recent_activity: [],
  });
});

describe("DashboardPage ordering", () => {
  it("puts attention, tasks, and escalated threads before KPIs and health", async () => {
    const { container } = render(await DashboardPage());

    const markerOrder = Array.from(
      container.querySelectorAll<HTMLElement>("[data-overview-marker]"),
    ).map((element) => element.dataset.overviewMarker);

    expect(markerOrder).toEqual([
      "needs-attention",
      "my-tasks",
      "threads-needing-attention",
      "kpi-row-one",
      "kpi-row-two",
      "skip-trace-credits",
      "sendillo-health",
      "quick-actions",
      "activity",
    ]);
  });

  it("offers a functional same-route Retry when the summary request fails", async () => {
    mocks.fetchDashboardSummary.mockResolvedValue(null);

    render(await DashboardPage());

    expect(screen.getByText(/Could not load dashboard data/)).toBeVisible();
    expect(screen.getByRole("link", { name: "Retry" })).toHaveAttribute(
      "href",
      "/dashboard",
    );
  });
});
