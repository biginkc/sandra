import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { createServer } from 'node:net';
import { TLSSocket, createSecureContext } from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connectionConfig, connectionEvidence, pinnedCa } from './connection.mjs';
import { catalogChildEnv, assertTarget } from '../outbox-db-contract-readonly.mjs';

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
  const read = name => readFileSync(path.join(dir,name));
  const fp = new X509Certificate(read('root.pem')).fingerprint256;
  return {dir, read, fp};
}
function packet(type, payload = Buffer.alloc(0)) {
  const b = Buffer.alloc(5 + payload.length); b.write(type,0); b.writeInt32BE(b.length-1,1); payload.copy(b,5); return b;
}
async function serverFor(f, {cert = 'leaf.pem', chain = 'inter.pem', plain = false, maxVersion} = {}) {
  let seenTls = 0;
  const context = createSecureContext({key:f.read('leaf.key'),cert:Buffer.concat([f.read(cert), ...(chain ? [f.read(chain)] : [])]),
    ...(maxVersion ? {minVersion:maxVersion,maxVersion} : {})});
  const server = createServer(socket => {
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
  return {port:server.address().port, get seenTls(){return seenTls;}, close:()=>new Promise(resolve=>server.close(resolve))};
}
const dsn = port => `postgres://user:password@localhost:${port}/postgres`;
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
  } finally {client?.connection?.stream?.destroy(); await srv.close();rmSync(f.dir,{recursive:true,force:true});}
});
test('Node pg local TLS negative controls and config mutations', async()=>{
  const f=fixture(); const srv=await serverFor(f); const plain=await serverFor(f,{plain:true}); const incomplete=await serverFor(f,{chain:null});
  const oldTls=await serverFor(f,{maxVersion:'TLSv1.1'});
  try {
    assert.throws(()=>connectionConfig('shared-readonly',dsn(srv.port),{}),/TLS_CA_REQUIRED/);
    assert.throws(()=>connectionConfig('shared-readonly',dsn(srv.port),{NODE_EXTRA_CA_CERTS:path.join(f.dir,'root.pem')},'00:'+'00:'.repeat(30)+'00'),/TLS_CA_PIN_MISMATCH/);
    assert.throws(()=>connectionConfig('shared-readonly',dsn(srv.port),{NODE_EXTRA_CA_CERTS:path.join(f.dir,'leaf.pem')},f.fp),/TLS_CA_PIN_MISMATCH/);
    assert.throws(()=>connectionConfig('shared-readonly',dsn(srv.port)+'?sslmode=disable',{NODE_EXTRA_CA_CERTS:path.join(f.dir,'root.pem')},f.fp),/TARGET_REFUSED/);
    await assert.rejects(connect(f,plain),/server does not support SSL|SSL/i);
    await assert.rejects(connect(f,incomplete),/certificate|verify|issuer|chain/i);
    await assert.rejects(connect(f,oldTls),/SSL|TLS|protocol|alert|version/i);
    const config=connectionConfig('shared-readonly',dsn(srv.port),{NODE_EXTRA_CA_CERTS:path.join(f.dir,'root.pem')},f.fp);
    assert.deepEqual({rejectUnauthorized:config.ssl.rejectUnauthorized,minVersion:config.ssl.minVersion,servername:config.ssl.servername},{rejectUnauthorized:true,minVersion:'TLSv1.2',servername:'localhost'});
    assert.equal(config.host,'localhost');
    assert.notEqual(config.ssl.ca,undefined);
    const downgraded=new Client({...config,ssl:{...config.ssl,rejectUnauthorized:false}});
    downgraded.on('error',()=>{});
    await downgraded.connect();
    await assert.rejects(connectionEvidence(downgraded,dsn(srv.port),pinnedCa({NODE_EXTRA_CA_CERTS:path.join(f.dir,'root.pem')},f.fp),f.fp),/TLS_CONFIG_DOWNGRADE/);
    downgraded.connection?.stream?.destroy();
  } finally {await Promise.all([srv.close(),plain.close(),incomplete.close(),oldTls.close()]);rmSync(f.dir,{recursive:true,force:true});}
});
test('catalog child env neutralizes inherited libpq overrides and refuses downgrade',()=>{
  const f=fixture();
  try {
    assert.throws(()=>catalogChildEnv(dsn(5432),{},'shared-readonly',f.fp),/TLS_CA_REQUIRED/);
    assert.throws(()=>catalogChildEnv(dsn(5432),{NODE_EXTRA_CA_CERTS:path.join(f.dir,'root.pem')},'shared-readonly','00:'+'00:'.repeat(30)+'00'),/TLS_CA_PIN_MISMATCH/);
    assert.throws(()=>catalogChildEnv(dsn(5432)+'?sslmode=disable',{NODE_EXTRA_CA_CERTS:path.join(f.dir,'root.pem')},'shared-readonly',f.fp),/TARGET_REFUSED/);
    const env=catalogChildEnv('postgres://user:password@localhost:5432/postgres',{
      NODE_EXTRA_CA_CERTS:path.join(f.dir,'root.pem'),PGSERVICE:'evil',PGSERVICEFILE:'evil',PGSSLMODE:'disable',PGSSLROOTCERT:'system',PGGSSENCMODE:'prefer',PGHOST:'evil',PGHOSTADDR:'evil',PGPORT:'1'},'shared-readonly',f.fp);
    assert.equal(env.PGSSLMODE,'verify-full'); assert.equal(env.PGSSLROOTCERT,path.join(f.dir,'root.pem'));
    assert.equal(env.PGSSLMINPROTOCOLVERSION,'TLSv1.2'); assert.equal(env.PGGSSENCMODE,'disable');
    for(const key of ['PGSERVICE','PGSERVICEFILE','PGHOSTADDR']) assert.equal(env[key],undefined);
    assert.equal(env.PGHOST,'localhost');assert.equal(env.PGPORT,'5432');assert.equal(env.LC_ALL,'C');
    for(const value of ['disable','require','verify-ca','system']) assert.notEqual(env.PGSSLMODE,value);
  } finally {rmSync(f.dir,{recursive:true,force:true});}
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

test('catalog adapter refuses libpq downgrades and unparseable conninfo',()=>{
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
    const parse=`import ast, pathlib, re\np=pathlib.Path('scripts/outbox-db-contract/catalog-readonly.py')\nt=ast.parse(p.read_text())\nf=next(x for x in t.body if isinstance(x,ast.FunctionDef) and x.name=='parse_conninfo')\nns={'re':re}\nexec(compile(ast.Module(body=[f],type_ignores=[]),str(p),'exec'),ns)\nassert ns['parse_conninfo']('You are connected to database x\\nSSL connection (protocol: TLSv1.3, cipher: TLS_AES_256_GCM_SHA384, bits: 256)')==('TLSv1.3','TLS_AES_256_GCM_SHA384')\nfor value in ('', 'You are connected to database x\\n', 'You are connected to database x\\nSSL connection (protocol: TLSv1.1, cipher: weak)'):\n try: ns['parse_conninfo'](value)\n except RuntimeError as e: assert str(e)=='CATALOG_TLS_EVIDENCE_MISSING'\n else: raise AssertionError('unparseable conninfo accepted')\n`;
    const result=spawnSync('python3',['-c',parse],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
  } finally {rmSync(f.dir,{recursive:true,force:true});}
});
