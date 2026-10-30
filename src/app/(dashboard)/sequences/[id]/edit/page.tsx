import { notFound, redirect } from "next/navigation";

import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { listTemplates } from "@/app/(dashboard)/templates/actions";
import { listVoicemailTemplateGroups } from "@/app/(dashboard)/templates/voicemail-template-actions";
import { isVoicemailDropEnabled } from "@/lib/voicemail-drop/registry";

import { getSequenceAdminStatus } from "../../admin";
import { getImpactAction, getSequenceWithSteps } from "../../actions";

import { SequenceEditor } from "./editor";

export default async function SequenceEditPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ new?: string }>;
}) {
  if (!(await getSequenceAdminStatus())) redirect("/leads");

  const { id } = await params;
  const isNew = (await searchParams).new === "1";
  const result = await getSequenceWithSteps(id);
  if (!result.ok || !result.data) {
    if (result.ok) notFound();
    return (
      <Page>
        <PageHeader
          breadcrumb={[
            { label: "Workspace" },
            { label: "Drips", href: "/sequences" },
            { label: "Edit" },
          ]}
          title="Drip editor"
        />
        <div className="text-destructive text-sm">
          Failed to load drip: {result.error.message}
        </div>
      </Page>
    );
  }
  if (result.data.managed) {
    return (
      <Page>
        <PageHeader
          breadcrumb={[{ label: "Workspace" }, { label: "Drips", href: "/sequences" }, { label: result.data.name }]}
          title={result.data.name}
        />
        <div className="text-muted-foreground text-sm">
          This is an automatic reply drip. Its texts and timing can&apos;t be edited here.
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
  const voicemailGroupsResult = await listVoicemailTemplateGroups();
  const voicemailGroups = voicemailGroupsResult.ok ? voicemailGroupsResult.data : [];

  return (
    <Page>
      <PageHeader
        breadcrumb={[
          { label: "Workspace" },
          { label: "Drips", href: "/sequences" },
          { label: result.data.name },
        ]}
        title={result.data.name}
        description={
          isNew
            ? "Details saved. Add your first step."
            : impact.total_enrolled > 0
            ? `${impact.total_enrolled} lead${impact.total_enrolled === 1 ? "" : "s"} enrolled · ${impact.scheduled_next_7d} due in the next 7 days`
            : "No leads enrolled yet."
        }
      />
      <SequenceEditor
        sequence={result.data}
        initialImpact={impact}
        templates={templates}
        isNew={isNew}
        voicemailDrop={{
          // Server-only: env presence and default IDs, never credentials.
          enabled: isVoicemailDropEnabled(),
          defaultVoiceId: process.env.DROPCOWBOY_VOICE_ID?.trim() || null,
          defaultPhoneLineId: process.env.DROPCOWBOY_PHONE_LINE_ID?.trim() || null,
          scriptGroups: voicemailGroups,
        }}
      />
    </Page>
  );
}
