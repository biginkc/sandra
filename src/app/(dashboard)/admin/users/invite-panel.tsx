"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { callAction } from "@/lib/errors/call-action";

import { grantUserAccess, removeUser } from "./actions";

export type UserRow = {
  id: string;
  email: string;
  createdAt: string;
  lastSignInAt: string | null;
  confirmed: boolean;
  isAdmin: boolean;
  isSelf: boolean;
};

export function InvitePanel() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [pending, startTransition] = useTransition();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) return;
    startTransition(async () => {
      const result = await callAction(grantUserAccess(trimmed), {
        fallbackMessage: "Access grant failed",
      });
      if (result.ok) {
        toast.success(
          result.data.created
            ? `Sandra access granted to ${result.data.grantedEmail}`
            : `Sandra access updated for ${result.data.grantedEmail}`,
        );
        setEmail("");
        router.refresh();
      }
    });
  };

  return (
    <form
      onSubmit={submit}
      className="border-border flex flex-wrap items-end gap-3 rounded-md border p-3"
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="invite-email" className="text-xs">
          Grant Sandra access (bmhgroupkc.com only)
        </Label>
        <Input
          id="invite-email"
          type="email"
          placeholder="name@bmhgroupkc.com"
          className="w-72"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={pending}
          required
        />
      </div>
      <Button type="submit" disabled={pending || !email.trim()}>
        {pending ? "Granting…" : "Grant access"}
      </Button>
    </form>
  );
}

export function RemoveUserButton({ id }: { id: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const click = () => {
    if (
      !window.confirm(
        "Remove this user? They lose access immediately but their contacts + property rows stay.",
      )
    ) {
      return;
    }
    startTransition(async () => {
      const result = await callAction(removeUser(id), {
        successMessage: "User removed",
        fallbackMessage: "Remove failed",
      });
      if (result.ok) router.refresh();
    });
  };
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={click}
      disabled={pending}
      aria-label="Remove user"
    >
      {pending ? "Removing…" : "Remove"}
    </Button>
  );
}
