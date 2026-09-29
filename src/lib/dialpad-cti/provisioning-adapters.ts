/**
 * Real-world adapters for the provisioning ports. Every boundary is injectable
 * so tests never touch Keychain, 1Password, Vercel, Dialpad or Supabase.
 *
 * Secret handling rules enforced here:
 *  - 1Password is reached through the SDK only (never the `op` binary). The
 *    read-only service-account token is fetched lazily from the macOS Keychain;
 *    the read-write token is fetched only when an item must be created.
 *  - Vercel receives values on stdin only; argv never carries a value.
 *  - Errors thrown from here carry an HTTP status or exit code, never a
 *    response body, stderr text or request text.
 */

import { execFileSync, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { DIALPAD_API_ORIGIN } from './directory';
import {
  ProvisioningError,
  type ConnectionDbPort,
  type ConnectionInsert,
  type ConnectionObservation,
  type DialpadHttpResponse,
  type DialpadPort,
  type SchemaState,
  type SecretRead,
  type SecretStorePort,
  type VercelPort,
} from './provisioning';

export const VAULT_TITLE = 'BMH Secrets';
export const READ_TOKEN_SERVICE = 'OP_SERVICE_ACCOUNT_TOKEN';
export const WRITE_TOKEN_SERVICE = 'OP_SERVICE_ACCOUNT_TOKEN_RW';
export const MANAGEMENT_PAT_ITEM = 'Supabase - Management API PAT';
export const MANAGEMENT_API_ORIGIN = 'https://api.supabase.com';
export const DEFAULT_SUPABASE_PROJECT_REF = 'copflsklaefwzipsrjqz';
export const DEFAULT_VERCEL_PROJECT = 'sandra';
export const DEFAULT_VERCEL_SCOPE = 'jarrad-5416s-projects';

const REQUEST_TIMEOUT_MS = 15_000;

/* ---------------------------- 1Password SDK ---------------------------- */

interface SdkVault {
  id: string;
  title: string;
}
interface SdkOverview {
  id: string;
  title: string;
  state?: string;
}
interface SdkItem {
  fields: { title: string; value?: string }[];
}
interface SdkClient {
  vaults: { list(): Promise<SdkVault[]> };
  items: {
    list(vaultId: string): Promise<SdkOverview[]>;
    get(vaultId: string, itemId: string): Promise<SdkItem>;
    create(params: Record<string, unknown>): Promise<unknown>;
  };
}
export interface OnePasswordSdk {
  createClient(config: { auth: string; integrationName: string; integrationVersion: string }): Promise<SdkClient>;
  ItemCategory: { ApiCredentials: string };
  ItemFieldType: { Concealed: string };
}

export function readKeychainSecret(service: string): string {
  const token = execFileSync('security', ['find-generic-password', '-w', '-s', service], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  if (!token) throw new ProvisioningError('keychain_unavailable', `${service} is empty in the macOS Keychain`);
  return token;
}

/** `CTI_PROVISION_OP_SDK_PATH` may point at an installed @1password/sdk entry file when the repo has no local install. */
export async function loadOnePasswordSdk(): Promise<OnePasswordSdk> {
  const override = process.env.CTI_PROVISION_OP_SDK_PATH;
  const specifier = override ? pathToFileURL(override).href : '@1password/sdk';
  return (await import(/* @vite-ignore */ specifier)) as OnePasswordSdk;
}

export interface SecretStoreDeps {
  readKeychain?: (service: string) => string;
  loadSdk?: () => Promise<OnePasswordSdk>;
}

export function createOnePasswordSecretStore(deps: SecretStoreDeps = {}): SecretStorePort {
  const readKeychain = deps.readKeychain ?? readKeychainSecret;
  const loadSdk = deps.loadSdk ?? loadOnePasswordSdk;
  const clients = new Map<string, Promise<{ client: SdkClient; vaultId: string }>>();

  const connect = (service: string) => {
    let pending = clients.get(service);
    if (!pending) {
      pending = (async () => {
        const sdk = await loadSdk();
        const client = await sdk.createClient({ auth: readKeychain(service), integrationName: 'sandra-cti-provisioning', integrationVersion: '1.0.0' });
        const vaults = (await client.vaults.list()).filter((vault) => vault.title === VAULT_TITLE);
        if (vaults.length !== 1) throw new ProvisioningError('vault_unavailable', `${VAULT_TITLE} vault is unavailable to this service account`);
        return { client, vaultId: vaults[0]!.id };
      })();
      clients.set(service, pending);
    }
    return pending;
  };

  return {
    async read(itemTitle, fieldTitle): Promise<SecretRead> {
      const { client, vaultId } = await connect(READ_TOKEN_SERVICE);
      const matches = (await client.items.list(vaultId)).filter((item) => item.title === itemTitle && (item.state === undefined || item.state === 'active'));
      if (matches.length === 0) return { state: 'missing' };
      if (matches.length > 1) return { state: 'duplicate' };
      const item = await client.items.get(vaultId, matches[0]!.id);
      const value = item.fields.find((field) => field.title === fieldTitle)?.value;
      return value ? { state: 'found', value } : { state: 'no_field' };
    },
    async create(itemTitle, fieldTitle, value, note) {
      const sdk = await loadSdk();
      const { client, vaultId } = await connect(WRITE_TOKEN_SERVICE);
      await client.items.create({
        category: sdk.ItemCategory.ApiCredentials,
        vaultId,
        title: itemTitle,
        fields: [{ id: 'credential', title: fieldTitle, fieldType: sdk.ItemFieldType.Concealed, value }],
        notes: note,
        tags: ['dialpad-cti', 'managed-by-provisioning'],
      });
    },
  };
}

/* ------------------------------- Vercel -------------------------------- */

export interface CommandResult {
  code: number;
  stdout: string;
}
export type CommandRunner = (command: string, args: readonly string[], stdin?: string) => Promise<CommandResult>;

export const runCommand: CommandRunner = (command, args, stdin) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ['pipe', 'pipe', 'ignore'], env: sanitizedEnv() });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.on('error', () => reject(new ProvisioningError('command_failed', `${command} could not be started`)));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout }));
    child.stdin.on('error', () => undefined);
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });

function sanitizedEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('OP_')) delete env[key];
  return env;
}

const ENV_NAME = /^[A-Z][A-Z0-9_]{0,200}$/;

/** Names only: a row counts when its first column is an env name and the row mentions Production. Values are discarded. */
export function parseVercelEnvNames(stdout: string): string[] {
  const names = new Set<string>();
  for (const line of stdout.split('\n')) {
    const columns = line.trim().split(/\s+/);
    const name = columns[0];
    if (name && ENV_NAME.test(name) && /\bProduction\b/.test(line)) names.add(name);
  }
  return [...names].sort();
}

export function createVercelPort(options: { project?: string; scope?: string; run?: CommandRunner } = {}): VercelPort {
  const run = options.run ?? runCommand;
  const project = options.project ?? DEFAULT_VERCEL_PROJECT;
  const scope = options.scope ?? DEFAULT_VERCEL_SCOPE;
  return {
    async listProductionEnvNames() {
      const result = await run('vercel', ['env', 'ls', 'production', '--project', project, '--scope', scope]);
      if (result.code !== 0) throw new ProvisioningError('vercel_list_failed', `vercel env ls exited ${result.code}`);
      return parseVercelEnvNames(result.stdout);
    },
    async addSensitiveProductionEnv(name, value) {
      if (!ENV_NAME.test(name)) throw new ProvisioningError('invalid_env_name', 'refusing to add an invalid env name');
      const result = await run('vercel', ['env', 'add', name, 'production', '--sensitive', '--project', project, '--scope', scope], value);
      if (result.code !== 0) throw new ProvisioningError('vercel_add_failed', `vercel env add ${name} exited ${result.code}`);
    },
  };
}

/* ------------------------------- Dialpad ------------------------------- */

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; redirect: 'error'; cache: 'no-store'; signal: AbortSignal },
) => Promise<{ status: number; text(): Promise<string> }>;

const DIALPAD_PATH = /^\/api\/v2\/[A-Za-z0-9/_?=&%.-]{1,300}$/;

export function createDialpadPort(apiKey: () => Promise<string>, fetchImpl: FetchLike = (url, init) => fetch(url, init)): DialpadPort {
  return {
    async request(method, path, bodyText): Promise<DialpadHttpResponse> {
      if (!DIALPAD_PATH.test(path)) throw new ProvisioningError('invalid_path', 'refusing to call an unexpected Dialpad path');
      const key = await apiKey();
      let response;
      try {
        response = await fetchImpl(`${DIALPAD_API_ORIGIN}${path}`, {
          method,
          headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', ...(bodyText !== undefined ? { 'Content-Type': 'application/json' } : {}) },
          ...(bodyText !== undefined ? { body: bodyText } : {}),
          redirect: 'error',
          cache: 'no-store',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch {
        throw new ProvisioningError('dialpad_unreachable', `Dialpad ${method} ${path.split('?')[0]} did not complete`);
      }
      return { status: response.status, text: await response.text() };
    },
  };
}

/* ------------------------ Supabase Management API ----------------------- */

export type QueryRunner = (sql: string) => Promise<unknown[]>;

const SAFE_TEXT = /^[A-Za-z0-9_.:/-]{1,300}$/;
const SAFE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function lit(value: string, pattern: RegExp): string {
  if (!pattern.test(value)) throw new ProvisioningError('unsafe_sql_value', 'a value failed validation before SQL construction');
  return `'${value}'`;
}

export function createManagementQueryRunner(projectRef: string, pat: () => Promise<string>, fetchImpl: FetchLike = (url, init) => fetch(url, init)): QueryRunner {
  if (!/^[a-z]{20}$/.test(projectRef)) throw new ProvisioningError('invalid_input', 'invalid Supabase project ref');
  return async (sql) => {
    let response;
    try {
      response = await fetchImpl(`${MANAGEMENT_API_ORIGIN}/v1/projects/${projectRef}/database/query`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${await pat()}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ query: sql }),
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new ProvisioningError('db_unreachable', 'the Supabase Management API did not respond');
    }
    if (response.status !== 200 && response.status !== 201) throw new ProvisioningError('db_query_failed', `Management API query returned HTTP ${response.status}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await response.text());
    } catch {
      throw new ProvisioningError('db_query_failed', 'Management API returned unreadable JSON');
    }
    if (!Array.isArray(parsed)) throw new ProvisioningError('db_query_failed', 'Management API returned a non-array result');
    return parsed;
  };
}

function firstRow(rows: unknown[]): Record<string, unknown> | null {
  const row = rows[0];
  return row && typeof row === 'object' ? (row as Record<string, unknown>) : null;
}

/** Data statements only. Schema DDL stays in the workflow-run migrations. */
export function createConnectionDbPort(run: QueryRunner): ConnectionDbPort {
  return {
    async inspectSchema(): Promise<SchemaState> {
      const row = firstRow(
        await run(`select
          (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'dialpad_org_connections'
             and column_name in ('dialpad_company_id', 'directory_api_key_ref')) = 2 as a2_columns,
          exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname = 'dialpad_cti_custom_data') as custom_data_function`),
      );
      return { a2Columns: row?.a2_columns === true, customDataFunction: row?.custom_data_function === true };
    },
    async organizationExists(orgId) {
      const row = firstRow(await run(`select exists (select 1 from public.organizations where id = ${lit(orgId, SAFE_UUID)}) as org_exists`));
      return row?.org_exists === true;
    },
    async findConnection(orgId, ctiClientId): Promise<ConnectionObservation | null> {
      const clientCheck = ctiClientId ? `(cti_client_id = ${lit(ctiClientId, /^[A-Za-z0-9_-]{1,200}$/)})` : 'false';
      const row = firstRow(
        await run(`select id, status, webhook_secret_ref, webhook_secret_version, allowed_origins, dialpad_company_id, directory_api_key_ref,
          ${clientCheck} as cti_client_id_matches
          from public.dialpad_org_connections where org_id = ${lit(orgId, SAFE_UUID)}`),
      );
      if (!row) return null;
      if (typeof row.id !== 'string' || typeof row.status !== 'string' || typeof row.webhook_secret_ref !== 'string') {
        throw new ProvisioningError('db_query_failed', 'connection row had an unexpected shape');
      }
      return {
        id: row.id,
        status: row.status,
        webhookSecretRef: row.webhook_secret_ref,
        webhookSecretVersion: Number(row.webhook_secret_version),
        allowedOrigins: Array.isArray(row.allowed_origins) ? row.allowed_origins.filter((o): o is string => typeof o === 'string') : [],
        companyId: typeof row.dialpad_company_id === 'string' ? row.dialpad_company_id : null,
        directoryKeyRef: typeof row.directory_api_key_ref === 'string' ? row.directory_api_key_ref : null,
        ctiClientIdMatches: row.cti_client_id_matches === true,
      };
    },
    async insertDisabledConnection(row: ConnectionInsert) {
      const result = firstRow(
        await run(`insert into public.dialpad_org_connections
          (org_id, status, cti_client_id, allowed_origins, webhook_secret_ref, webhook_secret_version, dialpad_company_id, directory_api_key_ref)
          values (${lit(row.orgId, SAFE_UUID)}, 'disabled', ${lit(row.ctiClientId, /^[A-Za-z0-9_-]{1,200}$/)}, array['https://dialpad.com']::text[],
            ${lit(row.webhookSecretRef, SAFE_TEXT)}, 1, ${lit(row.companyId, /^[0-9]{1,20}$/)}, ${lit(row.directoryKeyRef, SAFE_TEXT)})
          on conflict (org_id) do nothing returning id`),
      );
      return typeof result?.id === 'string' ? result.id : null;
    },
    async activateConnection(id, expected) {
      const rows = await run(`update public.dialpad_org_connections set status = 'active', updated_at = now()
        where id = ${lit(id, SAFE_UUID)} and org_id = ${lit(expected.orgId, SAFE_UUID)} and status = 'disabled'
          and webhook_secret_ref = ${lit(expected.webhookSecretRef, SAFE_TEXT)} and webhook_secret_version = 1
          and dialpad_company_id = ${lit(expected.companyId, /^[0-9]{1,20}$/)} and directory_api_key_ref = ${lit(expected.directoryKeyRef, SAFE_TEXT)}
          and allowed_origins = array['https://dialpad.com']::text[]
          and cti_client_id = ${lit(expected.ctiClientId, /^[A-Za-z0-9_-]{1,200}$/)}
        returning id`);
      return rows.length;
    },
  };
}
