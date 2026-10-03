"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { ChevronDown, ChevronRight, Droplet, Search } from "lucide-react"
import Link from "next/link"
import type { MyLeadDrip } from "@/lib/my-leads/drip-queries"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { PageHeader } from "@/components/page-header"
import { cn } from "@/lib/utils"
import { MyLeadsMetrics } from "./metrics"
import { StickyMyLeadsMetrics } from "./sticky-metrics"
import { MyLeadQueueRow, STAGE_NEXT } from "./queue-row"
import { MyLeadDetailPanel } from "./detail-panel"
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
const DRIP_BAR = "bg-cyan-800"

export function MyLeadsQueue({
  stages,
  drips,
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
  focusPropertyId = null,
  focusNonce = 0,
  onLeadChanged,
  onStageAction,
}: MyLeadsQueueProps) {
  const expandedMetricsRef = useRef<HTMLDivElement>(null)
  const scopeKey = JSON.stringify([search, selectedRepId])
  const [expansionScope, setExpansionScope] = useState(scopeKey)
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set(focusPropertyId ? [focusPropertyId] : []))
  const [collapsedSections, setCollapsedSections] = useState<ReadonlySet<MyLeadStage | 'in_drip'>>(new Set())
  const [detailStates, setDetailStates] = useState<
    Readonly<Record<string, MyLeadDetailState>>
  >({})
  const focusScrolled = useRef(false)
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

  const dripIds = (drips?.active ?? []).map((row) => row.propertyId)
  // The section a lead currently renders in, so a collapsed destination can be opened.
  const sectionOf = (propertyId: string): MyLeadStage | "in_drip" | null =>
    MY_LEAD_STAGE_ORDER.find((stage) => stages[stage].rows.some((row) => row.propertyId === propertyId)) ??
    (dripIds.includes(propertyId) ? "in_drip" : null)

  // Opens the destination section once, per deep-link navigation, when the row appears.
  const sectionOpenedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!focusPropertyId) { sectionOpenedFor.current = null; return }
    const key = `${focusPropertyId}:${focusNonce}`
    if (sectionOpenedFor.current === key) return
    const section = sectionOf(focusPropertyId)
    if (!section) return
    sectionOpenedFor.current = key
    setCollapsedSections((previous) => {
      if (!previous.has(section)) return previous
      const next = new Set(previous)
      next.delete(section)
      return next
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusPropertyId, focusNonce, stages, drips])

  // Scroll once per deep-link navigation. Background refreshes re-render with the
  // same target and must not move the page again.
  useEffect(() => {
    if (!focusPropertyId) { focusScrolled.current = false; return }
    if (focusScrolled.current) return
    const element = document.querySelector(`[data-lead-id="${CSS.escape(focusPropertyId)}"]`)
    // A row inside a collapsed section is hidden; wait until its section opens.
    if (!element || element.closest("[hidden]")) return
    focusScrolled.current = true
    element.scrollIntoView?.({ block: "start", behavior: "smooth" })
  }, [focusPropertyId, focusNonce, stages, drips, collapsedSections])

  // A new deep-link navigation (new lead, repeated link, Back/Forward) re-arms
  // scrolling and expands the target; the first mount is handled by the initial state.
  const handledFocus = useRef(focusPropertyId ? `${focusPropertyId}:${focusNonce}` : null)

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
    // A deep-linked lead stays open; the host clears the target when the user changes filters.
    setExpandedIds(new Set(focusPropertyId ? [focusPropertyId] : []))
    setDetailStates({})
    detailGeneration.current += 1
    requestIds.current = {}
    requestedDetails.current.clear()
    detailPageRequestIds.current = {}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey])

  useEffect(() => {
    if (!focusPropertyId) { handledFocus.current = null; return }
    const key = `${focusPropertyId}:${focusNonce}`
    if (handledFocus.current === key) return
    handledFocus.current = key
    focusScrolled.current = false
    setExpandedIds((previous) => new Set(previous).add(focusPropertyId))
  }, [focusPropertyId, focusNonce])

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
    const loadedIds = new Set([...MY_LEAD_STAGE_ORDER.flatMap((stage) => stages[stage].rows.map((row) => row.propertyId)), ...(drips?.active ?? []).map((row) => row.propertyId)])
    for (const propertyId of expandedIds) {
      if (activeDetails.current >= 3) break
      if (loadedIds.has(propertyId) && !requestedDetails.current.has(propertyId)) void loadDetails(propertyId)
    }
  }, [expandedIds, stages, drips, detailTick, loadDetails, expansionScope, scopeKey])

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
    <div className="flex w-full flex-col gap-8">
      <PageHeader
        breadcrumb={[{ label: "Workspace" }, { label: "My Leads" }]}
        title="My Leads"
        description={`${selectedRepLabel || "Your queue"} · Acquisitions`}
        actions={<div className="flex max-w-full flex-wrap items-center gap-2.5">
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

        </div>}
      />

      <div ref={expandedMetricsRef}><MyLeadsMetrics kpis={kpis} repliedToDrip={drips?.repliedCount ?? 0} /></div>
      <StickyMyLeadsMetrics kpis={kpis} expandedRef={expandedMetricsRef} repLabel={selectedRepLabel} repliedToDrip={drips?.repliedCount ?? 0} />

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
        <MyLeadStageSection
          stage="in_drip"
          page={{stage:'not_contacted',rows:[],totalCount:drips?.active.length??0,hasMore:false}}
          dripRows={drips?.active??[]}
          collapsed={collapsedSections.has('in_drip')}
          onToggleSection={() => setCollapsedSections(previous => {
            const next = new Set(previous); if (next.has('in_drip')) next.delete('in_drip'); else next.add('in_drip'); return next;
          })}
          expandedIds={expandedIds} detailStates={detailStates} onToggleDetails={toggleDetails}
          onRetryDetails={retryDetails} onDetailChanged={handleDetailChanged}
          onLoadDetailPage={onLoadDetailPage ? loadDetailPage : undefined}
          onLoadMore={onLoadMore} onStageAction={onStageAction}
        />
      </div>
    </div>
  )
}

function MyLeadStageSection({
  stage,
  page,
  dripRows,
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
  stage: MyLeadStage | 'in_drip'
  page: MyLeadsQueueProps["stages"][MyLeadStage]
  dripRows?: readonly MyLeadDrip[]
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
  const label = stage === 'in_drip' ? 'In a drip' : MY_LEAD_STAGE_LABELS[stage]
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
          stage === 'in_drip' ? DRIP_BAR : STAGE_BAR[stage]
        )}
      >
        <ChevronIcon className="size-4 shrink-0" aria-hidden="true" />
        {stage === 'in_drip' && <Droplet className="size-3 shrink-0" aria-hidden="true" />}
        <span className="text-xs font-bold uppercase tracking-widest text-white">{label}</span>
        <span
          aria-label={`${page.totalCount} ${page.totalCount === 1 ? "lead" : "leads"}`}
          className="inline-flex min-w-[22px] items-center justify-center rounded-full bg-black/20 px-2 py-0.5 font-mono text-[11px] font-semibold text-white"
        >
          {page.totalCount}
        </span>
        <span className="ml-auto hidden max-w-full truncate pl-3 text-[11.5px] text-white sm:block">{stage === 'in_drip' ? 'Texts go out on their own. A reply moves the lead back to its section.' : STAGE_NEXT[stage]}</span>
      </button>

      <div id={`my-leads-rows-${stage}`} hidden={collapsed}>
        {/* Keep loaded rows mounted so collapsing a stage preserves local drafts. */}
          <div className="space-y-2">
            {stage !== 'in_drip' && page.totalCount > page.rows.length && (
              <p className="px-1 text-xs text-muted-foreground">
                Showing {page.rows.length} of {page.totalCount}
              </p>
            )}

            {stage === 'in_drip' ? (dripRows?.length ? <div className="overflow-x-auto rounded-xl border bg-card">{dripRows.map(row => <article key={row.propertyId} className="border-t first:border-t-0" data-testid={`my-lead-drip-${row.propertyId}`} data-lead-id={row.propertyId}>
              <div className="grid min-w-[950px] grid-cols-[minmax(150px,1.4fr)_minmax(125px,1fr)_90px_minmax(180px,1.5fr)_minmax(120px,.8fr)_90px_90px] items-center gap-3 px-3 py-2 text-xs">
              <div className="min-w-0"><p className="truncate font-semibold">{row.queueRow?.homeownerName || 'Homeowner unavailable'}</p><p className="truncate text-muted-foreground">{row.queueRow?.address}</p></div>
              <p className="flex min-w-0 items-center gap-1 truncate font-semibold text-cyan-800"><Droplet className="size-3 shrink-0" />{row.sequenceName}</p>
              <p className="font-semibold">text {row.step} of {row.totalSteps}</p>
              <div className="min-w-0"><p className="text-[10px] uppercase text-muted-foreground">Last text {row.lastText ? new Date(row.lastText.sentAt).toLocaleDateString() : ''}</p><p className="truncate">{row.lastText?.preview ?? 'None yet'}</p></div>
              <div><p className="text-[10px] uppercase text-muted-foreground">Next text</p><p className="font-semibold">{row.nextTextAt ? new Date(row.nextTextAt).toLocaleString() : 'Not scheduled'}</p></div>
              <Link href={`/leads/${row.propertyId}`} className="rounded-full border px-2 py-1 text-center font-semibold hover:bg-muted">Open lead</Link>
              <button type="button" className="rounded-full border px-2 py-1 text-center font-semibold hover:bg-muted" aria-expanded={expandedIds.has(row.propertyId)} aria-controls={`my-lead-detail-${row.propertyId}`}
                aria-label={expandedIds.has(row.propertyId) ? `Hide details for ${row.queueRow?.address ?? 'this lead'}` : `Show details for ${row.queueRow?.address ?? 'this lead'}`}
                onClick={() => onToggleDetails(row.propertyId)}>{expandedIds.has(row.propertyId) ? 'Hide details' : 'Details'}</button>
              </div>
              <div id={`my-lead-detail-${row.propertyId}`} hidden={!expandedIds.has(row.propertyId)}>
                <MyLeadDetailPanel visible={expandedIds.has(row.propertyId) && !collapsed} state={detailStates[row.propertyId] ?? { status: 'loading' }}
                  onRetry={() => onRetryDetails(row.propertyId)} propertyId={row.propertyId} onChanged={() => onDetailChanged(row.propertyId)}
                  onLoadDetailPage={onLoadDetailPage ? (group, cursor) => onLoadDetailPage(row.propertyId, group, cursor) : undefined} />
              </div>
            </article>)}</div> : <div className="rounded-xl border border-dashed px-4 py-5 text-sm text-muted-foreground">No leads in a drip.</div>) : page.rows.length === 0 ? (
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
                    sectionVisible={!collapsed}
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

            {stage !== 'in_drip' && page.hasMore && (
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
