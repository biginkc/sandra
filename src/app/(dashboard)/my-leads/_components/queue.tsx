"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { ChevronDown, Search } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { MyLeadQueueRow, STAGE_COLORS, STAGE_NEXT } from "./queue-row"
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
  canSelectRep = false,
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
  const scopeKey = JSON.stringify([search, selectedPeriod, selectedRepId, selectedDateRange?.startDate, selectedDateRange?.endDate])
  const [expansionScope, setExpansionScope] = useState(scopeKey)
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
  const requestedDetails = useRef(new Set<string>())
  const activeDetails = useRef(0)
  const [detailTick, setDetailTick] = useState(0)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    setExpansionScope(scopeKey)
    setExpandedIds(new Set())
    setDetailStates({})
    detailGeneration.current += 1
    requestIds.current = {}
    requestedDetails.current.clear()
    detailPageRequestIds.current = {}
  }, [scopeKey])

  const loadDetails = useCallback(async (propertyId: string) => {
    requestedDetails.current.add(propertyId)
    activeDetails.current += 1
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
    } finally {
      activeDetails.current -= 1
      if (mounted.current) setDetailTick((tick) => tick + 1)
    }
  }, [onLoadDetail])

  // Expand only the loaded rows, and keep at most three detail reads in flight.
  // Collapsing or changing scope removes waiting work without issuing more reads.
  useEffect(() => {
    if (expansionScope !== scopeKey) return
    const loadedIds = new Set(MY_LEAD_STAGE_ORDER.flatMap((stage) => stages[stage].rows.map((row) => row.propertyId)))
    for (const propertyId of expandedIds) {
      if (activeDetails.current >= 3) break
      if (loadedIds.has(propertyId) && !requestedDetails.current.has(propertyId)) void loadDetails(propertyId)
    }
  }, [expandedIds, stages, detailTick, loadDetails, expansionScope, scopeKey])

  const toggleDetails = (propertyId: string) => {
    const isOpen = expandedIds.has(propertyId)
    setExpandedIds((previous) => {
      const next = new Set(previous)
      if (isOpen) next.delete(propertyId)
      else next.add(propertyId)
      return next
    })

  }

  const retryDetails = (propertyId: string) => {
    requestedDetails.current.delete(propertyId)
    setDetailTick((tick) => tick + 1)
  }

  const handleDetailChanged = (propertyId: string) => {
    retryDetails(propertyId)
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
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-[26px] leading-tight font-bold tracking-tight text-foreground">My Leads</h1>
          <p className="text-sm text-muted-foreground">{selectedRepLabel || "Your queue"} · Acquisitions</p>
        </div>
        <div className="flex max-w-full flex-wrap items-center gap-2.5">
          {canSelectRep && <>
          <label className="sr-only" htmlFor="my-leads-rep">
            Acquisitions member
          </label>
          <span className="relative inline-flex max-w-full min-w-0">
            <select
              id="my-leads-rep"
              aria-label="Acquisitions member"
              value={selectedRepId}
              onChange={(event) => onRepChange(event.target.value)}
              className="h-9 max-w-full min-w-0 appearance-none rounded-[10px] border border-border bg-card py-2 pr-7 pl-3 text-[12.5px] font-semibold text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              {repOptions.map((rep) => (
                <option key={rep.id} value={rep.id}>
                  {rep.label}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          </span>

          </>}
          <label className="sr-only" htmlFor="my-leads-period">
            KPI period
          </label>
          <span className="relative inline-flex max-w-full min-w-0">
            <select
              id="my-leads-period"
              aria-label="KPI period"
              value={selectedPeriod}
              onChange={(event) => onPeriodChange(event.target.value as MyLeadsPeriod)}
              className="h-9 max-w-full min-w-0 appearance-none rounded-[10px] border border-border bg-card py-2 pr-7 pl-3 text-[12.5px] font-semibold text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <option value="today">Today</option>
              <option value="week">This week</option>
              <option value="month">This month</option>
              <option value="custom">Custom range</option>
            </select>
            <ChevronDown className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          </span>

          {selectedPeriod === "custom" && (
            <div className="grid w-full gap-2 sm:grid-cols-2">
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

      <section aria-label="Acquisitions KPIs" className="grid grid-cols-2 gap-px overflow-hidden rounded-[16px] border border-border bg-border lg:grid-cols-6">
        {KPI_LABELS.map(([id, label]) => (
          <div key={id} data-testid={`kpi-${id}`} className="min-w-0 space-y-1.5 bg-card px-4 py-3.5">
            <p className="text-[10px] font-extrabold uppercase tracking-widest text-muted-foreground">{label}</p>
            <p className={cn("break-words text-[23px] font-extrabold tracking-tight tabular-nums", id === "stale-leads" && kpis.staleLeads > 0 ? "text-amber-700 dark:text-amber-300" : "text-foreground")}>{kpiValue(id, kpis)}</p>
          </div>
        ))}
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3" aria-label="Queue controls">
        <label className="relative block w-full sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input aria-label="Search My Leads" placeholder="Search name, address, or phone" value={search} onChange={(event) => onSearchChange(event.target.value)} className="rounded-[10px] border-border pl-8 text-[13px]" />
        </label>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" className="rounded-[10px]" onClick={() => setExpandedIds(new Set(MY_LEAD_STAGE_ORDER.flatMap((stage) => stages[stage].rows.map((row) => row.propertyId))))}>Expand all</Button>
          <Button type="button" variant="ghost" size="sm" className="rounded-[10px] border border-border" onClick={() => setExpandedIds(new Set())}>Collapse all</Button>
        </div>
      </div>

      <div className="flex flex-col gap-6">
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
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="flex items-center gap-2.5">
          <h2 id={`my-leads-heading-${stage}`} className={cn("text-xs font-extrabold uppercase tracking-widest", STAGE_COLORS[stage])}>
            {label}
          </h2>
          <Badge variant="secondary" aria-label={`${page.totalCount} ${label} leads`} className="rounded-full border border-border bg-muted font-mono text-[11px] font-semibold text-muted-foreground">
            {page.totalCount}
          </Badge>
        </div>
        <span className="h-px min-w-8 flex-1 bg-border" aria-hidden="true" />
        <p className="max-w-full text-[11.5px] text-muted-foreground">{STAGE_NEXT[stage]}</p>
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
    case "contact-rate": {
      const label = kpis.contactRateLabel || "Unavailable"
      const match = /^(.*\d)(%)$/.exec(label)
      return match ? <>{match[1]}<small className="text-[13px] font-bold text-muted-foreground">{match[2]}</small></> : label
    }
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
