import { describe, expect, it } from "vitest";
import { assertLocalOnlyTestEnv } from "./local-only-test-env";

const localDb = "postgresql://postgres:postgres@127.0.0.1:56329/postgres";
const localApi = "http://127.0.0.1:56331";

describe("assertLocalOnlyTestEnv", () => {
  it("accepts loopback DB and API", () => {
    expect(() => assertLocalOnlyTestEnv(localDb, localApi)).not.toThrow();
    expect(() => assertLocalOnlyTestEnv("postgresql://p:p@localhost:5432/postgres", "http://localhost:54331")).not.toThrow();
  });
  it.each([
    ["hosted direct DB", "postgresql://postgres:pw@db.ncsngxlcyxylaeskiteu.supabase.co:5432/postgres", localApi],
    ["hosted pooler DB", "postgresql://postgres.ncsngxlcyxylaeskiteu:pw@aws-1-us-east-1.pooler.supabase.com:5432/postgres", localApi],
    ["host override query", `${localDb}?host=db.example.com`, localApi],
    ["hosted API", localDb, "https://ncsngxlcyxylaeskiteu.supabase.co"],
    ["lookalike API host", localDb, "http://127.0.0.1.evil.test"],
    ["garbage API", localDb, "not a url"],
    ["API URL with userinfo", localDb, "http://user:pass@127.0.0.1:54331"],
    ["fragment host trick", localDb, "http://evil.com#@127.0.0.1"],
    ["userinfo host trick", localDb, "http://127.0.0.1@evil.com"],
    ["missing DB", undefined, localApi],
    ["missing API", localDb, undefined],
    ["empty", "", ""],
  ])("rejects %s", (_n, db, api) => {
    expect(() => assertLocalOnlyTestEnv(db, api)).toThrow();
  });
});
