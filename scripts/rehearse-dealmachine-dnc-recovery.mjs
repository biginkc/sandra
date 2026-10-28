import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const cluster=mkdtempSync('/tmp/sandra-dnc-repair-');
const sock=mkdtempSync('/tmp/sdr-');
const bin=execFileSync('pg_config',['--bindir'],{encoding:'utf8'}).trim();
const run=(cmd,args,input)=>execFileSync(join(bin,cmd),args,{input,stdio:'pipe',env:{...process.env,LC_ALL:'C'}});
const sql=text=>run('psql',['-h',sock,'-p','6544','-U','postgres','-At','-v','ON_ERROR_STOP=1'],text).toString().trim();
let started=false;
try {
  run('initdb',['-D',cluster,'-A','trust','-U','postgres']);
  run('pg_ctl',['-D',cluster,'-o',`-p 6544 -k ${sock} -c listen_addresses=''`,'-l',join(cluster,'server.log'),'start']); started=true;
  sql(`create role anon; create role authenticated; create role service_role;
    create table contacts(id uuid primary key,org_id uuid,created_at timestamptz,do_not_contact boolean,sms_opted_out boolean,phone_1 text,phone_2 text,phone_3 text);
    alter table contacts add column phone_digits text generated always as (replace(phone_1,'+','')) stored;
    create table campaigns(id uuid primary key,org_id uuid,name text);
    create table properties(id uuid primary key,homeowner_contact_id uuid,is_dnc_locked boolean);
    create table property_contacts(property_id uuid,contact_id uuid,org_id uuid,relationship text,created_at timestamptz);
    create table campaign_recipients(campaign_id uuid,property_id uuid,contact_id uuid);
    create table consent_events(contact_id uuid,event_type text);
    create table global_phone_dnc_registry(org_id uuid,phone_e164 text);
    create function contacts_true_dnc_lock_guard() returns trigger language plpgsql as $$begin
      if old.do_not_contact and not new.do_not_contact then raise exception 'DNC_LOCKED'; end if; return new; end;$$;
    create trigger contacts_true_dnc_lock_guard before update on contacts for each row execute function contacts_true_dnc_lock_guard();
    insert into campaigns values(md5('campaign')::uuid,md5('org')::uuid,'10.27.26-AbsenteeOwner-Fresh(MO-6-Counties)-SMS-DealMachine');
    insert into contacts(id,org_id,created_at,do_not_contact,sms_opted_out,phone_1,phone_2,phone_3) select md5(i::text)::uuid,md5('org')::uuid,'2026-10-27T23:30:00Z',true,false,'+1555000000'||i,null,null from generate_series(1,8) i;
    insert into properties select id,id,false from contacts;
    insert into property_contacts select id,id,org_id,'dealmachine_contact',created_at from contacts;
    insert into campaign_recipients select md5('campaign')::uuid,id,id from contacts;
    -- 1 and 2 eligible. Six independent protections must exclude 3 through 8.
    update contacts set created_at='2026-10-26T12:00:00Z' where id=md5('3')::uuid;
    update contacts set sms_opted_out=true where id=md5('4')::uuid;
    insert into consent_events values(md5('5')::uuid,'opt_out');
    update properties set is_dnc_locked=true where id=md5('6')::uuid;
    insert into global_phone_dnc_registry values(md5('org')::uuid,'+15550000007');
    update property_contacts set relationship='other_source' where contact_id=md5('8')::uuid;`);
  const originalGuard=sql("select pg_get_functiondef('contacts_true_dnc_lock_guard()'::regprocedure)");
  const migration=readFileSync(new URL('../supabase/migrations/20261028025659_correct_dealmachine_import_dnc.sql',import.meta.url),'utf8');
  // Production cohort fingerprint remains fixed in the actual migration.
  // Substitute only the fixture count/fingerprint for this isolated rehearsal.
  const digest=sql("select md5(string_agg(id::text,',' order by id)) from contacts where id in(md5('1')::uuid,md5('2')::uuid)");
  const fixtureMigration=migration.replace('candidate_count <> 9465','candidate_count <> 2').replace('a677abb5f321c7759d96b5526faf88dd',digest);
  assert.throws(()=>sql(migration),/Recovery cohort changed/);
  assert.equal(sql('select count(*) from contacts where not do_not_contact'),'0');
  assert.equal(sql("select to_regclass('public.dealmachine_import_dnc_corrections') is null"),'t');
  sql(fixtureMigration);
  assert.equal(sql('select count(*) from contacts where not do_not_contact'),'2');
  assert.equal(sql('select count(*) from contacts where do_not_contact'),'6');
  assert.equal(sql('select count(*) from dealmachine_import_dnc_corrections'),'2');
  assert.equal(sql("select pg_get_functiondef('contacts_true_dnc_lock_guard()'::regprocedure)"),originalGuard);
  assert.throws(()=>sql("update contacts set do_not_contact=false where id=md5('3')::uuid"),/DNC_LOCKED/);
  sql("update contacts set do_not_contact=true where id=md5('1')::uuid");
  assert.throws(()=>sql("update contacts set do_not_contact=false where id=md5('1')::uuid"),/DNC_LOCKED/);
  assert.throws(()=>sql('set role authenticated; select * from dealmachine_import_dnc_corrections'),/permission denied/);
  console.log('PASS: exact-cohort fail-closed rollback; vendor-created contacts corrected; prior contacts, STOP, consent opt-outs, property locks, global DNC and other sources preserved; original guard restored; audit inaccessible to browser role.');
} finally {
  if(started)run('pg_ctl',['-D',cluster,'stop','-m','immediate']);
  rmSync(cluster,{recursive:true,force:true});rmSync(sock,{recursive:true,force:true});
}
