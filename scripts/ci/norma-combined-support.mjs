import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import path from 'node:path';
import {CONTRACT,sha256} from './norma-contract-support.mjs';

export const COMBINED=JSON.parse(readFileSync(new URL('./norma-combined-contract.json',import.meta.url),'utf8'));
export function checkCombinedCheckout(root) {
  assert.equal(COMBINED.profile,'combined-explicit-legacy-and-paired-maintenance');
  assert.equal(COMBINED.legacy_schema_commit,'e94aef50332c5b2e6074cb8eb365d5ecebe87ee9');
  assert.equal(COMBINED.legacy_gate_commit,'b80253189e2cba9fdaaa2306c52f8899db7fabf7');
  assert.equal(COMBINED.paired_fixture_refinement.reviewed_legacy_commit,COMBINED.legacy_gate_commit);
  assert.equal(COMBINED.paired_fixture_refinement.file,'src/lib/norma/stress/teeth.integration.test.ts');
  assert.equal(COMBINED.paired_fixture_refinement.sha256,COMBINED.combined_sources[COMBINED.paired_fixture_refinement.file]);
  assert.equal(Object.keys(COMBINED.paired_assertion_sources).length,11);
  assert.equal(COMBINED.paired_assertion_sources[COMBINED.paired_fixture_refinement.file],undefined);
  for(const [file,hash] of Object.entries(COMBINED.paired_support_sources))assert.equal(hash,COMBINED.combined_sources[file],'Support pin must equal assembled pin');
  for(const file of ['vitest.config.ts','vitest.norma-stress.config.ts',...readdirSync(path.join(root,'src/lib/norma/stress')).filter(f=>f.endsWith('.ts')&&!f.endsWith('.integration.test.ts')).map(f=>'src/lib/norma/stress/'+f)]){assert.ok(COMBINED.combined_sources[file],'Missing assertion-support pin: '+file);if(file!=='src/lib/norma/stress/db.ts')assert.equal(COMBINED.paired_support_sources[file],COMBINED.combined_sources[file]);}
  assert.equal(COMBINED.paired_input_commit,'d2edabac632a7196820ff7c4a84fc620177211ee');
  assert.deepEqual(COMBINED.seeds,[101,202,303,404,505]);assert.equal(COMBINED.lifecycles,80);
  assert.deepEqual(Object.values(COMBINED.lanes).map(l=>l.tests),[176,19]);
  for(const lane of Object.values(COMBINED.lanes))assert.equal(lane.assertion_identities.length,lane.tests);
  assert.deepEqual(COMBINED.norma_migrations,CONTRACT.norma_migrations);
  assert.deepEqual(readdirSync(path.join(root,'supabase/migrations')).filter(f=>/^\d{14}_norma_.+\.sql$/.test(f)).map(f=>'supabase/migrations/'+f).sort(),Object.keys(CONTRACT.norma_migrations).sort());
  for (const [file,hash] of Object.entries({...COMBINED.norma_migrations,...COMBINED.paired_assertion_sources,...COMBINED.combined_sources})) assert.equal(sha256(readFileSync(path.join(root,file))),hash,'Combined source drift: '+file);
  const files=readdirSync(path.join(root,'src/lib/norma/stress')).filter(f=>f.endsWith('.integration.test.ts')).map(f=>'src/lib/norma/stress/'+f).sort();
  assert.deepEqual(files,COMBINED.lanes.paired.files,'Combined paired collection drift');
}
export function checkCombinedLane(env) {
  assert.equal(env.NORMA_SCHEMA_CONTRACT_LANE,'paired');
  assert.equal(env.NORMA_COMBINED_PROFILE,COMBINED.profile);
  assert.match(env.NORMA_SCHEMA_CONTRACT_RUN_ID??'',/^[a-f0-9]{16}$/);
  assert.equal(env.NORMA_STRESS_EXCLUDE_MIGRATIONS,'');
  assert.equal(env.NORMA_STRESS_SEED,'101,202,303,404,505');assert.equal(env.NORMA_STRESS_LIFECYCLES,'80');
  assert.equal(env.NORMA_MAINTENANCE_HOLD,'false','Positive lane is explicitly released; held behavior is tested separately');
  assert.match(env.NORMA_SCHEMA_SOURCE_SHA256??'',/^[a-f0-9]{64}$/);
  assert.equal(sha256(readFileSync(env.NORMA_SCHEMA_SOURCE_DUMP)),env.NORMA_SCHEMA_SOURCE_SHA256);
  assert.ok(env.NORMA_SCHEMA_MANIFEST_DIRECTORY);
  return 'paired';
}
export function validateCombinedReport(report,lane,root) {
  const expected=COMBINED.lanes[lane];assert.ok(expected);
  assert.equal(report.success,true);for(const k of ['numFailedTests','numPendingTests','numTodoTests'])assert.equal(report[k],0);
  assert.equal(report.numTotalTests,expected.tests);assert.equal(report.numPassedTests,expected.tests);
  assert.deepEqual(report.testResults.map(r=>path.relative(root,r.name).replaceAll('\\','/')).sort(),expected.files);
  const assertions=report.testResults.flatMap(r=>r.assertionResults);assert.equal(assertions.length,expected.tests);
  assert.ok(assertions.every(a=>a.status==='passed'));
  const identities=report.testResults.flatMap(f=>f.assertionResults.map(a=>JSON.stringify([path.relative(root,f.name).replaceAll('\\','/'),a.ancestorTitles,a.title]))).sort();
  assert.deepEqual(identities,expected.assertion_identities.map(a=>JSON.stringify(a)).sort(),'Assertion identity/multiplicity drift');
  if(lane==='paired')for(const seed of COMBINED.seeds)assert.equal(assertions.filter(a=>a.fullName.includes(`seed ${seed}: 80 lifecycles`)).length,1,'Missing paired seed '+seed);
  return {tests:expected.tests,files:expected.files,allAssertionsPassed:true};
}
