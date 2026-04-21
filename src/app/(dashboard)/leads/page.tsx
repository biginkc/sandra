import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/server";

import { Kanban } from "./kanban";

export const metadata = {
  title: "Leads · Sandra CRM",
};

export default async function LeadsPage() {
  const supabase = await createClient();
  const { data: leads, error } = await supabase
    .from("properties")
    .select(
      "id, address, city, state, zip, market, status, is_vacant, cass_status, absentee_flag",
    )
    .order("created_at", { ascending: false })
    .limit(500);

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Leads</h1>
          <p className="text-muted-foreground text-sm">
            Drag to move leads through the pipeline.
            {leads?.length ? (
              <> · Showing the latest {leads.length} of your lead pool.</>
            ) : null}
          </p>
        </div>
        <Link href="/import" className={buttonVariants()}>
          Import CSV
        </Link>
      </div>

      {error ? (
        <div className="text-destructive text-sm">
          Failed to load leads: {error.message}
        </div>
      ) : leads && leads.length > 0 ? (
        <Kanban initialLeads={leads} />
      ) : (
        <div className="text-muted-foreground border-border rounded-md border border-dashed p-8 text-center text-sm">
          No leads yet. Import a CSV to fill the pipeline.
        </div>
      )}
    </div>
  );
}
