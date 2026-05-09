import { redirect } from "next/navigation";

import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { createClient } from "@/lib/supabase/server";

import { getIntegrationStatus } from "./actions";
import { IntegrationsForm } from "./form";

interface Props {
  searchParams: Promise<{ connected?: string; error?: string }>;
}

export default async function IntegrationsSettingsPage(props: Props) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [status, params] = await Promise.all([
    getIntegrationStatus(),
    props.searchParams,
  ]);
  const banner = bannerFromParams(params);

  return (
    <Page>
      <PageHeader
        breadcrumb={[
          { label: "Settings" },
          { label: "Integrations" },
        ]}
        title="Integrations"
        description="Connect Slack and Google Calendar to receive task notifications outside Sandra. One-way outbound — Sandra remains the source of truth."
      />

      {banner && (
        <div
          role="status"
          data-banner-variant={banner.variant}
          className={
            banner.variant === "success"
              ? "rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900"
              : "border-destructive/20 bg-destructive/10 text-destructive rounded-md border px-4 py-3 text-sm"
          }
        >
          {banner.text}
        </div>
      )}

      {!status.ok ? (
        <div className="text-destructive text-sm">
          Failed to load integration status: {status.error.message}
        </div>
      ) : (
        <IntegrationsForm initial={status.data} />
      )}
    </Page>
  );
}

function bannerFromParams(params: { connected?: string; error?: string }):
  | { variant: "success" | "error"; text: string }
  | null {
  if (params.connected) {
    return {
      variant: "success",
      text:
        params.connected === "slack"
          ? "Slack connected."
          : "Google Calendar connected.",
    };
  }
  if (!params.error) return null;
  return { variant: "error", text: bannerForError(params.error) };
}

function bannerForError(code: string): string {
  switch (code) {
    case "state":
      return "Connection failed: state mismatch. Please try again.";
    case "callback":
      return "Connection failed during the callback. Please try again.";
    case "config":
      return "Server is missing OAuth credentials. Contact the admin.";
    case "start":
      return "Could not start the connection. Please try again.";
    default:
      return `Connection error: ${code}`;
  }
}
