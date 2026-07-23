import type { NextResponse } from "next/server";

export const AUTH_NO_CACHE_HEADERS = {
  "Cache-Control": "private, no-cache, no-store, must-revalidate, max-age=0",
  Expires: "0",
  Pragma: "no-cache",
} as const;

export function applyAuthNoCache(response: NextResponse): NextResponse {
  for (const [name, value] of Object.entries(AUTH_NO_CACHE_HEADERS)) {
    response.headers.set(name, value);
  }
  return response;
}
