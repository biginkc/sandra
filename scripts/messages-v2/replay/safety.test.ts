import { describe, expect, it } from "vitest";

import {
  PROD_PROJECT_REF,
  applyStubEnv,
  assertHandshake,
  assertHarnessEnv,
  assertLocalBaseUrl,
  assertSafeDbUrl,
  assertSafeSupabaseUrl,
  readProdRefs,
} from "./safety";

const prod = [PROD_PROJECT_REF];
const testRef = "abcdefghijklmnopqrst";

describe("assertLocalBaseUrl", () => {
  it("accepts loopback hosts only", () => {
    expect(assertLocalBaseUrl("http://localhost:3101").hostname).toBe("localhost");
    expect(assertLocalBaseUrl("http://127.0.0.1:3101").hostname).toBe("127.0.0.1");
    expect(assertLocalBaseUrl("http://[::1]:3101").hostname).toBe("[::1]");
  });
  it.each([
    "https://sandra.example.com",
    "https://app.biginkc.com",
    "http://localhost.evil.com",
    "http://127.0.0.1.evil.com",
    "http://evil.com/@localhost",
    "http://localhost@evil.com",
    "http://0.0.0.0:3000",
    "not a url",
    "ftp://localhost",
  ])("refuses %s", (url) => {
    expect(() => assertLocalBaseUrl(url)).toThrow(/replay/i);
  });
});

describe("assertSafeSupabaseUrl", () => {
  it("allows the local stack without a flag", () => {
    expect(assertSafeSupabaseUrl("http://127.0.0.1:54331", { prodRefs: prod }).kind).toBe("local");
  });
  it("refuses the production project even when explicitly allowed", () => {
    const url = `https://${PROD_PROJECT_REF}.supabase.co`;
    expect(() => assertSafeSupabaseUrl(url, { prodRefs: prod })).toThrow(/production/i);
    expect(() =>
      assertSafeSupabaseUrl(url, { prodRefs: prod, allowProjectRef: PROD_PROJECT_REF }),
    ).toThrow(/production/i);
  });
  it("refuses any string that embeds the production ref (pooler user, db host)", () => {
    expect(() =>
      assertSafeSupabaseUrl(`https://db.${PROD_PROJECT_REF}.supabase.co`, { prodRefs: prod }),
    ).toThrow(/production/i);
    expect(() =>
      assertSafeDbUrl(
        `postgresql://postgres.${PROD_PROJECT_REF}:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres`,
        { prodRefs: prod },
      ),
    ).toThrow(/production/i);
  });
  it("requires an explicit matching --allow-project-ref for a hosted project", () => {
    const url = `https://${testRef}.supabase.co`;
    expect(() => assertSafeSupabaseUrl(url, { prodRefs: prod })).toThrow(/allow-project-ref/);
    expect(() =>
      assertSafeSupabaseUrl(url, { prodRefs: prod, allowProjectRef: "zzzzzzzzzzzzzzzzzzzz" }),
    ).toThrow(/allow-project-ref/);
    expect(assertSafeSupabaseUrl(url, { prodRefs: prod, allowProjectRef: testRef })).toMatchObject({
      kind: "hosted",
      ref: testRef,
    });
  });
  it("refuses unknown custom domains (cannot prove they are not production)", () => {
    expect(() =>
      assertSafeSupabaseUrl("https://db.biginkc.com", { prodRefs: prod, allowProjectRef: "db" }),
    ).toThrow();
  });
  it("refuses an empty production-ref list (fail closed)", () => {
    expect(() => assertSafeSupabaseUrl("http://127.0.0.1:54331", { prodRefs: [] })).toThrow(/production ref/i);
  });
});

describe("assertSafeDbUrl", () => {
  it("accepts loopback postgres and rejects query-string host overrides", () => {
    expect(() =>
      assertSafeDbUrl("postgresql://postgres:postgres@127.0.0.1:54329/postgres", { prodRefs: prod }),
    ).not.toThrow();
    expect(() =>
      assertSafeDbUrl("postgresql://postgres:postgres@127.0.0.1:54329/postgres?host=evil.com", {
        prodRefs: prod,
      }),
    ).toThrow();
    expect(() =>
      assertSafeDbUrl("postgresql://u:p@db.example.com:5432/postgres", { prodRefs: prod }),
    ).toThrow();
  });
});

describe("readProdRefs", () => {
  it("always includes the built-in ref and adds refs found in env files", () => {
    const files: Record<string, string> = {
      "/repo/.env.production": "NEXT_PUBLIC_SUPABASE_URL=https://qqqqqqqqqqqqqqqqqqqq.supabase.co\n",
    };
    const refs = readProdRefs("/repo", (p) => {
      if (p in files) return files[p];
      throw new Error("ENOENT");
    });
    expect(refs).toContain(PROD_PROJECT_REF);
    expect(refs).toContain("qqqqqqqqqqqqqqqqqqqq");
  });
});

describe("harness env", () => {
  it("applyStubEnv forces the stub and LLM hold flags", () => {
    const env: NodeJS.ProcessEnv = { AI_RESPONDER_LLM_AUTOSEND: "1" };
    applyStubEnv(env);
    expect(env.SMS_PROVIDER_STUB).toBe("1");
    expect(env.AI_RESPONDER_LLM_AUTOSEND).toBe("0");
  });
  it("refuses to run when a Sendillo API key is present", () => {
    expect(() => assertHarnessEnv({ SMS_PROVIDER_STUB: "1", SENDILLO_API_KEY: "sk_live" })).toThrow(/SENDILLO_API_KEY/);
  });
  it("refuses other seller-SMS provider credentials too", () => {
    expect(() => assertHarnessEnv({ SMS_PROVIDER_STUB: "1", TWILIO_AUTH_TOKEN: "x" })).toThrow(/TWILIO_AUTH_TOKEN/);
    expect(() => assertHarnessEnv({ SMS_PROVIDER_STUB: "1", DIALPAD_API_KEY: "x" })).toThrow(/DIALPAD_API_KEY/);
  });
  it("refuses when the stub flag is missing", () => {
    expect(() => assertHarnessEnv({})).toThrow(/SMS_PROVIDER_STUB/);
  });
  it("passes with the stub on and credentials blank or absent", () => {
    expect(() => assertHarnessEnv({ SMS_PROVIDER_STUB: "1", SENDILLO_API_KEY: "  " })).not.toThrow();
  });
});

describe("assertHandshake (server-side stub proof)", () => {
  const ok = {
    replayStub: true,
    sendilloApiKeyPresent: false,
    llmAutosend: "0",
    supabaseHost: "127.0.0.1:54331",
  };
  it("accepts a stubbed server on the same supabase host", () => {
    expect(() => assertHandshake(ok, { supabaseHost: "127.0.0.1:54331" })).not.toThrow();
  });
  it.each([
    [{ ...ok, replayStub: false }, /stub/i],
    [{ ...ok, sendilloApiKeyPresent: true }, /api key/i],
    [{ ...ok, llmAutosend: "1" }, /autosend/i],
    [{ ...ok, supabaseHost: "other.supabase.co" }, /supabase/i],
    [null, /handshake/i],
  ])("refuses %j", (body, re) => {
    expect(() => assertHandshake(body, { supabaseHost: "127.0.0.1:54331" })).toThrow(re);
  });
});
