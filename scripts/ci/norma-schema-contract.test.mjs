import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { CONTRACT, checkEntryEnvironment, checkSchema, ownDatabase, validateReport } from './norma-contract-support.mjs';
import { parseArgs } from './run-norma-schema-contract.mjs';
const root=process.cwd();
function report(lane) {
  const expected=CONTRACT.lanes[lane];
  const files=expected.files.map(name=>({name:path.join(root,name),assertionResults:[]}));
  for (let i=0;i<expected.tests;i++) files[i%files.length].assertionResults.push({status:'passed',fullName:lane==='legacy'&&i<5?`seed ${CONTRACT.seeds[i]}: 80 lifecycles, zero invariant violations`:`case${i}`});
  return {success:true,numTotalTests:expected.tests,numPassedTests:expected.tests,numFailedTests:0,numPendingTests:0,numTodoTests:0,testResults:files};
}
for (const lane of ['legacy','postddl','upgrade']) test(`${lane} accepts complete exact collection`,()=>assert.equal(validateReport(report(lane),lane,root).tests,CONTRACT.lanes[lane].tests));
for (const change of [r=>r.success=false,r=>r.numPendingTests=1,r=>r.numTotalTests--,r=>r.numPassedTests--,r=>r.testResults.pop(),r=>r.testResults[0].assertionResults[0].status='skipped',r=>r.testResults[0].name=path.join(root,'wrong.test.ts'),r=>r.testResults[0].assertionResults.pop(),r=>r.testResults[0].assertionResults[0].fullName='no seed']) test(`false green refused: ${change}`,()=>{const r=report('legacy');change(r);assert.throws(()=>validateReport(r,'legacy',root));});
for (const key of ['NORMA_STRESS_SEED','NORMA_STRESS_LIFECYCLES','NORMA_STRESS_EXCLUDE_MIGRATIONS','NORMA_SCHEMA_CONTRACT_LANE','NORMA_DISPATCH_ENABLED','TEST_SUPABASE_DB_URL']) test(`external ${key} refused`,()=>assert.throws(()=>checkEntryEnvironment({[key]:''})));
test('only explicit source input allowed',()=>checkEntryEnvironment({NORMA_STRESS_SOURCE_DB_URL:'loopback'}));
for (const args of [[],['--skip','postddl'],['--output-directory','x','--lane','legacy'],['--output-directory']]) test(`arguments fail closed ${args}`,()=>assert.throws(()=>parseArgs(args)));
test('post-DDL cannot claim legacy schema',()=>assert.throws(()=>checkSchema({requests:true,attempt:true,legacy_claim:false,attempt_claim:true},'legacy')));
test('legacy cannot claim post-DDL schema',()=>assert.throws(()=>checkSchema({requests:true,attempt:false,legacy_claim:true,attempt_claim:false},'postddl')));
test('source with Norma relations refused',()=>assert.throws(()=>checkSchema({requests:true,attempt:false,legacy_claim:true,attempt_claim:false},'source')));
test('cleanup only owns exact run namespace',()=>{const id='0123456789abcdef';assert.ok(ownDatabase(`norma_schema_${id}_upgrade`,id));for (const name of ['norma_stress_other','norma_schema_ffffffffffffffff_upgrade',`norma_schema_${id}_evil";drop table x`]) assert.equal(ownDatabase(name,id),false);});

import {validateFixture} from './prepare-norma-fixture.mjs';
const fixtureEnv={GITHUB_ACTIONS:'true',E2E_DISPOSABLE_DATABASE:'1',E2E_CI_SUPABASE_DB_URL:'postgresql://postgres:postgres@127.0.0.1:55422/postgres'};
const config='project_id = "sandra-heavy-0123abcd"\n[db]\nport = 55422\n';
const labels={'com.supabase.cli.project':'sandra-heavy-0123abcd','com.supabase.cli.workdir':'/temp/sandra-heavy-Ab12cd'};
test('fixture admin preparation owns exact disposable container',()=>assert.equal(validateFixture(fixtureEnv,config,labels,'/temp/sandra-heavy-Ab12cd','/temp',{'5432/tcp':[{HostIp:'127.0.0.1',HostPort:'55422'}]}),'supabase_db_sandra-heavy-0123abcd'));
for (const [key,value] of [['GITHUB_ACTIONS','false'],['E2E_DISPOSABLE_DATABASE','0'],['E2E_CI_SUPABASE_DB_URL','postgresql://fake.example/db'],['DOCKER_HOST','ssh://remote']]) test(`fixture refuses ${key}`,()=>assert.throws(()=>validateFixture({...fixtureEnv,[key]:value},config,labels,'/temp/sandra-heavy-Ab12cd','/temp',{'5432/tcp':[{HostIp:'127.0.0.1',HostPort:'55422'}]})));
test('fixture refuses unrelated container label',()=>assert.throws(()=>validateFixture(fixtureEnv,config,{...labels,'com.supabase.cli.project':'sandra'},'/temp/sandra-heavy-Ab12cd','/temp',{'5432/tcp':[{HostIp:'127.0.0.1',HostPort:'55422'}]})));
test('fixture refuses outside runner directory',()=>assert.throws(()=>validateFixture(fixtureEnv,config,labels,'/elsewhere/sandra-heavy-Ab12cd','/temp',{'5432/tcp':[{HostIp:'127.0.0.1',HostPort:'55422'}]})));

test('fixture refuses another container port',()=>assert.throws(()=>validateFixture(fixtureEnv,config,labels,'/temp/sandra-heavy-Ab12cd','/temp',{'5432/tcp':[{HostIp:'127.0.0.1',HostPort:'56684'}]})));

import {subprocessEnvironment,validateUpgradeCases} from './norma-contract-support.mjs';
for (const key of ['PGHOSTADDR','PGSERVICE','PGPASSFILE','PGSSLMODE','PGOPTIONS','GIT_DIR','GIT_WORK_TREE','GIT_INDEX_FILE','GIT_CONFIG_COUNT','DOCKER_CONTEXT','DOCKER_CONFIG']) test(`subprocess override ${key} refused`,()=>assert.throws(()=>checkEntryEnvironment({[key]:'unsafe'})));
test('subprocess environment strips connection/credential/context settings',()=>assert.deepEqual(subprocessEnvironment({PATH:'/bin',HOME:'/home/test',PGHOSTADDR:'remote',GIT_DIR:'other',DOCKER_CONTEXT:'remote',BLAND_API_KEY:'dummy'}),{PATH:'/bin',HOME:'/home/test',NODE_ENV:'test',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}));
function upgradeReport() {return {testResults:[{assertionResults:Array.from({length:20},(_,i)=>({ancestorTitles:['upgrade','suite'],title:`case${i}`,fullName:`upgrade suite case${i}`}))}]};}
const cases=()=>Array.from({length:20},(_,i)=>({test:`upgrade > suite > case${i}`}));
test('upgrade receipts map one-to-one to collected tests',()=>validateUpgradeCases(cases(),upgradeReport()));
for (const mutate of [c=>c[19]=c[0],c=>c.pop(),c=>c[0].test='uncollected case']) test(`upgrade identity drift refused ${mutate}`,()=>{const c=cases();mutate(c);assert.throws(()=>validateUpgradeCases(c,upgradeReport()));});
for (const key of ['PGHOSTADDR','GIT_DIR','DOCKER_CONTEXT','DOCKER_CONFIG']) test(`fixture subprocess override ${key} refused`,()=>assert.throws(()=>validateFixture({...fixtureEnv,[key]:'unsafe'},config,labels,'/temp/sandra-heavy-Ab12cd','/temp',{'5432/tcp':[{HostIp:'127.0.0.1',HostPort:'55422'}]})));
