import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

import type {
  ParsedTableSearch,
  SortDirection,
} from "@/components/table/use-table-url-state";

import { TemplatesList } from "./templates-list";
import type { TemplateRow } from "./actions";
import type { TemplatesFilters } from "./page";

// `next/navigation`'s real router needs an App Router context Vitest doesn't
// provide. Hoisted mock so tests can assert what URL replace() was called
// with when the user types into search / clicks a sort header / changes the
// category Select.
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

// TemplateDialog and DeleteTemplateButton both transitively import server
// actions / Supabase server bindings that don't load cleanly in jsdom. Stub
// both — these tests focus on the URL-state surface of TemplatesList, not
// the row-action dialogs.
vi.mock("./template-dialog", () => ({
  TemplateDialog: () => null,
}));

vi.mock("./delete-template-button", () => ({
  DeleteTemplateButton: ({ systemManaged }: { systemManaged?: boolean }) => (
    <button data-testid="delete-btn" disabled={systemManaged}>Delete</button>
  ),
}));

function makeTemplate(
  overrides: Partial<TemplateRow> & { id: string },
): TemplateRow {
  return {
    id: overrides.id,
    name: overrides.name ?? `Template ${overrides.id}`,
    content: overrides.content ?? "Hello world",
    category: overrides.category ?? "General",
    system_managed: overrides.system_managed ?? false,
    created_at: overrides.created_at ?? "2026-04-29T10:00:00Z",
    updated_at: overrides.updated_at ?? "2026-04-29T12:00:00Z",
  };
}

const DEFAULT_PARSED: ParsedTableSearch<TemplatesFilters> = {
  page: 1,
  search: null,
  sort: "updated_at",
  dir: "desc" as SortDirection,
  filters: { category: null },
};

function renderTemplates(
  opts: {
    templates?: TemplateRow[];
    categories?: string[];
    parsed?: Partial<ParsedTableSearch<TemplatesFilters>>;
  } = {},
) {
  return render(
    <TemplatesList
      templates={opts.templates ?? [makeTemplate({ id: "t1" })]}
      categories={opts.categories ?? ["General", "Probate", "Vacant"]}
      senderName="Mel"
      parsed={{
        ...DEFAULT_PARSED,
        ...opts.parsed,
        filters: {
          ...DEFAULT_PARSED.filters,
          ...(opts.parsed?.filters ?? {}),
        },
      }}
    />,
  );
}

beforeEach(() => {
  routerReplace.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("<TemplatesList />", () => {
  it("renders the toolbar (search + category Select) and three sortable column headers", () => {
    renderTemplates();
    expect(screen.getByTestId("templates-search")).toBeInTheDocument();
    expect(screen.getByTestId("templates-category-select")).toBeInTheDocument();
    expect(screen.getByTestId("templates-sort-name")).toBeInTheDocument();
    expect(screen.getByTestId("templates-sort-category")).toBeInTheDocument();
    expect(
      screen.getByTestId("templates-sort-updated_at"),
    ).toBeInTheDocument();
  });

  it("typing in search calls router.replace with /templates?search=… after the 250ms debounce", async () => {
    // Real timers + waitFor — fake timers don't compose cleanly with the
    // hook's internal setTimeout path per Plans 01-04 / 01-05 SUMMARYs.
    const user = userEvent.setup();
    renderTemplates();
    await user.type(screen.getByTestId("templates-search"), "welcome");

    await waitFor(
      () => {
        expect(routerReplace).toHaveBeenCalled();
      },
      { timeout: 1500 },
    );
    expect(routerReplace.mock.calls.at(-1)?.[0]).toBe(
      "/templates?search=welcome",
    );
  });

  it("clicking the Name header (default sort: updated_at desc) emits ?sort=name (asc is default → omitted)", async () => {
    const user = userEvent.setup();
    renderTemplates();
    await user.click(screen.getByTestId("templates-sort-name"));
    await waitFor(() => expect(routerReplace).toHaveBeenCalledTimes(1));
    // Switching to a non-default column resets dir to "asc". buildTableHref
    // omits dir=asc because defaultDir is "desc"… wait — defaultDir is
    // "desc", so "asc" is NOT default → it IS emitted.
    // Confirmed: defaultDir="desc"; clicking a non-default column starts at
    // dir="asc"; dir !== defaultDir ⇒ included in URL.
    expect(routerReplace.mock.calls[0][0]).toBe(
      "/templates?sort=name&dir=asc",
    );
  });

  it("changing the category Select calls router.replace with /templates?category=Probate", async () => {
    // Base UI Select: pointerEventsCheck disabled because jsdom doesn't
    // implement pointer-events CSS computation; without this user.click()
    // throws "Pointer events are disabled" against the trigger.
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderTemplates();

    // Open the dropdown.
    await user.click(screen.getByTestId("templates-category-select"));

    // Wait for the portaled option to mount, then click it.
    const opt = await screen.findByTestId("templates-category-option-Probate");
    await user.click(opt);

    await waitFor(() => expect(routerReplace).toHaveBeenCalledTimes(1));
    expect(routerReplace.mock.calls[0][0]).toBe("/templates?category=Probate");
  });

  it("when category is set, selecting 'All categories' clears the URL filter", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderTemplates({ parsed: { filters: { category: "Probate" } } });

    await user.click(screen.getByTestId("templates-category-select"));
    const allOpt = await screen.findByTestId("templates-category-option-all");
    await user.click(allOpt);

    await waitFor(() => expect(routerReplace).toHaveBeenCalledTimes(1));
    // category → null collapses out of the URL; sort=updated_at + dir=desc
    // are the defaults → also stripped → URL collapses to bare path.
    expect(routerReplace.mock.calls[0][0]).toBe("/templates");
  });

  it("in-memory filter — when parsed.filters.category='Probate', only Probate templates render", () => {
    renderTemplates({
      templates: [
        makeTemplate({
          id: "t1",
          name: "Probate intro",
          category: "Probate",
        }),
        makeTemplate({
          id: "t2",
          name: "General hello",
          category: "General",
        }),
      ],
      parsed: { filters: { category: "Probate" } },
    });

    expect(screen.getByText("Probate intro")).toBeInTheDocument();
    expect(screen.queryByText("General hello")).toBeNull();
  });

  it("in-memory filter — when parsed.search='hello', matches name OR content (case-insensitive)", () => {
    renderTemplates({
      templates: [
        makeTemplate({ id: "t1", name: "Hello world", content: "Hi" }),
        makeTemplate({ id: "t2", name: "Goodbye", content: "Hello again" }),
        makeTemplate({ id: "t3", name: "Bye", content: "See ya" }),
      ],
      parsed: { search: "hello" },
    });

    expect(screen.getByText("Hello world")).toBeInTheDocument();
    expect(screen.getByText("Goodbye")).toBeInTheDocument(); // matches via content
    expect(screen.queryByText("Bye")).toBeNull();
  });

  it("system-managed row renders the System badge", () => {
    renderTemplates({
      templates: [makeTemplate({ id: "t1", name: "Owner check", system_managed: true })],
    });
    expect(screen.getByText("System")).toBeInTheDocument();
  });

  it("system-managed row has the delete button disabled", () => {
    renderTemplates({
      templates: [makeTemplate({ id: "t1", name: "Owner check", system_managed: true })],
    });
    expect(screen.getByTestId("delete-btn")).toBeDisabled();
  });
});
