import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {closeSync,existsSync,mkdirSync,openSync,readFileSync,readdirSync,symlinkSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import pg from 'pg';
import {requireLoopbackPostgresUrl} from '../../src/lib/testing/loopback-postgres-url.ts';
import {checkEntryEnvironment,checkSchema,CONTRACT,ownDatabase,schemaCatalog,sha256,subprocessEnvironment,writeManifest} from './norma-contract-support.mjs';
import {cleanupOwned} from './run-norma-schema-contract.mjs';
import {COMBINED,checkCombinedCheckout,validateCombinedReport} from './norma-combined-support.mjs';
const ROOT=path.resolve(fileURLToPath(new URL('../../',import.meta.url)));
export function parseCombinedArgs(args) {
  assert.ok(args.length===2&&args[0]==='--output-directory'&&args[1],'Exactly --output-directory <new directory>; no profile/skip switches');
  const out=path.resolve(args[1]);assert.ok(out!==ROOT&&!out.startsWith(ROOT+path.sep),'Artifacts must be outside candidate source');return out;
}
function git(args,env,cwd=ROOT) {return execFileSync('git',args,{cwd,env:subprocessEnvironment(env),encoding:'utf8'}).trim();}
function runPositive(lane,source,out,dumpHash,runId,env) {
  const report=path.join(out,lane+'.json');const args=['node_modules/vitest/vitest.mjs','run','--config',lane==='paired'?'vitest.norma-stress.config.ts':'vitest.config.ts','--reporter=default','--reporter=json','--outputFile='+report];
  if(lane==='controls')args.push(...COMBINED.lanes.controls.files);
  const child={...subprocessEnvironment(env),CI:'true',NORMA_STRESS_SOURCE_DB_URL:source,NORMA_SCHEMA_CONTRACT_LANE:'paired',NORMA_COMBINED_PROFILE:COMBINED.profile,NORMA_SCHEMA_CONTRACT_RUN_ID:runId,NORMA_SCHEMA_SOURCE_DUMP:path.join(out,'legacy-schema/source.sql'),NORMA_SCHEMA_SOURCE_SHA256:dumpHash,NORMA_SCHEMA_MANIFEST_DIRECTORY:path.join(out,'databases'),NORMA_STRESS_SEED:'101,202,303,404,505',NORMA_STRESS_LIFECYCLES:'80',NORMA_STRESS_EXCLUDE_MIGRATIONS:'',NORMA_MAINTENANCE_HOLD:'false'};
  const stdout=openSync(path.join(out,lane+'.log'),'w',0o600),stderr=openSync(path.join(out,lane+'.stderr.log'),'w',0o600);let result;
  try{result=spawnSync(process.execPath,args,{cwd:ROOT,env:child,stdio:['ignore',stdout,stderr],timeout:20*60_000});}finally{closeSync(stdout);closeSync(stderr);}
  assert.equal(result.status,0,`${lane} failed: code=${result.status}, signal=${result.signal??'none'}`);
  return {processExit:0,...validateCombinedReport(JSON.parse(readFileSync(report,'utf8')),lane,ROOT)};
}
export async function main(args=process.argv.slice(2),env=process.env) {
  assert.equal(Number(process.versions.node.split('.')[0]),24,'Combined gate requires the admitted Node24 runtime');
  checkEntryEnvironment(env);checkCombinedCheckout(ROOT);
  assert.equal(git(['status','--porcelain'],env),'','Clean combined candidate required');
  const source=requireLoopbackPostgresUrl(env.NORMA_STRESS_SOURCE_DB_URL??'');const out=parseCombinedArgs(args);assert.ok(!existsSync(out),'New output directory required');
  const commit=git(['rev-parse','HEAD'],env);assert.equal(git(['rev-parse',COMBINED.legacy_schema_commit+'^{commit}'],env),COMBINED.legacy_schema_commit);
  const immutableSchema=JSON.parse(git(['show',COMBINED.legacy_schema_commit+':scripts/ci/norma-schema-contract.json'],env));
  assert.deepEqual(CONTRACT.norma_migrations,immutableSchema.norma_migrations,'SQL hashes must equal the immutable schema input');
  for(const [file,hash] of Object.entries(COMBINED.paired_assertion_sources))assert.equal(sha256(execFileSync('git',['show',COMBINED.paired_input_commit+':'+file],{cwd:ROOT,env:subprocessEnvironment(env)})),hash,'Paired assertion pin differs from immutable input: '+file);
  const currentLock=sha256(readFileSync(path.join(ROOT,'package-lock.json')));assert.equal(currentLock,COMBINED.dependency_lock_sha256,'Dependency lock drift');
  const migrations=Object.fromEntries(readdirSync(path.join(ROOT,'supabase/migrations')).filter(f=>f.endsWith('.sql')).sort().map(f=>[f,sha256(readFileSync(path.join(ROOT,'supabase/migrations',f)))]));
  mkdirSync(path.join(out,'databases'),{recursive:true,mode:0o700});
  const runId=randomBytes(8).toString('hex'),legacyRoot=path.join(out,'legacy-checkout');
  const receipt={profile:COMBINED.profile,sourceCommit:commit,node:process.version,nodeExecutable:process.execPath,runId,legacySchemaCommit:COMBINED.legacy_schema_commit,contractSha256:sha256(readFileSync(path.join(ROOT,'scripts/ci/norma-combined-contract.json'))),checkoutMigrationManifest:migrations,lanes:{},success:false,releaseCompatible:false,releaseBlockers:['unfenced defaulted legacy claim','metadata-less legacy completion','serving hold/drain evidence','immutable provider evidence','hosted workflow and release admission']};
  const admin=new pg.Client({connectionString:source});let connected=false,createdLegacy=false;
  try {
    await admin.connect();connected=true;
    receipt.fixturePrivileges=(await admin.query('select current_user as role,rolsuper as superuser from pg_roles where rolname=current_user')).rows[0];assert.equal(receipt.fixturePrivileges.superuser,true,'Dedicated fixture admin required');
    receipt.sourceCatalog=await schemaCatalog(admin);checkSchema(receipt.sourceCatalog,'source');
    // Immutable, explicit schema profile. No source sniffing or fallback.
    git(['worktree','add','--detach',legacyRoot,COMBINED.legacy_schema_commit],env);createdLegacy=true;
    assert.equal(git(['rev-parse','HEAD'],env,legacyRoot),COMBINED.legacy_schema_commit);assert.equal(git(['status','--porcelain'],env,legacyRoot),'');
    assert.equal(sha256(readFileSync(path.join(legacyRoot,'package-lock.json'))),currentLock,'Legacy dependency lock mismatch');
    symlinkSync(path.join(ROOT,'node_modules'),path.join(legacyRoot,'node_modules'),'dir');
    const {main:runLegacy}=await import(pathToFileURL(path.join(legacyRoot,'scripts/ci/run-norma-schema-contract.mjs')).href);
    console.log('Combined gate: immutable matched legacy/schema hazards/upgrade starting');
    const legacyEnv={...subprocessEnvironment(env),NORMA_STRESS_SOURCE_DB_URL:source};
    delete legacyEnv.GIT_CONFIG_NOSYSTEM;delete legacyEnv.GIT_CONFIG_GLOBAL; // Entry inputs are distinct from sanitized subprocess environments.
    const legacy=await runLegacy(['--output-directory',path.join(out,'legacy-schema')],legacyEnv);
    assert.equal(legacy.sourceCommit,COMBINED.legacy_schema_commit);assert.equal(legacy.success,true);assert.deepEqual(legacy.cleanup,{removed:[],remaining:[]});
    receipt.legacyReceipt={sourceCommit:legacy.sourceCommit,node:legacy.node,runId:legacy.runId,sourceDumpSha256:legacy.sourceDumpSha256,lanes:legacy.lanes,cleanup:legacy.cleanup};
    const dump=readFileSync(path.join(out,'legacy-schema/source.sql'));assert.equal(sha256(dump),legacy.sourceDumpSha256);receipt.sourceDumpSha256=legacy.sourceDumpSha256;
    console.log('Combined gate: complete paired/maintenance positive lane starting');
    receipt.lanes.paired=runPositive('paired',source,out,receipt.sourceDumpSha256,runId,env);
    console.log('Combined gate: explicit maintenance/authentication controls starting');
    receipt.lanes.controls=runPositive('controls',source,out,receipt.sourceDumpSha256,runId,env);
    const manifests=readdirSync(path.join(out,'databases')).filter(f=>f.endsWith('.json')).map(f=>JSON.parse(readFileSync(path.join(out,'databases',f),'utf8')));assert.ok(manifests.length>=COMBINED.lanes.paired.files.length,'Missing paired scratch manifests');
    for(const m of manifests){assert.equal(m.runId,runId);assert.ok(ownDatabase(m.database,runId));assert.equal(m.lane,'paired');assert.equal(m.state,'dropped');assert.equal(m.sourceDumpSha256,receipt.sourceDumpSha256);checkSchema(m.catalog,'postddl');assert.deepEqual(m.migrations,Object.entries(CONTRACT.norma_migrations).map(([file,hash])=>({file:path.basename(file),sha256:hash})));}
    receipt.pairedDatabaseManifests=manifests;
    checkCombinedCheckout(ROOT);assert.equal(git(['rev-parse','HEAD'],env),commit);assert.equal(git(['status','--porcelain'],env),'');
    assert.deepEqual(Object.fromEntries(readdirSync(path.join(ROOT,'supabase/migrations')).filter(f=>f.endsWith('.sql')).sort().map(f=>[f,sha256(readFileSync(path.join(ROOT,'supabase/migrations',f)))])),migrations);
    receipt.success=true;
  } catch(error){receipt.failure=error.message.replace(/postgres(?:ql)?:\/\/\S+/g,'[connection redacted]');throw error;}
  finally {
    try {
      receipt.cleanup=connected?await cleanupOwned(admin,runId):{removed:[],remaining:[]};
      if(createdLegacy){assert.equal(git(['rev-parse','HEAD'],env,legacyRoot),COMBINED.legacy_schema_commit);assert.equal(git(['status','--porcelain'],env,legacyRoot),'');git(['worktree','remove',legacyRoot],env);receipt.legacyWorktreeRemoved=true;}
      else receipt.legacyWorktreeRemoved='not-created';
    }catch{receipt.success=false;receipt.cleanupFailed=true;}
    receipt.success=receipt.success&&receipt.cleanup?.removed?.length===0&&receipt.cleanup?.remaining?.length===0&&!receipt.cleanupFailed;
    writeManifest(path.join(out,'receipt.json'),receipt);await admin.end();if(!receipt.success)process.exitCode=1;
  }
  if(!receipt.success)throw new Error('Combined contract/cleanup failed');
  console.log('Combined contract receipt: '+path.join(out,'receipt.json'));return receipt;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e.message.replace(/postgres(?:ql)?:\/\/\S+/g,'[connection redacted]'));process.exitCode=1;});
