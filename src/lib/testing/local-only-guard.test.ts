import { describe, expect, it } from "vitest";

import { assertLocalOnlyEnvironment } from "./local-only-guard";

const LOCAL_API = "http://127.0.0.1:55331";
const LOCAL_DB = "postgresql://postgres:postgres@127.0.0.1:55329/postgres";

describe("assertLocalOnlyEnvironment", () => {
  it("accepts loopback API and DB", () => {
    expect(() => assertLocalOnlyEnvironment({ TEST_SUPABASE_URL: LOCAL_API, TEST_SUPABASE_DB_URL: LOCAL_DB })).not.toThrow();
    expect(() => assertLocalOnlyEnvironment({ TEST_SUPABASE_URL: "http://localhost:1", TEST_SUPABASE_DB_URL: "postgres://u:p@localhost:5/db" })).not.toThrow();
  });
  it("rejects the hosted project on either variable", () => {
    const hostedApi = "https://ncsngxlcyxylaeskiteu.supabase.co";
    const hostedDb = "postgresql://postgres.ncsngxlcyxylaeskiteu:pw@aws-1-us-east-1.pooler.supabase.com:5432/postgres";
    expect(() => assertLocalOnlyEnvironment({ TEST_SUPABASE_URL: hostedApi, TEST_SUPABASE_DB_URL: LOCAL_DB })).toThrow(/loopback/);
    expect(() => assertLocalOnlyEnvironment({ TEST_SUPABASE_URL: LOCAL_API, TEST_SUPABASE_DB_URL: hostedDb })).toThrow(/loopback/);
    expect(() => assertLocalOnlyEnvironment({ TEST_SUPABASE_URL: hostedApi, TEST_SUPABASE_DB_URL: hostedDb })).toThrow();
  });
  it("rejects missing, malformed, spoofed and host-override values", () => {
    expect(() => assertLocalOnlyEnvironment({})).toThrow();
    expect(() => assertLocalOnlyEnvironment({ TEST_SUPABASE_URL: LOCAL_API })).toThrow();
    expect(() => assertLocalOnlyEnvironment({ TEST_SUPABASE_URL: "not a url", TEST_SUPABASE_DB_URL: LOCAL_DB })).toThrow();
    expect(() => assertLocalOnlyEnvironment({ TEST_SUPABASE_URL: "http://127.0.0.1@evil.example.com", TEST_SUPABASE_DB_URL: LOCAL_DB })).toThrow();
    expect(() => assertLocalOnlyEnvironment({ TEST_SUPABASE_URL: "http://127.0.0.1.evil.example.com", TEST_SUPABASE_DB_URL: LOCAL_DB })).toThrow();
    expect(() => assertLocalOnlyEnvironment({ TEST_SUPABASE_URL: LOCAL_API, TEST_SUPABASE_DB_URL: `${LOCAL_DB}?host=db.evil.example.com` })).toThrow();
  });
});
