import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const cluster=mkdtempSync('/tmp/sandra-dm-db-');
const sock=mkdtempSync('/tmp/sdm-');
const port=6543;
const postgresBin = process.env.SANDRA_POSTGRES_BIN || execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim();
const run=(cmd,args)=>execFileSync(join(postgresBin,cmd),args,{stdio:'pipe',env:{...process.env,LC_ALL:'C'}});
const sql=(text)=>run('psql',['-h',sock,'-p',String(port),'-U','postgres','-At','-v','ON_ERROR_STOP=1','-c',text]).toString().trim();
let started=false;
try {
 run('initdb',['-D',cluster,'-A','trust','-U','postgres']);
 run('pg_ctl',['-D',cluster,'-o',`-p ${port} -k ${sock} -c listen_addresses=''`,'-l',join(cluster,'server.log'),'start']);started=true;
 sql(`create role anon; create role authenticated; create role service_role;
 create table properties (id uuid primary key,org_id uuid not null);
 create table contacts(id uuid primary key default gen_random_uuid(),org_id uuid not null,contact_type text,first_name text,last_name text,entity_name text,phone_1 text,phone_2 text,phone_3 text,phone_1_type text,phone_2_type text,phone_3_type text,email text,do_not_contact boolean default false,created_at timestamptz default now());
 create table property_contacts(property_id uuid references properties,contact_id uuid references contacts,org_id uuid,relationship text,source_identity text,source_position smallint check(source_position between 1 and 8),source_attributes jsonb,created_at timestamptz default now(),updated_at timestamptz default now(),primary key(property_id,relationship,source_identity));
 insert into properties values ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-00000000000a');`);
 sql(readFileSync(new URL('../supabase/migrations/20261027222111_dealmachine_property_contacts.sql',import.meta.url),'utf8'));
 const call=(id,dnc=false,org='a')=>`select upsert_dealmachine_property_contact('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-00000000000${org}','${id}',1::smallint,'{"email_address_3":"third@example.com"}','{"first_name":"Person","last_name":"${id}","phone_1":"+1417555010${id}","phone_1_type":"mobile","do_not_contact":${dnc}}');`;
 const first=sql(call('1'));assert.equal(sql(call('1')),first);
 sql(call('2',true));assert.equal(sql('select count(*) from property_contacts'),'2');
 assert.equal(sql('select count(*) from contacts'),'2');
 sql(call('1',true));sql(call('1',false));
 assert.equal(sql('select count(*) from contacts where do_not_contact'),'2');
 assert.equal(sql("select count(*) from property_contacts where source_attributes->>'email_address_3'='third@example.com'"),'2');
 assert.throws(()=>sql(call('3',false,'b')));
 assert.equal(sql("select has_function_privilege('authenticated','public.upsert_dealmachine_property_contact(uuid,uuid,text,smallint,jsonb,jsonb)','EXECUTE')"),'f');
 console.log('PASS: separate people, retry idempotency, metadata, DNC ratchet, organization and browser-role guards');
} finally {
 if(started)run('pg_ctl',['-D',cluster,'stop','-m','immediate']);
 rmSync(cluster,{recursive:true,force:true});rmSync(sock,{recursive:true,force:true});
}
