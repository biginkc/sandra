import {isIP} from 'node:net';
const fixtures=new Set(['sandra_inbox_install_20260913','sandra_inbox_action_runtime_20260913']);
const releaseHttpMarker='sandra-inbox-http-owned-synthetic-20260917';
export function databaseConfig(env){
 let url;try{url=new URL(env.INBOX_PROJECTION_DATABASE_URL);}catch{throw Error('Invalid projection database configuration');}
 if(!['postgres:','postgresql:'].includes(url.protocol)||!url.username||!url.password||url.hash)throw Error('Invalid projection database configuration');
 const mode=url.searchParams.get('sslmode');
 if([...url.searchParams.keys()].some(key=>key!=='sslmode'))throw Error('Unsupported projection database option');
 const fixture=env.INBOX_PROJECTION_OWNED_FIXTURE_PLAINTEXT==='true';
 if(fixture){
  const database=url.pathname.slice(1);
  const releaseHttp=url.hostname==='127.0.0.1'&&url.port==='54322'&&database==='postgres';
  const historical=url.hostname==='127.0.0.1'&&url.port==='5432'&&fixtures.has(database);
  if(!releaseHttp&&!historical)throw Error('Invalid owned fixture transport');
  if(env.INBOX_PROJECTION_EXPECT_DATABASE!==database||mode)throw Error('Invalid owned fixture transport');
  if(releaseHttp&&(
   env.INBOX_PROJECTION_FIXTURE_MARKER!==releaseHttpMarker||
   env.INBOX_PROJECTION_FIXTURE_OWNER!=='release-infra'||
   env.INBOX_PROJECTION_FIXTURE_PURPOSE!=='sandra-inbox-release-http'||
   env.INBOX_PROJECTION_FIXTURE_LABELS_VERIFIED!=='true'))throw Error('Invalid owned HTTP fixture guard');
 }else if(isIP(url.hostname)||url.hostname.includes(':')||/^[0-9.]+$/.test(url.hostname)||url.hostname==='localhost'||(mode&&mode!=='verify-full'))throw Error('Verified database hostname required');
 url.searchParams.delete('sslmode');
 return {connectionString:url.toString(),ssl:fixture?false:{rejectUnauthorized:true,servername:url.hostname}};
}
export function assertLogin(row){
 if(!row||row.role!=='inbox_projection_worker'||row.login===row.role||row.login_safe!==true||row.only_projection_membership!==true||row.no_direct_data!==true||row.only_expected_definers!==true)throw Error('Projection login authority mismatch');
}
