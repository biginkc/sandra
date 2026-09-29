/**
 * dialpad_org_connections.webhook_secret_ref is a name, never a value. The only
 * supported scheme is `env:DIALPAD_CTI_WEBHOOK_SECRET_<SUFFIX>`, resolved from
 * the server environment. The mandatory prefix keeps a mis-set reference from
 * reading an unrelated variable (for example a service key).
 *
 * During a rotation the previous secret may be supplied as
 * `<NAME>_PREVIOUS`; it is only accepted for the immediately preceding secret
 * version, so the webhook can be re-pointed at Dialpad without dropping events.
 */

const REF_PATTERN = /^env:(DIALPAD_CTI_WEBHOOK_SECRET_[A-Z0-9_]{1,80})$/;
const MIN_SECRET_LENGTH = 16;

export interface DialpadWebhookSecretCandidate {
  secret: string;
  version: number;
}

export type DialpadWebhookSecretEnv = Readonly<Record<string, string | undefined>>;

export function resolveDialpadWebhookSecrets(
  ref: string,
  currentVersion: number,
  env: DialpadWebhookSecretEnv,
): DialpadWebhookSecretCandidate[] {
  const match = REF_PATTERN.exec(ref);
  if (!match || !Number.isInteger(currentVersion) || currentVersion < 1) return [];
  const name = match[1]!;
  const candidates: DialpadWebhookSecretCandidate[] = [];
  const current = env[name];
  if (typeof current === 'string' && current.length >= MIN_SECRET_LENGTH) candidates.push({ secret: current, version: currentVersion });
  const previous = env[`${name}_PREVIOUS`];
  if (currentVersion > 1 && typeof previous === 'string' && previous.length >= MIN_SECRET_LENGTH && previous !== current) {
    candidates.push({ secret: previous, version: currentVersion - 1 });
  }
  return candidates;
}
