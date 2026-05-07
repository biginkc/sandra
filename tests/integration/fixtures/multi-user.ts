import { randomUUID } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

export const BMH_ORG_ID = "00000000-0000-0000-0000-000000000bbb";
export const TEST_ORG_B_ID = "00000000-0000-0000-0000-000000000ccc";

type Role = "owner" | "member";

type MembershipWriter = {
  from(table: "memberships"): {
    insert(values: {
      user_id: string;
      org_id: string;
      role: Role;
    }): Promise<{ error: { message: string } | null }>;
  };
};

function testUrl(): string {
  const url = process.env.TEST_SUPABASE_URL;
  if (!url) throw new Error("Missing TEST_SUPABASE_URL.");
  return url;
}

function anonKey(): string {
  const key = process.env.TEST_SUPABASE_ANON_KEY;
  if (!key) throw new Error("Missing TEST_SUPABASE_ANON_KEY.");
  return key;
}

export async function seedTwoOrgs(
  serviceClient: SupabaseClient<Database>,
): Promise<void> {
  const { error } = await serviceClient.from("organizations").upsert([
    { id: BMH_ORG_ID, name: "BMH Group" },
    { id: TEST_ORG_B_ID, name: "Test Org B" },
  ]);
  if (error) throw new Error(`seedTwoOrgs failed: ${error.message}`);
}

export async function createOrgUser(
  serviceClient: SupabaseClient<Database>,
  {
    orgId,
    email,
    role,
  }: {
    orgId: string;
    email: string;
    role: Role;
  },
): Promise<{ userId: string; jwt: string }> {
  const password = randomUUID();
  const { data: created, error: createError } =
    await serviceClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });

  if (createError || !created.user) {
    throw new Error(
      `createOrgUser auth create failed: ${createError?.message ?? "no user"}`,
    );
  }

  const { error: membershipError } = await (
    serviceClient as unknown as MembershipWriter
  )
    .from("memberships")
    .insert({ user_id: created.user.id, org_id: orgId, role });
  if (membershipError) {
    await serviceClient.auth.admin.deleteUser(created.user.id);
    throw new Error(
      `createOrgUser membership insert failed: ${membershipError.message}`,
    );
  }

  const anon = createClient<Database>(testUrl(), anonKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: session, error: signInError } =
    await anon.auth.signInWithPassword({ email, password });
  if (signInError || !session.session?.access_token) {
    await serviceClient.auth.admin.deleteUser(created.user.id);
    throw new Error(
      `createOrgUser sign-in failed: ${signInError?.message ?? "no token"}`,
    );
  }

  return { userId: created.user.id, jwt: session.session.access_token };
}

export function clientForUser(jwt: string): SupabaseClient<Database> {
  return createClient<Database>(testUrl(), anonKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: { Authorization: `Bearer ${jwt}` },
    },
  });
}
