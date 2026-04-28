import { redirect } from "next/navigation";

import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { isAdminEmail } from "@/lib/auth/allowlist";
import { createClient } from "@/lib/supabase/server";

import { getAiResponderConfig } from "./actions";
import { AiResponderConfigForm } from "./form";

export default async function AiResponderSettingsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  if (!isAdminEmail(user.email)) redirect("/leads");

  const result = await getAiResponderConfig();
  if (!result.ok) {
    return (
      <Page>
        <div className="text-destructive text-sm">
          Failed to load config: {result.error.message}
        </div>
      </Page>
    );
  }

  if (!result.data) {
    return (
      <Page>
        <PageHeader
          breadcrumb={[{ label: "Settings" }, { label: "AI responder" }]}
          title="AI responder"
          description="No active config found. Run migration 019 (or re-seed the org) to create one."
        />
      </Page>
    );
  }

  return (
    <Page>
      <PageHeader
        breadcrumb={[{ label: "Settings" }, { label: "AI responder" }]}
        title="AI responder"
        description="Claude-backed first-touch reply for inbound SMS. Runs after auto-qualify + notifications + sequence-pause in the Dialpad webhook. Safety rails live in four places: keyword escalator, skip classifier, model-side confidence/sentiment checks, and the output safety validator."
      />
      <AiResponderConfigForm initial={result.data} />
    </Page>
  );
}
