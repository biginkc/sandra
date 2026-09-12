"use client"

import { useEffect, useRef, useState } from "react"
import { Search } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { MyLeadQueueRow } from "./queue-row"
import {
  MY_LEAD_STAGE_LABELS,
  MY_LEAD_STAGE_ORDER,
  type MyLeadAction,
  type MyLeadDetail,
  type MyLeadDetailGroupName,
  type MyLeadDetailPageResult,
  type MyLeadDetailResult,
  type MyLeadDetailState,
  type MyLeadQueueRow as MyLeadQueueRowDto,
  type MyLeadStage,
  type MyLeadsPeriod,
  type MyLeadsQueueProps,
} from "./types"

const KPI_LABELS = [
  ["attempts", "Attempts"],
  ["contact-rate", "Contact rate"],
  ["assign-to-first-call", "Assign → first call"],
  ["appointments-kept", "Appointments kept"],
  ["offers-sent", "Offers sent"],
  ["stale-leads", "Stale leads"],
] as const

export function MyLeadsQueue({
  stages,
  kpis,
  search,
  selectedRepId,
  selectedPeriod,
  selectedDateRange,
  repOptions,
  selectedRepLabel,
  onSearchChange,
  onRepChange,
  onPeriodChange,
  onDateRangeChange,
  onLoadMore,
  onLoadDetail,
  onLoadDetailPage,
  onLeadChanged,
  onStageAction,
}: MyLeadsQueueProps) {
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(new Set())
  const [detailStates, setDetailStates] = useState<
    Readonly<Record<string, MyLeadDetailState>>
  >({})
  const requestIds = useRef<Record<string, number>>({})
  const detailPageRequestIds = useRef<Record<string, number>>({})
  const detailGeneration = useRef(0)
  const detailRequestSequence = useRef(0)
  const detailPageRequestSequence = useRef(0)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    setExpandedIds(new Set())
    setDetailStates({})
    detailGeneration.current += 1
    requestIds.current = {}
    detailPageRequestIds.current = {}
  }, [search, selectedPeriod, selectedRepId, selectedDateRange?.startDate, selectedDateRange?.endDate])

  const loadDetails = async (propertyId: string) => {
    const generation = detailGeneration.current
    const requestId = ++detailRequestSequence.current
    requestIds.current[propertyId] = requestId
    setDetailStates((previous) => ({ ...previous, [propertyId]: { status: "loading" } }))

    try {
      const result: MyLeadDetailResult = await onLoadDetail(propertyId)
      if (
        !mounted.current ||
        detailGeneration.current !== generation ||
        requestIds.current[propertyId] !== requestId
      ) return
      setDetailStates((previous) => ({
        ...previous,
        [propertyId]: result.ok
          ? { status: "ready", detail: result.detail }
          : { status: "error", message: result.message },
      }))
    } catch (error) {
      if (
        !mounted.current ||
        detailGeneration.current !== generation ||
        requestIds.current[propertyId] !== requestId
      ) return
      setDetailStates((previous) => ({
        ...previous,
        [propertyId]: {
          status: "error",
          message: error instanceof Error ? error.message : "Unable to load lead details.",
        },
      }))
    }
  }

  const toggleDetails = (propertyId: string) => {
    const isOpen = expandedIds.has(propertyId)
    setExpandedIds((previous) => {
      const next = new Set(previous)
      if (isOpen) next.delete(propertyId)
      else next.add(propertyId)
      return next
    })

    if (!isOpen && !detailStates[propertyId]) {
      void loadDetails(propertyId)
    }
  }

  const retryDetails = (propertyId: string) => {
    void loadDetails(propertyId)
  }

  const handleDetailChanged = (propertyId: string) => {
    void loadDetails(propertyId)
    onLeadChanged?.(propertyId)
  }

  const loadDetailPage = async (
    propertyId: string,
    group: MyLeadDetailGroupName,
    cursor: string
  ): Promise<MyLeadDetailPageResult> => {
    if (!onLoadDetailPage) return { ok: false, message: "More detail is unavailable." }
    const requestKey = `${propertyId}:${group}`
    const generation = detailGeneration.current
    const requestId = ++detailPageRequestSequence.current
    detailPageRequestIds.current[requestKey] = requestId
    const result = await onLoadDetailPage(propertyId, group, cursor)
    if (
      mounted.current &&
      detailGeneration.current === generation &&
      detailPageRequestIds.current[requestKey] === requestId &&
      result.ok &&
      result.group === group
    ) {
      setDetailStates((previous) => {
        const current = previous[propertyId]
        if (!current || current.status !== "ready") return previous
        return {
          ...previous,
          [propertyId]: {
            status: "ready",
            detail: appendDetailPage(current.detail, group, result.page),
          },
        }
      })
    }
    return result
  }

  return (
    <main className="mx-auto flex w-full max-w-[1600px] flex-col gap-6 px-4 py-6 lg:px-8">
      <header className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-muted-foreground">Acquisitions</p>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">My Leads</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {selectedRepLabel || "Your acquisition queue"} · warnings use live queue timing
            </p>
          </div>
          <Badge variant="secondary" className="h-6">
            {selectedRepLabel || "Signed-in rep"}
          </Badge>
        </div>

        <div className="grid gap-2 rounded-xl border bg-card p-3 shadow-sm md:grid-cols-[minmax(0,1fr)_12rem_9rem]">
          <label className="relative block">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              aria-label="Search My Leads"
              placeholder="Search address, homeowner, or phone"
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
              className="pl-8"
            />
          </label>

          <label className="sr-only" htmlFor="my-leads-rep">
            Acquisitions member
          </label>
          <select
            id="my-leads-rep"
            aria-label="Acquisitions member"
            value={selectedRepId}
            onChange={(event) => onRepChange(event.target.value)}
            className="h-8 rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {repOptions.map((rep) => (
              <option key={rep.id} value={rep.id}>
                {rep.label}
              </option>
            ))}
          </select>

          <label className="sr-only" htmlFor="my-leads-period">
            KPI period
          </label>
          <select
            id="my-leads-period"
            aria-label="KPI period"
            value={selectedPeriod}
            onChange={(event) => onPeriodChange(event.target.value as MyLeadsPeriod)}
            className="h-8 rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <option value="today">Today</option>
            <option value="week">This week</option>
            <option value="month">This month</option>
            <option value="custom">Custom range</option>
          </select>

          {selectedPeriod === "custom" && (
            <div className="grid gap-2 md:col-span-3 md:grid-cols-2">
              <label className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <span>From</span>
                <Input
                  aria-label="KPI start date"
                  type="date"
                  value={selectedDateRange?.startDate || ""}
                  onChange={(event) =>
                    onDateRangeChange({
                      startDate: event.target.value,
                      endDate: selectedDateRange?.endDate || "",
                    })
                  }
                />
              </label>
              <label className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <span>To</span>
                <Input
                  aria-label="KPI end date"
                  type="date"
                  value={selectedDateRange?.endDate || ""}
                  onChange={(event) =>
                    onDateRangeChange({
                      startDate: selectedDateRange?.startDate || "",
                      endDate: event.target.value,
                    })
                  }
                />
              </label>
            </div>
          )}
        </div>
      </header>

      <section aria-label="Acquisitions KPIs" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {KPI_LABELS.map(([id, label]) => (
          <Card key={id} size="sm" data-testid={`kpi-${id}`}>
            <CardContent className="space-y-1">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
              <p className="text-xl font-semibold tabular-nums text-foreground">{kpiValue(id, kpis)}</p>
            </CardContent>
          </Card>
        ))}
      </section>

      <div className="flex flex-col gap-4">
        {MY_LEAD_STAGE_ORDER.map((stage) => (
          <MyLeadStageSection
            key={stage}
            stage={stage}
            page={stages[stage]}
            expandedIds={expandedIds}
            detailStates={detailStates}
            onToggleDetails={toggleDetails}
            onRetryDetails={retryDetails}
            onDetailChanged={handleDetailChanged}
            onLoadDetailPage={onLoadDetailPage ? loadDetailPage : undefined}
            onLoadMore={onLoadMore}
            onStageAction={onStageAction}
          />
        ))}
      </div>
    </main>
  )
}

function MyLeadStageSection({
  stage,
  page,
  expandedIds,
  detailStates,
  onToggleDetails,
  onRetryDetails,
  onDetailChanged,
  onLoadDetailPage,
  onLoadMore,
  onStageAction,
}: {
  stage: MyLeadStage
  page: MyLeadsQueueProps["stages"][MyLeadStage]
  expandedIds: ReadonlySet<string>
  detailStates: Readonly<Record<string, MyLeadDetailState>>
  onToggleDetails: (propertyId: string) => void
  onRetryDetails: (propertyId: string) => void
  onDetailChanged: (propertyId: string) => void
  onLoadDetailPage?: (
    propertyId: string,
    group: MyLeadDetailGroupName,
    cursor: string
  ) => Promise<MyLeadDetailPageResult>
  onLoadMore: MyLeadsQueueProps["onLoadMore"]
  onStageAction: (action: MyLeadAction, row: MyLeadQueueRowDto) => void
}) {
  const label = MY_LEAD_STAGE_LABELS[stage]

  return (
    <section className="space-y-2" data-testid={`my-leads-section-${stage}`} aria-labelledby={`my-leads-heading-${stage}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 id={`my-leads-heading-${stage}`} className="text-base font-semibold text-foreground">
            {label}
          </h2>
          <Badge variant="secondary" aria-label={`${page.totalCount} ${label} leads`}>
            {page.totalCount}
          </Badge>
        </div>
        {page.totalCount > page.rows.length && (
          <span className="text-xs text-muted-foreground">
            Showing {page.rows.length} of {page.totalCount}
          </span>
        )}
      </div>

      {page.rows.length === 0 ? (
        <div className="rounded-xl border border-dashed px-4 py-5 text-sm text-muted-foreground">
          No leads in this section.
        </div>
      ) : (
        <div className="space-y-2">
          {page.rows.map((row) => (
            <MyLeadQueueRow
              key={row.propertyId}
              row={row}
              detailsOpen={expandedIds.has(row.propertyId)}
              detailState={detailStates[row.propertyId]}
              onToggleDetails={() => onToggleDetails(row.propertyId)}
              onRetryDetails={() => onRetryDetails(row.propertyId)}
              onDetailChanged={() => onDetailChanged(row.propertyId)}
              onLoadDetailPage={onLoadDetailPage
                ? (group, cursor) => onLoadDetailPage(row.propertyId, group, cursor)
                : undefined}
              onStageAction={onStageAction}
            />
          ))}
        </div>
      )}

      {page.hasMore && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={page.isLoadingMore}
          onClick={() => void onLoadMore(stage)}
        >
          {page.isLoadingMore ? "Loading…" : `Load more ${label}`}
        </Button>
      )}
    </section>
  )
}

function appendDetailPage(
  detail: MyLeadDetail,
  group: MyLeadDetailGroupName,
  page: MyLeadDetail[MyLeadDetailGroupName]
): MyLeadDetail {
  const current = detail[group]
  const existingIds = new Set(current.rows.map((row) => row.id))
  const rows = [...current.rows, ...page.rows.filter((row) => !existingIds.has(row.id))]
  return { ...detail, [group]: { ...page, rows } } as MyLeadDetail
}

function kpiValue(id: (typeof KPI_LABELS)[number][0], kpis: MyLeadsQueueProps["kpis"]) {
  switch (id) {
    case "attempts":
      return kpis.attempts
    case "contact-rate":
      return kpis.contactRateLabel || "Unavailable"
    case "assign-to-first-call":
      return kpis.assignToFirstCallLabel || "Unavailable"
    case "appointments-kept":
      return kpis.appointmentsKeptLabel || "Unavailable"
    case "offers-sent":
      return kpis.offersSent
    case "stale-leads":
      return kpis.staleLeads
  }
}
