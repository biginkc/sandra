import { notFound } from "next/navigation";

import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/supabase/types";

import { JobDetail } from "./job-detail";

export const metadata = {
  title: "Job · Sandra CRM",
};

type Job = Database["public"]["Tables"]["jobs"]["Row"];
type JobItem = Database["public"]["Tables"]["job_items"]["Row"];

const ITEM_PAGE_SIZE = 200;

export default async function JobDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: job, error: jobErr } = await supabase
    .from("jobs")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (jobErr || !job) {
    notFound();
  }

  // Fetch related rows in parallel — items, parent, children, csv_imports
  // metadata when applicable. Each query is small + indexed; no need to
  // chain them.
  const [itemsRes, parentRes, childrenRes, csvImportRes] =
    await Promise.all([
      supabase
        .from("job_items")
        .select("*")
        .eq("job_id", id)
        .order("status")
        .limit(ITEM_PAGE_SIZE),
      job.parent_job_id
        ? supabase
            .from("jobs")
            .select("id, type, status, title")
            .eq("id", job.parent_job_id)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      supabase
        .from("jobs")
        .select("id, type, status, title")
        .eq("parent_job_id", id)
        .order("created_at", { ascending: false }),
      job.related_import_id
        ? supabase
            .from("csv_imports")
            .select(
              "id, filename, source, market, total_rows, inserted_properties, skipped_duplicates, failed_rows, storage_path",
            )
            .eq("id", job.related_import_id)
            .maybeSingle()
        : Promise.resolve({ data: null }),
    ]);

  return (
    <Page>
      <PageHeader
        breadcrumb={[
          { label: "Workspace" },
          { label: "Jobs", href: "/jobs" },
          { label: shortenForCrumb(job) },
        ]}
        title={job.title ?? job.id.slice(0, 8)}
        description={`${job.type} · ${humanizeAge(job.created_at)}`}
      />

      <JobDetail
        job={job as Job}
        items={(itemsRes.data ?? []) as JobItem[]}
        parent={parentRes.data ?? null}
        childJobs={childrenRes.data ?? []}
        csvImport={csvImportRes.data ?? null}
      />
    </Page>
  );
}

function shortenForCrumb(job: Job): string {
  if (job.title) {
    return job.title.length > 50 ? `${job.title.slice(0, 47)}…` : job.title;
  }
  return job.id.slice(0, 8);
}

function humanizeAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}
