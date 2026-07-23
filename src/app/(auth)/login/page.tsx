"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { signIn, signInWithHugo } from "./actions";
import { LoginBackground } from "./login-background";

const CARD_GLOW =
  "0 0 0 1px rgba(60,130,255,0.16), 0 0 22px rgba(46,128,255,0.42), 0 0 60px rgba(46,128,255,0.22), 0 0 120px rgba(46,128,255,0.12), inset 0 1px 0 rgba(160,200,255,0.18), inset 0 0 26px rgba(46,128,255,0.06)";
const BUTTON_GLOW =
  "0 0 0 1px rgba(60,130,255,0.18), 0 0 18px rgba(46,128,255,0.45), 0 0 44px rgba(46,128,255,0.22), inset 0 1px 0 rgba(160,200,255,0.25), inset 0 0 18px rgba(46,128,255,0.1)";
const INPUT_CLASS =
  "h-12 rounded-xl border-[1.5px] border-white/10 bg-white/[0.025] px-4 text-[15px] text-[#f3f6fb] placeholder:text-[#5b6479] transition-colors focus-visible:border-[#78b0ff] focus-visible:ring-[#2e80ff]/25 hover:border-white/20";

export default function LoginPage() {
  return (
    <div className="relative flex min-h-screen flex-1 flex-col items-center justify-center p-4">
      <LoginBackground />

      <div className="mb-7 flex w-[360px] max-w-[82vw] flex-col items-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/brand/mascot.svg"
          alt=""
          aria-hidden="true"
          className="w-[56%]"
          style={{ filter: "drop-shadow(0 12px 22px rgba(0,0,0,0.5))" }}
        />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/brand/sandra-wordmark.png"
          alt="Sandra"
          className="-mt-1 w-full"
          style={{ filter: "drop-shadow(0 8px 18px rgba(0,0,0,0.45))" }}
        />
      </div>

      <div
        className="relative w-full max-w-[430px] rounded-[26px] border-[1.5px] px-[34px] pt-[34px] pb-[30px]"
        style={{
          background:
            "linear-gradient(180deg, rgba(13,19,33,0.94) 0%, rgba(9,13,24,0.96) 100%)",
          borderColor: "rgba(120,176,255,0.55)",
          boxShadow: CARD_GLOW,
        }}
      >
        <Suspense fallback={<LoginFormFallback />}>
          <LoginForm />
        </Suspense>
      </div>
    </div>
  );
}

function LoginForm() {
  return process.env.NEXT_PUBLIC_HUGO_SSO === "1" ? (
    <HugoLoginForm />
  ) : (
    <PasswordRollbackForm />
  );
}

function HugoLoginForm() {
  const [, formAction, pending] = useActionState(signInWithHugo, undefined);
  const searchParams = useSearchParams();
  const next = searchParams.get("next") ?? "";
  const urlError = searchParams.get("error");
  const errorMessage =
    urlError === "domain"
      ? "This Sandra account is not authorized. Ask an admin to grant access, then use the same email in Hugo."
      : urlError === "access"
        ? "Your Hugo identity is valid, but Sandra access has not been granted. Ask a Sandra admin for access."
      : urlError === "sso_in_progress"
        ? "A Hugo sign-in is already in progress in this browser. Finish that sign-in or wait a few minutes before trying again."
      : urlError === "sso_disabled"
        ? "Hugo sign-in is temporarily unavailable."
        : urlError === "password_disabled"
          ? "Sandra passwords and email sign-in links are disabled. Continue with Hugo."
          : urlError
            ? "Hugo sign-in could not be completed. Please try again."
            : null;

  return (
    <div className="mt-2 flex flex-col gap-5">
      <div>
        <h1 className="text-xl font-semibold text-[#f3f6fb]">Sign in to Sandra</h1>
        <p className="mt-2 text-[14px] leading-6 text-[#7e889c]">
          Use your Hugo identity. Sandra no longer accepts a separate password.
        </p>
      </div>

      {errorMessage ? (
        <p role="alert" aria-live="assertive" className="rounded-[10px] border border-[rgba(255,90,90,0.25)] bg-[rgba(255,80,80,0.08)] px-3 py-2 text-[13px] text-[#ff9a9a]">
          {errorMessage}
        </p>
      ) : null}

      <form action={formAction} aria-busy={pending}>
        <input type="hidden" name="next" value={next} />
        <Button
          type="submit"
          disabled={pending}
          className="h-14 w-full text-base text-white"
          style={{
            background:
              "linear-gradient(180deg, rgba(28,46,82,0.65), rgba(14,24,46,0.7))",
            border: "1.5px solid rgba(120,176,255,0.7)",
            boxShadow: BUTTON_GLOW,
          }}
        >
          {pending ? "Opening Hugo…" : "Sign in with Hugo"}
        </Button>
      </form>
    </div>
  );
}

function PasswordRollbackForm() {
  const [state, formAction, pending] = useActionState(signIn, null);
  const [showPassword, setShowPassword] = useState(false);
  const searchParams = useSearchParams();
  const next = searchParams.get("next") ?? "";
  const errorMessage =
    state && !state.ok
      ? state.error.message
      : searchParams.get("error") === "domain"
        ? "This CRM is restricted to authorized bmhgroupkc.com accounts."
        : null;

  return (
    <form action={formAction} aria-busy={pending} className="mt-6 flex flex-col gap-4">
      <input type="hidden" name="next" value={next} />
      <Input
        aria-label="Email"
        name="email"
        type="email"
        autoComplete="email"
        placeholder="Email"
        required
        className={INPUT_CLASS}
      />
      <div className="relative">
        <Input
          aria-label="Password"
          name="password"
          type={showPassword ? "text" : "password"}
          autoComplete="current-password"
          placeholder="Password"
          required
          className={`${INPUT_CLASS} pr-[62px]`}
        />
        <button
          type="button"
          onClick={() => setShowPassword((shown) => !shown)}
          aria-label={showPassword ? "Hide characters" : "Show characters"}
          aria-pressed={showPassword}
          className="absolute top-1/2 right-2 -translate-y-1/2 rounded-lg px-2.5 py-2 text-[12.5px] font-semibold text-[#7e889c]"
        >
          {showPassword ? "Hide" : "Show"}
        </button>
      </div>
      {errorMessage ? (
        <p role="alert" aria-live="assertive" className="rounded-[10px] border border-[rgba(255,90,90,0.25)] bg-[rgba(255,80,80,0.08)] px-3 py-2 text-[13px] text-[#ff9a9a]">
          {errorMessage}
        </p>
      ) : null}
      <Button
        type="submit"
        disabled={pending}
        className="mt-2 h-14 w-full text-base text-white"
        style={{
          background:
            "linear-gradient(180deg, rgba(28,46,82,0.65), rgba(14,24,46,0.7))",
          border: "1.5px solid rgba(120,176,255,0.7)",
          boxShadow: BUTTON_GLOW,
        }}
      >
        {pending ? "Signing in…" : "Sign in"}
      </Button>
      <p className="text-center text-xs text-[#7e889c]">
        Hugo is not active on this deployment; the existing Sandra login remains available.
      </p>
    </form>
  );
}

function LoginFormFallback() {
  return (
    <div className="mt-2 flex flex-col gap-5">
      <div>
        <h1 className="text-xl font-semibold text-[#f3f6fb]">Sign in to Sandra</h1>
        <p className="mt-2 text-[14px] leading-6 text-[#7e889c]">
          Use your Hugo identity.
        </p>
      </div>
      <Button disabled className="h-14 w-full text-base text-white">
        Loading…
      </Button>
    </div>
  );
}
