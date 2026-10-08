import { describe, expect, it } from "vitest";

import { replayOrgId } from "./seed-core";
import { assertHarnessEnv } from "./safety";
import { BLANKED_ENV, buildServerEnv } from "./server";

describe("buildServerEnv", () => {
  const leaky: Record<string, string | undefined> = {
    SENDILLO_API_KEY: "sk_live_x",
    TWILIO_AUTH_TOKEN: "t",
    DIALPAD_API_KEY: "d",
    BLAND_API_KEY: "b",
    TELNYX_API_KEY: "tx",
    TRACERFY_API_KEY: "tr",
    SMARTY_AUTH_TOKEN: "sm",
    NEXT_PUBLIC_SUPABASE_URL: "https://copflsklaefwzipsrjqz.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "prod-service-key",
    ANTHROPIC_API_KEY: "keep-me",
    AI_RESPONDER_LLM_AUTOSEND: "1",
    MESSAGING_PROVIDER: "twilio",
  };
  const env = buildServerEnv(leaky, { supabaseUrl: "http://127.0.0.1:54331", batchId: "b1", port: 3101, fromNumber: "+18165550100" });

  it("blanks every seller-SMS / call vendor credential", () => {
    for (const name of BLANKED_ENV) expect(env[name], name).toBe("");
    expect(() => assertHarnessEnv(env)).not.toThrow();
  });
  it("blanks Telnyx and the other paid/outbound vendor keys", () => {
    for (const name of ["TELNYX_API_KEY", "TRACERFY_API_KEY", "SMARTY_AUTH_TOKEN"]) {
      expect(BLANKED_ENV).toContain(name);
      expect(env[name]).toBe("");
    }
  });
  it("turns the stub on, LLM autosend off and forces the sendillo stub provider", () => {
    expect(env.SMS_PROVIDER_STUB).toBe("1");
    expect(env.AI_RESPONDER_LLM_AUTOSEND).toBe("0");
    expect(env.MESSAGING_PROVIDER).toBe("sendillo");
    expect(env.REPLAY_BATCH_ID).toBe("b1");
  });
  it("pins Supabase to the local stack even when the base env points at production", () => {
    expect(env.NEXT_PUBLIC_SUPABASE_URL).toBe("http://127.0.0.1:54331");
    expect(env.SUPABASE_SERVICE_ROLE_KEY).not.toBe("prod-service-key");
    expect(JSON.stringify(env)).not.toContain("copflsklaefwzipsrjqz");
  });
  it("leaves Jev / Claude credentials alone (they run for real)", () => {
    expect(env.ANTHROPIC_API_KEY).toBe("keep-me");
  });
  it("keeps the scope ids the send path needs and still blanks the Sendillo secrets", () => {
    const base = {
      ...leaky,
      SENDILLO_ORG_ID: "prod-org",
      SENDILLO_CONNECTION_ID: "conn-1",
      SENDILLO_PROVIDER_ACCOUNT_ID: "acct-1",
      SENDILLO_WEBHOOK_SECRET: "whsec",
      SENDILLO_FROM_NUMBER: "+19130000000",
    };
    const e = buildServerEnv(base, { supabaseUrl: "http://127.0.0.1:54331", batchId: "b1", port: 3101, fromNumber: "+18165550100" });
    // sendSmsToContact -> resolveProvider -> stub reads these (grep process.env.SENDILLO_* in src/lib/messaging).
    for (const name of ["SENDILLO_ORG_ID", "SENDILLO_CONNECTION_ID", "SENDILLO_PROVIDER_ACCOUNT_ID", "SENDILLO_WEBHOOK_SECRET", "SENDILLO_FROM_NUMBER"]) {
      expect(BLANKED_ENV as readonly string[]).not.toContain(name);
      expect(e[name], name).toBeTruthy();
    }
    expect(e.SENDILLO_CONNECTION_ID).toBe("conn-1");
    expect(e.SENDILLO_PROVIDER_ACCOUNT_ID).toBe("acct-1");
    // The scope check compares against the sending (replay) org, so it is pinned to it.
    expect(e.SENDILLO_ORG_ID).toBe(replayOrgId("b1"));
    expect(e.SENDILLO_API_KEY).toBe("");
    expect(e.SENDILLO_CAPTURE_SECRET).toBe("");
  });
  it("retains SENDILLO_ORG_ID when no batch is given", () => {
    const e = buildServerEnv({ SENDILLO_ORG_ID: "o" }, { supabaseUrl: "http://127.0.0.1:54331", batchId: null, port: 3101, fromNumber: "+18165550100" });
    expect(e.SENDILLO_ORG_ID).toBe("o");
  });
  it("passes --allow-project-ref through as REPLAY_ALLOW_PROJECT_REF", () => {
    const o = { supabaseUrl: "http://127.0.0.1:54331", batchId: "b1", port: 3101, fromNumber: "+18165550100" };
    expect(buildServerEnv({}, { ...o, allowProjectRef: "abcdefghijklmnopqrst" }).REPLAY_ALLOW_PROJECT_REF).toBe("abcdefghijklmnopqrst");
    expect(buildServerEnv({ REPLAY_ALLOW_PROJECT_REF: "x" }, o).REPLAY_ALLOW_PROJECT_REF).toBe("x");
  });
});
