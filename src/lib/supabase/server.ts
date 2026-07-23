import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import type { Database } from "./types";

type CookieMutation = {
  name: string;
  value: string;
  options: Parameters<Awaited<ReturnType<typeof cookies>>["set"]>[2];
};

type CreateClientOptions = {
  onCookieMutation?: (cookie: CookieMutation) => void;
};

export async function createClient(options: CreateClientOptions = {}) {
  const cookieStore = await cookies();

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options: cookieOptions }) =>
            options.onCookieMutation?.({
              name,
              value,
              options: cookieOptions,
            }),
          );
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Called from a Server Component — middleware handles the refresh.
          }
        },
      },
    },
  );
}
