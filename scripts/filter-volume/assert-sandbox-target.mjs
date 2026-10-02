// Fail-closed identity check, run immediately before ANY psql/db push/restart in
// the volume + lock harness. Aborts unless the target is the disposable sandbox:
//  - docker container `supabase_db_sandra-filter-vol` publishes host port 55329
//  - the Postgres reachable on 127.0.0.1:55329 started within 30 s of that
//    container (pg_postmaster_start_time vs docker State.StartedAt)
//  - it has NO `norma_stress_*`/other-agent databases and database name `postgres`
//  - the CLI workdir config (SBX_WORKDIR) declares db port 55329
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import pg from "pg";

export const SANDBOX = { container: "supabase_db_sandra-filter-vol", port: "55329", url: "postgresql://postgres:postgres@127.0.0.1:55329/postgres" };

export async function assertSandboxTarget({ url = SANDBOX.url, workdir = process.env.SBX_WORKDIR } = {}) {
  const fail = (m) => { throw new Error(`REFUSING (not the 55329 sandbox): ${m}`); };
  if (!url.includes(`127.0.0.1:${SANDBOX.port}/`)) fail(`url ${url.replace(/:[^:@]*@/, ":***@")}`);
  let info;
  try {
    info = JSON.parse(execFileSync("docker", ["inspect", SANDBOX.container, "--format", "{{json .}}"], { encoding: "utf8" }));
  } catch { fail(`container ${SANDBOX.container} not found`); }
  const hostPorts = Object.values(info.NetworkSettings.Ports ?? {}).flat().filter(Boolean).map((p) => p.HostPort);
  if (!hostPorts.includes(SANDBOX.port)) fail(`container publishes ${hostPorts}`);
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    const { rows: [r] } = await c.query(`select current_setting('port') as port, inet_server_port() as sport, current_database() as db,
      extract(epoch from pg_postmaster_start_time()) as pm, (select count(*)::int from pg_database where datname like 'norma%' or datname like 'sandra_%') as other_dbs`);
    const started = Date.parse(info.State.StartedAt) / 1000;
    if (r.db !== "postgres") fail(`database ${r.db}`);
    if (r.other_dbs !== 0) fail(`found ${r.other_dbs} other-agent databases (this is the shared dev stack)`);
    if (Math.abs(Number(r.pm) - started) > 30) fail(`postmaster start ${r.pm} vs container start ${started}`);
    if (workdir !== undefined) {
      if (!workdir) fail("SBX_WORKDIR empty");
      if (!/port\s*=\s*55329/.test(fs.readFileSync(`${workdir}/supabase/config.toml`, "utf8"))) fail("workdir config is not db port 55329");
    }
    return { container: info.Name, id: info.Id.slice(0, 12), port: r.port, serverPort: r.sport, db: r.db, postmasterStart: new Date(Number(r.pm) * 1000).toISOString() };
  } finally { await c.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await assertSandboxTarget(), null, 1));
}
