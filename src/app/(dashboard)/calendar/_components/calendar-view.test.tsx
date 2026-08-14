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
const nav = vi.hoisted(() => ({ search: "", replace: vi.fn() }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/calendar",
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({
    replace: nav.replace,
    push: vi.fn(),
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
    SelectTrigger: ({ children, ...props }: React.ComponentPropsWithoutRef<"div">) => (
      <div {...props}>{children}</div>
    ),
    SelectValue: () => null,
    SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => {
      const { onValueChange } = React.useContext(Ctx);
      return (
        <button type="button" data-testid={`select-item-${value}`} onClick={() => onValueChange(value)}>
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

function baseProps(overrides: Partial<React.ComponentProps<typeof CalendarView>> = {}) {
  return {
    view: "week" as const,
    week: WEEK,
    days: DAYS,
    appointments: [],
    timezone: CHI,
    viewerRole: "owner" as const,
    assignees: {},
    currentUserId: "user-1",
    ...overrides,
  };
}

describe("<CalendarView />", () => {
  beforeEach(() => {
    nav.search = "";
    nav.replace.mockClear();
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
  });

  it("renders week-nav prev/today/next links preserving view+assignee and shifting by 7 days", () => {
    nav.search = "view=agenda&assignee=rep-1";
    render(<CalendarView {...baseProps({ view: "agenda", week: "2026-08-17" })} />);

    expect(screen.getByTestId("calendar-week-prev")).toHaveAttribute(
      "href",
      "/calendar?view=agenda&assignee=rep-1&week=2026-08-10",
    );
    expect(screen.getByTestId("calendar-week-next")).toHaveAttribute(
      "href",
      "/calendar?view=agenda&assignee=rep-1&week=2026-08-24",
    );
    // "Today" targets today's own date key in the viewer's zone — just
    // assert it's present and well-formed (exact value depends on the
    // real clock, deliberately not frozen here).
    expect(screen.getByTestId("calendar-week-today").getAttribute("href")).toMatch(
      /^\/calendar\?view=agenda&assignee=rep-1&week=\d{4}-\d{2}-\d{2}$/,
    );
  });

  it("shows WeekGrid (hidden below md) and mounts AgendaList exactly once, hidden on desktop, when view=week", () => {
    render(<CalendarView {...baseProps({ view: "week" })} />);

    const weekGrid = screen.getByTestId("calendar-week-grid");
    expect(weekGrid.parentElement).toHaveClass("hidden", "md:block");

    expect(screen.getAllByTestId("calendar-agenda-wrapper")).toHaveLength(1);
    expect(screen.getByTestId("calendar-agenda-wrapper")).toHaveClass("md:hidden");
  });

  it("does not mount WeekGrid and shows AgendaList unconditionally when view=agenda", () => {
    render(<CalendarView {...baseProps({ view: "agenda" })} />);

    expect(screen.queryByTestId("calendar-week-grid")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("calendar-agenda-wrapper")).toHaveLength(1);
    expect(screen.getByTestId("calendar-agenda-wrapper")).toHaveClass("block");
  });

  it("renders the assignee filter for both owner and member roles (Codex round 1 — member default is own items, not a lockout)", () => {
    const { rerender } = render(<CalendarView {...baseProps({ viewerRole: "owner" })} />);
    expect(screen.getByTestId("calendar-assignee-filter")).toBeInTheDocument();

    rerender(<CalendarView {...baseProps({ viewerRole: "member" })} />);
    expect(screen.getByTestId("calendar-assignee-filter")).toBeInTheDocument();
  });

  it("defaults the filter value to Everyone for an owner and Me for a member when ?assignee= is absent", () => {
    nav.search = "";
    const { rerender } = render(<CalendarView {...baseProps({ viewerRole: "owner" })} />);
    expect(screen.getByTestId("calendar-assignee-filter-value")).toHaveTextContent("all");

    rerender(<CalendarView {...baseProps({ viewerRole: "member" })} />);
    expect(screen.getByTestId("calendar-assignee-filter-value")).toHaveTextContent("me");
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
    expect(nav.replace).toHaveBeenCalledWith("/calendar?view=week&assignee=rep-2");

    await user.click(screen.getByTestId("select-item-all"));
    expect(nav.replace).toHaveBeenCalledWith("/calendar?view=week&assignee=all");
  });

  it("renders +New with the current user id", () => {
    render(<CalendarView {...baseProps({ currentUserId: "user-42" })} />);
    expect(screen.getByTestId("stub-new-block-button")).toHaveTextContent("user-42");
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

    expect(nav.replace).toHaveBeenCalledWith("/calendar?view=week&assignee=rep-1");
  });
});
