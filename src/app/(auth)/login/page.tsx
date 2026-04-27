"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { requestPasswordReset, signIn } from "./actions";

/**
 * Next 16 requires `useSearchParams` to be inside a Suspense boundary
 * so static prerender can bail out of the subtree instead of failing
 * the build. The outer page is server-rendered for layout; the inner
 * LoginForm reads the query string.
 */
export default function LoginPage() {
  return (
    <div className="flex min-h-screen flex-1 items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>Sandra CRM · BMH Group</CardDescription>
        </CardHeader>
        <CardContent>
          <Suspense fallback={<LoginFormFallback />}>
            <LoginForm />
          </Suspense>
        </CardContent>
      </Card>
    </div>
  );
}

function LoginForm() {
  const [state, formAction, pending] = useActionState(signIn, null);
  const [resetState, resetAction, resetPending] = useActionState(
    requestPasswordReset,
    null,
  );
  const [showReset, setShowReset] = useState(false);
  const actionError = state && !state.ok ? state.error.message : null;
  const resetError = resetState && !resetState.ok ? resetState.error.message : null;
  const resetSuccess = resetState && resetState.ok;
  const searchParams = useSearchParams();
  const next = searchParams.get("next") ?? "";
  const urlError = searchParams.get("error");

  // Priority: action error from this submit attempt beats a prior URL
  // error (e.g. domain rejection from a previous session).
  const errorMessage =
    actionError ??
    (urlError === "domain"
      ? "This CRM is restricted to bmhgroupkc.com accounts. Sign in with a bmhgroupkc.com email or ask an admin for an invite."
      : urlError === "invite_failed"
        ? "Invite link couldn't be verified. Ask an admin to resend it."
        : null);

  if (showReset) {
    return (
      <form action={resetAction} className="flex flex-col gap-4">
        <p className="text-muted-foreground text-sm">
          Enter your email and we&apos;ll send a password-reset link.
        </p>
        <div className="flex flex-col gap-2">
          <Label htmlFor="reset-email">Email</Label>
          <Input
            id="reset-email"
            name="email"
            type="email"
            autoComplete="email"
            required
          />
        </div>
        {resetSuccess ? (
          <div className="border-border bg-muted text-foreground rounded-md border px-3 py-2 text-sm">
            If that email is on file, a reset link is on its way. Check your
            inbox (and spam).
          </div>
        ) : null}
        {resetError ? (
          <div className="border-destructive/30 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-sm">
            {resetError}
          </div>
        ) : null}
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => setShowReset(false)}
            disabled={resetPending}
            className="flex-1"
          >
            Back
          </Button>
          <Button type="submit" disabled={resetPending} className="flex-1">
            {resetPending ? "Sending…" : "Send link"}
          </Button>
        </div>
      </form>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="next" value={next} />
      <div className="flex flex-col gap-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
      </div>
      {errorMessage ? (
        <div className="border-destructive/30 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-sm">
          {errorMessage}
        </div>
      ) : null}
      <Button type="submit" disabled={pending}>
        {pending ? "Signing in…" : "Sign in"}
      </Button>
      <button
        type="button"
        onClick={() => setShowReset(true)}
        className="text-muted-foreground hover:text-foreground -mt-1 self-end text-xs underline-offset-4 hover:underline"
      >
        Forgot password?
      </button>
    </form>
  );
}

function LoginFormFallback() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="email">Email</Label>
        <Input id="email" type="email" disabled />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="password">Password</Label>
        <Input id="password" type="password" disabled />
      </div>
      <Button disabled>Loading…</Button>
    </div>
  );
}
