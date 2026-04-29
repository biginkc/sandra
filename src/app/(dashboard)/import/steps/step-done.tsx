"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { createClient } from "@/lib/supabase/client";
import type { Database } from "@/lib/supabase/types";

type Job = Database["public"]["Tables"]["jobs"]["Row"];

export function StepDone({ jobId }: { jobId: string }) {
  const [job, setJob] = useState<Job | null>(null);

  useEffect(() => {
    const supabase = createClient();
    let mounted = true;
    (async () => {
      const { data } = await supabase
        .from("jobs")
        .select("*")
        .eq("id", jobId)
        .single();
      if (mounted && data) setJob(data);
    })();
    return () => {
      mounted = false;
    };
  }, [jobId]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Import complete</CardTitle>
        <CardDescription>
          {job?.status === "completed"
            ? "All rows processed."
            : job?.status === "partial"
              ? "Some rows failed. See job details for specifics."
              : job?.status === "failed"
                ? "Import failed. See job details."
                : "Wrapping up…"}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Badge variant="outline">{job?.status ?? "…"}</Badge>
          <span className="text-muted-foreground text-sm">
            {job?.total_items ?? 0} rows
          </span>
        </div>
        <div className="grid grid-cols-3 gap-3 text-center text-sm">
          <Stat label="Succeeded" value={job?.succeeded_items ?? 0} />
          <Stat label="Failed" value={job?.failed_items ?? 0} />
          <Stat
            label="Skipped (dup)"
            value={Math.max(
              0,
              (job?.total_items ?? 0) -
                (job?.succeeded_items ?? 0) -
                (job?.failed_items ?? 0),
            )}
          />
        </div>
      </CardContent>
      <CardFooter className="flex gap-2">
        <Link href="/properties" className={buttonVariants()}>
          View properties
        </Link>
        <Link
          href={`/jobs/${jobId}`}
          className={buttonVariants({ variant: "outline" })}
        >
          Job details
        </Link>
        <Link
          href="/import"
          className={buttonVariants({ variant: "ghost" })}
        >
          New import
        </Link>
      </CardFooter>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="border-border flex flex-col rounded-md border p-3">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="text-lg font-semibold">{value}</span>
    </div>
  );
}
