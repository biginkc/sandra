import { NextResponse, type NextRequest } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { setHugoSessionProof } from "@/lib/auth/hugo-session-proof";

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  await supabase.auth.signOut({ scope: "local" });
  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  const response = NextResponse.redirect(url, { status: 303 });
  setHugoSessionProof(request, response, "");
  return response;
}
