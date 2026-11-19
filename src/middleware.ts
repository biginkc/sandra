import { updateSession } from "@/lib/supabase/middleware";
import { type NextRequest } from "next/server";

// Server actions arrive as POSTs to the page path with only a hashed id; log it so per-route action volume is attributable.
const ACTION_ROUTES = /^\/(my-leads|leads\/[^/]+)(\/|$)/;

export async function middleware(request: NextRequest) {
  const actionId = request.method === "POST" ? request.headers.get("next-action") : null;
  if (actionId && process.env.SERVER_ACTION_LOG !== "0" && ACTION_ROUTES.test(request.nextUrl.pathname)) {
    console.info(JSON.stringify({ event: "server_action.dispatch.v1", route: request.nextUrl.pathname, actionId }));
  }
  return await updateSession(request);
}

export const config = {
  matcher: [
    // Excludes Next.js internals, static assets, and Workflow DevKit's
    // internal `.well-known/workflow/*` paths (those are how the runtime
    // resumes paused workflows; intercepting them breaks step replay).
    "/((?!_next/static|_next/image|favicon.ico|\\.well-known/workflow/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|mp4|webm)$).*)",
  ],
};
