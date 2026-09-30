import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { createServer } from 'node:net';
import { TLSSocket, createSecureContext } from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connectionConfig, connectionEvidence, pinnedCa } from './connection.mjs';
import { catalogChildEnv, disposeCatalogChildEnv, assertTarget } from '../outbox-db-contract-readonly.mjs';

const run = (dir, ...args) => {
  const r = spawnSync('openssl', args, { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
};
function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tls-pooler-'));
  run(dir, 'req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout','root.key','-out','root.pem','-subj','/CN=local root','-addext','basicConstraints=critical,CA:TRUE');
  run(dir, 'req','-newkey','rsa:2048','-nodes','-keyout','inter.key','-out','inter.csr','-subj','/CN=local intermediate');
  writeFileSync(path.join(dir,'inter.ext'),'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n');
  run(dir, 'x509','-req','-in','inter.csr','-CA','root.pem','-CAkey','root.key','-CAcreateserial','-days','1','-out','inter.pem','-extfile','inter.ext');
  run(dir, 'req','-newkey','rsa:2048','-nodes','-keyout','leaf.key','-out','leaf.csr','-subj','/CN=localhost');
  writeFileSync(path.join(dir,'leaf.ext'),'subjectAltName=DNS:localhost\nbasicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\n');
  run(dir, 'x509','-req','-in','leaf.csr','-CA','inter.pem','-CAkey','inter.key','-CAcreateserial','-days','1','-out','leaf.pem','-extfile','leaf.ext');
  run(dir, 'req','-newkey','rsa:2048','-nodes','-keyout','wrong.key','-out','wrong.csr','-subj','/CN=wrong.example');
  writeFileSync(path.join(dir,'wrong.ext'),'subjectAltName=DNS:wrong.example\nbasicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\n');
  run(dir, 'x509','-req','-in','wrong.csr','-CA','inter.pem','-CAkey','inter.key','-CAserial','inter.srl','-days','1','-out','wrong.pem','-extfile','wrong.ext');
  run(dir, 'req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout','attacker.key','-out','attacker.pem','-subj','/CN=attacker root','-addext','basicConstraints=critical,CA:TRUE');
  const read = name => readFileSync(path.join(dir,name));
  const fp = new X509Certificate(read('root.pem')).fingerprint256;
  return {dir, read, fp};
}
function packet(type, payload = Buffer.alloc(0)) {
  const b = Buffer.alloc(5 + payload.length); b.write(type,0); b.writeInt32BE(b.length-1,1); payload.copy(b,5); return b;
}
async function serverFor(f, {cert = 'leaf.pem', key = 'leaf.key', chain = 'inter.pem', plain = false, maxVersion} = {}) {
  let seenTls = 0;
  let seenConnections = 0;
  const sockets = new Set();
  const context = createSecureContext({key:f.read(key),cert:Buffer.concat([f.read(cert), ...(chain ? [f.read(chain)] : [])]),
    ...(maxVersion ? {minVersion:maxVersion,maxVersion} : {})});
  const server = createServer(socket => {
    seenConnections++;
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.once('data', request => {
      if (request.length !== 8 || request.readInt32BE(4) !== 80877103) { socket.destroy(); return; }
      socket.write(plain ? 'N' : 'S');
      if (plain) { socket.end(); return; }
      const secure = new TLSSocket(socket,{isServer:true,secureContext:context,maxVersion});
      secure.on('error',e=>{});
      secure.on('secure',()=>{seenTls++; });
      let startup = false, buffer = Buffer.alloc(0);
      secure.on('data', data => {
        buffer = Buffer.concat([buffer,data]);
        if (!startup && buffer.length >= 4 && buffer.length >= buffer.readInt32BE(0)) {
          buffer = buffer.subarray(buffer.readInt32BE(0)); startup = true;
          const auth = Buffer.alloc(4); auth.writeInt32BE(0);
          secure.write(packet('R',auth)); secure.write(packet('Z',Buffer.from('I')));
        }
        while (startup && buffer.length >= 5 && buffer.length >= buffer.readInt32BE(1)+1) {
          const len=buffer.readInt32BE(1)+1; const type=String.fromCharCode(buffer[0]); buffer=buffer.subarray(len);
          if (type==='Q') { secure.write(packet('C',Buffer.from('SELECT 0\0'))); secure.write(packet('Z',Buffer.from('I'))); }
          else if (type==='X') secure.end();
        }
      });
    });
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {port:server.address().port, get seenTls(){return seenTls;}, get seenConnections(){return seenConnections;}, close:async()=>{
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve=>server.close(resolve));
  }};
}
const dsn = port => `postgres://user:password@localhost:${port}/postgres`;
function relabel(pem, label) {
  return pem.toString().replaceAll('BEGIN CERTIFICATE', `BEGIN ${label}`).replaceAll('END CERTIFICATE', `END ${label}`);
}
function bundleCases(f) {
  return [
    ['standard second certificate', Buffer.concat([f.read('root.pem'), f.read('attacker.pem')])],
    ['trusted certificate label', Buffer.from(`${f.read('root.pem').toString()}${relabel(f.read('attacker.pem'), 'TRUSTED CERTIFICATE')}`)],
    ['x509 certificate label', Buffer.from(`${f.read('root.pem').toString()}${relabel(f.read('attacker.pem'), 'X509 CERTIFICATE')}`)],
    ['trailing garbage', Buffer.from(`${f.read('root.pem').toString()}trailing garbage\n`)],
  ];
}
async function connect(f, srv, options={}) {
  const caFile=path.join(f.dir,options.ca ?? 'root.pem');
  const config=connectionConfig('shared-readonly',dsn(srv.port),{NODE_EXTRA_CA_CERTS:caFile},options.pin ?? f.fp);
  const client=new Client(config);
  try { await client.connect(); return {client,evidence:await connectionEvidence(client,dsn(srv.port),pinnedCa({NODE_EXTRA_CA_CERTS:caFile},options.pin ?? f.fp),options.pin ?? f.fp)}; }
  catch(e) { await client.end().catch(()=>{}); throw e; }
}
test('Node pg local TLS positive omits root and records upstream row informationally', async()=>{
  const f=fixture(); const srv=await serverFor(f);
  let client;
  try {
    const config=connectionConfig('shared-readonly',dsn(srv.port),{NODE_EXTRA_CA_CERTS:path.join(f.dir,'root.pem')},f.fp);
    assert.equal(config.ssl.rejectUnauthorized,true); assert.equal(config.ssl.minVersion,'TLSv1.2');
    assert.equal(config.ssl.servername,'localhost');
    const priorHost=process.env.PGHOST, priorMode=process.env.PGSSLMODE;
    process.env.PGHOST='wrong.example'; process.env.PGSSLMODE='disable';
    try { client=new Client(config); }
    finally {
      if (priorHost === undefined) delete process.env.PGHOST; else process.env.PGHOST=priorHost;
      if (priorMode === undefined) delete process.env.PGSSLMODE; else process.env.PGSSLMODE=priorMode;
    }
    assert.equal(client.connectionParameters.host,'localhost');
    assert.equal(client.connectionParameters.ssl.rejectUnauthorized,true);
    client.on('error',()=>{}); await client.connect();
    // The mock PostgreSQL server supplies no pg_stat_ssl row; absence is informational.
    client.query = async () => ({rows:[]});
    const evidence=await connectionEvidence(client,dsn(srv.port),pinnedCa({NODE_EXTRA_CA_CERTS:path.join(f.dir,'root.pem')},f.fp),f.fp);
    assert.equal(evidence.protocol,'TLSv1.3'); assert.equal(evidence.upstream_hop_ssl,null);
    assert.equal(evidence.pinned_ca_fingerprint,f.fp);
    const ca=pinnedCa({NODE_EXTRA_CA_CERTS:path.join(f.dir,'root.pem')},f.fp);
    client.query=async()=>{throw new Error('pg_stat_ssl unavailable');};
    assert.equal((await connectionEvidence(client,dsn(srv.port),ca,f.fp)).upstream_hop_ssl,null);
    client.query=async()=>({rows:[]});
    const verify=()=>connectionEvidence(client,dsn(srv.port),ca,f.fp);
    const socket=client.connection.stream;
    const authorized=socket.authorized;
    socket.authorized=false;
    await assert.rejects(verify(),/TLS_SOCKET_UNVERIFIED/);
    socket.authorized=authorized;
    const rejectUnauthorized=client.connectionParameters.ssl.rejectUnauthorized;
    client.connectionParameters.ssl.rejectUnauthorized=false;
    await assert.rejects(verify(),/TLS_CONFIG_DOWNGRADE/);
    client.connectionParameters.ssl.rejectUnauthorized=rejectUnauthorized;
    const getProtocol=socket.getProtocol;
    socket.getProtocol=()=> 'TLSv1.1';
    await assert.rejects(verify(),/TLS_PROTOCOL_REFUSED/);
    socket.getProtocol=getProtocol;
    const getPeerCertificate=socket.getPeerCertificate;
    socket.getPeerCertificate=(detailed)=>({...getPeerCertificate.call(socket,detailed),issuerCertificate:undefined});
    await assert.rejects(verify(),/TLS_CHAIN_INCOMPLETE/);
    socket.getPeerCertificate=getPeerCertificate;
    const servername=client.connectionParameters.ssl.servername;
    client.connectionParameters.ssl.servername='wrong.example';
    await assert.rejects(connectionEvidence(client,'postgres://user:password@wrong.example:5432/postgres',ca,f.fp),/TLS_HOSTNAME_MISMATCH/);
    client.connectionParameters.ssl.servername=servername;
    assert.ok(srv.seenTls);
  } finally {client?.connection?.stream?.destroy(); await client?.end().catch(()=>{}); await srv.close();rmSync(f.dir,{recursive:true,force:true});}
});
test('Node pg local TLS negative controls and config mutations', async()=>{
  const f=fixture(); const srv=await serverFor(f); const mismatch=await serverFor(f,{cert:'wrong.pem',key:'wrong.key'}); const plain=await serverFor(f,{plain:true}); const incomplete=await serverFor(f,{chain:null});
  const oldTls=await serverFor(f,{maxVersion:'TLSv1.1'});
  let downgraded;
  try {
    assert.throws(()=>connectionConfig('shared-readonly',dsn(srv.port),{}),/TLS_CA_REQUIRED/);
    assert.throws(()=>connectionConfig('shared-readonly',dsn(srv.port),{NODE_EXTRA_CA_CERTS:path.join(f.dir,'root.pem')},'00:'+'00:'.repeat(30)+'00'),/TLS_CA_PIN_MISMATCH/);
    assert.throws(()=>connectionConfig('shared-readonly',dsn(srv.port),{NODE_EXTRA_CA_CERTS:path.join(f.dir,'leaf.pem')},f.fp),/TLS_CA_PIN_MISMATCH/);
    assert.throws(()=>connectionConfig('shared-readonly',dsn(srv.port)+'?sslmode=disable',{NODE_EXTRA_CA_CERTS:path.join(f.dir,'root.pem')},f.fp),/TARGET_REFUSED/);
    await assert.rejects(connect(f,plain),/server does not support SSL|SSL/i);
    await assert.rejects(connect(f,mismatch),/hostname|altname|certificate/i);
    assert.ok(mismatch.seenConnections > 0);
    await assert.rejects(connect(f,incomplete),/certificate|verify|issuer|chain/i);
    await assert.rejects(connect(f,oldTls),/SSL|TLS|protocol|alert|version/i);
    const config=connectionConfig('shared-readonly',dsn(srv.port),{NODE_EXTRA_CA_CERTS:path.join(f.dir,'root.pem')},f.fp);
    assert.deepEqual({rejectUnauthorized:config.ssl.rejectUnauthorized,minVersion:config.ssl.minVersion,servername:config.ssl.servername},{rejectUnauthorized:true,minVersion:'TLSv1.2',servername:'localhost'});
    assert.equal(config.host,'localhost');
    assert.notEqual(config.ssl.ca,undefined);
    downgraded=new Client({...config,ssl:{...config.ssl,rejectUnauthorized:false}});
    downgraded.on('error',()=>{});
    await downgraded.connect();
    await assert.rejects(connectionEvidence(downgraded,dsn(srv.port),pinnedCa({NODE_EXTRA_CA_CERTS:path.join(f.dir,'root.pem')},f.fp),f.fp),/TLS_CONFIG_DOWNGRADE/);
  } finally {downgraded?.connection?.stream?.destroy(); await downgraded?.end().catch(()=>{}); await Promise.all([srv.close(),mismatch.close(),plain.close(),incomplete.close(),oldTls.close()]);rmSync(f.dir,{recursive:true,force:true});}
});
test('Node pg refuses every exclusive-CA bundle before a TCP connection', async()=>{
  const f=fixture(); const srv=await serverFor(f);
  try {
    for (const [label, bytes] of bundleCases(f)) {
      const caPath=path.join(f.dir,`${label.replaceAll(' ','-')}.pem`); writeFileSync(caPath,bytes);
      assert.throws(()=>connectionConfig('shared-readonly',dsn(srv.port),{NODE_EXTRA_CA_CERTS:caPath},f.fp),/TLS_CA_INVALID/,label);
    }
    assert.equal(srv.seenConnections,0);
  } finally {await srv.close();rmSync(f.dir,{recursive:true,force:true});}
});
test('catalog child env neutralizes inherited libpq overrides and refuses downgrade',()=>{
  const f=fixture();
  let env;
  try {
    assert.throws(()=>catalogChildEnv(dsn(5432),{},'shared-readonly',f.fp),/TLS_CA_REQUIRED/);
    assert.throws(()=>catalogChildEnv(dsn(5432),{NODE_EXTRA_CA_CERTS:path.join(f.dir,'root.pem')},'shared-readonly','00:'+'00:'.repeat(30)+'00'),/TLS_CA_PIN_MISMATCH/);
    assert.throws(()=>catalogChildEnv(dsn(5432)+'?sslmode=disable',{NODE_EXTRA_CA_CERTS:path.join(f.dir,'root.pem')},'shared-readonly',f.fp),/TARGET_REFUSED/);
    env=catalogChildEnv('postgres://user:password@localhost:5432/postgres',{
      NODE_EXTRA_CA_CERTS:path.join(f.dir,'root.pem'),PGSERVICE:'evil',PGSERVICEFILE:'evil',PGSSLMODE:'disable',PGSSLROOTCERT:'system',PGGSSENCMODE:'prefer',PGHOST:'evil',PGHOSTADDR:'evil',PGPORT:'1',INBOX_CATALOG_LOCAL_TLS:'1'},'shared-readonly',f.fp);
    assert.equal(env.PGSSLMODE,'verify-full'); assert.notEqual(env.PGSSLROOTCERT,path.join(f.dir,'root.pem'));
    assert.equal(readFileSync(env.PGSSLROOTCERT,'utf8'),readFileSync(path.join(f.dir,'root.pem'),'utf8'));
    assert.equal(statSync(env.PGSSLROOTCERT).mode & 0o777,0o600);
    assert.equal(env.PGSSLMINPROTOCOLVERSION,'TLSv1.2'); assert.equal(env.PGGSSENCMODE,'disable');
    for(const key of ['PGSERVICE','PGSERVICEFILE','PGHOSTADDR','INBOX_CATALOG_LOCAL_TLS']) assert.equal(env[key],undefined);
    assert.equal(env.PGHOST,'localhost');assert.equal(env.PGPORT,'5432');assert.equal(env.LC_ALL,'C');
    for(const value of ['disable','require','verify-ca','system']) assert.notEqual(env.PGSSLMODE,value);
    const rawCaPath=path.join(f.dir,'raw-ca.pem');
    writeFileSync(rawCaPath,Buffer.concat([f.read('root.pem'),Buffer.from('\n')]));
    const rawEnv={NODE_EXTRA_CA_CERTS:rawCaPath};
    const config=connectionConfig('shared-readonly',dsn(5432),rawEnv,f.fp);
    const canonical=pinnedCa(rawEnv,f.fp);
    assert.equal(config.ssl.ca,canonical.pem);
    assert.notEqual(config.ssl.ca,readFileSync(rawCaPath,'utf8'));
  } finally {disposeCatalogChildEnv(env);rmSync(f.dir,{recursive:true,force:true});}
});

test('real psql catalog path refuses every exclusive-CA bundle before TCP or password', async()=>{
  const f=fixture(); const srv=await serverFor(f);
  const base={...process.env,INBOX_CATALOG_HOSTED_TLS:'1',PGSSLMODE:'verify-full',
    PGSSLMINPROTOCOLVERSION:'TLSv1.2',PGGSSENCMODE:'disable',PGHOST:'localhost',PGPORT:String(srv.port),
    PGUSER:'user',PGPASSWORD:'password',PGDATABASE:'postgres',LC_ALL:'C'};
  try {
    for (const [label, bytes] of bundleCases(f)) {
      const caPath=path.join(f.dir,`${label.replaceAll(' ','-')}-catalog.pem`); writeFileSync(caPath,bytes);
      assert.throws(()=>catalogChildEnv(dsn(srv.port),{...base,NODE_EXTRA_CA_CERTS:caPath,PGSSLROOTCERT:caPath},'shared-readonly',f.fp),/TLS_CA_INVALID/,`${label} catalogChildEnv`);
      const result=spawnSync('python3',['scripts/outbox-db-contract/catalog-readonly.py'],{env:{...base,PGSSLROOTCERT:caPath},encoding:'utf8'});
      assert.notEqual(result.status,0,label);
      assert.match(result.stderr,/CATALOG_TLS_CA_INVALID/,label);
    }
    assert.equal(srv.seenConnections,0);
  } finally {await srv.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('catalog adapter rejects a local TLS server with an unpinned CA before handshake',async()=>{
  const f=fixture(); const srv=await serverFor(f);
  const env={...process.env,INBOX_CATALOG_HOSTED_TLS:'1',PGSSLMODE:'verify-full',
    PGSSLMINPROTOCOLVERSION:'TLSv1.2',PGGSSENCMODE:'disable',PGHOST:'localhost',PGPORT:String(srv.port),
    PGSSLROOTCERT:path.join(f.dir,'root.pem'),PGUSER:'user',PGPASSWORD:'password',PGDATABASE:'postgres',LC_ALL:'C'};
  try {
    const result=spawnSync('python3',['scripts/outbox-db-contract/catalog-readonly.py'],{env,encoding:'utf8',timeout:5000});
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/CATALOG_TLS_CA_PIN_MISMATCH/);
    assert.equal(srv.seenConnections,0);
  } finally {await srv.close();rmSync(f.dir,{recursive:true,force:true});}
});

async function psql(env) {
  const {spawn} = await import('node:child_process');
  return new Promise((resolve,reject)=>{
    const child=spawn('psql',['-X','-A','-t','-v','ON_ERROR_STOP=1','-c','\\conninfo'],{env});
    let stdout='',stderr='';
    child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);
    child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));
  });
}
test('real psql subprocess verifies local TLS and refuses wrong hostname, CA and plaintext',async()=>{
  const f=fixture();const valid=await serverFor(f);const plain=await serverFor(f,{plain:true});
  const incomplete=await serverFor(f,{chain:null});const oldTls=await serverFor(f,{maxVersion:'TLSv1.1'});
  try {
    const overrides={NODE_EXTRA_CA_CERTS:path.join(f.dir,'root.pem'),PGSERVICE:'evil',PGSERVICEFILE:'evil',PGSSLMODE:'disable',PGGSSENCMODE:'prefer',PGHOST:'evil',PGHOSTADDR:'evil',PGPORT:'1'};
    const env=catalogChildEnv(dsn(valid.port),{...process.env,...overrides},'shared-readonly',f.fp);
    const good=await psql(env);
    assert.equal(good.code,0,good.stderr);
    assert.match(good.stdout,/SSL connection \(protocol: TLSv1\.[23], cipher:/);
    assert.ok(valid.seenTls);
    const wrongHost=await psql({...env,PGHOST:'127.0.0.1'});
    assert.notEqual(wrongHost.code,0);
    const wrongCa=await psql({...env,PGSSLROOTCERT:path.join(f.dir,'leaf.pem')});
    assert.notEqual(wrongCa.code,0);
    const plaintext=await psql({...env,PGPORT:String(plain.port)});
    assert.notEqual(plaintext.code,0);
    const missingIntermediate=await psql({...env,PGPORT:String(incomplete.port)});
    assert.notEqual(missingIntermediate.code,0);
    const oldProtocol=await psql({...env,PGPORT:String(oldTls.port)});
    assert.notEqual(oldProtocol.code,0);
  } finally {await Promise.all([valid.close(),plain.close(),incomplete.close(),oldTls.close()]);rmSync(f.dir,{recursive:true,force:true});}
});

function parseProductionConninfo(files) {
  const script=`import importlib.util, json, pathlib, sys
p=pathlib.Path('scripts/outbox-db-contract/catalog-readonly.py').resolve()
spec=importlib.util.spec_from_file_location('catalog_readonly_test',p)
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
for filename in sys.argv[1:]:
 try:
  print(json.dumps({'ok': module.parse_conninfo(pathlib.Path(filename).read_text())}))
 except Exception as error:
  print(json.dumps({'error': str(error)}))
`;
  const result=spawnSync('python3',['-c',script,...files],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  return result.stdout.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
}

test('catalog adapter refuses libpq downgrades, malformed conninfo, and psql18 field drift',()=>{
  const f=fixture();
  try {
    const base={...process.env,INBOX_CATALOG_HOSTED_TLS:'1',PGSSLMODE:'verify-full',
      PGSSLROOTCERT:path.join(f.dir,'root.pem'),PGSSLMINPROTOCOLVERSION:'TLSv1.2',PGGSSENCMODE:'disable'};
    for(const mode of ['disable','require','verify-ca']) {
      const result=spawnSync('python3',['scripts/outbox-db-contract/catalog-readonly.py'],{env:{...base,PGSSLMODE:mode},encoding:'utf8'});
      assert.notEqual(result.status,0);assert.match(result.stderr,/CATALOG_TLS_CONFIG_REFUSED/);
    }
    const system=spawnSync('python3',['scripts/outbox-db-contract/catalog-readonly.py'],{env:{...base,PGSSLROOTCERT:'system'},encoding:'utf8'});
    assert.notEqual(system.status,0);assert.match(system.stderr,/CATALOG_TLS_CONFIG_REFUSED/);
    const fixturePath=name=>path.resolve('scripts/outbox-db-contract/fixtures',name);
    const parsed=parseProductionConninfo([
      fixturePath('conninfo-psql17.txt'),fixturePath('conninfo-psql18.txt'),fixturePath('conninfo-psql18-hostaddr.txt'),
      fixturePath('conninfo-psql18-unknown-field.txt'),fixturePath('conninfo-psql18-missing-ssl.txt')]);
    assert.deepEqual(parsed.slice(0,3),[{ok:['TLSv1.3','TLS_AES_256_GCM_SHA384']},{ok:['TLSv1.3','TLS_AES_256_GCM_SHA384']},{ok:['TLSv1.3','TLS_AES_256_GCM_SHA384']}]);
    assert.deepEqual(parsed.slice(3),[{error:'CATALOG_TLS_EVIDENCE_MISSING'},{error:'CATALOG_TLS_EVIDENCE_MISSING'}]);
  } finally {rmSync(f.dir,{recursive:true,force:true});}
});

test('catalog adapter fails closed when same-session conninfo is missing or garbled',()=>{
  const f=fixture();
  try {
    const bin=path.join(f.dir,'bin'); mkdirSync(bin);
    const fakePsql=path.join(bin,'psql');
    writeFileSync(fakePsql,'#!/usr/bin/env python3\nimport os, sys\nif not sys.stdin.read().startswith("\\\\conninfo\\nBEGIN"): raise SystemExit(3)\nsys.stdout.write(os.environ["FAKE_PSQL_OUTPUT"])\n');
    chmodSync(fakePsql,0o700);
    const catalog=JSON.stringify({relations:[],functions:[],types:[],schemas:[],trigger_names:[],index_names:[],schema_migrations:[]});
    const base={...process.env,PATH:`${bin}:${process.env.PATH}`,INBOX_CATALOG_LOCAL_TLS:'1',
      PGSSLMODE:'verify-full',PGSSLROOTCERT:path.join(f.dir,'root.pem'),PGSSLMINPROTOCOLVERSION:'TLSv1.2',
      PGGSSENCMODE:'disable',PGHOST:'localhost',PGPORT:'5432',LC_ALL:'C'};
    for(const prefix of ['', 'garbled conninfo\n']) {
      const result=spawnSync('python3',['scripts/outbox-db-contract/catalog-readonly.py'],{env:{...base,FAKE_PSQL_OUTPUT:`${prefix}BEGIN\nrepeatable read\non\n${catalog}\nCOMMIT\n`},encoding:'utf8'});
      assert.notEqual(result.status,0,prefix||'missing conninfo');
      assert.match(result.stderr,/CATALOG_TLS_EVIDENCE_MISSING/,prefix||'missing conninfo');
    }
  } finally {rmSync(f.dir,{recursive:true,force:true});}
});

const localCatalogTools = ['initdb','pg_ctl','postgres','pg_isready','psql'];
const missingLocalCatalogTools = localCatalogTools.filter(command=>spawnSync(command,['--version'],{stdio:'ignore'}).status!==0);
const localCatalogSkip = missingLocalCatalogTools.length ? `local PostgreSQL catalog integration unavailable; missing ${missingLocalCatalogTools.join(', ')}` : false;
if (localCatalogSkip) console.log(`SKIP: ${localCatalogSkip}`);
async function freeLocalPort() {
  const probe=createServer();
  await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(0,'127.0.0.1',resolve);});
  const port=probe.address().port;
  await new Promise(resolve=>probe.close(resolve));
  return port;
}
test('catalog-readonly.py runs conninfo and catalog reads in one real local TLS session', {skip:localCatalogSkip}, async()=>{
  const f=fixture(); const work=mkdtempSync(path.join(os.tmpdir(),'catalog-local-pg-')); const port=await freeLocalPort();
  const data=path.join(work,'data'); const root=path.join(work,'root.pem'); const cert=path.join(work,'server.crt'); const key=path.join(work,'server.key');
  let started=false;
  const command=(name,args,env={})=>{const result=spawnSync(name,args,{env:{...process.env,LC_ALL:'C',...env},encoding:'utf8'});assert.equal(result.status,0,result.stderr);return result;};
  try {
    writeFileSync(root,f.read('root.pem')); writeFileSync(cert,Buffer.concat([f.read('leaf.pem'),f.read('inter.pem')])); writeFileSync(key,f.read('leaf.key')); chmodSync(key,0o600);
    command('initdb',['-D',data,'--no-locale','--encoding=UTF8','-A','trust','-U','postgres']);
    const quote=value=>`'${value.replaceAll("'","''")}'`;
    writeFileSync(path.join(data,'postgresql.conf'),`${readFileSync(path.join(data,'postgresql.conf'),'utf8')}\nlisten_addresses = '127.0.0.1'\nport = ${port}\nssl = on\nssl_cert_file = ${quote(cert)}\nssl_key_file = ${quote(key)}\nssl_ca_file = ${quote(root)}\n`);
    writeFileSync(path.join(data,'pg_hba.conf'),`${readFileSync(path.join(data,'pg_hba.conf'),'utf8')}\nhostssl all all 127.0.0.1/32 trust\n`);
    command('pg_ctl',['-D',data,'-l',path.join(work,'postgres.log'),'-w','start']); started=true;
    const tlsEnv={PGHOST:'localhost',PGPORT:String(port),PGUSER:'postgres',PGDATABASE:'postgres',PGSSLMODE:'verify-full',PGSSLROOTCERT:root,PGSSLMINPROTOCOLVERSION:'TLSv1.2',PGGSSENCMODE:'disable'};
    command('psql',['-X','-v','ON_ERROR_STOP=1','-c','CREATE SCHEMA supabase_migrations; CREATE TABLE supabase_migrations.schema_migrations(version text);'],tlsEnv);
    const result=spawnSync('python3',['scripts/outbox-db-contract/catalog-readonly.py'],{env:{...process.env,...tlsEnv,INBOX_CATALOG_LOCAL_TLS:'1',LC_ALL:'C'},encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    const record=JSON.parse(result.stdout);
    assert.ok(record.section_sha256 && typeof record.section_sha256.schema_migrations==='string');
  } finally {
    if (started) spawnSync('pg_ctl',['-D',data,'-m','immediate','-w','stop'],{env:{...process.env,LC_ALL:'C'},encoding:'utf8'});
    rmSync(work,{recursive:true,force:true}); rmSync(f.dir,{recursive:true,force:true});
  }
});
