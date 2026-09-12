import { useState } from "react"
import { AlertCircle, CalendarClock, FileText, History, Play, PhoneCall, RefreshCw } from "lucide-react"

import { AddNoteComposer } from "@/app/(dashboard)/leads/[id]/notes-feed"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import {
  MyLeadAppointmentActions,
  MyLeadCallbackActions,
} from "./existing-detail-actions"
import type {
  MyLeadDetailGroup,
  MyLeadDetailGroupName,
  MyLeadDetailPageResult,
  MyLeadDetailPanelProps,
} from "./types"

type DetailPagingState = Partial<
  Record<MyLeadDetailGroupName, { loading: boolean; error: string | null }>
>

export function MyLeadDetailPanel({
  state,
  propertyId,
  onRetry,
  onChanged,
  onLoadDetailPage,
}: MyLeadDetailPanelProps) {
  const [paging, setPaging] = useState<DetailPagingState>({})

  if (state.status === "loading") {
    return (
      <div className="px-4 pb-4 pt-2 text-sm text-muted-foreground" role="status">
        Loading details…
      </div>
    )
  }

  if (state.status === "error") {
    return (
      <div className="mx-4 mb-4 flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert">
        <span className="flex items-center gap-2">
          <AlertCircle className="size-4" aria-hidden="true" />
          {state.message}
        </span>
        <Button type="button" variant="outline" size="xs" onClick={onRetry}>
          <RefreshCw aria-hidden="true" />
          Retry
        </Button>
      </div>
    )
  }

  const { detail } = state
  const loadGroup = async (group: MyLeadDetailGroupName, cursor: string) => {
    if (!onLoadDetailPage) return
    setPaging((previous) => ({ ...previous, [group]: { loading: true, error: null } }))
    let result: MyLeadDetailPageResult
    try {
      result = await onLoadDetailPage(group, cursor)
    } catch {
      result = { ok: false, message: "Unable to load more detail." }
    }
    if (result.ok && result.group === group) {
      setPaging((previous) => ({ ...previous, [group]: { loading: false, error: null } }))
      return
    }
    setPaging((previous) => ({
      ...previous,
      [group]: {
        loading: false,
        error: result.ok ? "The detail page did not match this group." : result.message,
      },
    }))
  }

  return (
    <div className="space-y-4 border-t border-[#f0eeec] px-4 pt-4 pb-[18px] dark:border-border" role="region" aria-label="Lead details">
      <DetailList
        icon={<PhoneCall aria-hidden="true" />}
        title="Attempts"
        count={detail.attempts.rows.length}
        page={detail.attempts}
        emptyLabel="No outreach attempts recorded."
        paging={paging.attempts}
        onLoadMore={onLoadDetailPage ? (cursor) => loadGroup("attempts", cursor) : undefined}
        renderRow={(attempt) => (
          <div key={attempt.id} className="grid grid-cols-[1fr_auto] items-start gap-3 border-b border-[#f0eeec] py-[9px] text-[12.5px] last:border-b-0 dark:border-border">
            <div>
              <p className="font-semibold text-foreground">{attempt.outcomeLabel}</p>
              <p className="mt-[3px] text-muted-foreground">{attempt.actorLabel}</p>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-[9px] whitespace-nowrap">
              {attempt.sourceLabel && (
                <span
                  className={cn(
                    "rounded-md px-2 py-0.5 font-mono text-[10px] font-semibold",
                    attempt.sourceLabel.toLowerCase() === "dialpad"
                      ? "bg-[#dcfce7] text-[#15803d] dark:bg-green-950 dark:text-green-300"
                      : "bg-[#dbeafe] text-[#1d4ed8] dark:bg-blue-950 dark:text-blue-300"
                  )}
                >
                  {attempt.sourceLabel}
                </span>
              )}
              {attempt.recordingUrl ? (
                <a
                  href={attempt.recordingUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-[#1d4ed8] no-underline dark:text-blue-300"
                >
                  <Play className="size-3" aria-hidden="true" />
                  Recording
                </a>
              ) : (
                <span className="text-[11.5px] font-medium text-muted-foreground italic">no recording</span>
              )}
              <span className="font-mono text-[10.5px] text-muted-foreground">{attempt.occurredLabel}</span>
            </div>
          </div>
        )}
      />
      <DetailList
        icon={<FileText aria-hidden="true" />}
        title="Notes"
        page={detail.notes}
        emptyLabel="No notes recorded."
        paging={paging.notes}
        onLoadMore={onLoadDetailPage ? (cursor) => loadGroup("notes", cursor) : undefined}
        footer={
          propertyId ? (
            <AddNoteComposer
              propertyId={propertyId}
              compact
              onSaved={() => onChanged?.("notes")}
            />
          ) : undefined
        }
        renderRow={(note) => (
          <div key={note.id} className="space-y-[2px]">
            <p className="font-mono text-[10.5px] font-semibold text-muted-foreground">
              {note.authorLabel} · {note.createdLabel}
            </p>
            <p className="text-[12.5px] leading-[1.55] whitespace-pre-wrap text-foreground">{note.body}</p>
          </div>
        )}
      />
      <div className="grid gap-5 border-t border-[#f0eeec] pt-4 md:grid-cols-3 dark:border-border">
        <DetailList
          icon={<CalendarClock aria-hidden="true" />}
          title="Appointments"
          page={detail.appointments}
          emptyLabel="No appointments recorded."
          paging={paging.appointments}
          onLoadMore={onLoadDetailPage ? (cursor) => loadGroup("appointments", cursor) : undefined}
          renderRow={(appointment) => (
            <div key={appointment.id} className="space-y-1.5">
              <p className="font-medium text-foreground">{appointment.label}</p>
              <p className="text-xs text-muted-foreground">
                {appointment.dueLabel} · {appointment.statusLabel}
              </p>
              {appointment.lifecycleAction ? (
                <MyLeadAppointmentActions
                  target={appointment.lifecycleAction}
                  onChanged={() => onChanged?.("appointments")}
                />
              ) : appointment.callbackAction ? (
                <MyLeadCallbackActions
                  target={appointment.callbackAction}
                  onChanged={() => onChanged?.("appointments")}
                />
              ) : null}
            </div>
          )}
        />
        <DetailList
          icon={<Badge variant="outline">$</Badge>}
          title="Offers"
          page={detail.offers}
          emptyLabel="No offers recorded."
          paging={paging.offers}
          onLoadMore={onLoadDetailPage ? (cursor) => loadGroup("offers", cursor) : undefined}
          renderRow={(offer) => (
            <div key={offer.id} className="space-y-0.5">
              <p className="font-medium text-foreground">
                {offer.amountLabel} · {offer.method}
              </p>
              <p className="text-xs text-muted-foreground">
                {offer.sentLabel} · {offer.outcomeLabel}
              </p>
            </div>
          )}
        />
        <DetailList
          icon={<History aria-hidden="true" />}
          title="History"
          page={detail.history}
          emptyLabel="No history recorded."
          paging={paging.history}
          onLoadMore={onLoadDetailPage ? (cursor) => loadGroup("history", cursor) : undefined}
          renderRow={(event) => (
            <div key={event.id} className="space-y-0.5">
              <p className="font-medium text-foreground">{event.label}</p>
              <p className="text-xs text-muted-foreground">{event.createdLabel}</p>
            </div>
          )}
        />
      </div>
    </div>
  )
}

function DetailList<T extends { id: string }>({
  icon,
  title,
  count,
  page,
  emptyLabel,
  paging,
  onLoadMore,
  footer,
  renderRow,
}: {
  icon: React.ReactNode
  title: string
  count?: number
  page: MyLeadDetailGroup<T>
  emptyLabel: string
  paging?: { loading: boolean; error: string | null }
  onLoadMore?: (cursor: string) => void
  footer?: React.ReactNode
  renderRow: (row: T) => React.ReactNode
}) {
  const rows = uniqueRows(page.rows)
  return (
    <section className="min-w-0 space-y-2 [overflow-wrap:anywhere]">
      <h3 className="flex items-center gap-1.5 text-[10px] font-extrabold tracking-[0.08em] text-muted-foreground uppercase">
        <span className="flex size-4 items-center justify-center [&>svg]:size-3">{icon}</span>
        {title}
        {count !== undefined && ` · ${count}`}
      </h3>
      <div className="space-y-2 text-sm">
        {rows.length > 0 ? rows.map(renderRow) : <p className="text-muted-foreground">{emptyLabel}</p>}
      </div>
      {footer}
      {onLoadMore && page.hasMore && page.nextCursor && (
        <div className="space-y-1.5">
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={paging?.loading}
            onClick={() => onLoadMore(page.nextCursor as string)}
          >
            {paging?.loading ? "Loading…" : `Load more ${title.toLowerCase()}`}
          </Button>
          {paging?.error && (
            <div className="flex items-center gap-2 text-xs text-destructive" role="alert">
              <span>{paging.error}</span>
              <Button type="button" variant="link" size="xs" onClick={() => onLoadMore(page.nextCursor as string)}>
                Retry
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  )
}

function uniqueRows<T extends { id: string }>(rows: readonly T[]) {
  const ids = new Set<string>()
  return rows.filter((row) => {
    if (ids.has(row.id)) return false
    ids.add(row.id)
    return true
  })
}
