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
import {
  addDaysToDateKey,
  monthStartDateKey,
  todayDateKeyInZone,
} from "./calendar-shared";
import { MonthGrid } from "./month-grid";
import { NewBlockButton } from "./new-block-button";
import { WeekGrid } from "./week-grid";

const ALL = "all";
const ME = "me";

const TAB_BASE = "rounded-full px-3 py-1.5 text-xs font-bold";
const TAB_ACTIVE = "bg-card text-foreground border-border border";
const TAB_INACTIVE = "text-muted-foreground hover:text-foreground";

/**
 * Calendar page's top-level client component: view switcher (Week/Agenda),
 * week navigation, an assignee filter (both roles — Codex round 1; a
 * member's default is their own items, not a lockout), "+ New", and the
 * WeekGrid/AgendaList surfaces below. Everything view-affecting lives in
 * the URL (`?view=&week=&assignee=`) so the page stays deep-linkable; every
 * control except the assignee `<Select>` (which needs an onChange) is a
 * plain `<Link>` per the plan.
 *
 * Desktop/mobile split is CSS-only (`md:` classes), no separate route or
 * fetch: WeekGrid mounts only when `view==="week"` (hidden below `md` by
 * its wrapper); AgendaList mounts exactly once, always — visible whenever
 * `view!=="week"` on any screen, and on top of that always visible below
 * `md` regardless of `view` (the plan's "day = mobile agenda"). Mounting
 * AgendaList exactly once (never twice) avoids duplicate DOM nodes /
 * duplicate `data-testid`s that a naive "render both, hide one with CSS"
 * approach would produce.
 */
export function CalendarView({
  view,
  week,
  month,
  days,
  appointments,
  timezone,
  viewerRole,
  assignees,
  assigneeLabels,
  currentUserId,
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

  const todayKey = todayDateKeyInZone(timezone);
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

  return (
    <div className="flex flex-col gap-4" data-testid="calendar-view">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          className="flex items-center gap-1"
          role="tablist"
          aria-label="Calendar view"
        >
          <Link
            href={buildHref({ view: "week" })}
            data-testid="calendar-view-week"
            aria-current={view === "week" || undefined}
            className={cn(TAB_BASE, view === "week" ? TAB_ACTIVE : TAB_INACTIVE)}
          >
            Week
          </Link>
          {/* Month is a desktop-only surface (Codex month-view round 2):
              below md the grid can't render and agenda takes over, so
              offering the tab there would select a view the phone cannot
              show. Deep links to ?view=month on mobile still render the
              agenda over the month range with range-neutral copy. */}
          <Link
            href={buildHref({ view: "month" })}
            data-testid="calendar-view-month"
            aria-current={view === "month" || undefined}
            className={cn(
              TAB_BASE,
              "hidden md:inline-block",
              view === "month" ? TAB_ACTIVE : TAB_INACTIVE,
            )}
          >
            Month
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
        </div>

        <div className="flex items-center gap-3 text-xs font-bold">
          {/* Month view steps the anchor by whole months (from the month
              key, NOT the grid's first cell, which can precede the month);
              week/agenda step by 7 days as before. */}
          <Link
            href={buildHref({
              week:
                view === "month" && month
                  ? monthStartDateKey(month, -1)
                  : addDaysToDateKey(week, -7),
            })}
            data-testid="calendar-week-prev"
            className="text-muted-foreground hover:text-foreground"
          >
            ← Prev
          </Link>
          <Link
            href={buildHref({ week: todayKey })}
            data-testid="calendar-week-today"
            className="text-muted-foreground hover:text-foreground"
          >
            Today
          </Link>
          <Link
            href={buildHref({
              week:
                view === "month" && month
                  ? monthStartDateKey(month, 1)
                  : addDaysToDateKey(week, 7),
            })}
            data-testid="calendar-week-next"
            className="text-muted-foreground hover:text-foreground"
          >
            Next →
          </Link>
        </div>

        <div className="flex items-center gap-2">
          {/* Both roles get the filter (Codex round 1) — "own items" is
              a default for members, not a lockout, and the booking flow
              already lets a member act on a teammate's behalf. */}
          <Select value={assigneeValue} onValueChange={onAssigneeChange}>
            <SelectTrigger
              size="sm"
              className="w-40"
              data-testid="calendar-assignee-filter"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Everyone</SelectItem>
              <SelectItem value={ME}>Me</SelectItem>
              {memberOptions.map(([id, email]) => (
                <SelectItem key={id} value={id}>
                  {email}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <NewBlockButton currentUserId={currentUserId} />
        </div>
      </div>

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
          />
        </div>
      ) : null}

      <div
        className={view === "agenda" ? "block" : "md:hidden"}
        data-testid="calendar-agenda-wrapper"
      >
        <AgendaList
          currentUserId={currentUserId}
          days={days}
          appointments={appointments}
          timezone={timezone}
          viewerRole={viewerRole}
          assignees={assigneeLabels}
        />
      </div>
    </div>
  );
}
