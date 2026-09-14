import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { start } from "workflow/api";
import { sentryPreviewCanaryWorkflow } from "@/workflows/sentry-preview-canary";
import { CANARY_COOKIE, canaryCookieValue } from "@/lib/errors/preview-canary-access";
import { ensureSentryServerClient } from "@/lib/errors/sentry-server-client";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const secret = process.env.SENTRY_CANARY_SECRET;
  if (process.env.VERCEL_ENV !== "preview" || !secret
    || request.headers.get("x-sandra-canary-secret") !== secret) {
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
  if (mode !== "server") return NextResponse.json({ error: "Invalid canary mode" }, { status: 400 });
  if (!ensureSentryServerClient()) return NextResponse.json({ error: "Sentry client inactive" }, { status: 503 });
  let eventId = "";
  Sentry.withScope((scope) => {
    scope.setTag("surface", "preview_canary");
    scope.setTag("operation", "server_capture");
    scope.setTag("kind", "controlled");
    eventId = Sentry.captureException(new Error("Controlled Sentry preview server failure"));
  });
  const delivered = await Sentry.flush(2_000);
  return NextResponse.json({ eventId, delivered });
}
