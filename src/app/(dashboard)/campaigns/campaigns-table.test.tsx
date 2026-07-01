import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ParsedTableSearch,
  SortDirection,
} from "@/components/table/use-table-url-state";

import { CampaignsTable, type CampaignRow, type CampaignsFilters } from "./campaigns-table";

const { routerReplace } = vi.hoisted(() => ({
  routerReplace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    refresh: vi.fn(),
    replace: routerReplace,
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

vi.mock("./actions", () => ({
  archiveCampaign: vi.fn(),
  launchCampaign: vi.fn(),
  previewCampaignLaunch: vi.fn(),
  unarchiveCampaign: vi.fn(),
}));

const DEFAULT_PARSED: ParsedTableSearch<CampaignsFilters> = {
  page: 1,
  search: null,
  sort: "created_at",
  dir: "desc" as SortDirection,
  filters: { archived: false },
};

function campaign(overrides: Partial<CampaignRow> & { id: string }): CampaignRow {
  return {
    id: overrides.id,
    name: overrides.name ?? `Campaign ${overrides.id}`,
    status: overrides.status ?? "completed",
    archived_at: overrides.archived_at ?? null,
    created_at: overrides.created_at ?? "2026-06-30T18:00:00.000Z",
    audienceSummary: overrides.audienceSummary ?? "1 filter",
    bodyPreview: overrides.bodyPreview ?? "Template pool: Opener - Homeowner",
    pace_seconds: overrides.pace_seconds ?? 8,
    skip_if_contacted: overrides.skip_if_contacted ?? false,
    recipientCount: overrides.recipientCount ?? 100,
  };
}

function renderCampaigns(rows: CampaignRow[]) {
  return render(
    <CampaignsTable rows={rows} parsed={DEFAULT_PARSED} total={rows.length} />,
  );
}

beforeEach(() => {
  routerReplace.mockReset();
});

describe("<CampaignsTable />", () => {
  it("renders unambiguous queue setup labels for every campaign table status", () => {
    renderCampaigns([
      campaign({ id: "active", status: "active" }),
      campaign({ id: "launching", status: "launching" }),
      campaign({ id: "paused", status: "paused" }),
      campaign({ id: "completed", status: "completed" }),
      campaign({ id: "failed", status: "failed" }),
      campaign({ id: "archived", status: "archived", archived_at: "2026-06-30T20:00:00.000Z" }),
    ]);

    expect(screen.getByText("Queue setup: not launched")).toBeInTheDocument();
    expect(screen.getByText("Queue setup: building")).toBeInTheDocument();
    expect(screen.getByText("Queue setup: paused")).toBeInTheDocument();
    expect(screen.getByText("Queue setup: built")).toBeInTheDocument();
    expect(screen.getByText("Queue setup: failed")).toBeInTheDocument();
    expect(screen.getByText("Archived")).toBeInTheDocument();
  });

  it("labels completed campaigns as queue setup instead of implying every text has sent", () => {
    renderCampaigns([
      campaign({
        id: "campaign-1",
        status: "completed",
        name: "June campaign",
      }),
    ]);

    expect(screen.getByText("Queue setup: built")).toBeInTheDocument();
    expect(screen.getByText("Queue built")).toBeInTheDocument();
    expect(screen.queryByText("completed")).toBeNull();
    expect(screen.queryByText("Sent")).toBeNull();
  });

  it("labels failed campaigns as queue setup failures", () => {
    renderCampaigns([
      campaign({
        id: "campaign-1",
        status: "failed",
        name: "June campaign",
      }),
    ]);

    expect(screen.getByText("Queue setup: failed")).toBeInTheDocument();
    expect(screen.getByText("Queue failed")).toBeInTheDocument();
  });
});
