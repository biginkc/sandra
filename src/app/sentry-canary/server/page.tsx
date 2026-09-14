import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { CANARY_COOKIE, validCanaryCookie } from "@/lib/errors/preview-canary-access";

export default async function ServerRenderCanary() {
  const secret = process.env.SENTRY_CANARY_SECRET;
  const cookieStore = await cookies();
  if (process.env.VERCEL_ENV !== "preview" || !secret
    || !validCanaryCookie(cookieStore.get(CANARY_COOKIE)?.value, secret)) notFound();
  throw new Error("Controlled Sentry canary server render failure");
}
