import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { StrictMode } from "react"
import { describe, expect, it, vi } from "vitest"

import { MyLeadsQueue } from "./queue"
import {
  MY_LEAD_STAGE_ORDER,
  type MyLeadDetail,
  type MyLeadQueueRow,
  type MyLeadStage,
  type MyLeadsQueueProps,
} from "./types"

const EMPTY_DETAIL: MyLeadDetail = {
  notes: { rows: [], hasMore: false, nextCursor: null },
  attempts: { rows: [], hasMore: false, nextCursor: null },
  appointments: { rows: [], hasMore: false, nextCursor: null },
  offers: { rows: [], hasMore: false, nextCursor: null },
  history: { rows: [], hasMore: false, nextCursor: null },
}

function makeRow(stage: MyLeadStage, index: number): MyLeadQueueRow {
  return {
    propertyId: `property-${index}`,
    queueStage: stage,
    address: `${index} Main Street`,
    homeownerName: `Homeowner ${index}`,
    phone: "555-0100",
    assignment: { label: "Maria", state: "known" },
    firstCall: { state: "pending", label: null },
    warningReasons: stage === "contacted" ? ["missing_next_step"] : [],
    attemptsCount: index,
    motivation: {
      temperature: "warm",
      motivationResponseKind: "provided",
      text: "Needs a simple sale",
    },
    nextStep: null,
    offer: null,
    archived: stage === "under_contract",
  }
}

function buildProps(overrides: Partial<MyLeadsQueueProps> = {}): MyLeadsQueueProps {
  const stages = Object.fromEntries(
    MY_LEAD_STAGE_ORDER.map((stage, index) => [
      stage,
      {
        stage,
        rows: [makeRow(stage, index + 1)],
        totalCount: 1,
        hasMore: false,
      },
    ])
  ) as unknown as MyLeadsQueueProps["stages"]

  return {
    stages,
    kpis: {
      attempts: 12,
      contactRateLabel: "50%",
      assignToFirstCallLabel: "2h 10m",
      appointmentsKeptLabel: "3 / 4",
      offersSent: 2,
      staleLeads: 1,
    },
    search: "",
    selectedRepId: "maria",
    selectedPeriod: "week",
    selectedDateRange: null,
    repOptions: [
      { id: "maria", label: "Maria" },
      { id: "jarrad", label: "Jarrad" },
    ],
    selectedRepLabel: "Maria",
    onSearchChange: vi.fn(),
    onRepChange: vi.fn(),
    onPeriodChange: vi.fn(),
    onDateRangeChange: vi.fn(),
    onLoadMore: vi.fn(),
    onLoadDetail: vi.fn(async () => ({ ok: true as const, detail: EMPTY_DETAIL })),
    onStageAction: vi.fn(),
    ...overrides,
  }
}

describe("MyLeadsQueue", () => {
  it("renders the five PRD sections and the six KPI tiles in order", () => {
    render(<MyLeadsQueue {...buildProps()} />)

    expect(screen.getByRole("heading", { name: "My Leads" })).toBeInTheDocument()
    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual([
      "Not contacted",
      "Contacted",
      "Needs offer / Interested",
      "Offer Sent",
      "Under Contract",
    ])
    expect(screen.getByTestId("kpi-attempts")).toHaveTextContent("Attempts12")
    expect(screen.getByTestId("kpi-contact-rate")).toHaveTextContent("Contact rate50%")
    expect(screen.getByTestId("kpi-stale-leads")).toHaveTextContent("Stale leads1")
  })

  it("keeps load-more controls independent for each stage", async () => {
    const user = userEvent.setup()
    const onLoadMore = vi.fn()
    const props = buildProps({
      onLoadMore,
      stages: {
        ...buildProps().stages,
        not_contacted: {
          ...buildProps().stages.not_contacted,
          totalCount: 21,
          hasMore: true,
        },
        offer_sent: {
          ...buildProps().stages.offer_sent,
          totalCount: 21,
          hasMore: true,
        },
      },
    })
    render(<MyLeadsQueue {...props} />)

    await user.click(screen.getByRole("button", { name: "Load more Not contacted" }))

    expect(onLoadMore).toHaveBeenCalledOnce()
    expect(onLoadMore).toHaveBeenCalledWith("not_contacted")
    expect(screen.getByRole("button", { name: "Load more Offer Sent" })).toBeInTheDocument()
  })

  it("passes search, member, period, date range, and stage actions to typed callbacks", async () => {
    const user = userEvent.setup()
    const props = buildProps({
      onSearchChange: vi.fn(),
      onRepChange: vi.fn(),
      onPeriodChange: vi.fn(),
      onDateRangeChange: vi.fn(),
      onStageAction: vi.fn(),
    })
    const { rerender } = render(<MyLeadsQueue {...props} />)

    fireEvent.change(screen.getByRole("textbox", { name: "Search My Leads" }), {
      target: { value: "oak" },
    })
    await user.selectOptions(screen.getByRole("combobox", { name: "Acquisitions member" }), "jarrad")
    await user.selectOptions(screen.getByRole("combobox", { name: "KPI period" }), "custom")
    rerender(<MyLeadsQueue {...props} selectedPeriod="custom" />)
    fireEvent.change(screen.getByLabelText("KPI start date"), {
      target: { value: "2026-09-01" },
    })
    await user.click(screen.getByRole("button", { name: "Ready to make an offer" }))

    expect(props.onSearchChange).toHaveBeenLastCalledWith("oak")
    expect(props.onRepChange).toHaveBeenCalledWith("jarrad")
    expect(props.onPeriodChange).toHaveBeenCalledWith("custom")
    expect(props.onDateRangeChange).toHaveBeenCalled()
    expect(props.onStageAction).toHaveBeenCalledWith("ready-for-offer", expect.objectContaining({ queueStage: "contacted" }))
  })

  it("keeps contract and first-call follow-up actions available in every permitted stage", () => {
    render(<MyLeadsQueue {...buildProps()} />)

    const notContacted = within(screen.getByTestId("my-lead-row-property-1"))
    const contacted = within(screen.getByTestId("my-lead-row-property-2"))
    const needsOffer = within(screen.getByTestId("my-lead-row-property-3"))
    const offerSent = within(screen.getByTestId("my-lead-row-property-4"))
    const underContract = within(screen.getByTestId("my-lead-row-property-5"))

    expect(notContacted.getByRole("button", { name: "Contract signed" })).toBeInTheDocument()
    expect(contacted.getByRole("button", { name: "Contract signed" })).toBeInTheDocument()
    expect(needsOffer.getByRole("button", { name: "Start call" })).toBeInTheDocument()
    expect(needsOffer.getByRole("button", { name: "Contract signed" })).toBeInTheDocument()
    expect(offerSent.getByRole("button", { name: "Start call" })).toBeInTheDocument()
    expect(underContract.queryByRole("button", { name: "Contract signed" })).not.toBeInTheDocument()
  })

  it("loads details only after a row is expanded and then renders the result", async () => {
    const user = userEvent.setup()
    let resolveDetails!: (value: { ok: true; detail: MyLeadDetail }) => void
    const onLoadDetail = vi.fn(
      () =>
        new Promise<{ ok: true; detail: MyLeadDetail }>((resolve) => {
          resolveDetails = resolve
        })
    )
    render(<MyLeadsQueue {...buildProps({ onLoadDetail })} />)

    expect(onLoadDetail).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "Show details for 1 Main Street" }))
    expect(onLoadDetail).toHaveBeenCalledWith("property-1")
    expect(screen.getByRole("status")).toHaveTextContent("Loading details…")

    resolveDetails({
      ok: true,
      detail: {
        ...EMPTY_DETAIL,
        notes: {
          rows: [
            {
              id: "note-1",
              authorLabel: "Maria",
              body: "Call after lunch",
              createdLabel: "Today",
            },
          ],
          hasMore: false,
          nextCursor: null,
        },
      },
    })

    await waitFor(() => expect(screen.getByText("Call after lunch")).toBeInTheDocument())
    expect(within(screen.getByRole("region", { name: "Lead details" })).getByText("Notes")).toBeInTheDocument()
  })

  it("discards a detail response from the previous member after filters reset", async () => {
    const user = userEvent.setup()
    let resolveOldDetails!: (value: { ok: true; detail: MyLeadDetail }) => void
    const oldDetails = new Promise<{ ok: true; detail: MyLeadDetail }>((resolve) => {
      resolveOldDetails = resolve
    })
    const newDetails = {
      ok: true as const,
      detail: {
        ...EMPTY_DETAIL,
        notes: {
          rows: [{ id: "new-note", authorLabel: "Jarrad", body: "New response", createdLabel: "Today" }],
          hasMore: false,
          nextCursor: null,
        },
      },
    }
    const onLoadDetail = vi.fn().mockReturnValueOnce(oldDetails).mockResolvedValueOnce(newDetails)
    const props = buildProps({ onLoadDetail })
    const { rerender } = render(
      <StrictMode>
        <MyLeadsQueue {...props} />
      </StrictMode>
    )

    await user.click(screen.getByRole("button", { name: "Show details for 1 Main Street" }))
    rerender(
      <StrictMode>
        <MyLeadsQueue {...props} selectedRepId="jarrad" selectedRepLabel="Jarrad" />
      </StrictMode>
    )
    await user.click(screen.getByRole("button", { name: "Show details for 1 Main Street" }))
    await waitFor(() => expect(screen.getByText("New response")).toBeInTheDocument())

    resolveOldDetails({
      ok: true,
      detail: {
        ...EMPTY_DETAIL,
        notes: {
          rows: [{ id: "old-note", authorLabel: "Maria", body: "Old response", createdLabel: "Yesterday" }],
          hasMore: false,
          nextCursor: null,
        },
      },
    })

    await waitFor(() => expect(screen.queryByText("Old response")).not.toBeInTheDocument())
    expect(onLoadDetail).toHaveBeenCalledTimes(2)
  })

  it("loads detail pages by group and appends without duplicate ids", async () => {
    const user = userEvent.setup()
    const firstPageNote = {
      id: "note-1",
      authorLabel: "Maria",
      body: "First page note",
      createdLabel: "Today",
    }
    const secondPageNote = {
      id: "note-2",
      authorLabel: "Maria",
      body: "Second page note",
      createdLabel: "Yesterday",
    }
    const onLoadDetailPage = vi.fn(async () => ({
      ok: true as const,
      group: "notes" as const,
      page: {
        rows: [firstPageNote, secondPageNote],
        hasMore: false,
        nextCursor: null,
      },
    }))
    const onLoadDetail = vi.fn(async () => ({
      ok: true as const,
      detail: {
        ...EMPTY_DETAIL,
        notes: { rows: [firstPageNote], hasMore: true, nextCursor: "cursor-1" },
      },
    }))

    render(<MyLeadsQueue {...buildProps({ onLoadDetail, onLoadDetailPage })} />)
    await user.click(screen.getByRole("button", { name: "Show details for 1 Main Street" }))
    await waitFor(() => expect(screen.getByText("First page note")).toBeInTheDocument())

    await user.click(screen.getByRole("button", { name: "Load more notes" }))

    await waitFor(() => expect(screen.getByText("Second page note")).toBeInTheDocument())
    expect(onLoadDetailPage).toHaveBeenCalledWith("property-1", "notes", "cursor-1")
    expect(screen.getAllByText("First page note")).toHaveLength(1)
  })
})
