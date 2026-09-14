import { NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import * as Sentry from "@sentry/nextjs";
import { start } from "workflow/api";
import { sentryPreviewCanaryWorkflow } from "@/workflows/sentry-preview-canary";
import { CANARY_COOKIE, canaryCookieValue } from "@/lib/errors/preview-canary-access";
import { ensureSentryServerClient } from "@/lib/errors/sentry-server-client";
import { runMonitoredCron } from "@/lib/errors/cron-monitor";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const secret = process.env.SENTRY_CANARY_SECRET;
  const supplied = request.headers.get("x-sandra-canary-secret");
  if (!(["preview", "production"].includes(process.env.VERCEL_ENV ?? "")) || !secret
    || !supplied || supplied.length > 256
    || !timingSafeEqual(createHash("sha256").update(supplied).digest(),
      createHash("sha256").update(secret).digest())) {
    return new Response(null, { status: 404 });
  }
  const input: unknown = await request.json().catch(() => null);
  const mode = input && typeof input === "object" && "mode" in input ? input.mode : null;
  if (mode === "session") {
    const response = NextResponse.json({ ready: true });
    response.cookies.set(CANARY_COOKIE, canaryCookieValue(secret), {
      httpOnly: true, secure: true, sameSite: "strict", path: "/sentry-canary", maxAge: 300,
    });
    return response;
  }
  if (mode === "workflow") {
    const run = await start(sentryPreviewCanaryWorkflow, []);
    return NextResponse.json({ runId: run.runId });
  }
  if (mode === "unhandled" && process.env.VERCEL_ENV === "preview") {
    throw new Error("Controlled Sentry canary unhandled request failure");
  }
  if (mode === "cron_ok" || mode === "cron_error") {
    if (process.env.VERCEL_ENV !== "preview") return new Response(null, { status: 404 });
    return runMonitoredCron(
      "sandra-sentry-preview-canary",
      { schedule: { type: "crontab", value: "* * * * *" }, checkinMargin: 1, maxRuntime: 1 },
      async () => NextResponse.json({ monitored: true, expectedFailure: mode === "cron_error" }),
      async () => mode === "cron_error",
    );
  }
  if (mode !== "server") return NextResponse.json({ error: "Invalid canary mode" }, { status: 400 });
  if (!ensureSentryServerClient()) return NextResponse.json({ error: "Sentry client inactive" }, { status: 503 });
  let eventId = "";
  Sentry.withScope((scope) => {
    scope.setTag("surface", "preview_canary");
    scope.setTag("operation", "server_capture");
    scope.setTag("kind", "controlled");
    eventId = Sentry.captureException(new Error("Controlled Sentry canary server failure"));
  });
  const delivered = await Sentry.flush(2_000);
  return NextResponse.json({ eventId, delivered });
}
