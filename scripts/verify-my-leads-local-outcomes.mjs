/** Read-only postconditions for the four-principal local browser campaign. */
import assert from 'node:assert/strict';
import pg from 'pg';

const db=new pg.Client({host:'127.0.0.1',port:58322,user:'postgres',password:'postgres',database:'postgres'});
await db.connect();
try {
  assert.equal((await db.query('select count(*)::int n from auth.users')).rows[0].n,4);
  const tasks=(await db.query('select type,count(*)::int n from public.tasks group by type order by type')).rows;
  assert.deepEqual(tasks,[{type:'appointment',n:1}],'Only the explicitly booked appointment exists; no automatic tasks');
  assert.equal((await db.query('select count(*)::int n from public.sequence_enrollments')).rows[0].n,0,'No automatic sequence enrollment');
  const handoff=(await db.query("select assigned_user_id,outreach_dispo from public.properties where id='20000000-0000-4000-8000-000000000007'")).rows[0];
  assert.equal(handoff.assigned_user_id,'10000000-0000-4000-8000-000000000002');
  assert.equal(handoff.outreach_dispo,'needs_sequence');
  console.log('PASS: four principals, one deliberate appointment, zero enrollments, configured-owner Needs sequence handoff');
} finally {await db.end();}
