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
 * shape any real Sandra user authenticates with.
 *
 * Round-9 hardening: coach_ci_seed_ownership / coach_ci_delete_own_
 * ownership take NO argument. The row each account owns is
 * 'coach-ci-' + auth.uid(), derived entirely server-side — there is no
 * parameter through which either account could name, claim, or overwrite
 * a row it doesn't already own, and each account can only ever have
 * exactly one row (the same derived key every time). Client code computes
 * the SAME 'coach-ci-' prefix only to know which Realtime topic to
 * subscribe to — it never tells the server what the row's key is.
 */
async function signIn(email: string, password: string, client: SupabaseClient): Promise<string> {
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  expect(error).toBeNull();
  expect(data.session?.access_token).toBeTruthy();
  expect(data.user?.id).toBeTruthy();
  client.realtime.setAuth(data.session!.access_token);
  return data.user!.id;
}

function callIdFor(userId: string): string {
  return `coach-ci-${userId}`;
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

let ownedCallId = "";
let foreignCallId = "";

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
  const ownerId = await signIn(requiredEnv("COACH_CI_OWNER_EMAIL"), requiredEnv("COACH_CI_OWNER_PASSWORD"), ownerClient);
  ownedCallId = callIdFor(ownerId);
  const { error: seedOwnedError } = await ownerClient.rpc("coach_ci_seed_ownership");
  expect(seedOwnedError).toBeNull();

  const foreignId = await signIn(requiredEnv("COACH_CI_FOREIGN_EMAIL"), requiredEnv("COACH_CI_FOREIGN_PASSWORD"), foreignClient);
  foreignCallId = callIdFor(foreignId);
  const { error: seedForeignError } = await foreignClient.rpc("coach_ci_seed_ownership");
  expect(seedForeignError).toBeNull();
});

afterAll(async () => {
  // Redundant with the CI workflow's own `if: always()` cleanup step, in
  // case this process is killed hard enough that afterAll never runs.
  await ownerClient.rpc("coach_ci_delete_own_ownership");
  await foreignClient.rpc("coach_ci_delete_own_ownership");
  await ownerClient.removeAllChannels();
  await ownerClient.auth.signOut();
  await foreignClient.auth.signOut();
});

describe("protected coach Realtime authorization canary", () => {
  it("rejects a caller-supplied identifier outright — the RPC takes no argument, so a row can never be named by anyone but its own account", async () => {
    // A raw fetch, not the typed client: proves the server itself refuses
    // any call carrying a parameter, not merely that our own client
    // happens not to send one.
    const response = await fetch(`${requiredEnv("TEST_SUPABASE_URL")}/rest/v1/rpc/coach_ci_seed_ownership`, {
      method: "POST",
      headers: {
        apikey: requiredEnv("TEST_SUPABASE_ANON_KEY"),
        Authorization: `Bearer ${requiredEnv("TEST_SUPABASE_ANON_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_call_id: "steal-attempt" }),
    });
    expect(response.ok).toBe(false);
    const body = (await response.json()) as { message?: string };
    expect(body.message ?? "").toMatch(/could not find the function/i);
  });

  it("proves the same authenticated socket can join its own seeded call and is explicitly denied the foreign account's — the foreign row can't be read, let alone stolen", async () => {
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
