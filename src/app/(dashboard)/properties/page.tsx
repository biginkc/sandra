import Link from "next/link";

import { Button, buttonVariants } from "@/components/ui/button";
import { isAdminEmail } from "@/lib/auth/allowlist";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import {
  ProspectsTable,
  type ListOption,
  type ProspectRow,
  type TagOption,
  type TeamMemberOption,
} from "./prospects-table";

const PAGE_SIZE = 50;

export const metadata = {
  title: "Prospects · Sandra CRM",
};

export default async function PropertiesPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const params = await searchParams;
  const rawPage = Number(params.page ?? 1);
  const page =
    Number.isFinite(rawPage) && rawPage >= 1 ? Math.trunc(rawPage) : 1;

  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: properties, count, error } = await supabase
    .from("properties")
    .select(
      "id, address, city, state, zip, market, cass_status, is_vacant, created_at",
      { count: "exact" },
    )
    .eq("status", "prospect")
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .range(from, to);

  const total = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const showingFrom = total === 0 ? 0 : from + 1;
  const showingTo = Math.min(to + 1, total);

  const prospects: ProspectRow[] = (properties ?? []).map((p) => ({
    id: p.id,
    address: p.address,
    city: p.city,
    state: p.state,
    zip: p.zip,
    market: p.market,
    cass_status: p.cass_status,
    is_vacant: p.is_vacant,
    created_at: p.created_at,
  }));

  // Active lists — feed the "Add to list" / "Remove from list" submenus.
  // Archived lists are hidden from the picker (they'd be a noisy confusion
  // vector); users can unarchive via /lists if they want them back.
  const { data: listRows } = await supabase
    .from("lists")
    .select("id, name, color, archived_at")
    .is("archived_at", null)
    .order("name", { ascending: true });
  const lists: ListOption[] = (listRows ?? []).map((l) => ({
    id: l.id,
    name: l.name,
    color: l.color,
  }));

  // Custom-category tags only — Feature 3's strict journey-marker model
  // forbids applying source / uploaded / skip-trace tags by hand.
  const { data: tagRows } = await supabase
    .from("tags")
    .select("id, name, color")
    .eq("category", "custom")
    .eq("system_managed", false)
    .order("name", { ascending: true });
  const tags: TagOption[] = (tagRows ?? []).map((t) => ({
    id: t.id,
    name: t.name,
    color: t.color,
  }));

  // Team members for the Assign submenu. Admin-only API; non-fatal on
  // failure (the Assign submenu just renders empty).
  let teamMembers: TeamMemberOption[] = [];
  try {
    const admin = createAdminClient();
    const { data: usersPage } = await admin.auth.admin.listUsers({
      perPage: 200,
    });
    teamMembers = (usersPage?.users ?? [])
      .filter((u) => !!u.email)
      .map((u) => ({ id: u.id, email: u.email as string }))
      .sort((a, b) => a.email.localeCompare(b.email));
  } catch {
    // Leave teamMembers empty — submenu renders a subtle empty state.
  }

  const isAdmin = isAdminEmail(user?.email);

  const headerCount =
    total === 0
      ? "No prospects yet. Import a CSV to fill the data lake."
      : `Showing ${showingFrom}–${showingTo} of ${total} prospect${total === 1 ? "" : "s"}. Qualify a prospect to move it into the leads pipeline.`;

  return (
    <div className="flex flex-col gap-4 p-6">
      {error ? (
        <div className="text-destructive text-sm">
          Failed to load prospects: {error.message}
        </div>
      ) : null}

      <ProspectsTable
        prospects={prospects}
        lists={lists}
        tags={tags}
        teamMembers={teamMembers}
        currentUserId={user?.id ?? null}
        canDelete={isAdmin}
        headerCount={headerCount}
      />

      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <div className="text-muted-foreground text-sm">
            Page {page} of {totalPages}
          </div>
          <div className="flex gap-2">
            {page > 1 ? (
              <Link
                href={`/properties?page=${page - 1}`}
                className={buttonVariants({ variant: "outline", size: "sm" })}
                prefetch={false}
              >
                ← Prev
              </Link>
            ) : (
              <Button variant="outline" size="sm" disabled>
                ← Prev
              </Button>
            )}
            {page < totalPages ? (
              <Link
                href={`/properties?page=${page + 1}`}
                className={buttonVariants({ variant: "outline", size: "sm" })}
                prefetch={false}
              >
                Next →
              </Link>
            ) : (
              <Button variant="outline" size="sm" disabled>
                Next →
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
