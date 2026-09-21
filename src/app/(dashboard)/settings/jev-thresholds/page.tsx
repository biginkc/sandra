import { redirect } from "next/navigation";

import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { isAdminEmail } from "@/lib/auth/allowlist";
import { createClient } from "@/lib/supabase/server";

import { getJevThresholds } from "./actions";
import { JevThresholdsForm } from "./form";

export default async function JevThresholdsSettingsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  if (!isAdminEmail(user.email)) redirect("/leads");

  const result = await getJevThresholds();
  if (!result.ok) {
    return (
      <Page>
        <div className="text-destructive text-sm">
          Failed to load Jev thresholds: {result.error.message}
        </div>
      </Page>
    );
  }

  if (!result.data) {
    return (
      <Page>
        <PageHeader
          breadcrumb={[{ label: "Settings" }, { label: "Jev thresholds" }]}
          title="Jev thresholds"
          description="No organization found."
        />
      </Page>
    );
  }

  return (
    <Page>
      <PageHeader
        breadcrumb={[{ label: "Settings" }, { label: "Jev thresholds" }]}
        title="Jev thresholds"
        description="Per-outcome native-confidence cutoffs for automatic Jev application."
      />
      <JevThresholdsForm orgId={result.data.orgId} initialRows={result.data.rows} />
    </Page>
  );
}
