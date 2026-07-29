import { formatDistanceToNow } from "date-fns/formatDistanceToNow";
import { notFound } from "next/navigation";
import type { User } from "@supabase/supabase-js";

import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { isAdminEmail } from "@/lib/auth/allowlist";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import {
  InvitePanel,
  MembershipAccessBadge,
  MembershipRoleControl,
  type UserRow,
} from "./invite-panel";
import { parseHugoUrl } from "./hugo-url";
import { loadSandraMemberships } from "./membership-inventory";

export const metadata = {
  title: "Team · Sandra CRM",
};

export default async function AdminUsersPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isAdminEmail(user.email)) {
    // Not an admin — pretend the page doesn't exist rather than
    // advertise there's something to hack at.
    notFound();
  }

  const admin = createAdminClient();
  const authUsers: User[] = [];
  let authError: string | null = null;
  for (let page = 1; page <= 100; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({
      page,
      perPage: 200,
    });
    if (error) {
      authError = error.message;
      break;
    }
    authUsers.push(...data.users);
    if (data.users.length < 200) break;
    if (page === 100) {
      authError = "User inventory exceeded the supported page limit.";
    }
  }

  const { membershipByUser, error: membershipError } =
    await loadSandraMemberships(admin);

  const rows: UserRow[] = authUsers.map((u) => {
    const membership = membershipByUser.get(u.id) ?? null;
    return {
      id: u.id,
      email: u.email ?? "(no email)",
      createdAt: u.created_at,
      lastSignInAt: u.last_sign_in_at ?? null,
      hugoLinked: Boolean(
        u.identities?.some((identity) => identity.provider === "custom:hugo"),
      ),
      membership,
      isSelf: u.id === user.id,
    };
  });

  return (
    <Page>
      <PageHeader
        breadcrumb={[{ label: "Admin" }, { label: "Team" }]}
        title="Team"
        description="View the Sandra team and manage app roles. Hugo owns accounts and Sandra access."
      />

      {authError || membershipError ? (
        <div className="text-destructive text-sm">
          Failed to load complete access state: {authError ?? membershipError}
        </div>
      ) : null}

      <InvitePanel hugoUrl={parseHugoUrl(process.env.NEXT_PUBLIC_HUGO_URL)} />

      <div className="border-border rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Access</TableHead>
              <TableHead>Hugo linked</TableHead>
              <TableHead>Last sign-in</TableHead>
              <TableHead>Joined</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="text-muted-foreground py-8 text-center"
                >
                  No users yet.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((r) => <UserRowView key={r.id} row={r} />)
            )}
          </TableBody>
        </Table>
      </div>
    </Page>
  );
}

function UserRowView({ row }: { row: UserRow }) {
  return (
    <TableRow>
      <TableCell className="font-medium">
        {row.email}
        {row.isSelf ? (
          <span className="text-muted-foreground ml-2 text-xs">(you)</span>
        ) : null}
      </TableCell>
      <TableCell>
        <MembershipRoleControl
          userId={row.id}
          email={row.email}
          membership={row.membership}
        />
      </TableCell>
      <TableCell>
        <MembershipAccessBadge membership={row.membership} />
      </TableCell>
      <TableCell>
        {row.hugoLinked ? (
          <Badge variant="secondary">yes</Badge>
        ) : (
          <Badge variant="outline">not yet</Badge>
        )}
      </TableCell>
      <TableCell className="text-muted-foreground text-sm">
        {row.lastSignInAt
          ? formatDistanceToNow(new Date(row.lastSignInAt), {
              addSuffix: true,
            })
          : "never"}
      </TableCell>
      <TableCell className="text-muted-foreground text-sm">
        {formatDistanceToNow(new Date(row.createdAt), { addSuffix: true })}
      </TableCell>
    </TableRow>
  );
}
