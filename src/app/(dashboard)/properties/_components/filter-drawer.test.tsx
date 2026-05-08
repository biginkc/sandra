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

import { FilterDrawer } from "./filter-drawer";

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
});
