import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";

// vi.hoisted ensures these are available inside vi.mock factories (which are
// hoisted to the top of the file by vitest's transform, before variable init).
const { replace, refresh, mockTogglePin } = vi.hoisted(() => ({
  replace: vi.fn(),
  refresh: vi.fn(),
  mockTogglePin: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, refresh }),
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/properties",
}));

vi.mock(
  "@/app/(dashboard)/properties/_actions/saved-filters",
  () => ({
    togglePinSavedFilter: mockTogglePin,
  })
);

// Mock the base-ui-backed dropdown primitives to render children directly
// (no portal, no floating-ui positioning) so jsdom tests can find content.
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div data-testid="dropdown-menu">{children}</div>,
  DropdownMenuTrigger: ({ children, ...props }: React.ComponentPropsWithoutRef<"div">) => (
    <div data-testid="preset-dropdown-trigger" role="button" tabIndex={0} {...props}>{children}</div>
  ),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dropdown-menu-content">{children}</div>
  ),
  DropdownMenuGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dropdown-menu-label">{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    onSelect,
    disabled,
  }: {
    children: React.ReactNode;
    onSelect?: () => void;
    disabled?: boolean;
  }) => (
    <div
      role="menuitem"
      aria-disabled={disabled}
      onClick={disabled ? undefined : onSelect}
    >
      {children}
    </div>
  ),
  DropdownMenuSeparator: () => <hr />,
}));

import { PresetDropdown } from "./preset-dropdown";
import type { Preset } from "./quick-filter-chip";

const BASE_PRESETS: Preset[] = [
  { id: "base-1", name: "Stacked",     is_base: true,  starred: false, filters_json: { v: 1, blocks: [{ id: "b1", kind: "list_count", range: { min: 2, max: null } }] } },
  { id: "base-2", name: "Vacant",      is_base: true,  starred: false, filters_json: { v: 1, blocks: [{ id: "b2", kind: "vacancy",    tri: "yes" }] } },
  { id: "base-3", name: "Engaged",     is_base: true,  starred: false, filters_json: { v: 1, blocks: [{ id: "b3", kind: "engagement", combinator: "any", values: ["replied"] }] } },
  { id: "base-4", name: "Cold",        is_base: true,  starred: false, filters_json: { v: 1, blocks: [{ id: "b4", kind: "engagement", combinator: "any", values: ["never_contacted"] }] } },
  { id: "base-5", name: "High Equity", is_base: true,  starred: false, filters_json: { v: 1, blocks: [{ id: "b5", kind: "equity_pct", range: { min: 40, max: null } }] } },
];

const USER_PRESET: Preset = {
  id: "user-1",
  name: "KC Out-of-State",
  is_base: false,
  starred: false,
  filters_json: { v: 1, blocks: [{ id: "u1", kind: "state", combinator: "not", values: ["MO"] }] },
};

beforeEach(() => {
  replace.mockReset();
  refresh.mockReset();
  mockTogglePin.mockReset();
});

describe("PresetDropdown", () => {
  it("renders Base label and 5 base preset items", () => {
    render(<PresetDropdown orgId="org-1" presets={BASE_PRESETS} />);
    // Dropdown is always-rendered via mock (no portal) — content visible immediately
    expect(screen.getByText("Base")).toBeInTheDocument();
    expect(screen.getByText("Stacked")).toBeInTheDocument();
    expect(screen.getByText("Vacant")).toBeInTheDocument();
    expect(screen.getByText("Engaged")).toBeInTheDocument();
    expect(screen.getByText("Cold")).toBeInTheDocument();
    expect(screen.getByText("High Equity")).toBeInTheDocument();
  });

  it("clicking a base preset calls replaceStack (via useFilterState)", async () => {
    const user = userEvent.setup();
    render(<PresetDropdown orgId="org-1" presets={BASE_PRESETS} />);
    await user.click(screen.getByText("Vacant"));
    // replaceStack flows through useFilterState → router.replace
    expect(replace).toHaveBeenCalled();
    const [url] = replace.mock.calls[0] as [string, ...unknown[]];
    expect(url).toContain("filters=");
  });

  it("renders Mine label with star toggle for user presets", () => {
    render(<PresetDropdown orgId="org-1" presets={[...BASE_PRESETS, USER_PRESET]} />);
    expect(screen.getByText("Mine")).toBeInTheDocument();
    expect(screen.getByText("KC Out-of-State")).toBeInTheDocument();
    // Star toggle button rendered for Mine preset (not for base presets)
    expect(screen.getByLabelText(/Pin KC Out-of-State/i)).toBeInTheDocument();
  });

  it("empty mine shows 'No saved presets yet'", () => {
    render(<PresetDropdown orgId="org-1" presets={BASE_PRESETS} />);
    expect(screen.getByText(/No saved presets yet/i)).toBeInTheDocument();
  });

  it("star toggle calls togglePinSavedFilter + router.refresh", async () => {
    const user = userEvent.setup();
    mockTogglePin.mockResolvedValue({ ok: true, data: { starred: true } });
    render(<PresetDropdown orgId="org-1" presets={[...BASE_PRESETS, USER_PRESET]} />);
    await user.click(screen.getByLabelText(/Pin KC Out-of-State/i));
    await waitFor(() => {
      expect(mockTogglePin).toHaveBeenCalledWith(
        expect.objectContaining({ id: "user-1", starred: true })
      );
    });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });
});
