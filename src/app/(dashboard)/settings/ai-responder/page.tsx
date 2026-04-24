import { redirect } from "next/navigation";

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
      <div className="p-6 text-sm text-destructive">
        Failed to load config: {result.error.message}
      </div>
    );
  }

  if (!result.data) {
    return (
      <div className="flex flex-col gap-4 p-6">
        <h1 className="text-2xl font-semibold">AI responder</h1>
        <p className="text-muted-foreground text-sm">
          No active config found. Run migration 019 (or re-seed the org) to
          create one.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">AI responder</h1>
        <p className="text-muted-foreground text-sm">
          Claude-backed first-touch reply for inbound SMS. Runs after
          auto-qualify + notifications + sequence-pause in the Dialpad
          webhook. Safety rails live in four places: keyword escalator,
          skip classifier, model-side confidence/sentiment checks, and
          the output safety validator.
        </p>
      </div>

      <AiResponderConfigForm initial={result.data} />
    </div>
  );
}
