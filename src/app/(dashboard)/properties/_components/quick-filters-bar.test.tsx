import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { encodeFilters, newBlockId } from "@/lib/prospects/filter-schema";

const replace = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, refresh }),
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/properties",
}));

import { QuickFilterChip } from "./quick-filter-chip";

beforeEach(() => {
  replace.mockReset();
  refresh.mockReset();
});

describe("QuickFilterChip", () => {
  it("renders the preset name", () => {
    const preset = {
      id: "p1",
      name: "Vacant",
      starred: false,
      is_base: true,
      filters_json: {
        v: 1 as const,
        blocks: [{ id: "x", kind: "vacancy" as const, tri: "yes" as const }],
      },
    };
    render(<QuickFilterChip preset={preset} orgId="org" currentFilterStateRaw={null} />);
    expect(screen.getByText("Vacant")).toBeInTheDocument();
  });

  it("clicking inactive chip applies preset to URL (router.replace called, URL contains filters=)", async () => {
    const user = userEvent.setup();
    const preset = {
      id: "p1",
      name: "Vacant",
      starred: false,
      is_base: true,
      filters_json: {
        v: 1 as const,
        blocks: [{ id: "x", kind: "vacancy" as const, tri: "yes" as const }],
      },
    };
    render(<QuickFilterChip preset={preset} orgId="org" currentFilterStateRaw={null} />);
    await user.click(screen.getByText("Vacant"));
    expect(replace).toHaveBeenCalled();
    const [url] = replace.mock.calls[0] as [string, ...unknown[]];
    expect(url).toContain("filters=");
  });

  it("clicking active chip clears URL filter (router.replace called, URL does NOT contain filters=)", async () => {
    const user = userEvent.setup();
    const blockId = newBlockId();
    const preset = {
      id: "p1",
      name: "Vacant",
      starred: false,
      is_base: true,
      filters_json: {
        v: 1 as const,
        blocks: [{ id: blockId, kind: "vacancy" as const, tri: "yes" as const }],
      },
    };
    // Different UUID in URL — should still match (active) because id is ignored
    const currentState = {
      v: 1 as const,
      blocks: [{ id: "different-uuid", kind: "vacancy" as const, tri: "yes" as const }],
    };
    const currentRaw = encodeFilters(currentState);
    render(<QuickFilterChip preset={preset} orgId="org" currentFilterStateRaw={currentRaw} />);
    await user.click(screen.getByText("Vacant"));
    expect(replace).toHaveBeenCalled();
    const [url] = replace.mock.calls[0] as [string, ...unknown[]];
    expect(url).not.toContain("filters=");
  });

  it("active state: aria-pressed=true when blocks match (ignoring id field)", () => {
    const preset = {
      id: "p1",
      name: "Vacant",
      starred: false,
      is_base: true,
      filters_json: {
        v: 1 as const,
        blocks: [{ id: "preset-uuid", kind: "vacancy" as const, tri: "yes" as const }],
      },
    };
    const currentState = {
      v: 1 as const,
      blocks: [{ id: "url-uuid", kind: "vacancy" as const, tri: "yes" as const }],
    };
    const currentRaw = encodeFilters(currentState);
    render(<QuickFilterChip preset={preset} orgId="org" currentFilterStateRaw={currentRaw} />);
    const btn = screen.getByRole("button");
    expect(btn).toHaveAttribute("aria-pressed", "true");
  });
});
