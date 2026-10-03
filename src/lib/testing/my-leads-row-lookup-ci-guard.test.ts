import { readFileSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { requireLoopbackPostgresUrl } from "./loopback-postgres-url"

const root = path.resolve(__dirname, "../../..")
const suite = readFileSync(path.join(root, "supabase/migrations/20261003120000_my_leads_queue_row_lookup.integration.test.ts"), "utf8")
const provision = readFileSync(path.join(root, "scripts/provision-e2e-local-database.mjs"), "utf8")

describe("My Leads row-lookup integration suite in the disposable-DB CI job", () => {
  it("accepts the database the CI provisioner publishes, while staying loopback-only", () => {
    const published = /DB_URL !== '([^']+)'/.exec(provision)?.[1]
    expect(published).toBeTruthy()
    expect(() => requireLoopbackPostgresUrl(published!)).not.toThrow()
    expect(() => requireLoopbackPostgresUrl("postgresql://postgres:postgres@db.example.com:5432/postgres")).toThrow()
  })

  it("uses the shared loopback guard instead of pinning one local port", () => {
    expect(suite).toContain("requireLoopbackPostgresUrl(url)")
    expect(suite).not.toMatch(/target\.port\s*!==\s*'54329'/)
  })
})
