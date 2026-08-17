import * as React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { addDaysInZone, getDayBoundsInZone } from "@/lib/time/zoned";

import type { CalendarDayBounds } from "../types";

import { CalendarView } from "./calendar-view";

const CHI = "America/Chicago";

// Mutable holder read by the useSearchParams mock below — vi.mock factories
// are hoisted, so the mock reads through this ref rather than a plain
// module-scope `let` (which vi.mock can't close over safely).
const nav = vi.hoisted(() => ({
  search: "",
  replace: vi.fn(),
  push: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/calendar",
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({
    replace: nav.replace,
    push: nav.push,
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

// AppointmentOutcomeRow's own internals are covered elsewhere (see
// appointment-outcome-row.test.tsx / week-grid.test.tsx / agenda-list.test.tsx)
// — stub it so mounting WeekGrid/AgendaList here doesn't drag in server
// actions.
vi.mock("@/components/appointments/appointment-outcome-row", () => ({
  AppointmentOutcomeRow: () => <div data-testid="stub-outcome-row" />,
}));

// NewBlockButton's own wiring is covered by new-block-button.test.tsx —
// stub it here so this suite only asserts CalendarView renders it with the
// right currentUserId, without dragging in BookAppointmentPopover.
vi.mock("./new-block-button", () => ({
  NewBlockButton: ({ currentUserId }: { currentUserId: string }) => (
    <div data-testid="stub-new-block-button">{currentUserId}</div>
  ),
}));

// Mirrors book-appointment-popover.test.tsx's convention for the
// base-ui-backed Select primitive (no ResizeObserver/PointerEvent
// polyfills in this jsdom setup).
vi.mock("@/components/ui/select", () => {
  const Ctx = React.createContext<{
    onValueChange: (value: string | null) => void;
  }>({ onValueChange: () => {} });
  return {
    Select: ({
      value,
      onValueChange,
      children,
    }: {
      value: string;
      onValueChange: (value: string | null) => void;
      children: React.ReactNode;
    }) => (
      <Ctx.Provider value={{ onValueChange }}>
        <div data-testid="calendar-assignee-filter-value">{value}</div>
        {children}
      </Ctx.Provider>
    ),
    SelectTrigger: ({
      children,
      ...props
    }: React.ComponentPropsWithoutRef<"div">) => (
      <div {...props}>{children}</div>
    ),
    SelectValue: () => null,
    SelectContent: ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    ),
    SelectItem: ({
      value,
      children,
    }: {
      value: string;
      children: React.ReactNode;
    }) => {
      const { onValueChange } = React.useContext(Ctx);
      return (
        <button
          type="button"
          data-testid={`select-item-${value}`}
          onClick={() => onValueChange(value)}
        >
          {children}
        </button>
      );
    },
  };
});

function dateKeyInZone(d: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const map: Record<string, string> = {};
  for (const p of parts) if (p.type !== "literal") map[p.type] = p.value;
  return `${map.year}-${map.month}-${map.day}`;
}

function buildWeek(anchor: Date, tz: string): CalendarDayBounds[] {
  const days: CalendarDayBounds[] = [];
  let cursor = getDayBoundsInZone(anchor, tz).dayStart;
  for (let i = 0; i < 7; i++) {
    const dayEnd = addDaysInZone(cursor, 1, tz);
    days.push({
      date: dateKeyInZone(cursor, tz),
      startUtc: cursor.toISOString(),
      endUtc: dayEnd.toISOString(),
    });
    cursor = dayEnd;
  }
  return days;
}

const DAYS = buildWeek(new Date("2026-08-19T12:00:00Z"), CHI);
const WEEK = DAYS[0].date;

function baseProps(
  overrides: Partial<React.ComponentProps<typeof CalendarView>> = {},
): React.ComponentProps<typeof CalendarView> {
  const defaults: React.ComponentProps<typeof CalendarView> = {
    view: "week" as const,
    week: WEEK,
    month: null,
    isCurrentPeriod: true,
    days: DAYS,
    appointments: [],
    timezone: CHI,
    viewerRole: "owner" as const,
    assignees: {},
    assigneeLabels: {},
    currentUserId: "user-1",
    nowMs: new Date("2026-08-19T12:00:00Z").getTime(),
    todayKey: dateKeyInZone(new Date("2026-08-19T12:00:00Z"), CHI),
  };
  return { ...defaults, ...overrides } as React.ComponentProps<
    typeof CalendarView
  >;
}

describe("<CalendarView />", () => {
  beforeEach(() => {
    nav.search = "";
    nav.replace.mockClear();
    nav.push.mockClear();
  });

  it("renders view-switcher links that preserve other params", () => {
    nav.search = "assignee=rep-1";
    render(<CalendarView {...baseProps({ view: "week" })} />);

    expect(screen.getByTestId("calendar-view-week")).toHaveAttribute(
      "href",
      "/calendar?assignee=rep-1&view=week",
    );
    expect(screen.getByTestId("calendar-view-agenda")).toHaveAttribute(
      "href",
      "/calendar?assignee=rep-1&view=agenda",
    );
    expect(screen.getByTestId("calendar-view-month")).toHaveAttribute(
      "href",
      "/calendar?assignee=rep-1&view=month&month=2026-08",
    );
    expect(
      screen.getByRole("navigation", { name: "Calendar view" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  });

  it("uses real week-nav buttons, preserves view+assignee, shifts by 7 days, and Today clears both independent anchors", async () => {
    nav.search = "view=agenda&assignee=rep-1";
    render(
      <CalendarView {...baseProps({ view: "agenda", week: "2026-08-17" })} />,
    );

    const user = userEvent.setup();
    await user.click(screen.getByTestId("calendar-prev"));
    expect(nav.push).toHaveBeenLastCalledWith(
      "/calendar?view=agenda&assignee=rep-1&week=2026-08-10",
    );
    await user.click(screen.getByTestId("calendar-next"));
    expect(nav.push).toHaveBeenLastCalledWith(
      "/calendar?view=agenda&assignee=rep-1&week=2026-08-24",
    );
    await user.click(screen.getByTestId("calendar-today"));
    expect(nav.push).toHaveBeenLastCalledWith(
      "/calendar?view=agenda&assignee=rep-1",
    );
    expect(screen.getByTestId("calendar-prev")).toHaveAttribute(
      "aria-label",
      "Previous period",
    );
    expect(screen.getByTestId("calendar-next")).toHaveAttribute(
      "aria-label",
      "Next period",
    );
  });

  it("shows WeekGrid (hidden below md) and mounts AgendaList exactly once, hidden on desktop, when view=week", () => {
    render(<CalendarView {...baseProps({ view: "week" })} />);

    const weekGrid = screen.getByTestId("calendar-week-grid");
    expect(weekGrid.parentElement).toHaveClass("hidden", "md:block");

    expect(screen.getAllByTestId("calendar-agenda-wrapper")).toHaveLength(1);
    expect(screen.getByTestId("calendar-agenda-wrapper")).toHaveClass(
      "md:hidden",
    );
  });

  it("does not mount WeekGrid and shows AgendaList unconditionally when view=agenda", () => {
    render(<CalendarView {...baseProps({ view: "agenda" })} />);

    expect(screen.queryByTestId("calendar-week-grid")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("calendar-agenda-wrapper")).toHaveLength(1);
    expect(screen.getByTestId("calendar-agenda-wrapper")).toHaveClass("block");
  });

  it("renders the assignee filter for both owner and member roles (Codex round 1 — member default is own items, not a lockout)", () => {
    const { rerender } = render(
      <CalendarView {...baseProps({ viewerRole: "owner" })} />,
    );
    expect(screen.getByTestId("calendar-assignee-filter")).toBeInTheDocument();
    expect(screen.getByTestId("calendar-assignee-filter")).toHaveAttribute(
      "aria-label",
      "Filter calendar by assignee",
    );

    rerender(<CalendarView {...baseProps({ viewerRole: "member" })} />);
    expect(screen.getByTestId("calendar-assignee-filter")).toBeInTheDocument();
  });

  it("defaults the filter value to Everyone for an owner and Me for a member when ?assignee= is absent", () => {
    nav.search = "";
    const { rerender } = render(
      <CalendarView {...baseProps({ viewerRole: "owner" })} />,
    );
    expect(
      screen.getByTestId("calendar-assignee-filter-value"),
    ).toHaveTextContent("all");

    rerender(<CalendarView {...baseProps({ viewerRole: "member" })} />);
    expect(
      screen.getByTestId("calendar-assignee-filter-value"),
    ).toHaveTextContent("me");
  });

  it("lets a member switch to a teammate or Everyone, writing an explicit ?assignee= param that round-trips (not relying on 'param absent' — that means 'me' for a member)", async () => {
    nav.search = "view=week";
    render(
      <CalendarView
        {...baseProps({
          viewerRole: "member",
          currentUserId: "user-1",
          assignees: { "user-1": "me@bmh.com", "rep-2": "rep2@bmh.com" },
        })}
      />,
    );

    const user = userEvent.setup();
    await user.click(screen.getByTestId("select-item-rep-2"));
    expect(nav.replace).toHaveBeenCalledWith(
      "/calendar?view=week&assignee=rep-2",
    );

    await user.click(screen.getByTestId("select-item-all"));
    expect(nav.replace).toHaveBeenCalledWith(
      "/calendar?view=week&assignee=all",
    );
  });

  it("renders +New with the current user id", () => {
    render(<CalendarView {...baseProps({ currentUserId: "user-42" })} />);
    expect(screen.getByTestId("stub-new-block-button")).toHaveTextContent(
      "user-42",
    );
  });

  it("keeps the toolbar targets at least 44px tall and always names the viewer timezone", () => {
    render(<CalendarView {...baseProps()} />);

    for (const testId of [
      "calendar-view-week",
      "calendar-view-month",
      "calendar-view-agenda",
      "calendar-week-prev",
      "calendar-week-today",
      "calendar-week-next",
      "calendar-prev",
      "calendar-today",
      "calendar-next",
      "calendar-assignee-filter",
    ]) {
      expect(screen.getByTestId(testId)).toHaveClass("min-h-11");
    }
    expect(screen.getByTestId("calendar-week-today")).toHaveClass("min-w-11");
    for (const testId of ["calendar-prev", "calendar-today", "calendar-next"]) {
      expect(screen.getByTestId(testId)).toHaveClass("whitespace-nowrap");
    }
    expect(screen.getByTestId("calendar-timezone-caption")).toHaveTextContent(
      "All times shown in America/Chicago.",
    );
    expect(
      screen.getByTestId("stub-new-block-button").parentElement,
    ).toHaveClass("[&>button]:min-h-11");
  });

  it("navigates via router.replace when the assignee filter changes", async () => {
    nav.search = "view=week";
    render(
      <CalendarView
        {...baseProps({
          viewerRole: "owner",
          assignees: { "rep-1": "rep@bmh.com" },
        })}
      />,
    );

    const user = userEvent.setup();
    await user.click(screen.getByTestId("select-item-rep-1"));

    expect(nav.replace).toHaveBeenCalledWith(
      "/calendar?view=week&assignee=rep-1",
    );
  });

  it("normalizes an unknown deep-linked assignee to the role default in the selector (Codex round 10)", () => {
    nav.search = "assignee=ghost-user-id";
    const { unmount } = render(
      <CalendarView
        {...baseProps({
          viewerRole: "owner",
          assignees: { "rep-1": "rep@bmh.com" },
          currentUserId: "owner-1",
        })}
      />,
    );
    expect(
      screen.getByTestId("calendar-assignee-filter-value").textContent,
    ).toBe("all");
    unmount();

    nav.search = "assignee=ghost-user-id";
    render(
      <CalendarView
        {...baseProps({
          viewerRole: "member",
          assignees: { "rep-1": "rep@bmh.com" },
          currentUserId: "rep-2",
        })}
      />,
    );
    expect(
      screen.getByTestId("calendar-assignee-filter-value").textContent,
    ).toBe("me");
  });

  it("canonicalizes a deep link to the viewer's own raw id as 'me' (Codex round 11)", () => {
    nav.search = "assignee=owner-1";
    render(
      <CalendarView
        {...baseProps({
          viewerRole: "owner",
          assignees: {
            "owner-1": "jarrad@bmhgroupkc.com",
            "rep-1": "rep@bmh.com",
          },
          currentUserId: "owner-1",
        })}
      />,
    );
    expect(
      screen.getByTestId("calendar-assignee-filter-value").textContent,
    ).toBe("me");
  });
});

describe("<CalendarView /> month view", () => {
  beforeEach(() => {
    nav.search = "";
    nav.replace.mockClear();
    nav.push.mockClear();
  });

  it("keeps Month visible on narrow screens so the active deep-link state is truthful", () => {
    render(<CalendarView {...baseProps()} />);
    expect(screen.getByTestId("calendar-view-month")).not.toHaveClass("hidden");
  });

  it("opens Month at its independent current anchor after Week was offset", () => {
    nav.search = "view=week&week=2040-06-10";
    render(<CalendarView {...baseProps({ week: "2040-06-10" })} />);

    expect(screen.getByTestId("calendar-view-month")).toHaveAttribute(
      "href",
      "/calendar?view=month&week=2040-06-10&month=2026-08",
    );
  });

  it("renders the Month tab and mounts MonthGrid when view=month", () => {
    render(
      <CalendarView {...baseProps({ view: "month", month: "2026-08" })} />,
    );
    expect(screen.getByTestId("calendar-view-month")).toHaveAttribute(
      "aria-current",
    );
    expect(screen.getByTestId("calendar-month-grid")).toBeInTheDocument();
    expect(screen.queryByTestId("calendar-week-grid")).not.toBeInTheDocument();
    expect(screen.getByTestId("calendar-mobile-month-state")).toHaveTextContent(
      "Month agenda for August 2026",
    );
    expect(screen.getByTestId("calendar-agenda-wrapper")).toHaveClass(
      "md:hidden",
    );
  });

  it("steps Month independently by whole months and Today resets both anchors", async () => {
    nav.search = "view=month&week=2026-08-16&month=2026-08";
    render(
      <CalendarView
        {...baseProps({ view: "month", month: "2026-08", week: "2026-07-26" })}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByTestId("calendar-prev"));
    expect(nav.push).toHaveBeenLastCalledWith(
      "/calendar?view=month&week=2026-08-16&month=2026-07",
    );
    await user.click(screen.getByTestId("calendar-next"));
    expect(nav.push).toHaveBeenLastCalledWith(
      "/calendar?view=month&week=2026-08-16&month=2026-09",
    );
    await user.click(screen.getByTestId("calendar-today"));
    expect(nav.push).toHaveBeenLastCalledWith("/calendar?view=month");
  });

  it("keeps 7-day stepping for the week view", async () => {
    render(<CalendarView {...baseProps()} />);
    await userEvent.setup().click(screen.getByTestId("calendar-prev"));
    expect(nav.push).toHaveBeenCalledWith(
      expect.stringContaining(`week=${addDaysToDateKeyForTest(WEEK, -7)}`),
    );
  });

  it("fills Today only while the displayed period is offset", () => {
    const { rerender } = render(
      <CalendarView {...baseProps({ isCurrentPeriod: false })} />,
    );
    expect(screen.getByTestId("calendar-today")).toHaveClass(
      "bg-foreground",
      "text-background",
    );
    rerender(<CalendarView {...baseProps({ isCurrentPeriod: true })} />);
    expect(screen.getByTestId("calendar-today")).toHaveClass("bg-card");
  });

  it("renders a truthful empty-period notice without replacing the grid", () => {
    render(<CalendarView {...baseProps({ appointments: [] })} />);
    expect(screen.getByTestId("calendar-empty-range-notice")).toHaveTextContent(
      "Nothing scheduled in this period.",
    );
    expect(screen.getByTestId("calendar-week-grid")).toBeInTheDocument();
  });
});

function addDaysToDateKeyForTest(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  const dt = new Date(Date.UTC(y, (m ?? 1) - 1, (d ?? 1) + days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}
