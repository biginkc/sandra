"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

import type { CalendarViewProps } from "../types";

import { AgendaList } from "./agenda-list";
import { addDaysToDateKey, monthStartDateKey } from "./calendar-shared";
import { MonthGrid } from "./month-grid";
import { NewBlockButton } from "./new-block-button";
import { WeekGrid } from "./week-grid";

const ALL = "all";
const ME = "me";

const TAB_BASE =
  "inline-flex min-h-11 items-center rounded-full px-3 py-1.5 text-xs font-bold";
const TAB_ACTIVE = "bg-card text-foreground border-border border";
const TAB_INACTIVE = "text-muted-foreground hover:text-foreground";

/**
 * Calendar page's top-level client component: view switcher
 * (Week/Month/Agenda),
 * week navigation, an assignee filter (both roles — Codex round 1; a
 * member's default is their own items, not a lockout), "+ New", and the
 * WeekGrid/AgendaList surfaces below. Everything view-affecting lives in
 * the URL (`?view=&week=&month=&assignee=`) so the page stays deep-linkable;
 * View state stays in links; period controls are real buttons that push
 * URL-backed anchors, and the assignee `<Select>` replaces its URL state.
 *
 * Desktop/mobile split is CSS-only (`md:` classes), no separate route or
 * fetch: WeekGrid and MonthGrid are hidden below `md`; AgendaList mounts
 * exactly once and represents the active range on a phone. In particular,
 * a narrow Month deep link keeps Month visibly active and labels the
 * 42-day list as a month agenda. Mounting AgendaList exactly once avoids
 * duplicate DOM nodes / duplicate `data-testid`s.
 */
export function CalendarView({
  view,
  week,
  month,
  isCurrentPeriod,
  days,
  appointments,
  timezone,
  viewerRole,
  assignees,
  assigneeLabels,
  currentUserId,
  nowMs,
  todayKey,
}: CalendarViewProps) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();

  const buildHref = (updates: Record<string, string | null>): string => {
    const sp = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(updates)) {
      if (value === null) sp.delete(key);
      else sp.set(key, value);
    }
    const qs = sp.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  };

  const rawAssignee = searchParams.get("assignee");
  // Normalize against the LIVE roster exactly like the page's query scope
  // (scoping.ts): an unknown or removed teammate in a deep link must render
  // the same value the query actually used — never a blank selector over
  // differently-scoped results (Codex round 10).
  // Own raw user id canonicalizes to ME — the selector's self option is
  // 'me', so a ?assignee=<own-id> deep link must render it (round 11).
  const normalizedAssignee =
    rawAssignee === currentUserId
      ? ME
      : rawAssignee === null ||
          rawAssignee === ALL ||
          rawAssignee === ME ||
          Object.prototype.hasOwnProperty.call(assignees, rawAssignee)
        ? rawAssignee
        : null;
  // No param -> the role's default (owner: everyone; member: me). Once a
  // value is picked, it's always written explicitly (including "all"), so
  // "Everyone" round-trips through the URL instead of collapsing back to
  // "no param" — which would silently re-default to "me" for a member
  // (page.tsx's `resolveAssigneeId` treats absence and role differently).
  const assigneeValue =
    normalizedAssignee ?? (viewerRole === "owner" ? ALL : ME);

  const onAssigneeChange = (value: string | null) => {
    if (!value) return;
    router.replace(buildHref({ assignee: value }));
  };

  // Full org roster minus the viewer (who already has the dedicated "Me"
  // option) — `assignees` is the full active-membership roster per the
  // shared contract (Codex round 1: loaded independently of the week's
  // appointments), not just the ids referenced in the current appointment
  // set, and available to both roles now that members get the filter too.
  const memberOptions = Object.entries(assignees)
    .filter(([id]) => id !== currentUserId)
    .sort(([, a], [, b]) => a.localeCompare(b));
  const monthLabel = month
    ? new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        month: "long",
        year: "numeric",
      }).format(new Date(`${month}-15T12:00:00.000Z`))
    : null;
  const previousHref =
    view === "month" && month
      ? buildHref({ month: monthStartDateKey(month, -1).slice(0, 7) })
      : buildHref({ week: addDaysToDateKey(week, -7) });
  const nextHref =
    view === "month" && month
      ? buildHref({ month: monthStartDateKey(month, 1).slice(0, 7) })
      : buildHref({ week: addDaysToDateKey(week, 7) });
  const todayHref = buildHref({ week: null, month: null });

  return (
    <div className="flex flex-col gap-4" data-testid="calendar-view">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav
          className="flex w-full items-center gap-1 sm:w-auto"
          aria-label="Calendar view"
        >
          <Link
            href={buildHref({ view: "week" })}
            data-testid="calendar-view-week"
            aria-current={view === "week" || undefined}
            className={cn(
              TAB_BASE,
              view === "week" ? TAB_ACTIVE : TAB_INACTIVE,
            )}
          >
            Week
          </Link>
          <Link
            href={buildHref({ view: "agenda" })}
            data-testid="calendar-view-agenda"
            aria-current={view === "agenda" || undefined}
            className={cn(
              TAB_BASE,
              view === "agenda" ? TAB_ACTIVE : TAB_INACTIVE,
            )}
          >
            Agenda
          </Link>
          {/* The phone renders the month range as a chronological agenda,
              not as a squeezed 7-column grid. Keep Month visible and
              active so a ?view=month deep link never hides its true state. */}
          <Link
            href={buildHref({
              view: "month",
              month: searchParams.get("month") ?? todayKey.slice(0, 7),
            })}
            data-testid="calendar-view-month"
            aria-current={view === "month" || undefined}
            className={cn(
              TAB_BASE,
              view === "month" ? TAB_ACTIVE : TAB_INACTIVE,
            )}
          >
            Month
          </Link>
        </nav>

        <div className="flex w-full items-center justify-between gap-3 text-xs font-bold sm:w-auto sm:justify-start">
          {/* Legacy selector wrappers remain click-compatible while the
              amendment adds the final selector names to real buttons. */}
          <span
            data-testid="calendar-week-prev"
            className="inline-flex min-h-11"
          >
            <button
              type="button"
              data-testid="calendar-prev"
              aria-label="Previous period"
              onClick={() => router.push(previousHref)}
              className="border-border bg-card text-muted-foreground hover:text-foreground inline-flex min-h-11 items-center rounded-full border px-3 whitespace-nowrap"
            >
              ← Prev
            </button>
          </span>
          <span
            data-testid="calendar-week-today"
            className="inline-flex min-h-11 min-w-11"
          >
            <button
              type="button"
              data-testid="calendar-today"
              onClick={() => router.push(todayHref)}
              className={cn(
                "inline-flex min-h-11 min-w-11 items-center justify-center rounded-full border px-3 whitespace-nowrap",
                isCurrentPeriod
                  ? "border-border bg-card text-foreground hover:bg-muted"
                  : "border-foreground bg-foreground text-background",
              )}
            >
              Today
            </button>
          </span>
          <span
            data-testid="calendar-week-next"
            className="inline-flex min-h-11"
          >
            <button
              type="button"
              data-testid="calendar-next"
              aria-label="Next period"
              onClick={() => router.push(nextHref)}
              className="border-border bg-card text-muted-foreground hover:text-foreground inline-flex min-h-11 items-center rounded-full border px-3 whitespace-nowrap"
            >
              Next →
            </button>
          </span>
        </div>

        <div className="flex w-full items-center gap-2 sm:w-auto">
          {/* Both roles get the filter (Codex round 1) — "own items" is
              a default for members, not a lockout, and the booking flow
              already lets a member act on a teammate's behalf. */}
          <Select value={assigneeValue} onValueChange={onAssigneeChange}>
            <SelectTrigger
              size="sm"
              className="min-h-11 min-w-0 flex-1 sm:w-40 sm:flex-none"
              aria-label="Filter calendar by assignee"
              data-testid="calendar-assignee-filter"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL} className="min-h-11">
                Everyone
              </SelectItem>
              <SelectItem value={ME} className="min-h-11">
                Me
              </SelectItem>
              {memberOptions.map(([id, email]) => (
                <SelectItem key={id} value={id} className="min-h-11">
                  {email}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="[&>button]:min-h-11">
            <NewBlockButton currentUserId={currentUserId} />
          </div>
        </div>
      </div>

      {appointments.length === 0 ? (
        <div
          className="text-muted-foreground -mt-2 text-xs font-semibold"
          data-testid="calendar-empty-range-notice"
        >
          Nothing scheduled in this period.
        </div>
      ) : null}

      <div
        className="text-muted-foreground text-xs"
        data-testid="calendar-timezone-caption"
      >
        All times shown in {timezone}.
      </div>

      {view === "month" && monthLabel ? (
        <div
          className="border-border bg-muted/40 rounded-xl border px-3 py-2 text-sm font-semibold md:hidden"
          data-testid="calendar-mobile-month-state"
        >
          Month agenda for {monthLabel}
        </div>
      ) : null}

      {view === "month" && month ? (
        <div className="hidden md:block">
          <MonthGrid
            currentUserId={currentUserId}
            days={days}
            appointments={appointments}
            timezone={timezone}
            viewerRole={viewerRole}
            assignees={assigneeLabels}
            month={month}
            nowMs={nowMs}
            todayKey={todayKey}
            dayHref={(date) => buildHref({ view: "week", week: date })}
          />
        </div>
      ) : null}

      {view === "week" ? (
        <div className="hidden md:block">
          <WeekGrid
            currentUserId={currentUserId}
            days={days}
            appointments={appointments}
            timezone={timezone}
            viewerRole={viewerRole}
            assignees={assigneeLabels}
            nowMs={nowMs}
            todayKey={todayKey}
          />
        </div>
      ) : null}

      <div
        className={view === "agenda" ? "block" : "md:hidden"}
        data-testid="calendar-agenda-wrapper"
      >
        <AgendaList
          key={`${days[0]?.date ?? "empty"}:${days.at(-1)?.date ?? "empty"}`}
          currentUserId={currentUserId}
          days={days}
          appointments={appointments}
          timezone={timezone}
          viewerRole={viewerRole}
          assignees={assigneeLabels}
          nowMs={nowMs}
        />
      </div>
    </div>
  );
}
