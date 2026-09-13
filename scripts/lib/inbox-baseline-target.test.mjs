import { test } from "node:test";
import assert from "node:assert/strict";
import { validateInboxBaselineTarget } from "./inbox-baseline-target.mjs";

const API = "http://127.0.0.1:58421";
const DB = "postgresql://postgres:postgres@127.0.0.1:58422/postgres";

test("accepts only owned endpoints and returns explicit PostgreSQL settings", () => {
  const expected = {
    apiOrigin: API,
    databaseConfig: { host: "127.0.0.1", port: 58422, database: "postgres", user: "postgres", password: "postgres", ssl: false },
  };
  const validated = validateInboxBaselineTarget(API, DB);
  assert.deepEqual(validated, expected);
  assert.deepEqual(validateInboxBaselineTarget(API + "/", DB.replace("postgresql:", "postgres:")), expected);
  assert.equal("connectionString" in validated.databaseConfig, false);
});

test("rejects PostgreSQL query overrides before another parser can redirect the connection", () => {
  for (const suffix of ["?host=remote.example", "?port=5432", "?host=/tmp/socket", "?dbname=other", "?user=other", "?sslmode=require", "?", "#fragment"]) {
    assert.throws(() => validateInboxBaselineTarget(API, DB + suffix), /^Error: Dedicated loopback target guard failed$/);
  }
});

test("rejects other protocols, hosts, ports, database paths and credentials", () => {
  for (const value of [
    DB.replace("postgresql:", "https:"), DB.replace("127.0.0.1", "localhost"),
    DB.replace("127.0.0.1", "remote.example"), DB.replace("58422", "54322"),
    DB.replace("/postgres", "/other"), DB.replace("postgres:postgres@", "other:private@"),
    DB.replace("postgres:postgres@", "postgres:private@"), DB + "/", " " + DB, undefined, null,
  ]) {
    assert.throws(() => validateInboxBaselineTarget(API, value), /^Error: Dedicated loopback target guard failed$/);
  }
});

test("rejects API credentials, paths, queries, fragments and non-owned origins", () => {
  for (const value of [
    API.replace("http:", "https:"), API.replace("127.0.0.1", "localhost"),
    API.replace("127.0.0.1", "user:private@127.0.0.1"), API.replace("58421", "54321"),
    API + "/rest/v1", API + "?host=remote.example", API + "#fragment", " " + API, undefined, null,
  ]) {
    assert.throws(() => validateInboxBaselineTarget(value, DB), /^Error: Dedicated loopback target guard failed$/);
  }
});
