import { createClient, REALTIME_SUBSCRIBE_STATES, type RealtimeChannel } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

const client = createClient(
  requiredEnv("TEST_SUPABASE_URL"),
  requiredEnv("TEST_SUPABASE_ANON_KEY"),
  { auth: { persistSession: false, autoRefreshToken: false } },
);

function subscribe(topic: string, timeoutMs = 15_000): Promise<{
  channel: RealtimeChannel;
  status: REALTIME_SUBSCRIBE_STATES;
  error?: Error;
}> {
  return new Promise((resolve, reject) => {
    const channel = client.channel(topic, { config: { private: true } });
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

afterAll(async () => {
  await client.removeAllChannels();
  await client.auth.signOut();
});

describe("protected coach Realtime authorization canary", () => {
  it("proves the same temporary user/socket can join its owned call and is explicitly denied the foreign call", async () => {
    const { data, error: signInError } = await client.auth.signInWithPassword({
      email: requiredEnv("COACH_CANARY_OWNER_EMAIL"),
      password: requiredEnv("COACH_CANARY_OWNER_PASSWORD"),
    });
    expect(signInError).toBeNull();
    expect(data.session?.access_token).toBeTruthy();
    client.realtime.setAuth(data.session!.access_token);

    // Keep the positive-control channel open. The denial therefore happens
    // on the exact same authenticated Realtime socket, ruling out generic
    // network/auth/channel failure as the source of CHANNEL_ERROR.
    const owned = await subscribe(`coach:${requiredEnv("COACH_CANARY_OWNED_CALL_ID")}`);
    expect(owned.status).toBe(REALTIME_SUBSCRIBE_STATES.SUBSCRIBED);

    const foreign = await subscribe(`coach:${requiredEnv("COACH_CANARY_FOREIGN_CALL_ID")}`);
    expect(foreign.status).toBe(REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR);
    expect(foreign.error).toBeInstanceOf(Error);
    expect(foreign.error?.message.length).toBeGreaterThan(0);
  });
});
