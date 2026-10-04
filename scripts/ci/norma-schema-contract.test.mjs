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
