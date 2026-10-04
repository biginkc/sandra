import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,realpathSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {subprocessEnvironment} from './norma-contract-support.mjs';
export function validateEntry(env) {
  for (const key of Object.keys(env)) assert.ok(!key.startsWith('PG')&&!key.startsWith('GIT_')&&!['DOCKER_CONTEXT','DOCKER_CONFIG'].includes(key),'Subprocess override refused: '+key);
  assert.equal(env.GITHUB_ACTIONS,'true');assert.equal(env.E2E_DISPOSABLE_DATABASE,'1');
  assert.ok(!env.DOCKER_HOST||env.DOCKER_HOST==='unix:///var/run/docker.sock','Local Docker required');
}
export function validateFixture(env, config, labels, workdir, runnerTemp, bindings) {
  validateEntry(env);
  assert.equal(path.dirname(workdir),runnerTemp,'Fixture must be directly inside runner temp');
  assert.match(path.basename(workdir),/^sandra-heavy-[a-zA-Z0-9]+$/);
  const id=/^project_id\s*=\s*"(sandra-heavy-[a-f0-9]{8})"\s*$/m.exec(config)?.[1];assert.ok(id,'Owned project ID required');
  const port=/\[db\][\s\S]*?^port\s*=\s*(\d+)\s*$/m.exec(config)?.[1];assert.equal(port,'55422');
  assert.equal(env.E2E_CI_SUPABASE_DB_URL,'postgresql://postgres:postgres@127.0.0.1:55422/postgres');
  assert.ok(bindings?.['5432/tcp']?.some(b=>b.HostPort==='55422'&&['','0.0.0.0','127.0.0.1','::','::1'].includes(b.HostIp)), 'DB port must map to this exact container');
  assert.equal(labels['com.supabase.cli.project'],id);
  assert.equal(path.resolve(labels['com.supabase.cli.workdir']??''),workdir);
  return `supabase_db_${id}`;
}
export function main(env=process.env) {
  validateEntry(env);
  const workdir=realpathSync(env.E2E_LOCAL_WORKDIR??''),temp=realpathSync(env.RUNNER_TEMP??'');
  assert.equal(path.dirname(workdir),temp,'Fixture must be directly inside runner temp');
  assert.match(path.basename(workdir),/^sandra-heavy-[a-zA-Z0-9]+$/);
  assert.equal(env.E2E_CI_SUPABASE_DB_URL,'postgresql://postgres:postgres@127.0.0.1:55422/postgres');
  const config=readFileSync(path.join(workdir,'supabase/config.toml'),'utf8');
  const id=/^project_id\s*=\s*"(sandra-heavy-[a-f0-9]{8})"\s*$/m.exec(config)?.[1];assert.ok(id,'Owned project ID required');
  const meta=JSON.parse(execFileSync('docker',['--host','unix:///var/run/docker.sock','inspect',`supabase_db_${id}`,'--format','{"id":{{json .Id}},"labels":{{json .Config.Labels}},"bindings":{{json .HostConfig.PortBindings}}}'],{encoding:'utf8',env:subprocessEnvironment(env)}));
  validateFixture(env,config,meta.labels,workdir,temp,meta.bindings);
  assert.match(meta.id,/^[a-f0-9]{64}$/,'Immutable container ID required');
  execFileSync('docker',['--host','unix:///var/run/docker.sock','exec',meta.id,'psql','-U','supabase_admin','-d','postgres','-v','ON_ERROR_STOP=1','-c','alter role postgres superuser'],{stdio:['ignore','pipe','pipe'],env:subprocessEnvironment(env)});
  console.log('Dedicated Norma fixture admin prepared; no hosted or shared project');
}
if (process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {try {main();} catch {console.error('Dedicated fixture validation/preparation failed');process.exitCode=1;}}
