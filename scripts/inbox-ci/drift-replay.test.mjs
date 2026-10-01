import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';

const REFS = ['ncsngxlcyxylaeskiteu', 'copflsklaefwzipsrjqz'];
const repo = path.resolve(import.meta.dirname, '../..');
const lane = path.join(repo, 'scripts/inbox-ci/drift-replay.sh');

const i16 = value => { const bytes = Buffer.alloc(2); bytes.writeInt16BE(value); return bytes; };
const u16 = value => { const bytes = Buffer.alloc(2); bytes.writeUInt16BE(value); return bytes; };
const i32 = value => { const bytes = Buffer.alloc(4); bytes.writeInt32BE(value); return bytes; };
const cstring = value => Buffer.from(`${value}\0`);
const message = (type, payload) => Buffer.concat([Buffer.from(type), i32(payload.length + 4), payload]);

function startPostgresStub() {
  const server = net.createServer(socket => {
    let buffer = Buffer.alloc(0);
    let phase = 'startup';

    const sendStartup = () => {
      socket.write(Buffer.concat([
        message('R', i32(0)),
        message('S', Buffer.concat([cstring('server_version'), cstring('17.0')])),
        message('K', Buffer.concat([i32(1), i32(1)])),
        message('Z', Buffer.from('I')),
      ]));
    };

    const sendVersion = () => {
      const field = Buffer.concat([cstring('server_version_num'), i32(0), i16(0), i32(23), i16(4), i32(-1), i16(0)]);
      const description = Buffer.concat([u16(1), field]);
      const value = Buffer.from('170000');
      const row = Buffer.concat([u16(1), i32(value.length), value]);
      socket.write(Buffer.concat([
        message('T', description),
        message('D', row),
        message('C', cstring('SHOW')),
        message('Z', Buffer.from('I')),
      ]));
    };

    const consume = () => {
      while (true) {
        if (phase === 'startup') {
          if (buffer.length < 8) return;
          const length = buffer.readInt32BE(0);
          if (buffer.length < length) return;
          const code = buffer.readInt32BE(4);
          buffer = buffer.subarray(length);
          if (code === 80877103) {
            socket.write(Buffer.from('N'));
            continue;
          }
          phase = 'query';
          sendStartup();
          continue;
        }
        if (buffer.length < 5) return;
        const length = buffer.readInt32BE(1);
        if (buffer.length < length + 1) return;
        const type = String.fromCharCode(buffer[0]);
        buffer = buffer.subarray(length + 1);
        if (type === 'Q') sendVersion();
        if (type === 'X') socket.end();
      }
    };

    socket.on('data', chunk => { buffer = Buffer.concat([buffer, chunk]); consume(); });
  });
  return server;
}

function startSupabaseHttpStub() {
  return createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.setHeader('content-type', 'application/json');
      if (request.url?.startsWith('/auth/v1/admin/users')) {
        response.end(JSON.stringify({ user: { id: '00000000-0000-0000-0000-000000000001' } }));
      } else {
        response.end('{}');
      }
    });
  });
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = error => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

function close(server) {
  return new Promise(resolve => server.close(() => resolve()));
}

function run(command, args, options, timeout) {
  return new Promise(resolve => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, stdout, stderr });
    };
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeout);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => finish({ status: null, error }));
    child.once('close', (status, signal) => finish({ status, signal, error: timedOut ? new Error(`timed out after ${timeout}ms`) : undefined }));
  });
}

function executable(directory, name, source) {
  const file = path.join(directory, name);
  writeFileSync(file, source);
  chmodSync(file, 0o755);
  return file;
}

function provisionRecorderSource() {
  return `import { appendFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
const script = args.shift();
const result = spawnSync(process.execPath, [script, ...args], { cwd: process.env.REPO_ROOT, env: process.env, encoding: 'utf8' });
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
const exportedRefKeys = Object.entries(process.env).filter(([, value]) => ['ncsngxlcyxylaeskiteu', 'copflsklaefwzipsrjqz'].some(ref => String(value).includes(ref))).map(([key]) => key);
const record = { script, args, githubEnv: process.env.GITHUB_ENV, exportedRefKeys, exitStatus: result.status, stderr: result.stderr?.slice(-4000) };
appendFileSync(process.env.PROVISION_RECORD, JSON.stringify(record) + '\\n');
const count = readFileSync(process.env.PROVISION_RECORD, 'utf8').trim().split('\\n').filter(Boolean).length;
if (result.status === 0 && count === 3) process.exit(77);
process.exit(result.status ?? 1);`;
}

function pythonRecorderSource() {
  return `import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '-c') { console.log(Date.now()); process.exit(0); }
if (args[0] === '-') process.exit(0);
const outputIndex = args.indexOf('--output');
if (outputIndex !== -1) {
  const output = args[outputIndex + 1];
  if (args.includes('--write-drift-fixture-sql')) writeFileSync(output, '-- local runtime fixture stub\\n');
  if (args.includes('--write-drift-record')) writeFileSync(output, JSON.stringify({ items: [] }) + '\\n');
}
if (args.includes('--preflight') || args.includes('catalog_fingerprint.py')) console.log(JSON.stringify({ sha256: 'a', section_sha256: { all: 'b' } }));`;
}

test('drift replay exports only neutral provision environment values', async () => {
  const work = mkdtempSync(path.join(tmpdir(), 'sandra-drift-runtime-'));
  const bin = path.join(work, 'bin');
  const runnerTemp = path.join(work, 'runner-temp');
  const originalEnvFile = path.join(work, 'original.env');
  const provisionRecord = path.join(work, 'provision-record.ndjson');
  const provisionRecorder = path.join(work, 'provision-recorder.mjs');
  const pythonRecorder = path.join(work, 'python-recorder.mjs');
  const basePath = process.env.PATH ?? '';
  const testedSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  const postgres = startPostgresStub();
  const supabaseHttp = startSupabaseHttpStub();

  try {
    await listen(postgres, 55422);
    await listen(supabaseHttp, 55421);
    writeFileSync(originalEnvFile, '');
    mkdirSync(runnerTemp, { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(provisionRecorder, provisionRecorderSource());
    writeFileSync(pythonRecorder, pythonRecorderSource());

    executable(bin, 'git', `#!/bin/sh
if [ "\${1:-}" = rev-parse ] && [ "\${2:-}" = HEAD ]; then printf '%s\\n' "$HEAVY_TESTED_SHA"; exit 0; fi
if [ "\${1:-}" = status ]; then exit 0; fi
exec "$REAL_GIT" "$@"
`);
    executable(bin, 'supabase', `#!/bin/sh
case "\${1:-}" in
  init)
    previous=''
    for arg in "$@"; do
      if [ "$previous" = --workdir ]; then mkdir -p "$arg/supabase"; fi
      previous="$arg"
    done
    exit 0
    ;;
  start|stop) exit 0 ;;
  status) printf '%s\\n' '{"API_URL":"http://127.0.0.1:55421","DB_URL":"postgresql://postgres:postgres@127.0.0.1:55422/postgres","ANON_KEY":"anon-key","SERVICE_ROLE_KEY":"service-key"}'; exit 0 ;;
  *) echo "unexpected supabase invocation: $*" >&2; exit 90 ;;
esac
`);
    executable(bin, 'psql', '#!/bin/sh\nexit 0\n');
    executable(bin, 'bash', `#!/bin/sh
if [ "\${1:-}" = scripts/inbox-ci/build-operator-indexes.sh ]; then exit 0; fi
exec "$REAL_BASH" "$@"
`);
    executable(bin, 'python3', `#!/bin/sh
exec "$REAL_NODE" "$PYTHON_RECORDER" "$@"
`);
    executable(bin, 'node', `#!/bin/sh
case "\${1:-}" in
  scripts/ci/provision-disposable-stack.mjs)
    exec "$REAL_NODE" "$PROVISION_RECORDER" "$@"
    ;;
  -p)
    printf '%s\\n' fake-org
    ;;
  scripts/inbox-ci/rehearse-readonly.mjs)
    output=''
    phase=''
    previous=''
    for arg in "$@"; do
      if [ "$previous" = --output ]; then output="$arg"; fi
      if [ "$previous" = --phase ]; then phase="$arg"; fi
      previous="$arg"
    done
    if [ -n "$output" ]; then printf '%s\\n' '{"org":"fake-org"}' > "$output"; fi
    if [ "$phase" = pre ]; then printf '%s\\n' '{"org":"fake-org"}'; else printf '%s\\n' post; fi
    ;;
  scripts/outbox-db-contract-mutations.mjs)
    printf '%s\\n' '{}' > "$2"
    ;;
  scripts/inbox-ci/write-failure-record.mjs)
    ;;
  *)
    echo "unexpected node invocation: $*" >&2
    exit 91
    ;;
esac
`);

    const env = {
      PATH: basePath,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
    };
    Object.assign(env, {
      PATH: `${bin}:${basePath}`,
      REAL_BASH: '/bin/bash',
      REAL_GIT: execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim(),
      REAL_NODE: process.execPath,
      HEAVY_LANE: 'drift-replay',
      HEAVY_TESTED_SHA: testedSha,
      GITHUB_ACTIONS: 'true',
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_REF_NAME: 'main',
      GITHUB_RUN_ID: '987654321',
      GITHUB_RUN_ATTEMPT: '1',
      RUNNER_TEMP: runnerTemp,
      GITHUB_ENV: originalEnvFile,
      REPO_ROOT: repo,
      PROVISION_RECORD: provisionRecord,
      PROVISION_RECORDER: provisionRecorder,
      PYTHON_RECORDER: pythonRecorder,
      PYTHONDONTWRITEBYTECODE: '1',
    });
    const result = await run('bash', [lane], { cwd: repo, env }, 10_000);
    const provisionOutput = existsSync(provisionRecord) ? readFileSync(provisionRecord, 'utf8') : '<provision record missing>';
    assert.equal(result.status, 77, `${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}\n${provisionOutput}`);

    const records = readFileSync(provisionRecord, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(records.length, 3, result.stderr);
    assert.deepEqual(records.map(record => record.exitStatus), [0, 0, 0]);
    assert.match(records[0].githubEnv, /\/baseline\.env$/);
    assert.match(records[1].githubEnv, /\/target-1\.env$/);
    assert.match(records[2].githubEnv, /\/target-2\.env$/);
    for (const [index, record] of records.entries()) assert.deepEqual(record.exportedRefKeys, [], `provision ${index + 1} exported a hosted project ref`);
    for (const ref of REFS) assert(!readFileSync(originalEnvFile, 'utf8').includes(ref), `runner environment contains ${ref}`);
  } finally {
    await close(postgres);
    await close(supabaseHttp);
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
