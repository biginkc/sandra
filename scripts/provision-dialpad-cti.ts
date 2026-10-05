#!/usr/bin/env tsx
/**
 * Provision the Dialpad CTI production configuration (preflight blockers B1-B3).
 * Dry-run by default: prints a secret-free plan and its digest, changes nothing.
 *
 *   npx tsx scripts/provision-dialpad-cti.ts \
 *     [--mode prepare|activate|deactivate] [--secret-source op|sdk] --org-id <uuid> --company-id <dialpad company id> --canary-user-id <dialpad user id> [--canary-user-id <id>]
 *
 *   # apply exactly the previewed plan (creates the connection DISABLED, the
 *   # secret, the two Vercel env names, the webhook and DISABLED subscriptions):
 *   ... --execute --expect-plan <digest from the dry-run>
 *
 *   # separate, restricted step after root's live-readiness review and a redeploy:
 *   ... --mode activate --execute --expect-plan <digest> --confirm-live-readiness <connection id>
 *
 *   # reverse of activate: disables every canary subscription, then the connection:
 *   ... --mode deactivate --execute --expect-plan <digest> --confirm-live-readiness <connection id>
 *
 * 1Password is reached through the `op` CLI with the BMH service account
 * (OP_SERVICE_ACCOUNT_TOKEN from the environment) by default: --secret-source op.
 * The SDK path (--secret-source sdk, Keychain token bootstrap) remains only for
 * prepare-mode item creation, which the op store refuses. No secret value is
 * ever printed or passed on argv.
 * CTI_PROVISION_OP_SDK_PATH may point at an installed @1password/sdk entry file.
 */

import { parseArgs } from 'node:util';

import {
  CREDENTIAL_FIELD,
  DEFAULT_SUPABASE_PROJECT_REF,
  DEFAULT_VERCEL_PROJECT,
  DEFAULT_VERCEL_SCOPE,
  ProvisioningError,
  SecretGuard,
  parseInputs,
  runProvisioning,
  type ProvisioningPorts,
} from '../src/lib/dialpad-cti/provisioning';
import {
  MANAGEMENT_PAT_ITEM,
  createConnectionDbPort,
  createDialpadPort,
  createManagementQueryRunner,
  createOnePasswordSecretStore,
  createOpCliSecretStore,
  createVercelPort,
} from '../src/lib/dialpad-cti/provisioning-adapters';

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      mode: { type: 'string' },
      'secret-source': { type: 'string', default: 'op' },
      'org-id': { type: 'string' },
      'company-id': { type: 'string' },
      'canary-user-id': { type: 'string', multiple: true },
      'public-origin': { type: 'string' },
      suffix: { type: 'string' },
      'project-ref': { type: 'string' },
      'vercel-project': { type: 'string' },
      'vercel-scope': { type: 'string' },
      execute: { type: 'boolean', default: false },
      'expect-plan': { type: 'string' },
      'confirm-live-readiness': { type: 'string' },
    },
    strict: true,
  });

  const inputs = parseInputs({
    mode: values.mode,
    orgId: values['org-id'],
    companyId: values['company-id'],
    canaryUserIds: values['canary-user-id'],
    publicOrigin: values['public-origin'],
    suffix: values.suffix,
    projectRef: values['project-ref'] ?? DEFAULT_SUPABASE_PROJECT_REF,
    vercelProject: values['vercel-project'] ?? DEFAULT_VERCEL_PROJECT,
    vercelScope: values['vercel-scope'] ?? DEFAULT_VERCEL_SCOPE,
    // The item titles are fixed defaults; override only through code review.
  });

  const secretSource = values['secret-source'] ?? 'op';
  if (secretSource !== 'op' && secretSource !== 'sdk') throw new ProvisioningError('invalid_input', '--secret-source must be op or sdk');
  const guard = new SecretGuard();
  const secrets = secretSource === 'sdk' ? createOnePasswordSecretStore() : createOpCliSecretStore();
  const cached = new Map<string, Promise<string>>();
  const readOnce = (title: string) => {
    let pending = cached.get(title);
    if (!pending) {
      pending = (async () => {
        const read = await secrets.read(title, CREDENTIAL_FIELD);
        if (read.state !== 'found') throw new ProvisioningError('secret_unavailable', `1Password item unavailable: ${title}`);
        guard.add(read.value);
        return read.value;
      })();
      cached.set(title, pending);
    }
    return pending;
  };

  const ports: ProvisioningPorts = {
    secrets,
    db: createConnectionDbPort(createManagementQueryRunner(inputs.supabaseProjectRef, () => readOnce(MANAGEMENT_PAT_ITEM))),
    vercel: createVercelPort({ project: inputs.vercelProject, scope: inputs.vercelScope }),
    dialpad: createDialpadPort(() => readOnce(inputs.apiKeyItem)),
  };

  const result = await runProvisioning(
    ports,
    inputs,
    { execute: values.execute === true, expectPlan: values['expect-plan'], confirmLiveReadiness: values['confirm-live-readiness'] },
    guard,
  );
  for (const line of result.lines) process.stdout.write(`${line}\n`);
  return result.exitCode;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    const message = error instanceof ProvisioningError ? `${error.code}: ${error.message}` : error instanceof Error && error.name === 'TypeError' ? `invalid arguments (${error.message.split('\n')[0]})` : 'unexpected_error';
    process.stderr.write(`provision-dialpad-cti failed: ${message}\n`);
    process.exit(1);
  },
);
