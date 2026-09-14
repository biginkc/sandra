import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import CanaryClient from "./canary-client";
import { CANARY_COOKIE, validCanaryCookie } from "@/lib/errors/preview-canary-access";

export default async function SentryCanaryPage() {
  const secret = process.env.SENTRY_CANARY_SECRET;
  const cookieStore = await cookies();
  if (!(["preview", "production"].includes(process.env.VERCEL_ENV ?? "")) || !secret
    || !validCanaryCookie(cookieStore.get(CANARY_COOKIE)?.value, secret)) notFound();
  return <CanaryClient />;
}
