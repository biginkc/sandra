import { redirect } from "next/navigation";

import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { getSingleActiveMembership } from "@/lib/auth/memberships";
import { createClient } from "@/lib/supabase/server";

import { SlackPreviewsClient } from "./client";

interface Props {
  searchParams: Promise<{ orgId?: string | string[] }>;
}

export default async function SlackPreviewsSettingsPage(props: Props) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [membership, params] = await Promise.all([
    getSingleActiveMembership(),
    props.searchParams,
  ]);
  const requestedOrgId =
    typeof params.orgId === "string" ? params.orgId : null;
  const orgId =
    membership.ok && (!requestedOrgId || requestedOrgId === membership.membership.org_id)
      ? membership.membership.org_id
      : null;

  return (
    <Page>
      <PageHeader
        breadcrumb={[
          { label: "Settings", href: "/settings/integrations" },
          { label: "Slack lead previews" },
        ]}
        title="Slack lead previews"
        description="Choose whether CRM lead links shared in eligible internal Slack channels can show a private preview."
      />
      <SlackPreviewsClient orgId={orgId} />
    </Page>
  );
}
