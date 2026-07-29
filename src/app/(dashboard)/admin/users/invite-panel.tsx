"use client";

import { ExternalLink } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { callAction } from "@/lib/errors/call-action";

import { updateMembershipRole, type MembershipRole } from "./actions";
import {
  describeSandraAccess,
  type SandraMembershipInventory,
} from "./membership-inventory";

export type UserRow = {
  id: string;
  email: string;
  createdAt: string;
  lastSignInAt: string | null;
  hugoLinked: boolean;
  membership: SandraMembershipInventory | null;
  isSelf: boolean;
};

export function InvitePanel({ hugoUrl }: { hugoUrl: string | null }) {
  return (
    <div className="border-border flex flex-wrap items-center justify-between gap-4 rounded-md border p-4">
      <div className="space-y-1">
        <p className="text-sm font-medium">Add or manage access in Hugo</p>
        <p className="text-muted-foreground text-sm">
          Hugo creates accounts and controls Sandra access. Return here to set
          an existing team member&apos;s Sandra role.
        </p>
      </div>
      {hugoUrl ? (
        <a
          href={hugoUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={buttonVariants({ size: "sm" })}
        >
          Open Hugo
          <ExternalLink aria-hidden />
        </a>
      ) : (
        <p role="alert" className="text-destructive text-sm">
          Hugo is not configured. Set NEXT_PUBLIC_HUGO_URL.
        </p>
      )}
    </div>
  );
}

export function RoleEditor({
  userId,
  email,
  role,
}: {
  userId: string;
  email: string;
  role: MembershipRole;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const changeRole = (nextRole: MembershipRole) => {
    if (nextRole === role) return;

    startTransition(async () => {
      const result = await callAction(updateMembershipRole(userId, nextRole), {
        successMessage: `${email} is now a Sandra ${nextRole}.`,
        fallbackMessage: "Role update failed",
      });
      if (result.ok) router.refresh();
    });
  };

  return (
    <select
      aria-label={`Sandra role for ${email}`}
      value={role}
      disabled={pending}
      onChange={(event) => changeRole(event.target.value as MembershipRole)}
      className="border-input bg-background h-8 rounded-md border px-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
    >
      <option value="owner">owner</option>
      <option value="member">member</option>
    </select>
  );
}

export function MembershipRoleControl({
  userId,
  email,
  membership,
}: {
  userId: string;
  email: string;
  membership: SandraMembershipInventory | null;
}) {
  if (!membership) {
    return <span className="text-muted-foreground text-sm">—</span>;
  }
  if (!membership.hasActiveAccess) {
    return (
      <span className="text-muted-foreground text-sm">{membership.role}</span>
    );
  }
  return <RoleEditor userId={userId} email={email} role={membership.role} />;
}

export function MembershipAccessBadge({
  membership,
}: {
  membership: SandraMembershipInventory | null;
}) {
  if (!membership) return <Badge variant="outline">not granted</Badge>;
  return (
    <Badge variant={membership.hasActiveAccess ? "secondary" : "destructive"}>
      {describeSandraAccess(membership)}
    </Badge>
  );
}
