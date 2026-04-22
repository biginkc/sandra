import { formatDistanceToNow } from "date-fns/formatDistanceToNow";
import { notFound } from "next/navigation";

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
  RemoveUserButton,
  type UserRow,
} from "./invite-panel";

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
  const { data, error } = await admin.auth.admin.listUsers({ perPage: 200 });

  const rows: UserRow[] = (data?.users ?? []).map((u) => ({
    id: u.id,
    email: u.email ?? "(no email)",
    createdAt: u.created_at,
    lastSignInAt: u.last_sign_in_at ?? null,
    confirmed: !!u.email_confirmed_at,
    isAdmin: isAdminEmail(u.email),
    isSelf: u.id === user.id,
  }));

  return (
    <div className="flex flex-col gap-4 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Team</h1>
        <p className="text-muted-foreground text-sm">
          Invite a teammate to Sandra CRM. They get a one-time sign-in link
          by email, pick a password, and land in the app. Only emails on the
          bmhgroupkc.com domain are permitted.
        </p>
      </div>

      {error ? (
        <div className="text-destructive text-sm">
          Failed to load users: {error.message}
        </div>
      ) : null}

      <InvitePanel />

      <div className="border-border rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Confirmed</TableHead>
              <TableHead>Last sign-in</TableHead>
              <TableHead>Joined</TableHead>
              <TableHead className="text-right">Actions</TableHead>
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
    </div>
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
        {row.isAdmin ? (
          <Badge>admin</Badge>
        ) : (
          <Badge variant="outline">member</Badge>
        )}
      </TableCell>
      <TableCell>
        {row.confirmed ? (
          <Badge variant="secondary">yes</Badge>
        ) : (
          <Badge variant="outline">pending</Badge>
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
      <TableCell className="text-right">
        {row.isSelf || row.isAdmin ? null : <RemoveUserButton id={row.id} />}
      </TableCell>
    </TableRow>
  );
}

