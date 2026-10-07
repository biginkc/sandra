import { describe, expect, it } from "vitest";

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
});
