import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { requireLoopbackPostgresUrl } from '../../src/lib/testing/loopback-postgres-url.ts';
import { CONTRACT, LEGACY_EXCLUSION, checkCheckout, checkEntryEnvironment, checkSchema, ownDatabase, schemaCatalog, sha256, subprocessEnvironment, validateUpgradeCases, validateReport, writeManifest } from './norma-contract-support.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export function parseArgs(args) {
  if (args.length !== 2 || args[0] !== '--output-directory' || !args[1]) throw new Error('Exactly --output-directory <new directory> is required');
  return path.resolve(args[1]);
}
export async function cleanupOwned(client, runId) {
  assert.match(runId, /^[a-f0-9]{16}$/);
  const all = (await client.query('select datname from pg_database')).rows.map(r => r.datname).filter(n => ownDatabase(n,runId));
  for (const name of all) await client.query(`drop database "${name}" with (force)`);
  const remaining = (await client.query('select datname from pg_database')).rows.map(r => r.datname).filter(n => ownDatabase(n,runId));
  assert.equal(remaining.length, 0, 'Owned scratch cleanup incomplete');
  return {removed:all, remaining};
}
function childEnv(source, lane, out, dumpHash, runId) {
  const env = {};
  for (const key of ['PATH','HOME','TMPDIR','TEMP','LANG','LC_ALL','SYSTEMROOT']) if (process.env[key]) env[key]=process.env[key];
  Object.assign(env, {
    CI:'true', NORMA_STRESS_SOURCE_DB_URL:source, TEST_SUPABASE_DB_URL:source,
    NORMA_SCHEMA_CONTRACT_LANE:lane, NORMA_SCHEMA_CONTRACT_RUN_ID:runId,
    NORMA_SCHEMA_SOURCE_DUMP:path.join(out,'source.sql'), NORMA_SCHEMA_SOURCE_SHA256:dumpHash,
    NORMA_SCHEMA_MANIFEST_DIRECTORY:path.join(out,'databases'),
    NORMA_STRESS_SEED:'101,202,303,404,505', NORMA_STRESS_LIFECYCLES:'80',
    NORMA_STRESS_EXCLUDE_MIGRATIONS:lane==='legacy' ? LEGACY_EXCLUSION : '',
  });
  return env;
}
function runLane(lane, source, out, dumpHash, runId) {
  const reportFile=path.join(out,`${lane}.json`);
  const args=['node_modules/vitest/vitest.mjs','run','--config',lane==='upgrade'?'vitest.local-integration.config.ts':'vitest.norma-stress.config.ts','--reporter=default','--reporter=json',`--outputFile=${reportFile}`];
  if (lane==='legacy') args.push('--exclude',CONTRACT.lanes.postddl.files[0]);
  else args.push(...CONTRACT.lanes[lane].files);
  const stdout=openSync(path.join(out,`${lane}.log`),'w',0o600), stderr=openSync(path.join(out,`${lane}.stderr.log`),'w',0o600);
  let result;
  try { result=spawnSync(process.execPath,args,{cwd:ROOT,env:childEnv(source,lane,out,dumpHash,runId),stdio:['ignore',stdout,stderr],timeout:20*60_000}); }
  finally {closeSync(stdout);closeSync(stderr);}
  assert.equal(result.status,0,`${lane} process failed (code=${result.status}, signal=${result.signal ?? 'none'})`);
  return {processExit:result.status,...validateReport(JSON.parse(readFileSync(reportFile,'utf8')),lane,ROOT)};
}
export async function main(args=process.argv.slice(2), env=process.env) {
  assert.ok(Number(process.versions.node.split('.')[0])>=24,'Node24+ required');
  checkEntryEnvironment(env);
  checkCheckout(ROOT);
  assert.equal(execFileSync('git',['status','--porcelain'],{cwd:ROOT,encoding:'utf8',env:subprocessEnvironment(env)}).trim(),'','Clean candidate required');
  const source=requireLoopbackPostgresUrl(env.NORMA_STRESS_SOURCE_DB_URL ?? '');
  const out=parseArgs(args);
  assert.ok(!existsSync(out),'Output directory already exists');
  mkdirSync(path.join(out,'databases'),{recursive:true,mode:0o700});
  const runId=randomBytes(8).toString('hex');
  const checkoutMigrations=Object.fromEntries(readdirSync(path.join(ROOT,'supabase/migrations')).filter(file=>file.endsWith('.sql')).sort().map(file=>[file,sha256(readFileSync(path.join(ROOT,'supabase/migrations',file)))]));
  const receipt={checkoutMigrationManifest:checkoutMigrations,version:1,runId,profile:'schema-only-three-mandatory-lanes',sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:ROOT,encoding:'utf8',env:subprocessEnvironment(env)}).trim(),node:process.version,contractSha256:sha256(readFileSync(path.join(ROOT,'scripts/ci/norma-schema-contract.json'))),lanes:{},success:false,releaseCompatible:false,releaseBlockers:['legacy worker expiry','defaulted unfenced claim','metadata-less unbound completion','serving hold/drain evidence']};
  const admin=new pg.Client({connectionString:source});
  await admin.connect();
  try {
    receipt.fixturePrivileges=(await admin.query('select current_user as role, rolsuper as superuser, rolcreatedb as createdb from pg_roles where rolname=current_user')).rows[0];
    assert.equal(receipt.fixturePrivileges.superuser,true,'Dedicated local fixture admin required for strict restore and audit clock');
    receipt.sourceCatalog=await schemaCatalog(admin); checkSchema(receipt.sourceCatalog,'source');
    const dump=execFileSync('pg_dump',['--schema-only','--no-owner',source],{maxBuffer:256*1024*1024,env:subprocessEnvironment(env)});
    writeFileSync(path.join(out,'source.sql'),dump,{mode:0o600});
    receipt.sourceDumpSha256=sha256(dump);
    for (const lane of ['legacy','postddl']) {
      console.log(`Norma contract: ${lane} starting`);
      receipt.lanes[lane]=runLane(lane,source,out,receipt.sourceDumpSha256,runId);
      console.log(`Norma contract: ${lane} passed`);
    }
    // Upgrade tests replay legacy + retry SQL inside rolled-back transactions;
    // their database therefore starts from the same pre-Norma snapshot.
    const name=`norma_schema_${runId}_upgrade`;
    await admin.query(`create database "${name}"`);
    writeManifest(path.join(out,'databases',`${name}.json`),{database:name,lane:'upgrade',runId,sourceDumpSha256:receipt.sourceDumpSha256,migrations:[],state:'created'});
    const u=new URL(source);u.pathname=`/${name}`;
    execFileSync('psql',['-q','-X','-v','ON_ERROR_STOP=1','-d',u.toString()],{input:dump,maxBuffer:256*1024*1024,env:subprocessEnvironment(env),stdio:['pipe','pipe','pipe']});
    const upgraded=new pg.Client({connectionString:u.toString()});await upgraded.connect();
    try {checkSchema(await schemaCatalog(upgraded),'upgrade-source');} finally {await upgraded.end();}
    console.log('Norma contract: upgrade starting');
    receipt.lanes.upgrade=runLane('upgrade',u.toString(),out,receipt.sourceDumpSha256,runId);
    console.log('Norma contract: upgrade passed');
    await admin.query(`drop database "${name}" with (force)`);
    writeManifest(path.join(out,'databases',`${name}.json`),{database:name,lane:'upgrade',runId,sourceDumpSha256:receipt.sourceDumpSha256,migrations:[],state:'dropped'});
    checkCheckout(ROOT); // Refuse source drift during tests, too.
    assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:ROOT,encoding:'utf8',env:subprocessEnvironment(env)}).trim(),receipt.sourceCommit,'Candidate HEAD changed');
    assert.equal(execFileSync('git',['status','--porcelain'],{cwd:ROOT,encoding:'utf8',env:subprocessEnvironment(env)}).trim(),'','Candidate changed during tests');
    assert.deepEqual(Object.fromEntries(readdirSync(path.join(ROOT,'supabase/migrations')).filter(file=>file.endsWith('.sql')).sort().map(file=>[file,sha256(readFileSync(path.join(ROOT,'supabase/migrations',file)))])),checkoutMigrations,'Foundation migration checkout drift');
    const manifests=readdirSync(path.join(out,'databases')).filter(f=>f.endsWith('.json')).map(f=>JSON.parse(readFileSync(path.join(out,'databases',f),'utf8')));
    assert.ok(manifests.some(m=>m.lane==='legacy')&&manifests.some(m=>m.lane==='postddl'),'Missing applied migration manifests');
    for (const m of manifests) {
      assert.equal(m.runId,runId,'Manifest ownership mismatch');
      assert.ok(ownDatabase(m.database,runId),'Manifest database ownership mismatch');
      assert.equal(m.sourceDumpSha256,receipt.sourceDumpSha256,'Manifest snapshot mismatch');
      assert.equal(m.state,'dropped','Fixture did not cleanly drop');
      if (m.lane!=='upgrade') {
        const expected=Object.entries(CONTRACT.norma_migrations).filter(([file])=>m.lane!=='legacy'||file!==CONTRACT.retry_file).map(([file,hash])=>({file:path.basename(file),sha256:hash}));
        assert.deepEqual(m.migrations,expected,'Applied SQL manifest mismatch');
        checkSchema(m.catalog,m.lane);
      }
    }
    const upgradeCases=JSON.parse(readFileSync(path.join(out,'upgrade-cases.json'),'utf8'));
    validateUpgradeCases(upgradeCases,JSON.parse(readFileSync(path.join(out,'upgrade.json'),'utf8')));
    assert.ok(upgradeCases.every(c=>c.rolledBack===true),'Upgrade rollback incomplete');
    for (const c of upgradeCases) {checkSchema(c.catalogs.source,'upgrade-source');checkSchema(c.catalogs.legacy,'legacy');checkSchema(c.catalogs.postddl,'postddl');checkSchema(c.catalogs.rolledBack,'upgrade-source');assert.deepEqual(c.migrations,CONTRACT.norma_migrations,'Upgrade hash manifest drift');}
    receipt.databaseManifests=manifests; receipt.upgradeCases=upgradeCases;
    receipt.success=true;
  } catch (error) {
    receipt.failure=error instanceof Error ? error.message.replace(/postgres(?:ql)?:\/\/\S+/g,'[connection redacted]') : 'Contract failed';
    throw error;
  } finally {
    try {receipt.cleanup=await cleanupOwned(admin,runId);}
    catch {receipt.success=false;receipt.cleanup={failed:true};}
    receipt.success=receipt.success && receipt.cleanup?.remaining?.length===0 && receipt.cleanup?.removed?.length===0;
    writeManifest(path.join(out,'receipt.json'),receipt);
    await admin.end();
    if (!receipt.success) process.exitCode=1;
  }
  if (!receipt.success) throw new Error('Schema contract or cleanup failed');
  console.log(`Norma contract receipt: ${path.join(out,'receipt.json')}`);
  return receipt;
}
if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) main().catch(error=>{console.error(error.message.replace(/postgres(?:ql)?:\/\/\S+/g,'[connection redacted]'));process.exitCode=1;});
