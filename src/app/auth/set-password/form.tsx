"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { setPassword } from "./actions";

type State = { ok: true } | { ok: false; message: string } | null;

export function SetPasswordForm({ email }: { email: string }) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<State, FormData>(
    async (_previous, formData) => {
      const password = String(formData.get("password") ?? "");
      const confirm = String(formData.get("confirm") ?? "");
      if (password.length < 8) {
        return { ok: false, message: "Password must be at least 8 characters." };
      }
      if (password !== confirm) {
        return { ok: false, message: "Passwords don't match." };
      }
      const result = await setPassword(password);
      return result.ok
        ? { ok: true }
        : { ok: false, message: result.error.message };
    },
    null,
  );

  useEffect(() => {
    if (state?.ok) {
      toast.success("Password set — you're in");
      router.push("/leads");
    }
  }, [router, state]);

  return (
    <form action={formAction} className="flex flex-col gap-4" aria-busy={pending}>
      <div className="flex flex-col gap-2">
        <Label htmlFor="email">Email</Label>
        <Input id="email" value={email} readOnly disabled />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="password">New password</Label>
        <Input id="password" name="password" type="password" autoComplete="new-password" minLength={8} required />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="confirm">Confirm password</Label>
        <Input id="confirm" name="confirm" type="password" autoComplete="new-password" minLength={8} required />
      </div>
      {state && !state.ok ? (
        <div role="alert" className="border-destructive/30 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-sm">
          {state.message}
        </div>
      ) : null}
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Set password"}
      </Button>
    </form>
  );
}
