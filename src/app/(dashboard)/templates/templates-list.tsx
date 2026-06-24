"use client";

import { useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DataTableFooter,
  DataTableShell,
} from "@/components/ui/data-table-shell";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { SortableHeader } from "@/components/table/sortable-header";
import {
  TableToolbar,
  TableToolbarSearch,
} from "@/components/table/table-toolbar";
import {
  useTableUrlState,
  type ParsedTableSearch,
  type SortDirection,
  type UseTableUrlStateReturn,
} from "@/components/table/use-table-url-state";

import { type TemplateRow } from "./actions";
import { DeleteTemplateButton } from "./delete-template-button";
import {
  type TemplatesFilters,
  type TemplatesSortableColumn,
} from "./page";
import { TemplateDialog } from "./template-dialog";

type Props = {
  templates: TemplateRow[];
  categories: string[];
  parsed: ParsedTableSearch<TemplatesFilters>;
  senderName: string;
};

const TEMPLATES_SORTABLE_COLUMNS = [
  "name",
  "category",
  "updated_at",
] as const;

const BUILD_CONFIG = {
  defaultSort: "updated_at" as const,
  defaultDir: "desc" as SortDirection,
  sortableColumns: TEMPLATES_SORTABLE_COLUMNS,
  buildFilterParams: (
    filters: Partial<TemplatesFilters>,
    sp: URLSearchParams,
  ) => {
    if (filters.category) sp.set("category", filters.category);
  },
};

/**
 * Client island for the /templates table. Consumes
 * useTableUrlState({ mode: "client" }) — URL is the mirror, the
 * prefetched `templates` array is the source. Search/sort/category
 * filter all run in-memory via useMemo over the array; the hook's
 * navigate calls router.replace to keep the URL in sync (no SSR
 * roundtrip, since `mode: "client"` skips the useTransition wrapper).
 *
 * Two notable quirks vs /lists and /jobs (per CONTEXT A2/D-10 +
 * RESEARCH Q1 recommendation b):
 *   1. The category filter stays as a Base UI <Select> (NOT a
 *      <TableToolbarFilterPill>). Pills are binary toggles; categories
 *      are a multi-option dropdown. The Select sits inside <TableToolbar>
 *      next to <TableToolbarSearch> and is wired to ts.navigate.
 *   2. Raw <table> → shadcn <Table> for visual continuity with
 *      /properties /lists /jobs.
 */
export function TemplatesList({ templates, categories, parsed, senderName }: Props) {
  const [editingTemplate, setEditingTemplate] = useState<TemplateRow | null>(
    null,
  );

  const ts = useTableUrlState<TemplatesFilters>({
    basePath: "/templates",
    parsed,
    mode: "client",
    config: BUILD_CONFIG,
  });

  // Apply URL state in-memory. Recomputes when templates mutates (e.g.,
  // after edit/delete via revalidatePath) OR when any URL-state field
  // changes. Pitfall 5 protection: every URL-state field is in deps.
  const visible = useMemo(() => {
    const q = ts.search.toLowerCase().trim();
    let result = templates.slice();

    if (q.length > 0) {
      result = result.filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          t.content.toLowerCase().includes(q),
      );
    }

    if (ts.filters.category) {
      result = result.filter((t) => t.category === ts.filters.category);
    }

    const sortKey = ts.sort as TemplatesSortableColumn;
    const ascending = ts.dir === "asc";
    result.sort((a, b) => {
      let cmp = 0;
      if (sortKey === "name") {
        cmp = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
      } else if (sortKey === "category") {
        cmp = (a.category ?? "")
          .toLowerCase()
          .localeCompare((b.category ?? "").toLowerCase());
      } else {
        // updated_at
        cmp =
          new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime();
      }
      return ascending ? cmp : -cmp;
    });

    return result;
  }, [templates, ts.search, ts.sort, ts.dir, ts.filters.category]);

  const onCategoryChange = (next: string | undefined) => {
    const newCategory = next === "all" || !next ? null : next;
    ts.navigate(
      `/templates${ts.buildHref({
        page: 1,
        // Forward search only when non-empty to keep the URL clean when
        // the user changes category without an active search.
        search: ts.search === "" ? null : ts.search,
        sort: ts.sort,
        dir: ts.dir,
        filters: { category: newCategory },
      })}`,
    );
  };

  return (
    <>
      <TableToolbar
        state={
          ts as unknown as UseTableUrlStateReturn<Record<string, unknown>>
        }
      >
        <TableToolbarSearch
          ariaLabel="Search templates by name or content"
          placeholder="Search templates…"
          testId="templates-search"
        />
        <Select
          value={parsed.filters.category ?? "all"}
          onValueChange={(v) => onCategoryChange(v ?? "all")}
        >
          <SelectTrigger
            className="w-full sm:w-[180px]"
            id="category-filter"
            data-testid="templates-category-select"
          >
            <SelectValue placeholder="All categories" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all" data-testid="templates-category-option-all">
              All categories
            </SelectItem>
            {categories.map((c) => (
              <SelectItem
                key={c}
                value={c}
                data-testid={`templates-category-option-${c}`}
              >
                {c}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </TableToolbar>

      <DataTableShell
        className="overflow-x-auto"
        data-pending={ts.navPending}
        data-testid="templates-table-container"
      >
        <Table>
          <TableHeader>
            <TableRow>
              <SortableHeader<TemplatesSortableColumn>
                column="name"
                current={ts.sort}
                dir={ts.dir}
                onClick={(c) => ts.onSort(c)}
                testIdPrefix="templates"
              >
                Name
              </SortableHeader>
              <SortableHeader<TemplatesSortableColumn>
                column="category"
                current={ts.sort}
                dir={ts.dir}
                onClick={(c) => ts.onSort(c)}
                testIdPrefix="templates"
              >
                Category
              </SortableHeader>
              <TableHead className="hidden md:table-cell">Preview</TableHead>
              <SortableHeader<TemplatesSortableColumn>
                column="updated_at"
                current={ts.sort}
                dir={ts.dir}
                onClick={(c) => ts.onSort(c)}
                testIdPrefix="templates"
              >
                Updated
              </SortableHeader>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {ts.navPending ? (
              Array.from({ length: Math.max(visible.length, 5) }).map(
                (_, i) => (
                  <TableRow
                    key={`skeleton-${i}`}
                    data-testid="templates-skeleton-row"
                  >
                    <TableCell>
                      <Skeleton className="h-4 w-48" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-5 w-20 rounded-full" />
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      <Skeleton className="h-4 w-72" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-4 w-16" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-8 w-20" />
                    </TableCell>
                  </TableRow>
                ),
              )
            ) : visible.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="text-muted-foreground py-12 text-center"
                >
                  {templates.length === 0
                    ? 'No templates yet. Click "New template" to create one.'
                    : "No templates match your search."}
                </TableCell>
              </TableRow>
            ) : (
              visible.map((t) => (
                <TableRow key={t.id}>
                  <TableCell>
                    <button
                      type="button"
                      onClick={() => setEditingTemplate(t)}
                      className="font-medium hover:underline"
                    >
                      {t.name}
                    </button>
                    {t.system_managed && (
                      <Badge variant="secondary" className="ml-1.5 text-xs">System</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{t.category}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden max-w-[300px] truncate md:table-cell">
                    {t.content.slice(0, 80)}
                    {t.content.length > 80 ? "…" : ""}
                  </TableCell>
                  <TableCell className="text-muted-foreground whitespace-nowrap text-xs">
                    <UpdatedAt iso={t.updated_at} />
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setEditingTemplate(t)}
                      >
                        Edit
                      </Button>
                      <DeleteTemplateButton
                        templateId={t.id}
                        templateName={t.name}
                        systemManaged={t.system_managed}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
        <DataTableFooter>
          <span className="text-muted-foreground text-sm">
            {visible.length} of {templates.length} template{templates.length === 1 ? "" : "s"}
          </span>
        </DataTableFooter>
      </DataTableShell>

      {/* Edit dialog */}
      {editingTemplate && (
        <TemplateDialog
          mode="edit"
          template={editingTemplate}
          open={!!editingTemplate}
          onOpenChange={(open) => {
            if (!open) setEditingTemplate(null);
          }}
          senderName={senderName}
        />
      )}
    </>
  );
}

/**
 * WR-12: render an absolute, server-stable label first paint, then swap
 * to the relative form on the client. Lifted UNCHANGED from the
 * pre-migration templates-list.tsx — same hydration-safe behavior.
 */
function UpdatedAt({ iso }: { iso: string }) {
  const [label, setLabel] = useState<string>(() => formatAbsolute(iso));

  useEffect(() => {
    const update = () => setLabel(formatRelative(iso));
    update();
    const id = setInterval(update, 60_000);
    return () => clearInterval(id);
  }, [iso]);

  return (
    <time dateTime={iso} title={formatAbsolute(iso)} suppressHydrationWarning>
      {label}
    </time>
  );
}

function formatAbsolute(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(
    d.getUTCDate(),
  )} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  return `${weeks}w ago`;
}
