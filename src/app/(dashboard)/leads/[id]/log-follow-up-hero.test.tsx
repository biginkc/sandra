vi.mock("@/lib/sequences/drip-progress", () => ({ listDripProgress: vi.fn(async () => []) }))
vi.mock("@/lib/supabase/client", () => ({ createClient: vi.fn() }))
import { act, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  loadMyLeadRow: vi.fn(),
  loadMyLeadCallReferences: vi.fn(),
  submitMyLeadCommand: vi.fn(),
  submitMyLeadHandoffDrip: vi.fn(),
}))

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }), usePathname: () => "/leads/lead-1" }))
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }))
vi.mock("@/app/(dashboard)/sequences/actions", () => ({ listDripChoices: vi.fn(async () => ({ ok: true, data: [] })), startDripForLeads: vi.fn(), changeDripAction: vi.fn() }))
vi.mock("@/app/(dashboard)/my-leads/actions", () => ({
  loadMyLeadRow: mocks.loadMyLeadRow, loadMyLeadCallReferences: mocks.loadMyLeadCallReferences,
  submitMyLeadCommand: mocks.submitMyLeadCommand, submitMyLeadHandoffDrip: mocks.submitMyLeadHandoffDrip,
}))

import { LeadMediaHero } from "./lead-media-hero"
import { LogFollowUpProvider, LogFollowUpTrigger } from "./log-follow-up-button"

const sizes = ["small", "mobile", "smallTablet", "tablet", "desktop", "wide", "large", "extraLarge", "ultra"] as const
const images = (host: string) => Object.fromEntries(sizes.map((size) => [size, `https://maps.googleapis.com/maps/api/${host}?size=${size}`])) as never
const media = { kind: "streetView", images: images("streetview"), aerialImages: images("staticmap"), aerialResolvedBy: "address", heading: null, panoramaId: "pano-1" } as never
const row = { propertyId: "lead-1", assignmentEpisodeId: "ep-1", queueVersion: 1, sharedStatus: "new_lead", address: "1 Main" }

// The real hero re-parents its actions when its image fails (Street View, then aerial, then flat),
// exactly what a brand-new lead with no imagery does 1-2s after the page loads.
function page(assigneeId = "rep-9") {
  return (
    <LogFollowUpProvider propertyId="lead-1" propertyLabel="1 Main" assigneeId={assigneeId} disabledReason={null} viewer={{ userId: "rep-9", orgId: "org-1" }}>
      <LeadMediaHero media={media} address="1 Main" locationLine="KC, MO" homeownerName="Jamie" actions={<LogFollowUpTrigger />} />
    </LogFollowUpProvider>
  )
}
const failImage = () => fireEvent.error(screen.getByTestId("lead-media-image"))

describe("Log follow-up survives the hero re-parenting its actions", () => {
  beforeEach(() => {
    for (const m of Object.values(mocks)) m.mockReset()
    mocks.loadMyLeadCallReferences.mockResolvedValue({ ok: true, options: [] })
  })

  it("a lookup that finishes after the hero fell back to aerial and flat still opens the dialog", async () => {
    let release!: (value: unknown) => void
    mocks.loadMyLeadRow.mockReturnValueOnce(new Promise((resolve) => { release = resolve }))
    render(page())
    await userEvent.setup().click(screen.getByRole("button", { name: "Log follow-up" }))
    expect(await screen.findByTestId("log-follow-up-loading")).toBeInTheDocument()
    failImage() // Street View fails -> aerial: the actions are re-parented
    failImage() // aerial fails -> flat: re-parented again
    expect(screen.getByTestId("lead-media-flat")).toBeInTheDocument()
    // The remounted button still shows the opening in progress, not a silently reset button.
    expect(screen.getByRole("button", { name: "Opening…" })).toBeDisabled()
    await act(async () => { release({ ok: true, lookup: { status: "found", row, snapshotAt: "x" } }) })
    expect(await screen.findByRole("dialog")).toBeInTheDocument()
  })

  it("an open dialog stays open when the hero re-parents afterwards", async () => {
    mocks.loadMyLeadRow.mockResolvedValue({ ok: true, lookup: { status: "found", row, snapshotAt: "x" } })
    render(page())
    await userEvent.setup().click(screen.getByRole("button", { name: "Log follow-up" }))
    expect(await screen.findByRole("dialog")).toBeInTheDocument()
    failImage()
    failImage()
    expect(screen.getByTestId("lead-media-flat")).toBeInTheDocument()
    expect(screen.getByRole("dialog")).toBeInTheDocument()
  })

  it("a refusal to open is visible after a re-parent, never silent", async () => {
    let release!: (value: unknown) => void
    mocks.loadMyLeadRow.mockReturnValueOnce(new Promise((resolve) => { release = resolve }))
    render(page())
    await userEvent.setup().click(screen.getByRole("button", { name: "Log follow-up" }))
    failImage()
    failImage()
    await act(async () => { release({ ok: true, lookup: { status: "unavailable", reason: "archived" } }) })
    expect(await screen.findByTestId("log-follow-up-note")).toHaveTextContent("This lead was archived from My Leads.")
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("a page re-render that changes the assignee prop keeps the in-flight opening", async () => {
    let release!: (value: unknown) => void
    mocks.loadMyLeadRow.mockReturnValue(new Promise((resolve) => { release = resolve }))
    const view = render(page("rep-9"))
    await userEvent.setup().click(screen.getByRole("button", { name: "Log follow-up" }))
    view.rerender(page("rep-10")) // a prop really changes mid-lookup
    expect(mocks.loadMyLeadRow).toHaveBeenCalledTimes(1)
    expect(mocks.loadMyLeadRow).toHaveBeenCalledWith({ memberId: "rep-9", propertyId: "lead-1" })
    await act(async () => { release({ ok: true, lookup: { status: "found", row, snapshotAt: "x" } }) })
    expect(await screen.findByRole("dialog")).toBeInTheDocument()
  })

  it("re-parenting mid-uncertain keeps the fields locked, the reconcile UI shown, and Reconcile replays the identical payload and key", async () => {
    const user = userEvent.setup({ delay: null })
    mocks.loadMyLeadRow.mockResolvedValue({ ok: true, lookup: { status: "found", row, snapshotAt: "x" } })
    mocks.submitMyLeadCommand
      .mockImplementationOnce(() => new Promise(() => undefined)) // the save never answers: frozen
      .mockResolvedValueOnce({ ok: true, duplicate: true, attemptRecorded: true })
    render(page())
    await user.click(screen.getByRole("button", { name: "Log follow-up" }))
    await user.selectOptions(await screen.findByLabelText("External outcome"), "reached")
    fireEvent.change(screen.getByLabelText("When did the outreach occur?"), { target: { value: "2026-09-11T09:00" } })
    await user.type(screen.getByLabelText("Note (optional)"), "Original note")
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      fireEvent.click(screen.getByRole("button", { name: "Save attempt" }))
      await act(async () => { await vi.advanceTimersByTimeAsync(25_001) })
    } finally { vi.useRealTimers() }
    expect(await screen.findByRole("button", { name: "Reconcile saved change" })).toBeInTheDocument()
    // The hero falls back to flat and re-parents its actions while the save is frozen.
    failImage()
    failImage()
    expect(screen.getByTestId("lead-media-flat")).toBeInTheDocument()
    expect(screen.getByLabelText("Note (optional)")).toBeDisabled()
    expect(screen.getByLabelText("Note (optional)")).toHaveValue("Original note")
    expect(screen.getByText(/original request is preserved for reconciliation/)).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Reconcile saved change" }))
    expect(await screen.findByRole("button", { name: "Done without changing drip" })).toBeInTheDocument()
    expect(mocks.submitMyLeadCommand).toHaveBeenCalledTimes(2)
    expect(mocks.submitMyLeadCommand.mock.calls[1][1]).toEqual(mocks.submitMyLeadCommand.mock.calls[0][1])
    expect(mocks.submitMyLeadCommand.mock.calls[1][1]).toMatchObject({ note: "Original note", idempotencyKey: (mocks.submitMyLeadCommand.mock.calls[0][1] as { idempotencyKey: string }).idempotencyKey })
  })
})

