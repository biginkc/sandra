import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
// Pure helpers imported from the .helpers module (NO "use client" directive)
// so this server component can call them during SSR without hitting Next.js's
// RSC client-reference boundary. Plan 01-03 SUMMARY documents this requirement;
// importing from "@/components/table/use-table-url-state" (the 'use client'
// module) would crash on /jobs the same way /properties did pre-fix.
import {
  parseTableSearch,
  type SortDirection,
} from "@/components/table/use-table-url-state.helpers";
import { isAdminEmail } from "@/lib/auth/allowlist";
import { createClient } from "@/lib/supabase/server";

import { JobsList } from "./jobs-list";

export const metadata = {
  title: "Jobs · Sandra CRM",
};

export const JOBS_SORTABLE_COLUMNS = [
  "title",
  "type",
  "status",
  "created_at",
] as const;
export type JobsSortableColumn = (typeof JOBS_SORTABLE_COLUMNS)[number];

export type JobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "partial"
  | "canceled"
  | "denied"
  | "pending_approval";

export type JobsFilters = { status: JobStatus | null };

const JOB_STATUS_VALUES: readonly JobStatus[] = [
  "queued",
  "running",
  "completed",
  "failed",
  "partial",
  "canceled",
  "denied",
  "pending_approval",
];

function isJobStatus(v: unknown): v is JobStatus {
  return (
    typeof v === "string" &&
    (JOB_STATUS_VALUES as readonly string[]).includes(v)
  );
}

export default async function JobsPage({
  searchParams,
}: {
  searchParams: Promise<{
    page?: string;
    search?: string;
    sort?: string;
    dir?: string;
    status?: string;
  }>;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const isAdmin = isAdminEmail(user?.email);

  const raw = await searchParams;
  const parsed = parseTableSearch<JobsFilters>(raw, {
    sortableColumns: JOBS_SORTABLE_COLUMNS,
    defaultSort: "created_at",
    defaultDir: "desc" as SortDirection,
    parseFilters: (r) => {
      const v = Array.isArray(r.status) ? r.status[0] : r.status;
      return { status: isJobStatus(v) ? v : null };
    },
  });

  return (
    <Page>
      <PageHeader
        breadcrumb={[{ label: "Workspace" }, { label: "Jobs" }]}
        title="Jobs"
        description="Every non-instant operation — imports, enrichment runs, scheduled sweeps — shows up here with live status."
      />
      <JobsList isAdmin={isAdmin} parsed={parsed} />
    </Page>
  );
}
