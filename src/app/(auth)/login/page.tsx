"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { requestPasswordReset, signIn, signInWithBmhId } from "./actions";
import { LoginBackground } from "./login-background";

// Flipped on per-app (Vercel env var) once the BMH ID pilot gate passes.
const BMH_ID_SSO_ENABLED = process.env.NEXT_PUBLIC_BMH_ID_SSO === "1";

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
        className="relative w-full max-w-[430px] rounded-[26px] border-[1.5px] px-[34px] pt-[34px] pb-[26px]"
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
  const [state, formAction, pending] = useActionState(signIn, null);
  const [resetState, resetAction, resetPending] = useActionState(
    requestPasswordReset,
    null,
  );
  const [showReset, setShowReset] = useState(false);
  const [showPw, setShowPw] = useState(false);

  const actionError = state && !state.ok ? state.error.message : null;
  const resetError = resetState && !resetState.ok ? resetState.error.message : null;
  const resetSuccess = resetState && resetState.ok;
  const searchParams = useSearchParams();
  const next = searchParams.get("next") ?? "";
  const urlError = searchParams.get("error");

  const errorMessage =
    actionError ??
    (urlError === "domain"
      ? "This CRM is restricted to bmhgroupkc.com accounts. Sign in with a bmhgroupkc.com email or ask an admin for an invite."
      : urlError === "invite_failed"
        ? "Invite link couldn't be verified. Ask an admin to resend it."
        : urlError === "sso"
          ? "BMH ID sign-in couldn't start. Try again, or sign in with your password."
          : null);

  if (showReset) {
    return (
      <form action={resetAction} className="mt-6 flex flex-col gap-4">
        <p className="text-[14px] text-[#7e889c]">
          Enter your email and we&apos;ll send a password-reset link.
        </p>
        <div className="flex flex-col gap-2">
          <Input
            id="reset-email"
            aria-label="Email"
            name="email"
            type="email"
            autoComplete="email"
            placeholder="Email"
            required
            className={INPUT_CLASS}
          />
        </div>
        {resetSuccess ? (
          <p className="rounded-[10px] border border-white/10 bg-white/[0.05] px-3 py-2 text-[13px] text-[#cdd6e6]">
            If that email is on file, a reset link is on its way. Check your
            inbox (and spam).
          </p>
        ) : null}
        {resetError ? (
          <p className="rounded-[10px] border border-[rgba(255,90,90,0.25)] bg-[rgba(255,80,80,0.08)] px-3 py-2 text-[13px] text-[#ff9a9a]">
            {resetError}
          </p>
        ) : null}
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => setShowReset(false)}
            disabled={resetPending}
            className="h-12 flex-1"
          >
            Back
          </Button>
          <Button
            type="submit"
            disabled={resetPending}
            className="h-12 flex-1 text-white"
            style={{
              background:
                "linear-gradient(180deg, rgba(28,46,82,0.65), rgba(14,24,46,0.7))",
              border: "1.5px solid rgba(120,176,255,0.7)",
              boxShadow: BUTTON_GLOW,
            }}
          >
            {resetPending ? "Sending…" : "Send link"}
          </Button>
        </div>
      </form>
    );
  }

  return (
    <>
      {BMH_ID_SSO_ENABLED ? (
        <div className="mt-6 flex flex-col gap-4">
          <form action={signInWithBmhId}>
            <input type="hidden" name="next" value={next} />
            <Button
              type="submit"
              className="h-12 w-full text-[15px] text-white"
              style={{
                background:
                  "linear-gradient(180deg, rgba(28,46,82,0.65), rgba(14,24,46,0.7))",
                border: "1.5px solid rgba(120,176,255,0.7)",
                boxShadow: BUTTON_GLOW,
              }}
            >
              Continue with BMH ID
            </Button>
          </form>
          <div className="flex items-center gap-3" aria-hidden="true">
            <span className="h-px flex-1 bg-white/10" />
            <span className="text-[12.5px] text-[#5b6479]">or</span>
            <span className="h-px flex-1 bg-white/10" />
          </div>
        </div>
      ) : null}

      <form
        action={formAction}
        className={`${BMH_ID_SSO_ENABLED ? "mt-4" : "mt-6"} flex flex-col gap-4`}
      >
        <input type="hidden" name="next" value={next} />

        <div className="flex flex-col gap-2">
          <Input
            id="email"
            aria-label="Email"
            name="email"
            type="email"
            autoComplete="email"
            placeholder="Email"
            required
            className={INPUT_CLASS}
          />
        </div>

        <div className="flex flex-col gap-2">
          <div className="relative">
            <Input
              id="password"
              aria-label="Password"
              name="password"
              type={showPw ? "text" : "password"}
              autoComplete="current-password"
              placeholder="Password"
              required
              className={`${INPUT_CLASS} pr-[62px]`}
            />
            <button
              type="button"
              onClick={() => setShowPw((v) => !v)}
              aria-label={showPw ? "Hide characters" : "Show characters"}
              aria-pressed={showPw}
              className="absolute top-1/2 right-2 -translate-y-1/2 rounded-lg px-2.5 py-2 text-[12.5px] font-semibold text-[#7e889c] transition-colors hover:bg-white/5 hover:text-[#bcd0f0]"
            >
              {showPw ? "Hide" : "Show"}
            </button>
          </div>
        </div>

        {errorMessage ? (
          <p className="rounded-[10px] border border-[rgba(255,90,90,0.25)] bg-[rgba(255,80,80,0.08)] px-3 py-2 text-[13px] text-[#ff9a9a]">
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

        <button
          type="button"
          onClick={() => setShowReset(true)}
          className="-mt-1 self-end text-[13.5px] text-[#7e889c] underline-offset-4 transition-colors hover:text-[#bcd0f0] hover:underline"
        >
          Forgot password?
        </button>
      </form>
    </>
  );
}

function LoginFormFallback() {
  return (
    <div className="mt-6 flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Input aria-label="Email" type="email" disabled className={INPUT_CLASS} />
      </div>
      <div className="flex flex-col gap-2">
        <Input
          aria-label="Password"
          type="password"
          disabled
          className={INPUT_CLASS}
        />
      </div>
      <Button disabled className="mt-2 h-14 w-full text-base text-white">
        Loading…
      </Button>
    </div>
  );
}
