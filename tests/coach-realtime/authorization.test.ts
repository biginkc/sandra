import { createClient, REALTIME_SUBSCRIBE_STATES, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

/**
 * Two PERMANENT, narrowly-scoped test users (seeded once, out-of-band, on
 * the TEST project only — never production) replace the earlier design's
 * ephemeral per-run users created/deleted via the service-role admin API.
 * Neither this test nor the CI workflow that runs it ever holds a
 * service-role key, a DB password, or a Supabase account token — only
 * these two users' own login credentials and the anon key, the exact same
 * shape any real Sandra user authenticates with. A compromised runtime
 * gains nothing beyond what these two accounts can already do: seed/
 * delete their OWN row in coach_call_index, via the coach_ci_seed_
 * ownership / coach_ci_delete_own_ownership RPCs, which check auth.uid()
 * against exactly these two ids server-side — not even a real Sandra user
 * can call them successfully.
 */
async function signIn(email: string, password: string, client: SupabaseClient): Promise<string> {
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  expect(error).toBeNull();
  expect(data.session?.access_token).toBeTruthy();
  return data.session!.access_token;
}

const ownerClient = createClient(
  requiredEnv("TEST_SUPABASE_URL"),
  requiredEnv("TEST_SUPABASE_ANON_KEY"),
  { auth: { persistSession: false, autoRefreshToken: false } },
);
const foreignClient = createClient(
  requiredEnv("TEST_SUPABASE_URL"),
  requiredEnv("TEST_SUPABASE_ANON_KEY"),
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const ownedCallId = requiredEnv("COACH_CANARY_OWNED_CALL_ID");
const foreignCallId = requiredEnv("COACH_CANARY_FOREIGN_CALL_ID");

function subscribe(topic: string, timeoutMs = 15_000): Promise<{
  channel: RealtimeChannel;
  status: REALTIME_SUBSCRIBE_STATES;
  error?: Error;
}> {
  return new Promise((resolve, reject) => {
    const channel = ownerClient.channel(topic, { config: { private: true } });
    const timer = setTimeout(() => reject(new Error(`No terminal subscribe status for ${topic}`)), timeoutMs);
    channel.subscribe((status, error) => {
      if (
        status === REALTIME_SUBSCRIBE_STATES.SUBSCRIBED ||
        status === REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR ||
        status === REALTIME_SUBSCRIBE_STATES.TIMED_OUT ||
        status === REALTIME_SUBSCRIBE_STATES.CLOSED
      ) {
        clearTimeout(timer);
        resolve({ channel, status, error });
      }
    });
  });
}

beforeAll(async () => {
  // Each user seeds their OWN ownership row via the RPC — the row's
  // operator_user_id is auth.uid() inside that SECURITY DEFINER function,
  // not a client-supplied value, so neither client can seed a row it
  // doesn't itself own even if it wanted to.
  const ownerToken = await signIn(requiredEnv("COACH_CI_OWNER_EMAIL"), requiredEnv("COACH_CI_OWNER_PASSWORD"), ownerClient);
  ownerClient.realtime.setAuth(ownerToken);
  const { error: seedOwnedError } = await ownerClient.rpc("coach_ci_seed_ownership", { p_call_id: ownedCallId });
  expect(seedOwnedError).toBeNull();

  await signIn(requiredEnv("COACH_CI_FOREIGN_EMAIL"), requiredEnv("COACH_CI_FOREIGN_PASSWORD"), foreignClient);
  const { error: seedForeignError } = await foreignClient.rpc("coach_ci_seed_ownership", { p_call_id: foreignCallId });
  expect(seedForeignError).toBeNull();
});

afterAll(async () => {
  // Each client deletes only its OWN row (same auth.uid() enforcement as
  // seeding) — this is a redundant defense-in-depth layer alongside the
  // CI workflow's own `if: always()` cleanup step, in case this process
  // is killed hard enough that afterAll itself never runs.
  await ownerClient.rpc("coach_ci_delete_own_ownership", { p_call_id: ownedCallId });
  await foreignClient.rpc("coach_ci_delete_own_ownership", { p_call_id: foreignCallId });
  await ownerClient.removeAllChannels();
  await ownerClient.auth.signOut();
  await foreignClient.auth.signOut();
});

describe("protected coach Realtime authorization canary", () => {
  it("proves the same authenticated socket can join its owned call and is explicitly denied the foreign call", async () => {
    // Keep the positive-control channel open. The denial therefore happens
    // on the exact same authenticated Realtime socket, ruling out generic
    // network/auth/channel failure as the source of CHANNEL_ERROR.
    const owned = await subscribe(`coach:${ownedCallId}`);
    expect(owned.status).toBe(REALTIME_SUBSCRIBE_STATES.SUBSCRIBED);

    const foreign = await subscribe(`coach:${foreignCallId}`);
    expect(foreign.status).toBe(REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR);
    expect(foreign.error).toBeInstanceOf(Error);
    expect(foreign.error?.message.length).toBeGreaterThan(0);
  });
});
