import { mkdtemp, cp, rm } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOOPBACK_API_URL = 'http://127.0.0.1:54321';
const LOOPBACK_DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const SUPABASE_CLI_VERSION = '2.116.0';
const CANONICAL_FIXTURE_ORG = {
  id: '00000000-0000-0000-0000-000000000bbb',
  source: 'tests/integration/fixtures/multi-user.ts:BMH_ORG_ID',
  role: 'canonical integration tenant',
};
const PRODUCTION_EQUIVALENCE_UNKNOWN_REASON =
  'No production inspection was performed by this local runner.';

// This is an explicit audit list, rather than a broad Date/now regex. Each
// entry names the predicate, source and clock domain that the manifest claims
// to have reviewed. The source hashes below make an unreviewed source change
// visible in the retained run evidence.
const CLOCK_AUDIT = [
  {
    id: 'enrollment_first_due',
    sourceKey: 'enrollment',
    sourcePath: 'src/lib/sequences/enrollment.ts',
    function: 'enrollLead',
    predicate: 'step 0 delay to sequence_enrollments.next_run_at',
    clock: 'application Date / new Date()',
    contract: /delayToDate\(step0\.delay_after_previous_minutes,\s*new Date\(\)\)/,
  },
  {
    id: 'tick_due_and_budget',
    sourceKey: 'handlers',
    sourcePath: 'src/app/api/cron/sequence-tick/handlers.ts',
    function: 'runSequenceTick',
    predicate: 'due enrollment/message selection and elapsed budget',
    clock: 'application Date / Date.now()',
    contract: /const\s+startedAt\s*=\s*Date\.now\(\)[\s\S]*const\s+nowIso\s*=\s*new Date\(\)\.toISOString\(\)/,
  },
  {
    id: 'native_claim_stale_cutoff',
    sourceKey: 'tick',
    sourcePath: 'src/lib/sequences/tick.ts',
    function: 'processEnrollmentTick',
    predicate: 'claim scheduled_for and application stale-cutoff input',
    clock: 'application Date / Date.now(); DB RPC clamps minimum age',
    contract: /scheduled_for:\s*new Date\(\)\.toISOString\(\)[\s\S]*p_stale_before:\s*new Date\(Date\.now\(\)\s*-\s*SEQUENCE_CLAIM_STALE_MS\)/,
  },
  {
    id: 'quiet_hours',
    sourceKey: 'quietHours',
    sourcePath: 'src/lib/messaging/quiet-hours.ts',
    function: 'checkQuietHours',
    predicate: 'local send window and test override',
    clock: 'application Date / E2E_QUIET_HOURS_NOW override',
    contract: /const\s+override\s*=\s*process\.env\.E2E_QUIET_HOURS_NOW[\s\S]*return\s+new Date\(\)/,
  },
  {
    id: 'direct_quiet_deferral',
    sourceKey: 'tick',
    sourcePath: 'src/lib/sequences/tick.ts',
    function: 'processEnrollmentTick',
    predicate: 'quiet-hours next_run_at deferral',
    clock: 'application Date / Date.now()',
    contract: /Date\.now\(\)\s*\+\s*10\s*\*\s*60\s*\*\s*60\s*\*\s*1000/,
  },
  {
    id: 'next_step_due',
    sourceKey: 'tick',
    sourcePath: 'src/lib/sequences/tick.ts',
    function: 'advanceEnrollment',
    predicate: 'next step delay to sequence_enrollments.next_run_at',
    clock: 'application Date / new Date()',
    contract: /delayToDate\(\s*nextStep\.delay_after_previous_minutes,\s*new Date\(\),/,
  },
  {
    id: 'queue_pending_stale_sweep',
    sourceKey: 'handlers',
    sourcePath: 'src/app/api/cron/sequence-tick/handlers.ts',
    function: 'failStalePendingProviderAttempts',
    predicate: 'pending provider attempt age cutoff',
    clock: 'application Date / Date.now()',
    contract: /const\s+cutoffIso\s*=\s*new Date\(nowMs\s*-\s*PROVIDER_PENDING_STALE_MS\)\.toISOString\(\)/,
  },
  {
    id: 'queue_due_and_pending_age',
    sourceKey: 'send',
    sourcePath: 'src/lib/messaging/send.ts',
    function: 'releaseQueuedMessage',
    constant: 'PROVIDER_PENDING_STALE_MS',
    predicate: 'queued release due check and provider-pending age',
    clock: 'application Date / Date.now()',
    contract: /PROVIDER_PENDING_STALE_MS\s*=\s*15\s*\*\s*60_000[\s\S]*scheduled_for\)[\s\S]*Date\.now\(\)/,
  },
  {
    id: 'queue_retry_backoff',
    sourceKey: 'send',
    sourcePath: 'src/lib/messaging/send.ts',
    function: 'buildProviderRetryUpdate',
    relatedFunction: 'deferQueuedMessage',
    predicate: 'provider transient retry nextRetryAt/scheduled_for',
    clock: 'application Date / Date.now()',
    contract: /PROVIDER_TRANSIENT_DEFER_MS\s*=\s*5\s*\*\s*60_000[\s\S]*now\.getTime\(\)\s*\+\s*PROVIDER_TRANSIENT_DEFER_MS\s*\*\s*attempt[\s\S]*Date\.now\(\)\s*\+\s*PROVIDER_TRANSIENT_DEFER_MS/,
    attempt: '* attempt',
  },
  {
    id: 'sequence_audit_defaults',
    sourceKey: 'sequenceMigration',
    sourcePath: 'supabase/migrations/018_sequences_v1.sql',
    function: 'sequence_step_runs.created_at default',
    predicate: 'audit row creation timestamp',
    clock: 'PostgreSQL now()',
    contract: /create table sequence_step_runs\s*\([^;]*?created_at timestamptz not null default now\(\)\s*\);/,
  },
  {
    id: 'provider_intent_timestamp',
    sourceKey: 'runtimeMigration',
    sourcePath: 'supabase/migrations/20260917110000_sequence_runtime_recovery.sql',
    function: 'authorize_sequence_provider_attempt',
    predicate: 'provider-intent attempt_started_at',
    clock: 'PostgreSQL now()',
    contract: /authorize_sequence_provider_attempt[\s\S]*attempt_started_at\s*=\s*now\(\)/,
  },
  {
    id: 'retry_resume_schedule',
    sourceKey: 'runtimeMigration',
    sourcePath: 'supabase/migrations/20260917110000_sequence_runtime_recovery.sql',
    function: 'retry_sequence_step, resume_sequence_enrollment',
    predicate: 'explicit recovery next_run_at',
    clock: 'PostgreSQL now()',
    contract: /retry_sequence_step[\s\S]*next_run_at\s*=\s*now\(\)[\s\S]*resume_sequence_enrollment[\s\S]*next_at\s*:=\s*now\(\)\s*\+\s*make_interval\(mins\s*=>\s*s\.delay_after_previous_minutes\)/,
  },
  {
    id: 'stale_claim_reconciliation',
    sourceKey: 'runtimeMigration',
    sourcePath: 'supabase/migrations/20260917110000_sequence_runtime_recovery.sql',
    function: 'retire_stale_sequence_claim',
    predicate: 'bounded stale claim age',
    clock: 'PostgreSQL now()',
    contract: /retire_stale_sequence_claim[\s\S]*least\(\s*coalesce\(p_stale_before,\s*now\(\)\s*-\s*interval\s+'15 minutes'\),\s*now\(\)\s*-\s*interval\s+'15 minutes'\s*\)/,
  },
];
// Sequence canaries only need Postgres, Auth, PostgREST, Kong and storage.
// Keeping dashboards, realtime, mail, and observability out of the disposable
// stack reduces image and volume pressure on constrained runners.
const DISPOSABLE_SUPABASE_EXCLUDES = [
  'studio',
  'postgres-meta',
  'realtime',
  'edge-runtime',
  'logflare',
  'vector',
  'mailpit',
  'imgproxy',
];
const MIN_FREE_BYTES = 3 * 1024 ** 3;
const browserAcceptanceEnabled = process.env.SANDRA_CANARY_BROWSER === '1';
const browserOnlyEnabled = process.env.SANDRA_CANARY_BROWSER_ONLY === '1';
if (browserOnlyEnabled && !browserAcceptanceEnabled) {
  throw new Error('SANDRA_CANARY_BROWSER_ONLY=1 requires SANDRA_CANARY_BROWSER=1');
}

function disposableBrowserIdentity() {
  const githubRun = process.env.GITHUB_ACTIONS === 'true';
  const runSlug = githubRun
    ? `gha-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`
    : `local-${process.pid}-${randomBytes(6).toString('hex')}`;
  if (
    githubRun &&
    (!/^[1-9][0-9]*$/.test(process.env.GITHUB_RUN_ID ?? '') ||
      !/^[1-9][0-9]*$/.test(process.env.GITHUB_RUN_ATTEMPT ?? ''))
  ) {
    throw new Error('Browser acceptance requires numeric GitHub run identity.');
  }
  return {
    runSlug,
    email: `e2e-ci+${runSlug}@bmhgroupkc.com`,
    password: randomBytes(32).toString('base64url'),
  };
}

const browserIdentity = browserAcceptanceEnabled ? disposableBrowserIdentity() : null;
const browserLedgerToken = browserAcceptanceEnabled
  ? randomBytes(24).toString('base64url')
  : null;
// Deliberately omit all inherited application, cloud and provider credentials.
const basic = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'CI', 'GITHUB_ACTIONS', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
if (process.env.SANDRA_CANARY_DOCKER_HOST) {
  if (!process.env.SANDRA_CANARY_DOCKER_HOST.startsWith('unix:///')) throw new Error('Only a local Docker socket is allowed');
  basic.DOCKER_HOST = process.env.SANDRA_CANARY_DOCKER_HOST;
}
const workdir = await mkdtemp(path.join(tmpdir(), 'sandra-disposable-canary-'));
let activeChild;
let cancelled = false;
let cleaning = false;
let forceKill;
function terminate(child) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  forceKill = setTimeout(() => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') console.error('Could not terminate owned child'); }
  }, 5000);
  forceKill.unref();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (cleaning || cancelled) return;
  cancelled = true;
  process.exitCode = 1;
  terminate(activeChild);
});
function run(command, args, env = basic, capture = false) {
  if (cancelled && !cleaning) return Promise.reject(new Error('Disposable run cancelled'));
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, detached: true, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    activeChild = child;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timeout = cleaning ? setTimeout(() => { timedOut = true; terminate(child); }, 60000) : undefined;
    if (capture) {
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
    }
    child.on('error', reject);
    child.on('close', code => {
      if ((cancelled && !cleaning) || timedOut) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') console.error('Could not kill remaining owned process group'); }
      }
      clearTimeout(timeout);
      clearTimeout(forceKill);
      activeChild = undefined;
      if (code === 0 && !timedOut && (!cancelled || cleaning)) resolve(stdout);
      else {
        const diagnostic = capture ? scrubDiagnostic(`${stdout}\n${stderr}`).trim() : '';
        reject(new Error(`${command} ${args[0]} exited ${code}${cancelled ? ' after cancellation' : ''}${diagnostic ? `: ${diagnostic}` : ''}`));
      }
    });
  });
}

function scrubDiagnostic(value) {
  return value
    .replace(/(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+@/gi, '$1[REDACTED]@')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_TOKEN]')
    .replace(/((?:anon|service[_ -]?role|jwt[_ -]?secret|access[_ -]?token|api[_ -]?key)[^:=\n]*[:=])\s*[^\s,]+/gi, '$1 [REDACTED]');
}

async function assertDiskHeadroom() {
  const output = await run('df', ['-Pk', root], basic, true);
  const fields = output.trim().split('\n').at(-1)?.trim().split(/\s+/) ?? [];
  const availableKb = Number(fields[3]);
  if (!Number.isFinite(availableKb) || availableKb * 1024 < MIN_FREE_BYTES) {
    const available = Number.isFinite(availableKb) ? `${availableKb} KiB` : 'unknown';
    throw new Error(`Insufficient disk headroom for disposable Supabase stack (available ${available}; need at least ${MIN_FREE_BYTES / 1024 / 1024 / 1024} GiB)`);
  }
}

function projectResourcePattern(projectName) {
  const escaped = projectName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^supabase_[^\\n]*_${escaped}$`);
}

async function listOwnedDockerResources(kind, projectName) {
  const listArgs = kind === 'container'
    ? [kind, 'ls', '--all', '--format', '{{.Names}}', '--filter', `name=${projectName}`]
    : [kind, 'ls', '--quiet', '--filter', `name=${projectName}`];
  const values = (await run('docker', listArgs, basic, true))
    .split(/\s+/)
    .map(value => value.trim())
    .filter(Boolean);
  const pattern = projectResourcePattern(projectName);
  return values.filter(value => pattern.test(value));
}

async function removeOwnedDockerResources() {
  const projectName = path.basename(workdir);
  const containers = await listOwnedDockerResources('container', projectName);
  if (containers.length) await run('docker', ['rm', '--force', ...containers], basic, true);
  const volumes = await listOwnedDockerResources('volume', projectName);
  if (volumes.length) await run('docker', ['volume', 'rm', '--force', ...volumes], basic, true);
  const [remainingContainers, remainingVolumes] = await Promise.all([
    listOwnedDockerResources('container', projectName),
    listOwnedDockerResources('volume', projectName),
  ]);
  if (remainingContainers.length || remainingVolumes.length) {
    throw new Error(`Owned Docker resources remain after cleanup (${[...remainingContainers, ...remainingVolumes].join(', ')})`);
  }
}

async function gitValue(args, { allowEmpty = false } = {}) {
  const value = (await run('git', args, basic, true)).trim();
  if (!allowEmpty && !value) throw new Error(`Git returned no value for ${args.join(' ')}`);
  return value;
}

async function fileSha256(filepath) {
  const { readFile } = await import('node:fs/promises');
  return createHash('sha256').update(await readFile(filepath)).digest('hex');
}

async function directorySha256(directory) {
  const { readdir, readFile } = await import('node:fs/promises');
  const files = [];
  async function visit(current, relative = '') {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = path.join(current, entry.name);
      const childRelative = path.join(relative, entry.name);
      if (entry.isDirectory()) await visit(child, childRelative);
      else files.push([childRelative, createHash('sha256').update(await readFile(child)).digest('hex')]);
    }
  }
  await visit(directory);
  if (!files.length) throw new Error(`No migration files found in ${directory}`);
  return createHash('sha256').update(files.map(([name, sha]) => `${name}\0${sha}\n`).join('')).digest('hex');
}

async function assertSourceContracts() {
  const { readFile } = await import('node:fs/promises');
  const paths = {
    quietHours: path.join(root, 'src/lib/messaging/quiet-hours.ts'),
    enrollment: path.join(root, 'src/lib/sequences/enrollment.ts'),
    tick: path.join(root, 'src/lib/sequences/tick.ts'),
    handlers: path.join(root, 'src/app/api/cron/sequence-tick/handlers.ts'),
    send: path.join(root, 'src/lib/messaging/send.ts'),
    fixtureOrgSource: path.join(root, 'tests/integration/fixtures/multi-user.ts'),
    vercel: path.join(root, 'vercel.json'),
    sequenceMigration: path.join(root, 'supabase/migrations/018_sequences_v1.sql'),
    runtimeMigration: path.join(root, 'supabase/migrations/20260917110000_sequence_runtime_recovery.sql'),
  };
  const source = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([name, filepath]) => [name, { filepath, text: await readFile(filepath, 'utf8'), sha256: await fileSha256(filepath) }])));
  const contracts = [
    ['quietHours', /QUIET_HOURS_OPEN_HOUR\s*=\s*8\b/, 'quiet-hours open hour 08:00'],
    ['quietHours', /QUIET_HOURS_CLOSE_HOUR\s*=\s*21\b/, 'quiet-hours close hour 21:00'],
    ['tick', /Date\.now\(\)\s*\+\s*10\s*\*\s*60\s*\*\s*60\s*\*\s*1000/, 'direct quiet deferral +10h'],
    ['handlers', /const\s+BATCH_SIZE\s*=\s*100\b/, 'sequence batch 100'],
    ['handlers', /const\s+RETAINED_CLAIM_LOOKAHEAD_ROWS\s*=\s*BATCH_SIZE\b/, 'retained-claim lookahead cap equals one batch'],
    ['handlers', /const\s+DRAIN_BATCH_SIZE\s*=\s*240\b/, 'queue drain 240'],
    ['handlers', /const\s+TICK_BUDGET_MS\s*=\s*240_000\b/, 'tick budget 240000ms'],
    ['handlers', /const\s+BLOCKED_DEFER_MS\s*=\s*30\s*\*\s*60_000\b/, 'queue quiet deferral 30m'],
    ['fixtureOrgSource', /BMH_ORG_ID\s*=\s*['"]00000000-0000-0000-0000-000000000bbb['"]/, 'canonical fixture organization'],
    ['vercel', /"schedule"\s*:\s*"\*\/5 \* \* \* \*"/, 'sequence cron */5'],
    ['sequenceMigration', /idx_step_runs_unique_enrollment_step/, 'sequence step uniqueness constraint'],
    ['runtimeMigration', /idx_step_runs_active_enrollment_step/, 'active sequence step uniqueness constraint'],
    ['runtimeMigration', /attempt_started_at\s*=\s*now\(\)/, 'claim attempt database clock'],
    ['runtimeMigration', /next_run_at\s*=\s*now\(\)/, 'retry database clock'],
    ['runtimeMigration', /next_at\s*:=\s*now\(\)\s*\+\s*make_interval\(mins\s*=>\s*s\.delay_after_previous_minutes\)/, 'resume database clock'],
    ['runtimeMigration', /least\(\s*coalesce\(p_stale_before,\s*now\(\)\s*-\s*interval\s+'15 minutes'\),\s*now\(\)\s*-\s*interval\s+'15 minutes'\s*\)/, 'database stale-claim minimum age'],
  ];
  for (const audit of CLOCK_AUDIT) {
    if (!source[audit.sourceKey]) {
      throw new Error(`Manifest clock audit source is not loaded: ${audit.sourcePath}`);
    }
    contracts.push([audit.sourceKey, audit.contract, `clock audit ${audit.id}`]);
  }
  for (const [name, pattern, label] of contracts) {
    if (!pattern.test(source[name].text)) throw new Error(`Manifest source contract drift: ${label}`);
  }
  return source;
}

function postgrestVersionFromStatus(status) {
  const reported = status.POSTGREST_VERSION ?? status.REST_VERSION ?? status.postgrestVersion;
  if (typeof reported === 'string' && reported.trim()) return reported.trim();
  return 'UNKNOWN (local Supabase status does not expose PostgREST version; no container inspection performed)';
}

async function readLocalDatabaseManifest(dbUrl) {
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  try {
    const [{ rows: metadata }, { rows: indexes }] = await Promise.all([
      client.query("select version() as version, current_database() as database, current_setting('transaction_isolation') as transaction_isolation"),
      client.query("select c.relname as name, pg_get_indexdef(c.oid) as definition from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname in ('idx_step_runs_active_enrollment_step', 'idx_step_runs_unique_enrollment_step', 'idx_enrollments_unique_active') order by c.relname"),
    ]);
    const uniqueStepIndex = indexes.find((index) => index.name === 'idx_step_runs_active_enrollment_step');
    if (!uniqueStepIndex) throw new Error('Manifest critical index missing: idx_step_runs_active_enrollment_step');
    return {
      postgresVersion: metadata[0]?.version ?? 'UNKNOWN',
      database: metadata[0]?.database ?? 'UNKNOWN',
      transactionIsolation: metadata[0]?.transaction_isolation ?? 'UNKNOWN',
      indexes,
    };
  } finally {
    await client.end();
  }
}

async function printEnvironmentManifest(status, workdir, cliVersionOutput) {
  // Keep this manifest deliberately free of generated keys and connection
  // strings. It is safe to retain in CI logs as evidence for the exact run.
  const source = await assertSourceContracts();
  const migrationDirectory = path.join(workdir, 'supabase/migrations');
  const database = process.env.SANDRA_CANARY_RUNNER_CONTRACT === '1'
    ? { postgresVersion: 'CONTRACT_TEST', database: 'postgres', transactionIsolation: 'CONTRACT_TEST', indexes: [] }
    : await readLocalDatabaseManifest(status.DB_URL);
  const manifest = {
    kind: 'sandra-disposable-canary-environment',
    source: {
      commitSha: await gitValue(['rev-parse', 'HEAD']),
      copiedMigrationsSha256: await directorySha256(migrationDirectory),
      copiedCriticalMigrations: Object.fromEntries(await Promise.all([
        '018_sequences_v1.sql',
        '20260917110000_sequence_runtime_recovery.sql',
      ].map(async (name) => [name, await fileSha256(path.join(migrationDirectory, name))]))),
      sourceFiles: Object.fromEntries(Object.entries(source).map(([name, value]) => [name, { path: path.relative(root, value.filepath), sha256: value.sha256 }])),
    },
    database: {
      supabaseCli: cliVersionOutput.trim(),
      postgrestVersion: postgrestVersionFromStatus(status),
      postgresVersion: database.postgresVersion,
      database: database.database,
      transactionIsolation: database.transactionIsolation,
      apiOrigin: LOOPBACK_API_URL,
      dbOrigin: '127.0.0.1:54322',
    },
    fixtureOrg: CANONICAL_FIXTURE_ORG,
    isolation: {
      project: 'unique temporary Supabase project',
      docker: 'dedicated local Unix socket only',
      excludedSupabaseServices: DISPOSABLE_SUPABASE_EXCLUDES,
      hostedDatabase: false,
      providerCredentials: false,
      providerMode: 'mock',
      browserAcceptance: browserAcceptanceEnabled,
      browserOnly: browserOnlyEnabled,
      testLane: browserOnlyEnabled
        ? 'browser-only'
        : browserAcceptanceEnabled
          ? 'integration-and-browser'
          : 'integration-only',
      providerLedger: browserAcceptanceEnabled ? 'loopback token-protected ledger' : 'disabled',
      testFileParallelism: false,
      teardown: 'supabase stop --no-backup, then remove temporary project directory',
    },
    providerContractCoverage: {
      selectedProvider: 'mock',
      outbound: 'mock invocation log records a distinct invocation and accepted external ID; no external provider request is permitted',
      sequenceFailures: 'native sequence tests cover definitive rejection and ambiguous provider outcomes with the mock transport',
      inbound: 'Sendillo and Dialpad webhook route fixtures, including signature and STOP/replay handling',
      adapterMapping: 'Sendillo outbound adapter unit coverage is outside this disposable integration lane; its documented 400 rejection and ambiguous timeout/network/5xx/2xx-without-ID mapping is not treated as production-provider evidence here',
      configuredProductionProvider: 'UNKNOWN (production inspection was not performed)',
    },
    productionEquivalence: {
      status: 'UNKNOWN',
      postgresVersion: 'UNKNOWN',
      postgrestVersion: 'UNKNOWN',
      transactionIsolation: 'UNKNOWN',
      configuredProvider: 'UNKNOWN',
      deployedCronCadence: 'UNKNOWN',
      reason: PRODUCTION_EQUIVALENCE_UNKNOWN_REASON,
    },
    criticalConstraint: {
      migration: 'supabase/migrations/20260917110000_sequence_runtime_recovery.sql',
      index: 'idx_step_runs_active_enrollment_step',
      key: ['enrollment_id', 'step_id'],
      predicate: 'claim_active',
      legacyIndex: 'idx_step_runs_unique_enrollment_step (retired by runtime recovery migration)',
      claimColumns: {
        claim_active: { default: true },
        attempt_outcome: { default: 'unknown' },
        attempt_started_at: { databaseClock: 'now()' },
        attempt_count: { default: 0 },
        failure_reason: { default: null },
      },
      staleClaimClockClamp: "least(coalesce(p_stale_before, now() - interval '15 minutes'), now() - interval '15 minutes')",
      databaseIndexes: database.indexes,
    },
    clocks: {
      quietHoursLocal: '[08:00, 21:00)',
      quietDeferralMs: 10 * 60 * 60 * 1000,
      enrollmentAndTick: 'application Date / Date.now()',
      resumeAndRetry: {
        clock: 'PostgreSQL now()',
        paths: [
          'public.resume_sequence_enrollment',
          'public.retry_sequence_step',
        ],
        retryNextRun: 'now()',
        resumeNextRun: 'now() + make_interval(mins => step.delay_after_previous_minutes)',
      },
      staleClaimPredicate: {
        clock: 'PostgreSQL now()',
        expression: "least(coalesce(p_stale_before, now() - interval '15 minutes'), now() - interval '15 minutes')",
      },
      databaseAuditDefaults: 'PostgreSQL now() (not substituted by fake application Date)',
      staleClaimMinimumAgeMs: 15 * 60 * 1000,
      queueDeferralMs: 30 * 60 * 1000,
      sequenceTickBatch: 100,
      retainedClaimLookaheadRows: 100,
      retainedClaimLookaheadPages: 1,
      sequenceTickDrain: 240,
      sequenceTickBudgetMs: 240000,
      cronCadence: '*/5 * * * *',
      audit: CLOCK_AUDIT.map((entry) => {
        const manifestEntry = { ...entry };
        delete manifestEntry.contract;
        return manifestEntry;
      }),
    },
  };
  console.log(`[disposable-canary-manifest] ${JSON.stringify(manifest)}`);
}

let initialized = false;
try {
  const cliVersionOutput = await run('supabase', ['--version'], basic, true);
  if (!cliVersionOutput.includes(SUPABASE_CLI_VERSION)) throw new Error(`Expected Supabase CLI ${SUPABASE_CLI_VERSION}`);
  await run('supabase', ['init', '--workdir', workdir]);
  initialized = true;
  await cp(path.join(root, 'supabase/migrations'), path.join(workdir, 'supabase/migrations'), { recursive: true });
  // Supabase prints generated local keys during start. Capture both streams;
  // never forward that output to CI or a terminal.
  if (process.env.SANDRA_CANARY_RUNNER_CONTRACT !== '1') await assertDiskHeadroom();
  await run('supabase', ['start', '--workdir', workdir, '--exclude', DISPOSABLE_SUPABASE_EXCLUDES.join(',')], basic, true);
  let status;
  try {
    status = JSON.parse(await run('supabase', ['status', '--workdir', workdir, '--output', 'json'], basic, true));
  } catch {
    throw new Error('Unable to read local Supabase status JSON');
  }
  if (status.API_URL !== LOOPBACK_API_URL || status.DB_URL !== LOOPBACK_DB_URL) throw new Error('Unexpected local stack endpoints');
  if (process.env.SANDRA_CANARY_RUNNER_CONTRACT !== '1') await printEnvironmentManifest(status, workdir, cliVersionOutput);
  const testEnv = {
    ...basic,
    TEST_SUPABASE_URL: status.API_URL,
    TEST_SUPABASE_DB_URL: status.DB_URL,
    TEST_SUPABASE_ANON_KEY: status.ANON_KEY,
    TEST_SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
    NEXT_PUBLIC_SUPABASE_URL: status.API_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: status.ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
    E2E_DISPOSABLE_DATABASE: '1',
    E2E_CI_SUPABASE_DB_URL: status.DB_URL,
    E2E_ALLOW_LOCAL_SUPABASE: '1',
    MESSAGING_PROVIDER: 'mock',
    ADDRESS_VERIFIER_PROVIDER: 'mock',
    SKIP_TRACE_PROVIDER: 'mock',
  };
  if (browserAcceptanceEnabled && browserIdentity && browserLedgerToken) {
    Object.assign(testEnv, {
      E2E_RUN_SLUG: browserIdentity.runSlug,
      E2E_TEST_USER_EMAIL: browserIdentity.email,
      E2E_TEST_USER_PASSWORD: browserIdentity.password,
      E2E_AUTH_BYPASS: '1',
      NEXT_PUBLIC_HUGO_SSO: '0',
      CRON_SECRET: 'sequence-readiness-local-cron',
      SEQUENCE_READINESS_MOCK_PROVIDER_LEDGER: '1',
      SEQUENCE_READINESS_LEDGER_URL: 'http://127.0.0.1:3558/ledger',
      SEQUENCE_READINESS_LEDGER_TOKEN: browserLedgerToken,
      NEXT_FONT_GOOGLE_MOCKED_RESPONSES: path.join(root, 'tests/sequence-readiness/google-fonts-mock.cjs'),
    });
  }
  await run('npx', ['tsx', 'scripts/provision-disposable-canary-owner.ts'], testEnv);
  if (!browserOnlyEnabled) {
    await run('npx', ['vitest', 'run', '--config', 'vitest.disposable-canary.config.ts'], testEnv);
  }
  if (browserAcceptanceEnabled) {
    await run('npx', ['playwright', 'test', '--config', 'playwright.sequence-readiness.config.ts'], testEnv);
  }
} catch (error) {
  console.error(scrubDiagnostic(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
} finally {
  cleaning = true;
  // The unique project is destroyed even after seed/test failure. No shared reset.
  let cleanupFailure;
  if (initialized) {
    try {
      await run('supabase', ['stop', '--workdir', workdir, '--no-backup']);
    } catch (error) {
      cleanupFailure = error;
      console.error(`Disposable stack stop failed: ${scrubDiagnostic(error.message)}`);
    }
    try {
      await removeOwnedDockerResources();
    } catch (error) {
      cleanupFailure ??= error;
      console.error(`Disposable Docker cleanup failed: ${scrubDiagnostic(error.message)}`);
    }
  }
  try {
    await rm(workdir, { recursive: true, force: true });
  } catch (error) {
    cleanupFailure ??= error;
    console.error(`Disposable project directory cleanup failed: ${scrubDiagnostic(error.message)}`);
  }
  if (cleanupFailure) process.exitCode = 1;
}
