import { redirect } from "next/navigation";

import { isAdminEmail } from "@/lib/auth/allowlist";
import { createClient } from "@/lib/supabase/server";
import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";

import { CreateSequenceForm } from "./form";

export default async function NewSequencePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!isAdminEmail(user?.email)) redirect("/leads");

  return (
    <Page>
      <PageHeader
        breadcrumb={[
          { label: "Sequences", href: "/sequences" },
          { label: "New" },
        ]}
        title="New sequence"
        description="Name it and describe what it's for. You'll add steps on the next screen."
      />
      <CreateSequenceForm />
    </Page>
  );
}
