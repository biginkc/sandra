import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import {
  parseTableSearch,
  type SortDirection,
} from "@/components/table/use-table-url-state.helpers";

import { listTemplates, listCategories } from "./actions";
import { NewTemplateButton } from "./new-template-button";
import { TemplatesList } from "./templates-list";
import { getOutboundSenderName } from "@/lib/messaging/sender-persona";

export const TEMPLATES_SORTABLE_COLUMNS = [
  "name",
  "category",
  "updated_at",
] as const;
export type TemplatesSortableColumn =
  (typeof TEMPLATES_SORTABLE_COLUMNS)[number];

export type TemplatesFilters = { category: string | null };

export default async function TemplatesPage({
  searchParams,
}: {
  searchParams: Promise<{
    page?: string;
    search?: string;
    sort?: string;
    dir?: string;
    category?: string;
  }>;
}) {
  // Parallelize searchParams await + the two server actions; they're
  // independent. parseTableSearch is the pure helper from .helpers (NOT
  // the hook module) per Plan 01-03's RSC boundary fix — server
  // components must stay outside the 'use client' barrier.
  const [raw, templatesResult, categoriesResult] = await Promise.all([
    searchParams,
    listTemplates(),
    listCategories(),
  ]);

  const templates = templatesResult.ok ? templatesResult.data : [];
  const categories = categoriesResult.ok ? categoriesResult.data : [];
  const senderName = getOutboundSenderName();

  const parsed = parseTableSearch<TemplatesFilters>(raw, {
    sortableColumns: TEMPLATES_SORTABLE_COLUMNS,
    defaultSort: "updated_at",
    defaultDir: "desc" as SortDirection,
    parseFilters: (r) => {
      const v = Array.isArray(r.category) ? r.category[0] : r.category;
      // Only accept categories that the server knows about — guards against
      // stale URLs after a category was renamed/deleted.
      return { category: v && categories.includes(v) ? v : null };
    },
  });

  return (
    <Page>
      <PageHeader
        breadcrumb={[{ label: "Workspace" }, { label: "Templates" }]}
        title="Templates"
        description="Reusable SMS templates with variable interpolation. Use {{first_name | fallback}} syntax for personalization."
        actions={<NewTemplateButton senderName={senderName} />}
      />

      {!templatesResult.ok && (
        <div className="text-destructive text-sm">
          Failed to load templates: {templatesResult.error.message}
        </div>
      )}

      <TemplatesList
        templates={templates}
        categories={categories}
        parsed={parsed}
        senderName={senderName}
      />
    </Page>
  );
}
