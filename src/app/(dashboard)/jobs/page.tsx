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
    <div className="flex flex-col gap-4 p-6">
      <div>
        <h1 className="text-4xl font-black tracking-tight md:text-[2.5rem]">Jobs</h1>
        <p className="text-muted-foreground text-sm">
          Every non-instant operation — imports, enrichment runs, scheduled
          sweeps — shows up here with live status.
        </p>
      </div>
      <JobsList isAdmin={isAdmin} />
    </div>
  );
}
