import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { expect, it } from 'vitest';
import { loadTestEnv } from '@tests/integration/env';
import { requireLoopbackPostgresUrl } from '@/lib/testing/loopback-postgres-url';

const sql=readFileSync(new URL('./20261003120000_my_leads_queue_row_lookup.sql',import.meta.url),'utf8');
const url=process.env.TEST_SUPABASE_DB_URL??loadTestEnv().TEST_SUPABASE_DB_URL;

it('returns a queue row identical to the page row, or a precise unavailable reason, with scoped access',async()=>{
  if(!url) throw new Error('Missing TEST_SUPABASE_DB_URL');
  // Loopback only, on whichever port the local stack or the CI disposable stack (54322) uses.
  requireLoopbackPostgresUrl(url);
  if(!/^begin;\s*/i.test(sql)||!/\s*commit;\s*$/i.test(sql)) throw new Error('Migration transaction wrapper changed');
  const db=new Client({connectionString:url});
  await db.connect();
  try {
    await db.query('begin');
    await db.query(sql.replace(/^begin;\s*/i,'').replace(/\s*commit;\s*$/i,''));
    const org=randomUUID(), owner=randomUUID(), rep=randomUUID(), other=randomUUID(), outsider=randomUUID();
    for(const id of [owner,rep,other,outsider]) await db.query('insert into auth.users(id) values ($1)',[id]);
    await db.query("insert into public.organizations(id,name) values ($1,'Row lookup')",[org]);
    await db.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'owner')",[owner,org]);
    for(const id of [rep,other,outsider]) await db.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'member')",[id,org]);
    await db.query('insert into public.acquisition_org_settings(org_id,my_leads_enabled) values ($1,true)',[org]);
    await db.query("select set_config('request.jwt.claim.sub',$1,true)",[owner]);
    for(const id of [rep,other]) {
      await db.query("select set_config('my_leads.designation_update',$1,true)",[`${owner}:${org}:${id}`]);
      await db.query('update public.memberships set acquisitions_enabled=true where user_id=$1 and org_id=$2',[id,org]);
    }
    await db.query("select set_config('my_leads.designation_update','',true)");
    const ids=Object.fromEntries(['found','unassigned','otherRep','closed','dead','dncLocked','archived','noEpisode','deleted','contactDnc','foreignEpisode'].map(k=>[k,randomUUID()]));
    for(const [key,id] of Object.entries(ids)) {
      const assignee=key==='unassigned'?null:key==='otherRep'?other:rep;
      await db.query("insert into public.properties(id,org_id,address,state,status,assigned_user_id) values ($1,$2,$3,'MO','new_lead',$4)",[id,org,`${key} Main`,assignee]);
    }
    await db.query("update public.properties set status='closed' where id=$1",[ids.closed]);
    await db.query("update public.properties set status='dead' where id=$1",[ids.dead]);
    await db.query("update public.properties set is_dnc_locked=true where id=$1",[ids.dncLocked]);
    await db.query("update public.properties set deleted_at=now() where id=$1",[ids.deleted]);
    await db.query("insert into public.acquisition_queue_states(property_id,org_id,stage,stage_entered_at,archived_at,archived_by,archive_reason) values ($1,$2,'contacted',now(),now(),$3,'manual')",[ids.archived,org,owner]);
    await db.query("update public.acquisition_assignment_episodes set ended_at=clock_timestamp()+interval '1 minute' where property_id=$1 and ended_at is null",[ids.noEpisode]);

    // Contact-level DNC (property itself not locked) stays in the queue.
    const contact=randomUUID();
    await db.query("insert into public.contacts(id,org_id,first_name,last_name,do_not_contact) values ($1,$2,'Dee','Enn',true)",[contact,org]);
    await db.query('update public.properties set homeowner_contact_id=$1 where id=$2',[contact,ids.contactDnc]);
    // A DNC contact normally locks its property (guard triggers). Bypass them for this fixture
    // only, so the projection's contactDnc flag is exercised with an unlocked property.
    await db.query("set local session_replication_role='replica'");
    await db.query('update public.properties set is_dnc_locked=false where id=$1',[ids.contactDnc]);
    await db.query("set local session_replication_role='origin'");
    // Assigned to rep, but the open episode belongs to another member.
    await db.query('update public.acquisition_assignment_episodes set assignee_user_id=$1 where property_id=$2 and ended_at is null',[other,ids.foreignEpisode]);
    // Foreign org with its own property.
    const org2=randomUUID(), foreign=randomUUID();
    await db.query("insert into public.organizations(id,name) values ($1,'Other org')",[org2]);
    await db.query("insert into public.properties(id,org_id,address,state,status) values ($1,$2,'Foreign Main','MO','new_lead')",[foreign,org2]);

    const as=async<T>(role:'authenticated'|'anon',sub:string|null,fn:()=>Promise<T>)=>{
      await db.query(`set local role ${role}`);
      await db.query("select set_config('request.jwt.claim.role',$1,true)",[role]);
      await db.query("select set_config('request.jwt.claim.sub',$1,true)",[sub??'']);
      try { return await fn(); } finally { await db.query('reset role').catch(()=>{}); }
    };
    const lookup=async(sub:string,member:string,property:string)=>as('authenticated',sub,async()=>
      (await db.query('select public.fn_get_my_leads_queue_row($1,$2,$3) as r',[org,member,property])).rows[0].r);
    const expectError=async(run:()=>Promise<unknown>,pattern:RegExp)=>{
      await db.query('savepoint s');
      let failure:unknown=null;
      try { await run(); } catch(error) { failure=error; }
      await db.query('rollback to savepoint s');
      await db.query('reset role');
      expect(String((failure as Error)?.message)).toMatch(pattern);
    };

    // found: identical to the row the queue page returns.
    const found=await lookup(rep,rep,ids.found);
    expect(found.status).toBe('found');
    expect(new Date(found.snapshotAt).getTime()).toBeGreaterThan(0);
    const page=await as('authenticated',rep,async()=>
      (await db.query('select public.fn_get_acquisition_queue_page($1,$2) as p',[org,rep])).rows[0].p);
    const pageRows=Object.values(page.stages as Record<string,{rows:{propertyId:string}[]}>).flatMap(s=>s.rows);
    expect(pageRows.find(r=>r.propertyId===ids.found)).toEqual(found.row);
    expect(found.row.propertyId).toBe(ids.found);
    // The owner may read the rep's row.
    expect((await lookup(owner,rep,ids.found)).row).toEqual(found.row);

    // No acquisition_queue_states row: still found, as not_contacted at version 0.
    expect((await db.query('select 1 from public.acquisition_queue_states where property_id=$1',[ids.found])).rowCount).toBe(0);
    expect(found.row).toMatchObject({stage:'not_contacted',queueVersion:0,contactDnc:false});
    // Contact-level DNC with an unlocked property is found, flagged.
    const dnc=await lookup(rep,rep,ids.contactDnc);
    expect(dnc.status).toBe('found');
    expect(dnc.row).toMatchObject({propertyId:ids.contactDnc,contactDnc:true,contactId:contact});
    // Open episode owned by another member: not in this member's queue.
    expect(await lookup(rep,rep,ids.foreignEpisode)).toEqual({status:'unavailable',reason:'no_active_episode'});
    // Another org's property is not_found, with no row, for both rep and owner.
    expect(await lookup(rep,rep,foreign)).toEqual({status:'unavailable',reason:'not_found'});
    expect(await lookup(owner,rep,foreign)).toEqual({status:'unavailable',reason:'not_found'});

    // Reason codes (rep reading their own queue).
    const reason=async(key:keyof typeof ids)=>(await lookup(rep,rep,ids[key]));
    expect(await lookup(rep,rep,randomUUID())).toEqual({status:'unavailable',reason:'not_found'});
    expect(await reason('deleted')).toEqual({status:'unavailable',reason:'not_found'});
    expect(await reason('unassigned')).toEqual({status:'unavailable',reason:'unassigned'});
    expect(await reason('otherRep')).toEqual({status:'unavailable',reason:'other_rep'});
    for(const key of ['closed','dead','dncLocked'] as const) expect(await reason(key)).toEqual({status:'unavailable',reason:'closed_dead_dnc'});
    expect(await reason('archived')).toEqual({status:'unavailable',reason:'archived'});
    expect(await reason('noEpisode')).toEqual({status:'unavailable',reason:'no_active_episode'});
    // Precedence: other rep's closed lead reports other_rep before closed; closed+archived reports closed first.
    await db.query("update public.properties set status='closed' where id=$1",[ids.otherRep]);
    expect(await reason('otherRep')).toEqual({status:'unavailable',reason:'other_rep'});
    await db.query("insert into public.acquisition_queue_states(property_id,org_id,stage,stage_entered_at,archived_at,archived_by,archive_reason) values ($1,$2,'contacted',now(),now(),$3,'manual') on conflict do nothing",[ids.closed,org,owner]);
    expect(await reason('closed')).toEqual({status:'unavailable',reason:'closed_dead_dnc'});

    // Access control.
    await expectError(()=>lookup(rep,other,ids.found),/FORBIDDEN/);
    await expectError(()=>lookup(outsider,rep,ids.found),/FORBIDDEN/);
    await expectError(()=>as('anon',null,()=>db.query('select public.fn_get_my_leads_queue_row($1,$2,$3)',[org,rep,ids.found])),/permission denied/);
    await expectError(()=>as('authenticated',rep,()=>db.query('select * from public.my_leads_queue_rows_for($1,$2,now(),null)',[org,rep])),/permission denied/);
    await expectError(()=>as('authenticated',rep,()=>db.query('select * from public.my_leads_queue_rows($1,$2,now())',[org,rep])),/permission denied/);
    await expectError(()=>as('authenticated',rep,()=>db.query('select public.fn_get_my_leads_queue_row($1,$2,null)',[org,rep])),/INVALID_INPUT/);

    // The internal 3-arg projection is unchanged: no property filter.
    const unfiltered=await db.query('select count(*)::int as n from public.my_leads_queue_rows($1,$2,now())',[org,rep]);
    const filtered=await db.query('select count(*)::int as n from public.my_leads_queue_rows_for($1,$2,now(),$3)',[org,rep,ids.found]);
    expect(unfiltered.rows[0].n).toBe(2);
    expect(filtered.rows[0].n).toBe(1);
    expect((await db.query('select count(*)::int as n from public.my_leads_queue_rows_for($1,$2,now(),$3)',[org,rep,ids.otherRep])).rows[0].n).toBe(0);

    // FEATURE_DISABLED.
    await db.query('update public.acquisition_org_settings set my_leads_enabled=false where org_id=$1',[org]);
    await expectError(()=>lookup(rep,rep,ids.found),/FEATURE_DISABLED/);
  } finally {await db.query('rollback').catch(()=>{});await db.end();}
});
