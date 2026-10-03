import { redirect } from "next/navigation";

import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import {
  getCallerMembershipsOrThrow,
  type Membership,
} from "@/lib/auth/memberships";
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

  const [memberships, params] = await Promise.all([
    getCallerMembershipsOrThrow(),
    props.searchParams,
  ]);
  const requestedOrgId =
    typeof params.orgId === "string" ? params.orgId : null;
  const activeMemberships = memberships.filter(isActiveMembership);
  const orgId = requestedOrgId && activeMemberships.some(
    (membership) => membership.org_id === requestedOrgId,
  )
    ? requestedOrgId
    : activeMemberships.length === 1
      ? activeMemberships[0].org_id
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

function isActiveMembership(membership: Membership): boolean {
  if (membership.access_status && membership.access_status !== "active") {
    return false;
  }
  if (membership.deletion_prepared_at) return false;
  return !(
    membership.access_expires_at &&
    Date.parse(membership.access_expires_at) <= Date.now()
  );
}
