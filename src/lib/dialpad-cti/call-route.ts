import type { DialpadCallingBootstrap } from './dispatch';

export type DialpadCallRoute = 'dialpad' | 'softphone';

export interface DialpadCallRouteFacts {
  /** `click_to_dial` flag for the org (a missing row reads false). */
  clickToDialFlag: boolean;
  /** `schemaReady('api_dial')`. */
  apiDialSchemaReady: boolean;
  /** `loadDialpadCallingBootstrap` result: null unless the org Dialpad connection is active. */
  bootstrap: DialpadCallingBootstrap | null;
  /** The viewer is an active Acquisitions member (`isAcquisitionsCaller`: acquisitions_enabled with active access, any role). */
  acquisitionsMember: boolean;
}

/**
 * The one rule for where a Call button sends the call. Dialpad only when ALL hold: the flag is on, the
 * api_dial schema has landed, the org Dialpad connection is active (bootstrap non-null) and the viewer is
 * an active Acquisitions caller (acquisitions_enabled, any role, owners included). Everyone else is the legacy softphone, even with a Dialpad binding.
 * An Acquisitions member with no live binding stays on Dialpad: the dial is refused server-side with the
 * "not verified" denial, never silently sent to Telnyx.
 */
export function decideDialpadCallRoute(facts: DialpadCallRouteFacts): DialpadCallRoute {
  if (!facts.acquisitionsMember) return 'softphone';
  if (!facts.clickToDialFlag || !facts.apiDialSchemaReady) return 'softphone';
  if (!facts.bootstrap) return 'softphone';
  return 'dialpad';
}

export interface DialpadCallRouteDeps {
  isFlagOn(orgId: string): Promise<boolean>;
  isSchemaReady(): Promise<boolean>;
  loadBootstrap(orgId: string, userId: string): Promise<DialpadCallingBootstrap | null>;
}

/**
 * Server-derived route for a viewer. Short-circuits so that with the flag off nothing beyond the flag read
 * runs, and any failure reads as the softphone (never blocks a page).
 */
export async function loadDialpadCallRoute(deps: DialpadCallRouteDeps, orgId: string, userId: string, acquisitionsMember: boolean): Promise<DialpadCallRoute> {
  if (!acquisitionsMember) return 'softphone';
  try {
    if (!(await deps.isFlagOn(orgId))) return 'softphone';
    if (!(await deps.isSchemaReady())) return 'softphone';
    const bootstrap = await deps.loadBootstrap(orgId, userId);
    return decideDialpadCallRoute({ clickToDialFlag: true, apiDialSchemaReady: true, bootstrap, acquisitionsMember });
  } catch {
    return 'softphone';
  }
}
