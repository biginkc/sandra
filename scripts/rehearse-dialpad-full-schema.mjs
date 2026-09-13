/** Full checked-out migration replay on a NEW genuine Supabase db-only stack.
 * No mocked prerequisite tables and no hosted connection configuration accepted.
 * Usage: node scripts/rehearse-dialpad-full-schema.mjs /tmp/sandra-dialpad-full-schema-XXXXXX
 * Initialize that owned directory with supabase init; select unique local ports;
 * run supabase db start there before invoking this script. No reset is performed.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import pg from 'pg';
const dir=process.argv[2];
assert.match(dir??'',/^\/tmp\/sandra-dialpad-full-schema-[A-Za-z0-9]+$/);
assert.equal(existsSync(dir+'/supabase/.temp/project-ref'),false,'Hosted linked projects forbidden');
const config=readFileSync(dir+'/supabase/config.toml','utf8');
const port=Number(config.match(/\[db\]\s*[\s\S]*?^port = (\d+)/m)?.[1]);
assert.ok(port>=59000&&port<60000,'Dedicated local port required');
const client=new pg.Client({host:'127.0.0.1',port,user:'postgres',password:'postgres',database:'postgres'});
const receipt={scope:'All checked-out SQL migrations on genuine clean local Supabase managed schema; not hosted drift proof',port,applied:[],failure:null};
let step='preflight';
try {
 await client.connect();
 assert.equal((await client.query("select to_regclass('public.properties') relation")).rows[0].relation,null,'Refuse an already-populated app database');
 assert.ok((await client.query("select to_regclass('auth.users') relation")).rows[0].relation,'Genuine initialized Auth schema required');
 assert.ok((await client.query("select to_regclass('storage.objects') relation")).rows[0].relation,'Genuine initialized Storage schema required');
 const folder=new URL('../supabase/migrations/',import.meta.url);
 for(const file of readdirSync(folder).filter(x=>x.endsWith('.sql')).sort()) {
  step=file;const sql=readFileSync(new URL(file,folder),'utf8');
  await client.query(sql);
  receipt.applied.push({file,sha256:createHash('sha256').update(sql).digest('hex')});
 }
 console.log(`PASS: full migration replay (${receipt.applied.length} migrations)`);
} catch(error) {
 receipt.failure={step,code:error.code??null,message:error.message};
 console.error(JSON.stringify(receipt.failure));process.exitCode=1;
} finally {
 await client.end();
 writeFileSync(dir+'/full-schema-replay.json',JSON.stringify(receipt,null,2),{mode:0o600});
}
