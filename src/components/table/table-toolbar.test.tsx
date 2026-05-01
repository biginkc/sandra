import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

import {
  TableToolbar,
  TableToolbarSearch,
  TableToolbarFilterPill,
} from "./table-toolbar";
import {
  useTableUrlState,
  useTableUrlStateContext,
  type ParsedTableSearch,
  type SortDirection,
} from "./use-table-url-state";

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

const SORTABLE_COLUMNS = ["address", "created_at"] as const;

type EmptyFilters = Record<string, never>;

function makeOptions(parsed?: Partial<ParsedTableSearch<EmptyFilters>>) {
  return {
    basePath: "/test",
    parsed: {
      page: 1,
      search: null,
      sort: "created_at",
      dir: "desc" as SortDirection,
      filters: {},
      ...parsed,
    } as ParsedTableSearch<EmptyFilters>,
    config: {
      defaultSort: "created_at",
      defaultDir: "desc" as SortDirection,
      sortableColumns: SORTABLE_COLUMNS,
    },
  };
}

function ToolbarHarness(props: {
  initialSearch?: string;
  children: React.ReactNode;
}) {
  const ts = useTableUrlState(makeOptions({ search: props.initialSearch ?? null }));
  // The hook returns UseTableUrlStateReturn<EmptyFilters>; TableToolbar expects
  // UseTableUrlStateReturn<Record<string, unknown>> — the loose context type
  // is the documented compound-component compromise (see plan 01-02 notes).
  return (
    <TableToolbar state={ts as unknown as React.ComponentProps<typeof TableToolbar>["state"]}>
      {props.children}
    </TableToolbar>
  );
}

beforeEach(() => {
  routerReplace.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("<TableToolbar />", () => {
  it("renders the rounded-card wrapper", () => {
    const { container } = render(
      <ToolbarHarness>
        <span>child</span>
      </ToolbarHarness>,
    );
    const slot = container.querySelector('[data-slot="table-toolbar"]');
    expect(slot).not.toBeNull();
    expect(slot?.className).toContain("rounded-2xl");
    expect(slot?.className).toContain("border-border");
    expect(slot?.className).toContain("bg-card");
  });

  it("provides TableUrlStateContext to children", () => {
    function Probe() {
      const ctx = useTableUrlStateContext();
      return <span data-testid="probe-base-path">{ctx.basePath}</span>;
    }
    render(
      <ToolbarHarness>
        <Probe />
      </ToolbarHarness>,
    );
    expect(screen.getByTestId("probe-base-path")).toHaveTextContent("/test");
  });
});

describe("<TableToolbarSearch />", () => {
  it("renders an Input with the supplied aria-label, placeholder, and testId", () => {
    render(
      <ToolbarHarness>
        <TableToolbarSearch
          ariaLabel="Search test"
          placeholder="Type here…"
          testId="t-search"
        />
      </ToolbarHarness>,
    );
    const input = screen.getByLabelText("Search test");
    expect(input).toHaveAttribute("placeholder", "Type here…");
    expect(input).toHaveAttribute("data-testid", "t-search");
  });

  it("is uncontrolled (defaultValue) — initial value reflects ctx.search", () => {
    render(
      <ToolbarHarness initialSearch="seed">
        <TableToolbarSearch ariaLabel="Search test" testId="t-search" />
      </ToolbarHarness>,
    );
    const input = screen.getByTestId("t-search") as HTMLInputElement;
    // Uncontrolled inputs initialize via defaultValue; the DOM `value` reflects
    // the current input state, not a React-tracked state.
    expect(input.value).toBe("seed");
  });

  it("debounces typing then calls router.replace with the trimmed search after 250ms", async () => {
    // Real timers + waitFor (matches prospects-table.test.tsx:331-345 pattern).
    // Fake timers + userEvent.type don't compose well with React 19's
    // useTransition inside useTableUrlState — the transition schedules
    // work that fake timers never flush, hanging the test.
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(
      <ToolbarHarness>
        <TableToolbarSearch ariaLabel="Search test" testId="t-search" />
      </ToolbarHarness>,
    );
    const input = screen.getByTestId("t-search");

    await user.type(input, "Main St");

    await waitFor(
      () => {
        expect(routerReplace).toHaveBeenCalled();
      },
      { timeout: 1500 },
    );
    expect(routerReplace.mock.calls.at(-1)?.[0]).toBe("/test?search=Main+St");
  });

  it("X clear button is hidden initially when search is empty", () => {
    render(
      <ToolbarHarness>
        <TableToolbarSearch ariaLabel="Search test" testId="t-search" />
      </ToolbarHarness>,
    );
    expect(screen.queryByTestId("t-search-clear")).toBeNull();
  });

  it("X clear button is visible on first paint when initial search is non-empty", () => {
    render(
      <ToolbarHarness initialSearch="seed">
        <TableToolbarSearch ariaLabel="Search test" testId="t-search" />
      </ToolbarHarness>,
    );
    expect(screen.getByTestId("t-search-clear")).toBeInTheDocument();
  });

  it("clicking X clears immediately (no debounce wait) and routes with no ?search param", async () => {
    const user = userEvent.setup();
    render(
      <ToolbarHarness initialSearch="seed">
        <TableToolbarSearch ariaLabel="Search test" testId="t-search" />
      </ToolbarHarness>,
    );
    const clear = screen.getByTestId("t-search-clear");
    await user.click(clear);

    expect(routerReplace).toHaveBeenCalledTimes(1);
    expect(routerReplace.mock.calls[0][0]).toBe("/test");
  });
});

describe("<TableToolbarFilterPill />", () => {
  it("renders the children text and is variant='outline' (no data-active) when inactive", () => {
    const onClick = vi.fn();
    render(
      <ToolbarHarness>
        <TableToolbarFilterPill active={false} onClick={onClick} testId="pill-vacant">
          Vacant
        </TableToolbarFilterPill>
      </ToolbarHarness>,
    );
    const pill = screen.getByTestId("pill-vacant");
    expect(pill).toHaveTextContent("Vacant");
    expect(pill).not.toHaveAttribute("data-active");
  });

  it("renders data-active='true' when active and includes the X icon", () => {
    render(
      <ToolbarHarness>
        <TableToolbarFilterPill active={true} onClick={vi.fn()} testId="pill-vacant">
          Vacant
        </TableToolbarFilterPill>
      </ToolbarHarness>,
    );
    const pill = screen.getByTestId("pill-vacant");
    expect(pill).toHaveAttribute("data-active", "true");
    // Lucide icons render as <svg> children; the X icon comes after the text node.
    expect(pill.querySelector("svg")).not.toBeNull();
  });

  it("invokes onClick exactly once when clicked", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <ToolbarHarness>
        <TableToolbarFilterPill active={false} onClick={onClick} testId="pill-vacant">
          Vacant
        </TableToolbarFilterPill>
      </ToolbarHarness>,
    );
    await user.click(screen.getByTestId("pill-vacant"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
