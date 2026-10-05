import type { SupabaseClient } from '@supabase/supabase-js';

import { reportError } from '@/lib/errors/report';
import type { Database, Json } from '@/lib/supabase/types';

import {
  classifyDialpadRpcError,
  parseDialpadCallStatus,
  parseDialpadDispatchAuthorization,
  parsePreparedDialpadCallIntent,
  type DialpadCallStatus,
  type DialpadDenialDetail,
  type DialpadIdentityType,
} from './contracts';
import {
  assessDialpadDirectoryIdentity,
  dialpadDirectoryVerificationRef,
  fetchDialpadDirectoryUser,
  findDialpadDirectoryUserByEmail,
  parseClaimedDialpadUserId,
  resolveDialpadDirectoryKey,
  type DialpadDirectoryEnv,
  type DialpadDirectoryFetch,
} from './directory';
import { DialpadDbError } from './event-processing';
import { isDialpadTargetOriginConfigured } from './protocol';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DialpadDialEndpoint = 'initiate_call' | 'call';

export interface DialpadConnectionView {
  id: string;
  status: string;
  allowedOrigins: string[];
  companyId: string | null;
  directoryKeyRef: string | null;
  recordingIngestEndpoint?: string | null;
  /** Which Dialpad endpoint places API calls (2.7; Phase 0 decides, default initiate_call). */
  dialEndpoint: DialpadDialEndpoint;
  /** Separate dial key ref, or null to reuse the directory key. */
  dialKeyRef: string | null;
}

/** Per-slot DNC / validity pre-check (fn_dialpad_call_slots); never a substitute for the server-side enforcement. */
export interface DialpadCallSlot {
  slot: 1 | 2 | 3;
  callable: boolean;
  reason: 'property_dnc' | 'contact_dnc' | 'phone_dnc' | 'invalid' | null;
}

export interface DialpadBindingView {
  id: string;
  status: 'pending' | 'verified';
  dialpadUserId: string;
}

export interface DialpadGrantView {
  id: string;
  callerNumberE164: string;
  identityType: DialpadIdentityType | null;
}

export interface DialpadTargetPhones {
  contactId: string;
  slots: { slot: 1 | 2 | 3; raw: string }[];
}

/** The database surface used by A2; production wraps the service-role client, tests inject a fake. */
export interface DialpadDispatchDb {
  loadConnection(orgId: string): Promise<DialpadConnectionView | null>;
  loadLiveBinding(orgId: string, userId: string): Promise<DialpadBindingView | null>;
  loadActiveGrants(orgId: string, userId: string): Promise<DialpadGrantView[]>;
  loadTargetPhones(orgId: string, userId: string, propertyId: string, contactId: string): Promise<DialpadTargetPhones | null>;
  /** How many dials this rep authorized since `sinceIso`, and how many authorized intents are still unmatched and younger than 20 s. */
  loadDispatchLoad(orgId: string, userId: string, sinceIso: string): Promise<{ authorizedLastMinute: number; unmatchedLast20s: number }>;
  /**
   * The newest intent for this rep and lead whose dial was released (authorized), is still unmatched and
   * unexpired. It may or may not have rung. Null when none. Read-then-act like the other guards.
   */
  loadUnresolvedIntent(orgId: string, userId: string, propertyId: string, nowIso: string): Promise<{ intentId: string; idempotencyKey: string } | null>;
  loadCallSlots(orgId: string, userId: string, propertyId: string, contactId: string): Promise<DialpadCallSlot[]>;
  claimBinding(orgId: string, userId: string, dialpadUserId: string): Promise<Json>;
  verifyBinding(bindingId: string, kind: 'provider_directory', ref: string): Promise<Json>;
  prepareIntent(args: {
    orgId: string;
    userId: string;
    propertyId: string;
    contactId: string;
    phoneSlot: number;
    idempotencyKey: string;
    grantId: string | null;
  }): Promise<Json>;
  authorizeDispatch(orgId: string, userId: string, intentId: string): Promise<Json>;
  cancelIntent(orgId: string, userId: string, intentId: string): Promise<Json>;
  getCallStatus(orgId: string, userId: string, intentId: string): Promise<Json>;
}

type DbError = { code?: string | null; details?: string | null; message?: string } | null;

function unwrap<T>(result: { data: T; error: DbError }): T {
  if (result.error) throw new DialpadDbError(classifyDialpadRpcError(result.error), result.error.code ?? null);
  return result.data;
}

export function createSupabaseDialpadDispatchDb(client: SupabaseClient<Database>): DialpadDispatchDb {
  return {
    async loadConnection(orgId) {
      // `*` rather than a column list: the 2.7 dial columns land a minute after this code deploys,
      // and a named missing column would fail the whole bootstrap. Missing columns read as defaults.
      const { data, error } = await client
        .from('dialpad_org_connections')
        .select('*')
        .eq('org_id', orgId)
        .maybeSingle();
      if (error) throw new DialpadDbError(classifyDialpadRpcError(error), error.code ?? null);
      if (!data) return null;
      const row = data as Partial<typeof data>;
      return {
        id: data.id,
        status: data.status,
        allowedOrigins: data.allowed_origins,
        companyId: data.dialpad_company_id,
        directoryKeyRef: data.directory_api_key_ref,
        recordingIngestEndpoint: data.recording_ingest_endpoint,
        dialEndpoint: row.dial_endpoint === 'call' ? 'call' : 'initiate_call',
        dialKeyRef: typeof row.dial_api_key_ref === 'string' ? row.dial_api_key_ref : null,
      };
    },
    async loadLiveBinding(orgId, userId) {
      const { data, error } = await client
        .from('dialpad_member_bindings')
        .select('id, status, dialpad_user_id')
        .eq('org_id', orgId)
        .eq('user_id', userId)
        .neq('status', 'revoked')
        .maybeSingle();
      if (error) throw new DialpadDbError(classifyDialpadRpcError(error), error.code ?? null);
      if (!data || (data.status !== 'pending' && data.status !== 'verified')) return null;
      return { id: data.id, status: data.status, dialpadUserId: data.dialpad_user_id };
    },
    async loadActiveGrants(orgId, userId) {
      const { data, error } = await client
        .from('dialpad_number_grants')
        .select('id, caller_number_e164, identity_type')
        .eq('org_id', orgId)
        .eq('user_id', userId)
        .eq('status', 'active')
        .order('granted_at', { ascending: true })
        .limit(20);
      if (error) throw new DialpadDbError(classifyDialpadRpcError(error), error.code ?? null);
      return (data ?? []).map((grant) => ({
        id: grant.id,
        callerNumberE164: grant.caller_number_e164,
        identityType: grant.identity_type === 'Office' || grant.identity_type === 'OfficeGroup' || grant.identity_type === 'CallCenter'
          ? grant.identity_type
          : null,
      }));
    },
    async loadTargetPhones(orgId, userId, propertyId, contactId) {
      const { data: property, error: propertyError } = await client
        .from('properties')
        .select('id, assigned_user_id, homeowner_contact_id, deleted_at')
        .eq('id', propertyId)
        .eq('org_id', orgId)
        .maybeSingle();
      if (propertyError) throw new DialpadDbError(classifyDialpadRpcError(propertyError), propertyError.code ?? null);
      if (!property || property.deleted_at !== null || property.assigned_user_id !== userId) return null;
      if (property.homeowner_contact_id !== contactId) {
        const { data: link, error: linkError } = await client
          .from('property_contacts')
          .select('contact_id')
          .eq('org_id', orgId)
          .eq('property_id', propertyId)
          .eq('contact_id', contactId)
          .maybeSingle();
        if (linkError) throw new DialpadDbError(classifyDialpadRpcError(linkError), linkError.code ?? null);
        if (!link) return null;
      }
      const { data: contact, error: contactError } = await client
        .from('contacts')
        .select('id, phone_1, phone_2, phone_3, do_not_contact')
        .eq('id', contactId)
        .eq('org_id', orgId)
        .maybeSingle();
      if (contactError) throw new DialpadDbError(classifyDialpadRpcError(contactError), contactError.code ?? null);
      if (!contact || contact.do_not_contact) return null;
      const slots: DialpadTargetPhones['slots'] = [];
      for (const [slot, raw] of [[1, contact.phone_1], [2, contact.phone_2], [3, contact.phone_3]] as const) {
        if (typeof raw === 'string' && raw.trim().length > 0) slots.push({ slot, raw });
      }
      return { contactId: contact.id, slots };
    },
    // Accepted race: this read-then-act guard is not atomic, so two truly simultaneous dials from
    // one rep could both pass. Accepted for a single rep; the provider 429 is the backstop.
    async loadDispatchLoad(orgId, userId, sinceIso) {
      const { data, error } = await client
        .from('dialpad_call_intents')
        .select('id, status, dispatch_authorized_at, matched_at')
        .eq('org_id', orgId)
        .eq('rep_user_id', userId)
        .not('dispatch_authorized_at', 'is', null)
        .gte('dispatch_authorized_at', sinceIso)
        .limit(50);
      if (error) throw new DialpadDbError(classifyDialpadRpcError(error), error.code ?? null);
      const rows = data ?? [];
      const inFlightSince = Date.now() - 20_000;
      return {
        authorizedLastMinute: rows.length,
        unmatchedLast20s: rows.filter((row) => row.status === 'prepared' && row.matched_at === null
          && row.dispatch_authorized_at !== null && Date.parse(row.dispatch_authorized_at) >= inFlightSince).length,
      };
    },
    async loadUnresolvedIntent(orgId, userId, propertyId, nowIso) {
      const { data, error } = await client
        .from('dialpad_call_intents')
        .select('id, idempotency_key')
        .eq('org_id', orgId)
        .eq('rep_user_id', userId)
        .eq('property_id', propertyId)
        .eq('status', 'prepared')
        .is('matched_at', null)
        .not('dispatch_authorized_at', 'is', null)
        .gt('expires_at', nowIso)
        .order('dispatch_authorized_at', { ascending: false })
        .limit(1);
      if (error) throw new DialpadDbError(classifyDialpadRpcError(error), error.code ?? null);
      const row = data?.[0];
      return row ? { intentId: row.id as string, idempotencyKey: row.idempotency_key as string } : null;
    },
    async loadCallSlots(orgId, userId, propertyId, contactId) {
      const data = unwrap(await client.rpc('fn_dialpad_call_slots', { p_org_id: orgId, p_rep_user_id: userId, p_property_id: propertyId, p_contact_id: contactId }));
      if (!Array.isArray(data)) return [];
      const slots: DialpadCallSlot[] = [];
      for (const entry of data) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        const slot = entry.slot;
        const reason = entry.reason;
        if (slot !== 1 && slot !== 2 && slot !== 3) continue;
        slots.push({
          slot,
          callable: entry.callable === true,
          reason: reason === 'property_dnc' || reason === 'contact_dnc' || reason === 'phone_dnc' || reason === 'invalid' ? reason : null,
        });
      }
      return slots;
    },
    async claimBinding(orgId, userId, dialpadUserId) {
      return unwrap(await client.rpc('fn_claim_dialpad_member_binding', { p_org_id: orgId, p_user_id: userId, p_dialpad_user_id: dialpadUserId }));
    },
    async verifyBinding(bindingId, kind, ref) {
      return unwrap(await client.rpc('fn_verify_dialpad_member_binding', { p_binding_id: bindingId, p_verification_kind: kind, p_verification_ref: ref }));
    },
    async prepareIntent(args) {
      return unwrap(await client.rpc('fn_prepare_dialpad_call_intent', {
        p_org_id: args.orgId,
        p_rep_user_id: args.userId,
        p_property_id: args.propertyId,
        p_contact_id: args.contactId,
        p_phone_slot: args.phoneSlot,
        p_idempotency_key: args.idempotencyKey,
        p_number_grant_id: args.grantId,
      }));
    },
    async authorizeDispatch(orgId, userId, intentId) {
      return unwrap(await client.rpc('fn_authorize_dialpad_dispatch', { p_org_id: orgId, p_rep_user_id: userId, p_intent_id: intentId }));
    },
    async cancelIntent(orgId, userId, intentId) {
      return unwrap(await client.rpc('fn_cancel_dialpad_call_intent', { p_org_id: orgId, p_rep_user_id: userId, p_intent_id: intentId }));
    },
    async getCallStatus(orgId, userId, intentId) {
      return unwrap(await client.rpc('fn_get_dialpad_call_status', { p_org_id: orgId, p_rep_user_id: userId, p_intent_id: intentId }));
    },
  };
}

/** Org and rep always come from the authenticated session, never from client input. */
export interface DialpadActor {
  orgId: string;
  userId: string;
}

/** What the API-dial client needs: the connection is active and the rep's binding/grant state. No iframe, no browser capture (D4). */
export interface DialpadCallingBootstrap {
  connectionId: string;
  binding: { status: 'none' } | { status: 'pending' | 'verified'; dialpadUserId: string };
  grants: { id: string; callerNumberE164: string; identityType: DialpadIdentityType | null }[];
}

const DENIAL_MESSAGES: Record<DialpadDenialDetail, string> = {
  connection_inactive: 'Dialpad calling is not active for this organization.',
  my_leads_disabled: 'My Leads is not enabled for this organization.',
  rep_not_active: 'Your Acquisitions access is not active.',
  binding_not_verified: 'Your Dialpad account is not verified. Connect it before calling.',
  binding_exists: 'You already have a verified Dialpad account. Ask an owner to reset it.',
  binding_not_pending: 'This Dialpad connection can no longer be verified. Reconnect it.',
  property_unavailable: 'This lead is no longer available.',
  property_dnc_locked: 'This lead is locked as Do Not Contact.',
  not_assigned_rep: 'This lead is no longer assigned to you.',
  contact_not_on_property: 'This contact is no longer on the lead.',
  contact_do_not_contact: 'This contact is marked Do Not Contact.',
  phone_unavailable: 'That phone number changed. Refresh and choose it again.',
  phone_dnc: 'That phone number is on the Do Not Call list.',
  caller_grant_unavailable: 'That caller ID is no longer available to you.',
  granter_not_owner: 'Only an owner can grant caller IDs.',
  revoker_not_owner: 'Only an owner can revoke caller IDs.',
  dialpad_user_already_bound: 'That Dialpad account is already connected to another user.',
  intent_already_matched: 'This call is already in progress.',
};

export function dialpadDenialMessage(detail: DialpadDenialDetail | null): string {
  return detail ? DENIAL_MESSAGES[detail] : 'Sandra could not start this call.';
}

export type DialpadFailureCode =
  | 'invalid_input'
  | 'not_configured'
  | 'origin_not_allowed'
  | 'not_bound'
  | 'denied'
  | 'unsupported_caller_identity'
  | 'unavailable'
  | 'cancelled'
  | 'matched'
  | 'expired';

export interface DialpadFailure {
  ok: false;
  code: DialpadFailureCode;
  message: string;
  denial?: DialpadDenialDetail;
}

function fail(code: DialpadFailureCode, message: string, denial?: DialpadDenialDetail): DialpadFailure {
  return denial ? { ok: false, code, message, denial } : { ok: false, code, message };
}

function failureFromDbError(error: unknown): DialpadFailure {
  if (error instanceof DialpadDbError) {
    if (error.failure.kind === 'forbidden') return fail('denied', dialpadDenialMessage(error.failure.detail), error.failure.detail ?? undefined);
    if (error.failure.kind === 'not_found') return fail('invalid_input', 'That call or lead is no longer available.');
    if (error.failure.kind === 'invalid_input') return fail('invalid_input', 'Sandra could not accept that request.');
    if (error.failure.kind === 'idempotency_conflict') return fail('invalid_input', 'That request was already used for a different call. Start the call again.');
  }
  reportError(error instanceof Error ? error : new Error('dialpad cti operation failed'), {
    errorClass: 'database',
    tags: { surface: 'server', operation: 'dialpad_cti', kind: error instanceof DialpadDbError ? 'db_error' : 'unexpected' },
  });
  return fail('unavailable', 'Sandra could not reach Dialpad calling. Nothing was dialed; try again.');
}

/** Everything the API-dial client needs, or null when this org/rep has no usable Dialpad connection. */
export async function loadDialpadCallingBootstrap(db: DialpadDispatchDb, actor: DialpadActor): Promise<DialpadCallingBootstrap | null> {
  const connection = await db.loadConnection(actor.orgId);
  if (!connection || connection.status !== 'active' || !isDialpadTargetOriginConfigured(connection.allowedOrigins)) return null;
  const [binding, grants] = await Promise.all([db.loadLiveBinding(actor.orgId, actor.userId), db.loadActiveGrants(actor.orgId, actor.userId)]);
  return {
    connectionId: connection.id,
    binding: binding ? { status: binding.status, dialpadUserId: binding.dialpadUserId } : { status: 'none' },
    grants,
  };
}

export type VerifyBindingResult =
  | { ok: true; dialpadUserId: string; replayed: boolean }
  | DialpadFailure
  | { ok: false; code: 'identity_mismatch'; message: string; reason: string };

export interface VerifyBindingDeps {
  env: DialpadDirectoryEnv;
  fetchImpl?: DialpadDirectoryFetch;
}

/**
 * The browser's user_authentication id is only a claim. It becomes a verified
 * binding only when Dialpad's own directory says that user exists, is active,
 * belongs to the org's Dialpad company and lists the authenticated Sandra
 * user's confirmed email. The directory check runs before any row is written.
 */
export async function verifyDialpadBinding(
  db: DialpadDispatchDb,
  actor: DialpadActor,
  identity: { email: string | null; emailConfirmed: boolean },
  claimedUserId: unknown,
  deps: VerifyBindingDeps,
): Promise<VerifyBindingResult> {
  const claimed = parseClaimedDialpadUserId(claimedUserId);
  if (!claimed) return fail('invalid_input', 'Dialpad did not report a valid user.');
  try {
    const connection = await db.loadConnection(actor.orgId);
    if (!connection || connection.status !== 'active' || !isDialpadTargetOriginConfigured(connection.allowedOrigins)) {
      return fail('not_configured', dialpadDenialMessage('connection_inactive'));
    }
    const existing = await db.loadLiveBinding(actor.orgId, actor.userId);
    if (existing?.status === 'verified') {
      return existing.dialpadUserId === claimed
        ? { ok: true, dialpadUserId: claimed, replayed: true }
        : fail('denied', dialpadDenialMessage('binding_exists'), 'binding_exists');
    }
    const apiKey = resolveDialpadDirectoryKey(connection.directoryKeyRef, deps.env);
    if (!apiKey || !connection.companyId) {
      return fail('not_configured', 'Dialpad account verification is not configured for this organization. Ask an owner to finish setup.');
    }
    const directory = await fetchDialpadDirectoryUser({ dialpadUserId: claimed, apiKey, fetchImpl: deps.fetchImpl });
    if (!directory.ok) {
      if (directory.reason === 'not_found') {
        return { ok: false, code: 'identity_mismatch', reason: 'user_not_found', message: 'Dialpad does not recognize that account for this organization.' };
      }
      return fail('unavailable', 'Sandra could not verify your Dialpad account right now. Try again shortly.');
    }
    const assessment = assessDialpadDirectoryIdentity({
      claimedDialpadUserId: claimed,
      expectedCompanyId: connection.companyId,
      sandraEmail: identity.email,
      sandraEmailConfirmed: identity.emailConfirmed,
      user: directory.user,
    });
    if (!assessment.ok) {
      return {
        ok: false,
        code: 'identity_mismatch',
        reason: assessment.reason,
        message: 'That Dialpad account does not match your Sandra sign-in. Sign in to Dialpad with the same work email.',
      };
    }
    const claim = await db.claimBinding(actor.orgId, actor.userId, claimed);
    const bindingId = claim && typeof claim === 'object' && !Array.isArray(claim) ? claim.bindingId : null;
    if (typeof bindingId !== 'string' || !UUID.test(bindingId)) return fail('unavailable', 'Sandra could not record your Dialpad account. Try again.');
    await db.verifyBinding(bindingId, 'provider_directory', dialpadDirectoryVerificationRef(connection.companyId, claimed));
    return { ok: true, dialpadUserId: claimed, replayed: false };
  } catch (error) {
    return failureFromDbError(error);
  }
}

export type EnsureBindingResult =
  | { ok: true; dialpadUserId: string; status: 'verified'; created: boolean }
  | DialpadFailure
  | { ok: false; code: 'identity_mismatch'; message: string; reason: string };

/**
 * Binding without the iframe (2.7): a verified binding is returned as is; otherwise the rep's
 * confirmed Sandra email is looked up in the Dialpad directory and the found id goes through the
 * unchanged `verifyDialpadBinding` (company, active state and listed email are all re-proven).
 * Claiming needs an active connection, so first-time binding happens right after activation.
 */
export async function ensureDialpadBinding(
  db: DialpadDispatchDb,
  actor: DialpadActor,
  identity: { email: string | null; emailConfirmed: boolean },
  deps: VerifyBindingDeps,
): Promise<EnsureBindingResult> {
  try {
    const connection = await db.loadConnection(actor.orgId);
    if (!connection || connection.status !== 'active' || !isDialpadTargetOriginConfigured(connection.allowedOrigins)) {
      return fail('not_configured', dialpadDenialMessage('connection_inactive'));
    }
    const existing = await db.loadLiveBinding(actor.orgId, actor.userId);
    if (existing?.status === 'verified') return { ok: true, dialpadUserId: existing.dialpadUserId, status: 'verified', created: false };
    const email = identity.email?.trim().toLowerCase() ?? '';
    if (!email || !identity.emailConfirmed) {
      return { ok: false, code: 'identity_mismatch', reason: 'email_unverified', message: 'Confirm your Sandra email before connecting Dialpad.' };
    }
    const apiKey = resolveDialpadDirectoryKey(connection.directoryKeyRef, deps.env);
    if (!apiKey || !connection.companyId) {
      return fail('not_configured', 'Dialpad account verification is not configured for this organization. Ask an owner to finish setup.');
    }
    const found = await findDialpadDirectoryUserByEmail({ email, apiKey, fetchImpl: deps.fetchImpl });
    if (!found.ok) {
      if (found.reason === 'not_found') {
        return { ok: false, code: 'identity_mismatch', reason: 'user_not_found', message: 'Dialpad has no user with your Sandra email in this organization.' };
      }
      if (found.reason === 'invalid_response') {
        return { ok: false, code: 'identity_mismatch', reason: 'ambiguous', message: 'Dialpad lists more than one user with your email. Ask an owner to resolve it.' };
      }
      return fail('unavailable', 'Sandra could not reach the Dialpad directory right now. Try again shortly.');
    }
    const verified = await verifyDialpadBinding(db, actor, identity, found.user.id, deps);
    if (!verified.ok) return verified;
    return { ok: true, dialpadUserId: verified.dialpadUserId, status: 'verified', created: !verified.replayed };
  } catch (error) {
    return failureFromDbError(error);
  }
}

export interface DialpadCallTargets {
  contactId: string;
  phones: { slot: 1 | 2 | 3; masked: string }[];
  grants: DialpadCallingBootstrap['grants'];
}

export function maskDialpadPhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  return digits.length >= 4 ? `••• ••• ${digits.slice(-4)}` : '••••';
}

export async function listDialpadCallTargets(
  db: DialpadDispatchDb,
  actor: DialpadActor,
  input: { propertyId: unknown; contactId: unknown },
): Promise<({ ok: true } & DialpadCallTargets) | DialpadFailure> {
  if (typeof input.propertyId !== 'string' || !UUID.test(input.propertyId) || typeof input.contactId !== 'string' || !UUID.test(input.contactId)) {
    return fail('invalid_input', 'Choose a lead with a contact first.');
  }
  try {
    const [phones, grants] = await Promise.all([
      db.loadTargetPhones(actor.orgId, actor.userId, input.propertyId, input.contactId),
      db.loadActiveGrants(actor.orgId, actor.userId),
    ]);
    if (!phones) return fail('denied', 'This lead is not available for calling by you.', 'not_assigned_rep');
    return { ok: true, contactId: phones.contactId, phones: phones.slots.map((entry) => ({ slot: entry.slot, masked: maskDialpadPhone(entry.raw) })), grants };
  } catch (error) {
    return failureFromDbError(error);
  }
}

export interface DialpadStartCallInput {
  propertyId: unknown;
  contactId: unknown;
  phoneSlot: unknown;
  grantId: unknown;
  idempotencyKey: unknown;
}

export type DialpadStartCallResult =
  | {
      ok: true;
      /** true only on the single authorization that may dial; a retry of the same key returns false. */
      dispatched: true;
      intentId: string;
      expiresAt: string;
      dial: {
        dialpadUserId: string;
        phoneNumber: string;
        customData: string;
        identityType: DialpadIdentityType | null;
        /** JS number for the browser protocol; null when the identity id is kept as text (`identityIdText`). */
        identityId: number | null;
        /** The exact int64 text, for the server-side dialer. */
        identityIdText: string | null;
        outboundCallerId: string | null;
      };
    }
  | { ok: true; dispatched: false; intentId: string }
  | DialpadFailure;

export interface DialpadStartCallOptions {
  /** The server-side dialer renders ids as exact JSON integer text, so ids beyond 2^53 are fine there. */
  allowLargeIdentityIds?: boolean;
}

/**
 * Prepare (idempotent on the client key) then authorize in one server-side
 * step. Only the authorize call that first stamps the intent releases the dial
 * payload; every retry of the same key returns dispatched:false, so a retry can
 * never dial twice. The caller identity is never taken from client input.
 */
export async function startDialpadCall(db: DialpadDispatchDb, actor: DialpadActor, input: DialpadStartCallInput, options: DialpadStartCallOptions = {}): Promise<DialpadStartCallResult> {
  const { propertyId, contactId, phoneSlot, grantId, idempotencyKey } = input;
  if (typeof propertyId !== 'string' || !UUID.test(propertyId) || typeof contactId !== 'string' || !UUID.test(contactId)
      || typeof idempotencyKey !== 'string' || !UUID.test(idempotencyKey)
      || (phoneSlot !== 1 && phoneSlot !== 2 && phoneSlot !== 3)
      || (grantId !== null && grantId !== undefined && (typeof grantId !== 'string' || !UUID.test(grantId)))) {
    return fail('invalid_input', 'Choose a lead, contact and phone number first.');
  }
  try {
    const connection = await db.loadConnection(actor.orgId);
    if (!connection || connection.status !== 'active') return fail('not_configured', dialpadDenialMessage('connection_inactive'));
    if (!isDialpadTargetOriginConfigured(connection.allowedOrigins)) return fail('origin_not_allowed', 'Dialpad is not allowed for this organization.');
    const binding = await db.loadLiveBinding(actor.orgId, actor.userId);
    if (!binding || binding.status !== 'verified') return fail('not_bound', dialpadDenialMessage('binding_not_verified'), 'binding_not_verified');

    const prepared = parsePreparedDialpadCallIntent(await db.prepareIntent({
      orgId: actor.orgId,
      userId: actor.userId,
      propertyId,
      contactId,
      phoneSlot,
      idempotencyKey,
      grantId: typeof grantId === 'string' ? grantId : null,
    }));
    if (!options.allowLargeIdentityIds && prepared.callerIdentityId !== null && !Number.isSafeInteger(Number(prepared.callerIdentityId))) {
      // The browser protocol carries identity_id as a JSON number; an id beyond 2^53 cannot be sent exactly.
      await db.cancelIntent(actor.orgId, actor.userId, prepared.intentId);
      return fail('unsupported_caller_identity', 'That caller ID cannot be used from the browser dialer.');
    }

    const authorization = parseDialpadDispatchAuthorization(await db.authorizeDispatch(actor.orgId, actor.userId, prepared.intentId));
    switch (authorization.status) {
      case 'authorized':
        return {
          ok: true,
          dispatched: true,
          intentId: authorization.intentId,
          expiresAt: authorization.expiresAt,
          dial: {
            dialpadUserId: authorization.dial.dialpadUserId,
            phoneNumber: authorization.dial.phoneNumber,
            customData: authorization.dial.customData,
            identityType: authorization.dial.identityType,
            identityId: authorization.dial.identityId === null || !Number.isSafeInteger(Number(authorization.dial.identityId)) ? null : Number(authorization.dial.identityId),
            identityIdText: authorization.dial.identityId,
            outboundCallerId: authorization.dial.outboundCallerId,
          },
        };
      case 'already_dispatched':
        return { ok: true, dispatched: false, intentId: authorization.intentId };
      case 'denied':
        return fail('denied', dialpadDenialMessage(authorization.denial), authorization.denial);
      case 'cancelled':
        return fail('cancelled', 'This call was cancelled. Start it again.');
      case 'matched':
        return fail('matched', dialpadDenialMessage('intent_already_matched'), 'intent_already_matched');
      case 'expired':
        return fail('expired', 'No confirmation from Dialpad. Check the dialer before calling again.');
    }
  } catch (error) {
    return failureFromDbError(error);
  }
}

export async function getDialpadCallStatus(
  db: DialpadDispatchDb,
  actor: DialpadActor,
  intentId: unknown,
): Promise<{ ok: true; status: DialpadCallStatus } | DialpadFailure> {
  if (typeof intentId !== 'string' || !UUID.test(intentId)) return fail('invalid_input', 'Unknown call.');
  try {
    return { ok: true, status: parseDialpadCallStatus(await db.getCallStatus(actor.orgId, actor.userId, intentId)) };
  } catch (error) {
    return failureFromDbError(error);
  }
}

export async function cancelDialpadCall(
  db: DialpadDispatchDb,
  actor: DialpadActor,
  intentId: unknown,
): Promise<{ ok: true } | DialpadFailure> {
  if (typeof intentId !== 'string' || !UUID.test(intentId)) return fail('invalid_input', 'Unknown call.');
  try {
    await db.cancelIntent(actor.orgId, actor.userId, intentId);
    return { ok: true };
  } catch (error) {
    return failureFromDbError(error);
  }
}
