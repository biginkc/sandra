const fs = require('fs');
const crypto = require('crypto');
const { Client } = require('pg');
const root = process.env.PERF_RUN_DIR;
const phase = process.argv[2];
if (!['baseline', 'after'].includes(phase)) throw new Error('phase');
const { org } = JSON.parse(fs.readFileSync(`${root}/identity.json`));
const client = new Client({ connectionString: process.env.PERF_DATABASE_URL });
const N = 2000;
const uuid = () => crypto.randomUUID();
const ms = d => Number(d) / 1e6;
async function main() {
  await client.connect();
  const result = await client.query('SELECT id, homeowner_contact_id AS contact_id FROM public.properties WHERE org_id=$1 AND homeowner_contact_id IS NOT NULL ORDER BY id LIMIT $2', [org,N]);
  if (result.rows.length !== N) throw new Error('Insufficient fixture properties');
  const rows = result.rows;
  const updateIds = Array.from({length:N},uuid), deleteIds = Array.from({length:N},uuid);
  const prep = async ids => {
    for(let i=0;i<N;i+=100){
      const values=[], parts=[];
      ids.slice(i,i+100).forEach((id,j)=>{ const k=i+j; parts.push(`($${values.length+1},$${values.length+2},$${values.length+3},$${values.length+4},'sms','outbound','queued','D7 queued','+18162804181','+15559990000')`); values.push(id,org,rows[k].contact_id,rows[k].id); });
      await client.query(`INSERT INTO public.messages(id,org_id,contact_id,property_id,channel,direction,status,body,from_address,to_address) VALUES ${parts.join(',')}`,values);
    }
  };
  await prep(updateIds); await prep(deleteIds);
  const samples = fs.createWriteStream(`${root}/${phase}-samples.csv`); samples.write('operation,iteration,ms\n');
  const operations = [
    ['message_insert_inbound',i=>['INSERT INTO public.messages(id,org_id,conversation_id,contact_id,property_id,channel,direction,status,body,from_address,to_address) VALUES($1,$2,$3,$4,$5,\'sms\',\'inbound\',\'received\',\'D7 measured inbound\',\'+15559990000\',\'+18162804181\')',[uuid(),org,uuid(),rows[i].contact_id,rows[i].id]]],
    ['message_update_queued_sent',i=>['UPDATE public.messages SET status=\'sent\',sent_at=now() WHERE id=$1',[updateIds[i]]]],
    ['message_delete_queued',i=>['DELETE FROM public.messages WHERE id=$1',[deleteIds[i]]]],
    ['contact_update',i=>['UPDATE public.contacts SET notes=$2 WHERE id=$1',[rows[i].contact_id,`D7 ${phase} ${i}`]]],
    ['property_update',i=>['UPDATE public.properties SET notes=$2 WHERE id=$1',[rows[i].id,`D7 ${phase} ${i}`]]],
    ['consent_insert',i=>['INSERT INTO public.consent_events(id,org_id,contact_id,channel,event_type,source) VALUES($1,$2,$3,\'sms\',\'help_request\',\'d7_measure\')',[uuid(),org,rows[i].contact_id]]],
  ];
  for(const [name, make] of operations){
    for(let i=0;i<N;i++){
      const [sql,params]=make(i); const start=process.hrtime.bigint();
      await client.query(sql,params); const elapsed=process.hrtime.bigint()-start;
      samples.write(`${name},${i},${ms(elapsed).toFixed(6)}\n`);
    }
    console.log(`${phase} ${name} complete`);
  }
  await new Promise(resolve=>samples.end(resolve));
  await client.end();
}
main().catch(async e=>{console.error(e);try{await client.end()}catch{} process.exit(1)});
