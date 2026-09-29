#!/usr/bin/env tsx
/**
 * Configure one already-reviewed Dialpad recording receiver on an existing
 * DISABLED connection. Dry-run is the default; this command never creates a
 * connection, changes Dialpad subscriptions, probes the endpoint, or mutates
 * schema. The verified hostname must come from the dedicated service's actual
 * domain readback supplied by the operator.
 *
 * First setup:
 *   npx tsx scripts/configure-dialpad-recording-endpoint.ts \
 *     --org-id <uuid> --connection-id <uuid> --company-id <dialpad id> \
 *     --endpoint wss://receiver.example.up.railway.app/dialpad-browser-ingest \
 *     --verified-hostname receiver.example.up.railway.app \
 *     --expected-previous-endpoint null
 *
 * Apply exactly the reviewed dry-run:
 *   ... --execute --expect-plan <digest>
 */

import { parseArgs } from 'node:util';

import {
  DEFAULT_SUPABASE_PROJECT_REF,
  ProvisioningError,
  SecretGuard,
  type ConnectionDbPort,
} from '../src/lib/dialpad-cti/provisioning';
import {
  MANAGEMENT_PAT_ITEM,
  createConnectionDbPort,
  createManagementQueryRunner,
  createOnePasswordSecretStore,
} from '../src/lib/dialpad-cti/provisioning-adapters';
import {
  parseRecordingEndpointInputs,
  runRecordingEndpointConfiguration,
} from '../src/lib/dialpad-cti/recording-endpoint';

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      'org-id': { type: 'string' },
      'connection-id': { type: 'string' },
      'company-id': { type: 'string' },
      endpoint: { type: 'string' },
      'verified-hostname': { type: 'string' },
      'expected-previous-endpoint': { type: 'string' },
      'project-ref': { type: 'string' },
      execute: { type: 'boolean', default: false },
      'expect-plan': { type: 'string' },
    },
    strict: true,
  });
  const previousRaw = values['expected-previous-endpoint'];
  const inputs = parseRecordingEndpointInputs({
    orgId: values['org-id'],
    connectionId: values['connection-id'],
    companyId: values['company-id'],
    endpoint: values.endpoint,
    verifiedHostname: values['verified-hostname'],
    projectRef: values['project-ref'] ?? DEFAULT_SUPABASE_PROJECT_REF,
    ...(previousRaw === 'null' ? { expectedPreviousEndpoint: null } : { expectedPreviousEndpoint: previousRaw }),
  });

  const guard = new SecretGuard();
  const secrets = createOnePasswordSecretStore();
  const cached = new Map<string, Promise<string>>();
  const readOnce = (title: string) => {
    let pending = cached.get(title);
    if (!pending) {
      pending = (async () => {
        const read = await secrets.read(title, 'credential');
        if (read.state !== 'found') throw new ProvisioningError('secret_unavailable', `1Password item unavailable: ${title}`);
        guard.add(read.value);
        return read.value;
      })();
      cached.set(title, pending);
    }
    return pending;
  };
  const db: ConnectionDbPort = createConnectionDbPort(createManagementQueryRunner(inputs.projectRef, () => readOnce(MANAGEMENT_PAT_ITEM)));
  const result = await runRecordingEndpointConfiguration(db, inputs, { execute: values.execute === true, expectPlan: values['expect-plan'] });
  for (const line of result.lines) process.stdout.write(`${guard.scrub(line)}\n`);
  return result.exitCode;
}

main().then((code) => process.exitCode = code).catch((error: unknown) => {
  const message = error instanceof ProvisioningError ? `${error.code}: ${error.message}` : 'unexpected_error';
  process.stderr.write(`configure-dialpad-recording-endpoint failed: ${message}\n`);
  process.exitCode = 1;
});
