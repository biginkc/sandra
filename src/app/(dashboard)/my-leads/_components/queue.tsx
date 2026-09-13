"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { ChevronDown, ChevronRight, Search } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { MyLeadsMetrics } from "./metrics"
import { StickyMyLeadsMetrics } from "./sticky-metrics"
import { MyLeadQueueRow, STAGE_NEXT } from "./queue-row"
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
  type MyLeadsQueueProps,
} from "./types"

// Solid section colors for the collapsible header bar. Each shade is chosen to
// clear WCAG AA (≥4.5:1) against the white bar text.
const STAGE_BAR: Record<MyLeadStage, string> = {
  not_contacted: "bg-blue-600",
  contacted: "bg-teal-700",
  needs_offer: "bg-amber-700",
  offer_sent: "bg-violet-600",
  under_contract: "bg-green-700",
}

export function MyLeadsQueue({
  stages,
  kpis,
  search,
  selectedRepId,
  repOptions,
  canSelectRep = false,
  onReviewingChange,
  selectedRepLabel,
  onSearchChange,
  onRepChange,
  onLoadMore,
  onLoadDetail,
  onLoadDetailPage,
  detailRevision = 0,
  onLeadChanged,
  onStageAction,
}: MyLeadsQueueProps) {
  const expandedMetricsRef = useRef<HTMLDivElement>(null)
  const scopeKey = JSON.stringify([search, selectedRepId])
  const [expansionScope, setExpansionScope] = useState(scopeKey)
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(new Set())
  const [collapsedSections, setCollapsedSections] = useState<ReadonlySet<MyLeadStage>>(new Set())
  const [detailStates, setDetailStates] = useState<
    Readonly<Record<string, MyLeadDetailState>>
  >({})
  const expandedIdsRef = useRef<ReadonlySet<string>>(new Set())
  expandedIdsRef.current = expandedIds
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
    onReviewingChange?.(expandedIds.size > 0)
  }, [expandedIds, onReviewingChange])

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

  useEffect(() => {
    if (detailRevision === 0) return
    detailGeneration.current += 1
    requestedDetails.current.clear()
    requestIds.current = {}
    detailPageRequestIds.current = {}
    setDetailStates((previous) => {
      const next = { ...previous }
      for (const propertyId of Object.keys(next)) {
        if (expandedIdsRef.current.has(propertyId)) next[propertyId] = { status: "loading" }
        else delete next[propertyId]
      }
      return next
    })
    setDetailTick((tick) => tick + 1)
  }, [detailRevision])

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
    cursor: string | null
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
            detail: cursor === null
              ? { ...current.detail, [group]: result.page }
              : appendDetailPage(current.detail, group, result.page),
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

        </div>
      </header>

      <div ref={expandedMetricsRef}><MyLeadsMetrics kpis={kpis} /></div>
      <StickyMyLeadsMetrics kpis={kpis} expandedRef={expandedMetricsRef} repLabel={selectedRepLabel} />

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
            collapsed={collapsedSections.has(stage)}
            onToggleSection={() =>
              setCollapsedSections((previous) => {
                const next = new Set(previous)
                if (next.has(stage)) next.delete(stage)
                else next.add(stage)
                return next
              })
            }
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
  collapsed,
  onToggleSection,
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
  collapsed: boolean
  onToggleSection: () => void
  expandedIds: ReadonlySet<string>
  detailStates: Readonly<Record<string, MyLeadDetailState>>
  onToggleDetails: (propertyId: string) => void
  onRetryDetails: (propertyId: string) => void
  onDetailChanged: (propertyId: string) => void
  onLoadDetailPage?: (
    propertyId: string,
    group: MyLeadDetailGroupName,
    cursor: string | null
  ) => Promise<MyLeadDetailPageResult>
  onLoadMore: MyLeadsQueueProps["onLoadMore"]
  onStageAction: (action: MyLeadAction, row: MyLeadQueueRowDto) => void
}) {
  const label = MY_LEAD_STAGE_LABELS[stage]
  const ChevronIcon = collapsed ? ChevronRight : ChevronDown

  return (
    <section className="space-y-2" data-testid={`my-leads-section-${stage}`} aria-labelledby={`my-leads-heading-${stage}`}>
      <h2 id={`my-leads-heading-${stage}`} className="sr-only">{label}</h2>
      <button
        type="button"
        onClick={onToggleSection}
        aria-expanded={!collapsed}
        aria-controls={`my-leads-rows-${stage}`}
        className={cn(
          "flex w-full items-center gap-2.5 rounded-[10px] px-4 py-2.5 text-left text-white outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white",
          STAGE_BAR[stage]
        )}
      >
        <ChevronIcon className="size-4 shrink-0" aria-hidden="true" />
        <span className="text-xs font-bold uppercase tracking-widest text-white">{label}</span>
        <span
          aria-label={`${page.totalCount} leads`}
          className="inline-flex min-w-[22px] items-center justify-center rounded-full bg-black/20 px-2 py-0.5 font-mono text-[11px] font-semibold text-white"
        >
          {page.totalCount}
        </span>
        <span className="ml-auto hidden max-w-full truncate pl-3 text-[11.5px] text-white sm:block">{STAGE_NEXT[stage]}</span>
      </button>

      <div id={`my-leads-rows-${stage}`} hidden={collapsed}>
        {!collapsed && (
          <div className="space-y-2">
            {page.totalCount > page.rows.length && (
              <p className="px-1 text-xs text-muted-foreground">
                Showing {page.rows.length} of {page.totalCount}
              </p>
            )}

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
          </div>
        )}
      </div>
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
