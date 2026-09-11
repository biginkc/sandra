import { useState } from "react"
import { AlertCircle, CalendarClock, FileText, History, PhoneCall, RefreshCw } from "lucide-react"

import { AddNoteComposer } from "@/app/(dashboard)/leads/[id]/notes-feed"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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
    <div className="grid gap-4 border-t bg-muted/20 px-4 py-4 md:grid-cols-2 xl:grid-cols-5" role="region" aria-label="Lead details">
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
          <div key={note.id} className="space-y-0.5">
            <p className="font-medium text-foreground">{note.body}</p>
            <p className="text-xs text-muted-foreground">
              {note.authorLabel} · {note.createdLabel}
            </p>
          </div>
        )}
      />
      <DetailList
        icon={<PhoneCall aria-hidden="true" />}
        title="Attempts"
        page={detail.attempts}
        emptyLabel="No outreach attempts recorded."
        paging={paging.attempts}
        onLoadMore={onLoadDetailPage ? (cursor) => loadGroup("attempts", cursor) : undefined}
        renderRow={(attempt) => (
          <div key={attempt.id} className="space-y-0.5">
            <p className="font-medium text-foreground">{attempt.outcomeLabel}</p>
            <p className="text-xs text-muted-foreground">
              {attempt.actorLabel} · {attempt.occurredLabel}
            </p>
          </div>
        )}
      />
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
  )
}

function DetailList<T extends { id: string }>({
  icon,
  title,
  page,
  emptyLabel,
  paging,
  onLoadMore,
  footer,
  renderRow,
}: {
  icon: React.ReactNode
  title: string
  page: MyLeadDetailGroup<T>
  emptyLabel: string
  paging?: { loading: boolean; error: string | null }
  onLoadMore?: (cursor: string) => void
  footer?: React.ReactNode
  renderRow: (row: T) => React.ReactNode
}) {
  const rows = uniqueRows(page.rows)
  return (
    <section className="min-w-0 space-y-2">
      <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <span className="flex size-4 items-center justify-center [&>svg]:size-3">{icon}</span>
        {title}
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
