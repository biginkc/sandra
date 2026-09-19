/**
 * Identity required in messages that are explicitly marked as cold openers.
 * Keep this literal so opener copy does not change with account or process
 * environment configuration.
 */
export const OPENING_IDENTITY = "Mel with BMH" as const;
const OPENING_IDENTITY_PATTERN = /\bMel\s+with\s+BMH\b/i;

export function hasOpeningIdentity(body: string): boolean {
  return OPENING_IDENTITY_PATTERN.test(body);
}

export function openingIdentityError(body: string): string | null {
  return hasOpeningIdentity(body)
    ? null
    : `Opening SMS must identify the sender as "${OPENING_IDENTITY}".`;
}
