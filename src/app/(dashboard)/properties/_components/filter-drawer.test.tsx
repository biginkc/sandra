import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// ── next/navigation mock ──────────────────────────────────────────────────────
// replace() simulates router.replace by extracting the search string from the
// URL and updating window.location via replaceState using a relative URL so
// jsdom doesn't throw a SecurityError from cross-origin checks.
const replace = vi.fn((url: string) => {
  try {
    // Extract just the search string to avoid jsdom SecurityError on full URLs.
    const searchStart = url.indexOf("?");
    const search = searchStart >= 0 ? url.slice(searchStart) : "";
    window.history.replaceState({}, "", `/properties${search}`);
  } catch {
    // Fallback: store the search string for the next useSearchParams call.
  }
});
const refresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, refresh }),
  useSearchParams: () => new URLSearchParams(window.location.search),
  usePathname: () => "/properties",
}));

// ── count action mock ─────────────────────────────────────────────────────────
const countMock = vi.fn();

vi.mock("@/app/(dashboard)/properties/_actions/count", () => ({
  countProspectsForFilter: (...args: unknown[]) => countMock(...args),
}));

import type { BlockStack, Combinator, FilterBlock } from "@/lib/prospects/filter-schema";
import { encodeFilters } from "@/lib/prospects/filter-schema";
import { FilterDrawer } from "./filter-drawer";
import { BlockOptionsContext, type BlockOptions } from "./blocks/_block-shell";
import { renderBlock } from "./blocks/registry";

beforeEach(() => {
  replace.mockClear();
  refresh.mockReset();
  countMock.mockResolvedValue({ ok: true, data: { count: 42 } });
  window.history.replaceState({}, "", "/properties");
});

// Helper: render the drawer pre-opened via the controlled `open` prop.
// This bypasses the SheetTrigger click which requires base-ui animation
// to complete in jsdom — instead we render with the sheet already open.
function renderOpen(
  extraProps: Partial<React.ComponentProps<typeof FilterDrawer>> = {},
) {
  const onOpenChange = vi.fn();
  const utils = render(
    <FilterDrawer
      orgId="org-1"
      open={true}
      onOpenChange={onOpenChange}
      {...extraProps}
    />,
  );
  return { onOpenChange, ...utils };
}

const blockOptions: BlockOptions = {
  lists: [],
  tags: [],
  markets: ["Jackson"],
  states: ["MO", "KS"],
  assignees: [],
  sources: ["county"],
  pipelineStatuses: ["prospect", "new_lead", "contacted"],
  motivationLevels: ["warm", "hot"],
  outreachDispos: [],
  cassStatuses: ["verified", "unverified", "invalid"],
};

function renderOpenWithRealBlocks() {
  const onOpenChange = vi.fn();
  const element = (
    <BlockOptionsContext.Provider value={blockOptions}>
      <FilterDrawer
        orgId="org-1"
        open={true}
        onOpenChange={onOpenChange}
        renderBlock={renderBlock}
      />
    </BlockOptionsContext.Provider>
  );
  const utils = render(element);
  return {
    onOpenChange,
    ...utils,
    rerenderDrawer: () =>
      act(async () => {
        utils.rerender(element);
      }),
  };
}

function setFilters(blocks: BlockStack) {
  window.history.replaceState(
    {},
    "",
    `/properties?filters=${encodeFilters({ v: 1, blocks })}`,
  );
}

type MockProspect = {
  id: string;
  status: "prospect" | "new_lead" | "contacted";
  cassStatus: "verified" | "unverified" | "invalid";
  vacant: boolean | null;
  absentee: boolean | null;
  equityPct: number | null;
  engagement: "never_contacted" | "attempted" | "replied" | "opted_out";
  listCount: number;
};

const mockProspects: MockProspect[] = [
  {
    id: "verified-vacant-replied",
    status: "prospect",
    cassStatus: "verified",
    vacant: true,
    absentee: false,
    equityPct: 35,
    engagement: "replied",
    listCount: 2,
  },
  {
    id: "verified-vacant-attempted-high-equity",
    status: "prospect",
    cassStatus: "verified",
    vacant: true,
    absentee: false,
    equityPct: 45,
    engagement: "attempted",
    listCount: 1,
  },
  {
    id: "unverified-occupied-absentee-low-equity",
    status: "prospect",
    cassStatus: "unverified",
    vacant: false,
    absentee: true,
    equityPct: 15,
    engagement: "never_contacted",
    listCount: 0,
  },
  {
    id: "invalid-unknown-vacancy-replied-high-equity",
    status: "prospect",
    cassStatus: "invalid",
    vacant: null,
    absentee: false,
    equityPct: 60,
    engagement: "replied",
    listCount: 3,
  },
  {
    id: "new-lead-vacant-replied-high-equity",
    status: "new_lead",
    cassStatus: "verified",
    vacant: true,
    absentee: false,
    equityPct: 70,
    engagement: "replied",
    listCount: 2,
  },
  {
    id: "new-lead-unverified-occupied",
    status: "new_lead",
    cassStatus: "unverified",
    vacant: false,
    absentee: false,
    equityPct: 10,
    engagement: "attempted",
    listCount: 0,
  },
];

function hasPipelineStatusBlock(blocks: BlockStack) {
  return blocks.some((block) => block.kind === "pipeline_status");
}

function matchesCombinator<T>(value: T, values: T[], combinator: Combinator) {
  if (values.length === 0) return true;
  const includes = values.includes(value);
  return combinator === "not" ? !includes : includes;
}

function matchesRange(value: number | null, range: { min: number | null; max: number | null }) {
  if (range.min == null && range.max == null) return true;
  if (value == null) return false;
  if (range.min != null && value < range.min) return false;
  if (range.max != null && value > range.max) return false;
  return true;
}

function matchesTri(value: boolean | null, tri: "any" | "yes" | "no") {
  if (tri === "any") return true;
  if (tri === "yes") return value === true;
  return value !== true;
}

function mockProspectMatchesBlock(prospect: MockProspect, block: FilterBlock) {
  switch (block.kind) {
    case "vacancy":
      return matchesTri(prospect.vacant, block.tri);
    case "absentee":
      return matchesTri(prospect.absentee, block.tri);
    case "cass":
      return matchesCombinator(prospect.cassStatus, block.values, block.combinator);
    case "equity_pct":
      return matchesRange(prospect.equityPct, block.range);
    case "list_count":
      return matchesRange(prospect.listCount, block.range);
    case "pipeline_status":
      return matchesCombinator(prospect.status, block.values, block.combinator);
    case "engagement":
      return matchesCombinator(prospect.engagement, block.values, block.combinator);
    default:
      return true;
  }
}

function countMockProspects(blocks: BlockStack) {
  return mockProspects.filter((prospect) => {
    const passesBasePipeline = hasPipelineStatusBlock(blocks) || prospect.status === "prospect";
    return passesBasePipeline && blocks.every((block) => mockProspectMatchesBlock(prospect, block));
  }).length;
}

function installMockProspectCounter() {
  countMock.mockImplementation(async ({ blocks }: { blocks: BlockStack }) => ({
    ok: true,
    data: { count: countMockProspects(blocks) },
  }));
}

async function waitForShowCount(count: number) {
  await waitFor(() => {
    expect(
      screen.getByRole("button", {
        name: new RegExp(`show ${count} prospects`, "i"),
      }),
    ).toBeInTheDocument();
  });
}

async function waitForDebouncedCount() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 300));
  });
}

async function addFilterBlock(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  rerenderDrawer: () => Promise<void>,
) {
  await user.click(screen.getByRole("button", { name: /add filter block/i }));
  await user.click(screen.getByText(label));
  await rerenderDrawer();
}

function vacancyBlock(tri: "any" | "yes" | "no"): Extract<FilterBlock, { kind: "vacancy" }> {
  return { id: `vacancy-${tri}`, kind: "vacancy", tri };
}

function cassBlock(
  values: Array<MockProspect["cassStatus"]>,
  combinator: Combinator = "any",
): Extract<FilterBlock, { kind: "cass" }> {
  return { id: `cass-${values.join("-")}`, kind: "cass", combinator, values };
}

function equityPctBlock(
  min: number | null,
  max: number | null = null,
): Extract<FilterBlock, { kind: "equity_pct" }> {
  return { id: `equity-${min ?? "any"}-${max ?? "any"}`, kind: "equity_pct", range: { min, max } };
}

function pipelineStatusBlock(
  values: Array<MockProspect["status"]>,
  combinator: Combinator = "any",
): Extract<FilterBlock, { kind: "pipeline_status" }> {
  return { id: `pipeline-${values.join("-")}`, kind: "pipeline_status", combinator, values };
}

function engagementBlock(
  values: Array<MockProspect["engagement"]>,
  combinator: Combinator = "any",
): Extract<FilterBlock, { kind: "engagement" }> {
  return { id: `engagement-${values.join("-")}`, kind: "engagement", combinator, values };
}

function listCountBlock(
  min: number | null,
  max: number | null = null,
): Extract<FilterBlock, { kind: "list_count" }> {
  return { id: `list-count-${min ?? "any"}-${max ?? "any"}`, kind: "list_count", range: { min, max } };
}

describe("FilterDrawer", () => {
  it("renders 'Filters' trigger button when uncontrolled", () => {
    render(<FilterDrawer orgId="org-1" />);
    expect(screen.getByRole("button", { name: /filters/i })).toBeInTheDocument();
  });

  it("clicking Filters opens drawer with empty-state copy", () => {
    renderOpen();
    expect(
      screen.getByText(/add a filter to slice your prospects/i),
    ).toBeInTheDocument();
  });

  it("clicking + Add Filter Block opens picker with search input", async () => {
    const user = userEvent.setup();
    renderOpen();
    await user.click(screen.getByRole("button", { name: /add filter block/i }));
    expect(screen.getByPlaceholderText(/search filters/i)).toBeInTheDocument();
  });

  it("selecting Vacancy from picker adds a block row to the drawer body", async () => {
    const user = userEvent.setup();
    const { rerender } = renderOpen();
    await user.click(screen.getByRole("button", { name: /add filter block/i }));
    await user.click(screen.getByText("Vacancy"));

    // router.replace was called with the new URL — re-render so useSearchParams
    // picks up the updated window.location.search.
    await act(async () => {
      rerender(
        <FilterDrawer orgId="org-1" open={true} onOpenChange={vi.fn()} />,
      );
    });

    // Picker closes; block row appears
    expect(screen.queryByPlaceholderText(/search filters/i)).not.toBeInTheDocument();
    expect(document.querySelector("[data-block-row]")).toBeInTheDocument();
    expect(document.querySelector("[data-kind='vacancy']")).toBeInTheDocument();
  });

  it("Show N prospects button displays count from the count action", async () => {
    renderOpen();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /show 42 prospects/i }),
      ).toBeInTheDocument();
    });
  });

  it("clicking × on a block row removes it", async () => {
    const user = userEvent.setup();
    const { rerender } = renderOpen();

    // Add a block first
    await user.click(screen.getByRole("button", { name: /add filter block/i }));
    await user.click(screen.getByText("Vacancy"));
    await act(async () => {
      rerender(
        <FilterDrawer orgId="org-1" open={true} onOpenChange={vi.fn()} />,
      );
    });
    expect(document.querySelector("[data-block-row]")).toBeInTheDocument();

    // Remove it
    await user.click(screen.getByRole("button", { name: /remove block/i }));
    await act(async () => {
      rerender(
        <FilterDrawer orgId="org-1" open={true} onOpenChange={vi.fn()} />,
      );
    });
    expect(document.querySelector("[data-block-row]")).not.toBeInTheDocument();
  });

  it("SheetContent has !max-w-[440px] class for SPEC width override", () => {
    renderOpen();
    const popup = document.querySelector("[data-slot='sheet-content']");
    expect(popup?.className).toContain("!max-w-[440px]");
  });

  it("uses a non-obscuring overlay so the table stays visible while filtering", () => {
    renderOpen();
    const overlay = document.querySelector("[data-slot='sheet-overlay']");
    expect(overlay?.className).toContain("bg-transparent");
    expect(overlay?.className).toContain("backdrop-blur-none");
    expect(overlay?.className).toContain("pointer-events-none");
  });

  // ── Slot tests ────────────────────────────────────────────────────────────

  it("renders nothing for topSlot/footerSlot when not provided", () => {
    renderOpen();
    expect(document.querySelector("[data-top-slot]")).not.toBeInTheDocument();
    expect(document.querySelector("[data-footer-slot]")).not.toBeInTheDocument();
    // Unconditional Show N button is still present
    expect(screen.getByRole("button", { name: /show/i })).toBeInTheDocument();
  });

  it("renders topSlot inside SheetHeader when provided", () => {
    renderOpen({
      topSlot: <div data-testid="top-slot-child">TOP</div>,
    });
    const topSlotEl = screen.getByTestId("top-slot-child");
    expect(topSlotEl).toBeInTheDocument();
    expect(document.querySelector("[data-top-slot]")).toContainElement(topSlotEl);
  });

  it("renders footerSlot inside SheetFooter when provided alongside Show N button", () => {
    renderOpen({
      footerSlot: <div data-testid="footer-slot-child">FOOT</div>,
    });
    const footerSlotEl = screen.getByTestId("footer-slot-child");
    expect(footerSlotEl).toBeInTheDocument();
    expect(document.querySelector("[data-footer-slot]")).toContainElement(footerSlotEl);
    // Show N button still present
    expect(screen.getByRole("button", { name: /show/i })).toBeInTheDocument();
  });

  it("renders both topSlot AND footerSlot when both provided (Plan 09 composition)", () => {
    renderOpen({
      topSlot: <div data-testid="ts">TOP</div>,
      footerSlot: <div data-testid="fs">FOOT</div>,
    });
    expect(screen.getByTestId("ts")).toBeInTheDocument();
    expect(screen.getByTestId("fs")).toBeInTheDocument();
    // Show N button still present
    expect(screen.getByRole("button", { name: /show/i })).toBeInTheDocument();
  });

  describe("mock prospect dataset filter semantics", () => {
    beforeEach(() => {
      installMockProspectCounter();
    });

    it("counts the unfiltered prospect-only baseline from mocked data", async () => {
      renderOpenWithRealBlocks();

      await waitForDebouncedCount();

      await waitForShowCount(4);
      expect(countMock).toHaveBeenLastCalledWith({
        orgId: "org-1",
        blocks: [],
      });
    });

    it("updates the count when a real Vacancy drawer control is selected", async () => {
      const user = userEvent.setup();
      const { rerenderDrawer } = renderOpenWithRealBlocks();

      await addFilterBlock(user, "Vacancy", rerenderDrawer);
      const yesRadio = await screen.findByRole("radio", { name: /yes \(vacant\)/i });
      await user.click(yesRadio);
      expect(yesRadio).toBeChecked();
      await waitForDebouncedCount();

      await waitForShowCount(2);
      expect(countMock).toHaveBeenLastCalledWith({
        orgId: "org-1",
        blocks: [expect.objectContaining({ kind: "vacancy", tri: "yes" })],
      });
    });

    it("ANDs Vacancy and CASS blocks so impossible combinations count as zero", async () => {
      setFilters([vacancyBlock("yes"), cassBlock(["unverified"])]);

      renderOpenWithRealBlocks();
      await waitForDebouncedCount();

      await waitForShowCount(0);
      expect(countMock).toHaveBeenLastCalledWith({
        orgId: "org-1",
        blocks: [
          expect.objectContaining({ kind: "vacancy", tri: "yes" }),
          expect.objectContaining({ kind: "cass", values: ["unverified"] }),
        ],
      });
    });

    it("ANDs Vacancy with Equity % range against mocked property values", async () => {
      setFilters([vacancyBlock("yes"), equityPctBlock(40)]);

      renderOpenWithRealBlocks();
      await waitForDebouncedCount();

      await waitForShowCount(1);
      expect(countMock).toHaveBeenLastCalledWith({
        orgId: "org-1",
        blocks: [
          expect.objectContaining({ kind: "vacancy", tri: "yes" }),
          expect.objectContaining({
            kind: "equity_pct",
            range: { min: 40, max: null },
          }),
        ],
      });
    });

    it("uses Pipeline Status blocks to include non-prospect mocked rows", async () => {
      setFilters([pipelineStatusBlock(["new_lead"]), vacancyBlock("yes")]);

      renderOpenWithRealBlocks();
      await waitForDebouncedCount();

      await waitForShowCount(1);
      expect(countMock).toHaveBeenLastCalledWith({
        orgId: "org-1",
        blocks: [
          expect.objectContaining({
            kind: "pipeline_status",
            values: ["new_lead"],
          }),
          expect.objectContaining({ kind: "vacancy", tri: "yes" }),
        ],
      });
    });

    it("combines Engagement and List Count filters over mocked outreach data", async () => {
      setFilters([engagementBlock(["replied"]), listCountBlock(2)]);

      renderOpenWithRealBlocks();
      await waitForDebouncedCount();

      await waitForShowCount(2);
      expect(countMock).toHaveBeenLastCalledWith({
        orgId: "org-1",
        blocks: [
          expect.objectContaining({
            kind: "engagement",
            values: ["replied"],
          }),
          expect.objectContaining({
            kind: "list_count",
            range: { min: 2, max: null },
          }),
        ],
      });
    });
  });
});
