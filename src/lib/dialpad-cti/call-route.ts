import type { DialpadCallingBootstrap } from './dispatch';

export type DialpadCallRoute = 'dialpad' | 'softphone';

export interface DialpadCallRouteFacts {
  /** `click_to_dial` flag for the org (a missing row reads false). */
  clickToDialFlag: boolean;
  /** `schemaReady('api_dial')`. */
  apiDialSchemaReady: boolean;
  /** `loadDialpadCallingBootstrap` result: null unless the org Dialpad connection is active. */
  bootstrap: DialpadCallingBootstrap | null;
}

/**
 * The one rule for where a Call button sends the call. Dialpad only when ALL hold: the flag is on, the
 * api_dial schema has landed, the org Dialpad connection is active (bootstrap non-null) and the viewer
 * has a live (pending or verified) binding. Anything else is the legacy softphone, unchanged.
 */
export function decideDialpadCallRoute(facts: DialpadCallRouteFacts): DialpadCallRoute {
  if (!facts.clickToDialFlag || !facts.apiDialSchemaReady) return 'softphone';
  if (!facts.bootstrap) return 'softphone';
  if (facts.bootstrap.binding.status === 'none') return 'softphone';
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
export async function loadDialpadCallRoute(deps: DialpadCallRouteDeps, orgId: string, userId: string): Promise<DialpadCallRoute> {
  try {
    if (!(await deps.isFlagOn(orgId))) return 'softphone';
    if (!(await deps.isSchemaReady())) return 'softphone';
    const bootstrap = await deps.loadBootstrap(orgId, userId);
    return decideDialpadCallRoute({ clickToDialFlag: true, apiDialSchemaReady: true, bootstrap });
  } catch {
    return 'softphone';
  }
}
