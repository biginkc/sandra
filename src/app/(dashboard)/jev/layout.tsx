import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";

import { JevTabNav } from "./jev-tab-nav";

export default async function JevLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  return (
    <div className="flex w-full flex-1 flex-col">
      <JevTabNav />
      {children}
    </div>
  );
}
