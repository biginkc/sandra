import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import * as React from "react"

const mocks = vi.hoisted(() => ({
  routerRefresh: vi.fn(),
  loadMyLeads: vi.fn(),
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.routerRefresh }),
}))

vi.mock("@/components/softphone/softphone-provider", () => ({
  useOptionalSoftphone: () => null,
}))

vi.mock("@/components/appointments/book-appointment-popover", () => ({
  BookAppointmentPopover: () => null,
}))

vi.mock("./actions", () => ({
  loadMyLeads: mocks.loadMyLeads,
  loadMyLeadsStage: vi.fn(),
  loadMyLeadDetail: vi.fn(),
  loadMyLeadCallReferences: vi.fn(),
  submitMyLeadCommand: vi.fn(),
  changeAcquisitionDesignation: vi.fn(),
  changeAcquisitionSettings: vi.fn(),
}))

vi.mock("./_components/queue", () => ({
  MyLeadsQueue: ({
    stages,
  }: {
    stages: { not_contacted?: { rows: Array<{ address: string }> } }
  }) => {
    const [expanded, setExpanded] = React.useState(false)
    const row = stages.not_contacted?.rows[0]
    return (
      <section aria-label="Mock My Leads queue">
        <span data-testid="queue-address">{row?.address}</span>
        <button type="button" onClick={() => setExpanded(true)}>
          Expand details
        </button>
        {expanded && <div data-testid="mounted-detail">Details remain mounted</div>}
      </section>
    )
  },
}))

vi.mock("./_components/attempt-dialog", () => ({
  AcquisitionAttemptDialog: () => null,
}))
vi.mock("./_components/readiness-dialog", () => ({
  AcquisitionReadinessDialog: () => null,
}))
vi.mock("./_components/offer-dialog", () => ({
  AcquisitionOfferDialog: () => null,
}))
vi.mock("./_components/lifecycle-dialog", () => ({
  AcquisitionLifecycleDialog: () => null,
}))

import type { AcquisitionKpis, AcquisitionRoster, QueueSnapshot } from "@/lib/my-leads/queries"
import { MyLeadsClient } from "./client"

const viewer = {
  userId: "rep-1",
  orgId: "org-1",
  isOwner: false,
}

const roster: AcquisitionRoster = {
  isOwner: false,
  members: [
    {
      id: "rep-1",
      label: "Maria",
      role: "member",
      acquisitionsEnabled: true,
      active: true,
      hasHistory: true,
    },
  ],
  settings: { enabled: true, recipientId: null, revision: 1 },
}

const kpis: AcquisitionKpis = {
  attempts: 1,
  reached: 1,
  pendingOutcomes: 0,
  firstCallSamples: 1,
  firstCallPending: 0,
  firstCallElapsedSeconds: 120,
  appointmentsDue: 0,
  appointmentsHeld: 0,
  orgAppointmentsUnattributed: 0,
  offersSent: 0,
  staleLeads: 0,
}

function snapshot(address: string): QueueSnapshot {
  return {
    stages: {
      not_contacted: {
        rows: [
          {
            propertyId: "property-1",
            stage: "not_contacted",
            queueVersion: 1,
            sharedStatus: "new_lead",
            assignmentEpisodeId: "episode-1",
            assignedAt: "2026-09-11T14:00:00.000Z",
            initializedAt: "2026-09-11T14:00:00.000Z",
            episodeKind: "live",
            clockEligible: true,
            firstCallAt: null,
            stageEnteredAt: null,
            address,
            city: "Kansas City",
            state: "MO",
            homeownerName: "Fixture Homeowner",
            phone: "555-0100",
            contactId: "contact-1",
            phones: ["555-0100"],
            contactDnc: false,
            temperature: null,
            motivationKind: null,
            motivationText: null,
            warningReasons: [],
            nextStepAt: null,
            nextStepType: null,
            offer: null,
            attemptsCount: 0,
          },
        ],
        totalCount: 1,
        filteredCount: 1,
        cursor: null,
        hasMore: false,
      },
    },
    snapshotAt: "2026-09-11T14:00:00.000Z",
    nextWarningAt: null,
    search: "",
  }
}

function renderClient(initialSnapshot: QueueSnapshot, initialKpis = kpis) {
  return render(
    <MyLeadsClient
      viewer={viewer}
      roster={roster}
      initialMemberId={viewer.userId}
      initialSnapshot={initialSnapshot}
      initialKpis={initialKpis}
    />,
  )
}

describe("MyLeadsClient", () => {
  it("preserves expanded queue details when router refresh supplies new initial props", async () => {
    const user = userEvent.setup()
    const initialSnapshot = snapshot("106 Fixture Lane")
    const { rerender } = renderClient(initialSnapshot)

    await user.click(screen.getByRole("button", { name: "Expand details" }))
    expect(screen.getByTestId("mounted-detail")).toHaveTextContent("Details remain mounted")

    rerender(
      <MyLeadsClient
        viewer={viewer}
        roster={roster}
        initialMemberId={viewer.userId}
        initialSnapshot={{ ...initialSnapshot, snapshotAt: "2026-09-11T14:01:00.000Z" }}
        initialKpis={{ ...kpis, attempts: 2 }}
      />,
    )

    expect(screen.getByTestId("queue-address")).toHaveTextContent("106 Fixture Lane")
    expect(screen.getByTestId("mounted-detail")).toHaveTextContent("Details remain mounted")
    expect(mocks.loadMyLeads).not.toHaveBeenCalled()
  })
})
