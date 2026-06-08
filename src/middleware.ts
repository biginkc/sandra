import { updateSession } from "@/lib/supabase/middleware";
import { type NextRequest } from "next/server";

export async function middleware(request: NextRequest) {
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
