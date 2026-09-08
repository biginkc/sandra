#!/usr/bin/env node
// One-time server operator command. Never imported by application code.
import { Client } from 'pg';
const apply = process.argv.includes('--apply');
const local = process.argv.includes('--local-rehearsal');
if (process.argv.slice(2).some(arg => !['--apply', '--local-rehearsal'].includes(arg))) throw new Error('Supported flags: --apply, --local-rehearsal; default is read-only.');
const ORG = '00000000-0000-0000-0000-000000000bbb';
const CONTACT = 'b4b8d7cb-d51e-4af8-888a-a15e07001961';
const PROPERTY = 'b4b8d7cb-d51e-4af8-888a-a15e07001962';
const NOTE = 'b4b8d7cb-d51e-4af8-888a-a15e07001963';
const PHONE = '+18165440196';
const REVISION = 'd49eb24670e6347c4367919473fc3cfadbe97087cd1b8b5896ec0e2921f43c51';
const profile = `Internal training only — fictional Jordan Ellis homeowner profile, age 47. Source Switchboard configuration revision ${REVISION}. Owner-occupied 1978 ranch at 1842 Lantern Finch Lane, Maple Glen, Missouri; 3 bedrooms, 2 bathrooms, 1,480 square feet. Mortgage balance $142,000; desired sale price $210,000. Aging roof needs replacement, dated kitchen, crawlspace dampness. Moving closer to an adult daughter; cannot fund repairs. Preferred move in 60 days; needs 21 days occupancy after closing. Sole title owner; consults a trusted sister who is not an owner. Wants an as-is sale with no seller fees. Cannot cover a mortgage shortfall. This is a configuration profile note, not contact history or consent.`;
const url = process.env.SANDRA_PRODUCTION_DATABASE_URL;
if (!url) throw new Error('SANDRA_PRODUCTION_DATABASE_URL must be supplied by the authorized server operator.');
const target = new URL(url);
const project = 'copflsklaefwzipsrjqz';
if (local && (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) || !/^\/seed_jordan_rehearsal_[0-9]+$/.test(target.pathname))) throw new Error('Local rehearsal requires the dedicated loopback fixture database.');
if (!local && target.hostname !== `db.${project}.supabase.co` && !decodeURIComponent(target.username).endsWith(`.${project}`)) throw new Error('Connection must target the reviewed Sandra production project.');
const client = new Client({ connectionString: url, application_name: 'seed-jordan-training', connectionTimeoutMillis: 15000 });
try {
  await client.connect();
  await client.query(apply ? 'begin' : 'begin read only');
  await client.query("set local lock_timeout='5s'");
  await client.query("set local statement_timeout='20s'");
  // Match the existing privileged migration workflow. No JWT/key is manufactured.
  const actor = await client.query('select current_user as role');
  if (!['postgres', 'service_role'].includes(actor.rows[0].role)) throw new Error('Privileged server database connection required.');
  await client.query("select set_config('request.jwt.claim.role','service_role',true)");
  const guards = await client.query("select count(*)::int as n from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace ns on ns.oid=c.relnamespace where ns.nspname='public' and not t.tgisinternal and t.tgenabled in ('O','A') and (c.relname,t.tgname) in (('properties','guard_training_property'),('contacts','guard_training_contact'),('messages','guard_training_messages'),('sequence_enrollments','guard_training_enrollments'),('tasks','guard_training_tasks'),('esign_requests','guard_training_esign'),('consent_events','guard_training_consent'))");
  const marker = await client.query("select 1 from information_schema.columns where table_schema='public' and table_name='properties' and column_name='is_training'");
  if (!marker.rowCount || guards.rows[0].n !== 7) throw new Error('Training guards must be deployed before seeding.');
  if (apply) await client.query('lock table public.contacts, public.properties, public.lead_notes in share row exclusive mode');
  const contacts = await client.query('select id,org_id,first_name,last_name,phone_1,phone_2,phone_3,email from public.contacts where id=$1 or $2 in (phone_1,phone_2,phone_3)', [CONTACT, PHONE]);
  const properties = await client.query('select id,org_id,homeowner_contact_id,is_training,status,address,city,state,is_dnc_locked,outreach_dispo,ai_responder_disabled,skip_trace_disabled from public.properties where id=$1 or homeowner_contact_id=$2 or (address=$3 and city=$4)', [PROPERTY, CONTACT, '1842 Lantern Finch Lane','Maple Glen']);
  const notes = await client.query('select id,property_id,org_id,body from public.lead_notes where id=$1', [NOTE]);
  if (contacts.rowCount || properties.rowCount || notes.rowCount) {
    const c=contacts.rows[0], p=properties.rows[0], n=notes.rows[0];
    if (contacts.rowCount!==1 || properties.rowCount!==1 || notes.rowCount!==1 || c.id!==CONTACT || c.org_id!==ORG || c.first_name!=='Jordan' || c.last_name!=='Ellis' || c.phone_1!==PHONE || c.phone_2 || c.phone_3 || c.email || p.id!==PROPERTY || p.org_id!==ORG || p.homeowner_contact_id!==CONTACT || !p.is_training || p.status!=='new_lead' || p.address!=='1842 Lantern Finch Lane' || p.city!=='Maple Glen' || p.state!=='MO' || p.is_dnc_locked || p.outreach_dispo || !p.ai_responder_disabled || !p.skip_trace_disabled || n.property_id!==PROPERTY || n.org_id!==ORG || n.body!==profile) throw new Error('Existing seed identity conflicts or is incomplete; no records changed. Review privately.');
    console.log(JSON.stringify({ action:'already_seeded', property_id:PROPERTY, revision:REVISION }));
  } else if (!apply) {
    console.log(JSON.stringify({ action:'would_create', property_id:PROPERTY, revision:REVISION }));
  } else {
    // Existing lead-intake mechanism preserves an unverified type; transaction-local only.
    await client.query("select set_config('sandra.allow_unverified_lead_phone','on',true)");
    await client.query('insert into public.contacts(id,org_id,first_name,last_name,phone_1) values($1,$2,$3,$4,$5)',[CONTACT,ORG,'Jordan','Ellis',PHONE]);
    await client.query('insert into public.properties(id,org_id,address,city,state,homeowner_contact_id,is_training,ai_responder_disabled,skip_trace_disabled,status,year_built,beds,baths,sqft,mortgage_balance,listing_price,is_vacant,absentee_flag,notes) values($1,$2,$3,$4,$5,$6,true,true,true,$7,1978,3,2,1480,142000,210000,false,false,$8)',[PROPERTY,ORG,'1842 Lantern Finch Lane','Maple Glen','MO',CONTACT,'new_lead',profile]);
    await client.query('insert into public.lead_notes(id,org_id,property_id,body) values($1,$2,$3,$4)',[NOTE,ORG,PROPERTY,profile]);
    console.log(JSON.stringify({ action:'created_in_transaction', property_id:PROPERTY, revision:REVISION }));
  }
  await client.query(apply ? 'commit' : 'rollback');
  console.log(apply ? 'Seed transaction committed.' : 'Dry run complete; no records changed.');
} catch {
  await client.query('rollback').catch(()=>{});
  console.error('Jordan seed failed; transaction rolled back. Check guards and conflicting seed identity using protected operator diagnostics.');
  process.exitCode=1;
} finally { await client.end().catch(()=>{}); }
