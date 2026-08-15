import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { createClient } from "@/lib/supabase/server";

import { Wizard } from "./wizard";

export const metadata = {
  title: "Import · Sandra CRM",
};

export default async function ImportPage() {
  // Fetch the county list server-side and pass it down to the client
  // wizard. Per phase 02 D-01 the counties table is the single source
  // of truth for valid markets — adding a new market is a DB insert,
  // no code deploy. RLS on counties scopes the read to the user's org.
  const supabase = await createClient();
  const { data: counties } = await supabase
    .from("counties")
    .select("id, name, state, market")
    .order("state", { ascending: true })
    .order("name", { ascending: true });

  return (
    <Page>
      <PageHeader
        breadcrumb={[{ label: "Workspace" }, { label: "Import" }]}
        title="Import prospects"
        description="Imported properties appear in Prospects for review before promotion to Leads."
      />
      <Wizard counties={counties ?? []} />
    </Page>
  );
}
