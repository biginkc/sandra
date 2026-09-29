#!/usr/bin/env tsx
/**
 * Provision the Dialpad CTI production configuration (preflight blockers B1-B3).
 * Dry-run by default: prints a secret-free plan and its digest, changes nothing.
 *
 *   npx tsx scripts/provision-dialpad-cti.ts \
 *     --org-id <uuid> --company-id <dialpad company id> --canary-user-id <dialpad user id> [--canary-user-id <id>]
 *
 *   # apply exactly the previewed plan (creates the connection DISABLED, the
 *   # secret, the two Vercel env names, the webhook and DISABLED subscriptions):
 *   ... --execute --expect-plan <digest from the dry-run>
 *
 *   # separate, restricted step after root's live-readiness review and a redeploy:
 *   ... --mode activate --execute --expect-plan <digest> --confirm-live-readiness <connection id>
 *
 * 1Password is reached through the SDK only (Keychain service token bootstrap);
 * never the `op` binary. No secret value is ever printed or passed on argv.
 * CTI_PROVISION_OP_SDK_PATH may point at an installed @1password/sdk entry file.
 */

import { parseArgs } from 'node:util';

import {
  CREDENTIAL_FIELD,
  ProvisioningError,
  SecretGuard,
  parseInputs,
  runProvisioning,
  type ProvisioningPorts,
} from '../src/lib/dialpad-cti/provisioning';
import {
  DEFAULT_SUPABASE_PROJECT_REF,
  MANAGEMENT_PAT_ITEM,
  createConnectionDbPort,
  createDialpadPort,
  createManagementQueryRunner,
  createOnePasswordSecretStore,
  createVercelPort,
} from '../src/lib/dialpad-cti/provisioning-adapters';

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      mode: { type: 'string' },
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
    // The item titles are fixed defaults; override only through code review.
  });

  const guard = new SecretGuard();
  const secrets = createOnePasswordSecretStore();
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
    db: createConnectionDbPort(createManagementQueryRunner(values['project-ref'] ?? DEFAULT_SUPABASE_PROJECT_REF, () => readOnce(MANAGEMENT_PAT_ITEM))),
    vercel: createVercelPort({ project: values['vercel-project'], scope: values['vercel-scope'] }),
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
