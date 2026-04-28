import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { isAdminEmail } from "@/lib/auth/allowlist";
import { createClient } from "@/lib/supabase/server";

import { JobsList } from "./jobs-list";

export const metadata = {
  title: "Jobs · Sandra CRM",
};

export default async function JobsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const isAdmin = isAdminEmail(user?.email);

  return (
    <Page>
      <PageHeader
        breadcrumb={[{ label: "Workspace" }, { label: "Jobs" }]}
        title="Jobs"
        description="Every non-instant operation — imports, enrichment runs, scheduled sweeps — shows up here with live status."
      />
      <JobsList isAdmin={isAdmin} />
    </Page>
  );
}
