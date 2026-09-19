// Actual core retry, dedicated database role, immutable accepted step identity.
import pg from 'pg';
import {createRunner,databaseConfiguration} from './core.mjs';
if(process.env.INBOX_ACTION_LOCAL_FIXTURE!=='1')throw Error('Owned proof required');
const [orgId,operationId]=process.argv.slice(2);
const pool=new pg.Pool({...databaseConfiguration(process.env),max:1,application_name:'sandra-inbox-action-deadlock-proof'});
const attempts=[];
const observed={query:async(statement,args)=>{try{return await pool.query(statement,args);}catch(error){if(statement.includes('run_step'))attempts.push({code:error.code,args});throw error;}}};
try{
 const runner=createRunner(observed),operation=await runner.load({orgId,operationId});
 const stepId=operation.steps[0],result=await runner.step(operation,stepId);
 if(attempts.length!==1||attempts[0].code!=='40P01'||JSON.stringify(attempts[0].args)!==JSON.stringify([orgId,operationId,stepId]))throw Error('Expected exact actual worker deadlock victim and same identity retry');
 console.log(JSON.stringify({result,aborted:attempts}));
}finally{await pool.end();}
