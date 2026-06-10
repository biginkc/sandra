import { notFound, redirect } from "next/navigation";

import { isAdminEmail } from "@/lib/auth/allowlist";
import { createClient } from "@/lib/supabase/server";
import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { listTemplates } from "@/app/(dashboard)/templates/actions";

import { getImpactAction, getSequenceWithSteps } from "../../actions";

import { SequenceEditor } from "./editor";

export default async function SequenceEditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!isAdminEmail(user?.email)) redirect("/leads");

  const { id } = await params;
  const result = await getSequenceWithSteps(id);
  if (!result.ok || !result.data) {
    if (result.ok) notFound();
    return (
      <Page>
        <PageHeader
          breadcrumb={[
            { label: "Workspace" },
            { label: "Sequences", href: "/sequences" },
            { label: "Edit" },
          ]}
          title="Sequence editor"
        />
        <div className="text-destructive text-sm">
          Failed to load sequence: {result.error.message}
        </div>
      </Page>
    );
  }
  const impactResult = await getImpactAction(id);
  const impact = impactResult.ok
    ? impactResult.data
    : { total_enrolled: 0, scheduled_next_7d: 0 };

  const templatesResult = await listTemplates();
  const templates = templatesResult.ok ? templatesResult.data : [];

  return (
    <Page>
      <PageHeader
        breadcrumb={[
          { label: "Workspace" },
          { label: "Sequences", href: "/sequences" },
          { label: result.data.name },
        ]}
        title={result.data.name}
        description={
          impact.total_enrolled > 0
            ? `${impact.total_enrolled} lead${impact.total_enrolled === 1 ? "" : "s"} enrolled · ${impact.scheduled_next_7d} due in the next 7 days`
            : "No leads enrolled yet."
        }
      />
      <SequenceEditor
        sequence={result.data}
        initialImpact={impact}
        templates={templates}
      />
    </Page>
  );
}
