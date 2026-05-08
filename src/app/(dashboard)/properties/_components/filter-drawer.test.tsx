import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
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

import { FilterDrawer } from "./filter-drawer";
import { BlockOptionsContext, type BlockOptions } from "./blocks/_block-shell";
import { renderBlock } from "./blocks/registry";
import type { FilterBlock } from "@/lib/prospects/filter-schema";

beforeEach(() => {
  replace.mockClear();
  refresh.mockReset();
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

async function addFilterBlock(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  rerenderDrawer: () => Promise<void>,
) {
  await user.click(screen.getByRole("button", { name: /add filter block/i }));
  await user.click(screen.getByText(label));
  await rerenderDrawer();
}

function currentBlocks(): FilterBlock[] {
  const raw = new URLSearchParams(window.location.search).get("filters");
  expect(raw).toBeTruthy();
  const decoded = JSON.parse(raw as string) as { blocks: FilterBlock[] };
  return decoded.blocks;
}

describe("FilterDrawer", () => {
  it("renders 'Filters' trigger button when uncontrolled", () => {
    render(<FilterDrawer orgId="org-1" />);
    expect(screen.getByRole("button", { name: /filters/i })).toBeInTheDocument();
  });

  it("clicking Filters opens drawer without empty-state copy", () => {
    renderOpen();
    expect(
      screen.queryByText(/add a filter to slice your prospects/i),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add filter block/i })).toBeInTheDocument();
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
    expect(screen.queryByRole("button", { name: /show/i })).not.toBeInTheDocument();
  });

  it("renders topSlot inside SheetHeader when provided", () => {
    renderOpen({
      topSlot: <div data-testid="top-slot-child">TOP</div>,
    });
    const topSlotEl = screen.getByTestId("top-slot-child");
    expect(topSlotEl).toBeInTheDocument();
    expect(document.querySelector("[data-top-slot]")).toContainElement(topSlotEl);
  });

  it("renders footerSlot inside SheetFooter without an apply CTA", () => {
    renderOpen({
      footerSlot: <div data-testid="footer-slot-child">FOOT</div>,
    });
    const footerSlotEl = screen.getByTestId("footer-slot-child");
    expect(footerSlotEl).toBeInTheDocument();
    expect(document.querySelector("[data-footer-slot]")).toContainElement(footerSlotEl);
    expect(screen.queryByRole("button", { name: /show/i })).not.toBeInTheDocument();
  });

  it("renders both topSlot AND footerSlot when both provided (Plan 09 composition)", () => {
    renderOpen({
      topSlot: <div data-testid="ts">TOP</div>,
      footerSlot: <div data-testid="fs">FOOT</div>,
    });
    expect(screen.getByTestId("ts")).toBeInTheDocument();
    expect(screen.getByTestId("fs")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /show/i })).not.toBeInTheDocument();
  });

  it("encodes Vacancy + CASS selections into URL filter state immediately", async () => {
    const user = userEvent.setup();
    const { rerenderDrawer } = renderOpenWithRealBlocks();

    await addFilterBlock(user, "Vacancy", rerenderDrawer);
    await user.click(await screen.findByRole("radio", { name: /yes \(vacant\)/i }));
    await rerenderDrawer();

    await addFilterBlock(user, "CASS", rerenderDrawer);
    await user.click(await screen.findByRole("checkbox", { name: /^verified$/i }));
    await rerenderDrawer();

    expect(currentBlocks()).toEqual([
      expect.objectContaining({ kind: "vacancy", tri: "yes" }),
      expect.objectContaining({
        kind: "cass",
        combinator: "any",
        values: ["verified"],
      }),
    ]);
  });

  it("encodes zero-result-prone Engagement buckets without waiting on server count", async () => {
    const user = userEvent.setup();
    const { rerenderDrawer } = renderOpenWithRealBlocks();

    await addFilterBlock(user, "Engagement", rerenderDrawer);
    await user.click(await screen.findByRole("checkbox", { name: /attempted/i }));
    await rerenderDrawer();

    expect(currentBlocks()).toEqual([
      expect.objectContaining({
        kind: "engagement",
        combinator: "any",
        values: ["attempted"],
      }),
    ]);
    expect(screen.queryByRole("button", { name: /show/i })).not.toBeInTheDocument();
  });

  it("encodes Equity percent ranges into URL filter state", async () => {
    const user = userEvent.setup();
    const { rerenderDrawer } = renderOpenWithRealBlocks();

    await addFilterBlock(user, "Equity %", rerenderDrawer);
    await user.type(await screen.findByLabelText(/minimum equity percent/i), "50");
    await rerenderDrawer();

    expect(currentBlocks()).toEqual([
      expect.objectContaining({
        kind: "equity_pct",
        range: { min: 50, max: null },
      }),
    ]);
  });
});
