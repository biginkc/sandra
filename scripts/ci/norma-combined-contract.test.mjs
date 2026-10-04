import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {checkEntryEnvironment} from './norma-contract-support.mjs';
import {COMBINED,checkCombinedCheckout,checkCombinedLane,validateCombinedReport} from './norma-combined-support.mjs';
import {parseCombinedArgs} from './run-norma-combined-contract.mjs';
const root=process.cwd();
function report(lane) {
 const expected=COMBINED.lanes[lane],files=expected.files.map(name=>({name:path.join(root,name),assertionResults:[]}));
 for(let i=0;i<expected.tests;i++)files[i%files.length].assertionResults.push({status:'passed',title:'case'+i,ancestorTitles:['test'],fullName:lane==='paired'&&i<5?`seed ${COMBINED.seeds[i]}: 80 lifecycles`:'case'+i});
 return {success:true,numTotalTests:expected.tests,numPassedTests:expected.tests,numFailedTests:0,numPendingTests:0,numTodoTests:0,testResults:files};
}
for(const lane of ['paired','controls'])test(lane+' requires the exact full positive collection',()=>validateCombinedReport(report(lane),lane,root));
for(const mutation of [r=>r.success=false,r=>r.numPassedTests--,r=>r.numTotalTests--,r=>r.numPendingTests=1,r=>r.testResults.pop(),r=>r.testResults[0].assertionResults[0].status='skipped',r=>r.testResults[0].assertionResults[0].fullName='missing seed',r=>r.testResults[0].assertionResults.pop(),r=>r.testResults[1].assertionResults[0]=r.testResults[0].assertionResults[0]])test('combined false green refused '+mutation,()=>{const r=report('paired');mutation(r);assert.throws(()=>validateCombinedReport(r,'paired',root));});
for(const args of [[],['--profile','schema-only'],['--output-directory','x','--skip','legacy'],['--output-directory',root],['--output-directory',path.join(root,'work/output')]])test('combined profile arguments refuse '+args,()=>assert.throws(()=>parseCombinedArgs(args)));
for(const key of ['NORMA_COMBINED_PROFILE','NORMA_SCHEMA_CONTRACT_LANE','NORMA_MAINTENANCE_HOLD','NORMA_STRESS_EXCLUDE_MIGRATIONS'])test('external combined override '+key+' refused',()=>assert.throws(()=>checkEntryEnvironment({[key]:'paired'})));
test('assembled sources and immutable paired assertions match explicit manifest',()=>checkCombinedCheckout(root));
test('legacy lane cannot impersonate combined paired lane',()=>assert.throws(()=>checkCombinedLane({NORMA_SCHEMA_CONTRACT_LANE:'legacy'})));
