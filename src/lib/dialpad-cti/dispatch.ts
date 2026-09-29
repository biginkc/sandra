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
  parseClaimedDialpadUserId,
  resolveDialpadDirectoryKey,
  type DialpadDirectoryEnv,
  type DialpadDirectoryFetch,
} from './directory';
import { DialpadDbError } from './event-processing';
import { isDialpadTargetOriginConfigured } from './protocol';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RECENT_WINDOW_MS = 60 * 60 * 1000;

export interface DialpadConnectionView {
  id: string;
  status: string;
  allowedOrigins: string[];
  companyId: string | null;
  directoryKeyRef: string | null;
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
  listRecentIntentIds(orgId: string, userId: string, sinceIso: string, limit: number): Promise<string[]>;
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
      const { data, error } = await client
        .from('dialpad_org_connections')
        .select('id, status, allowed_origins, dialpad_company_id, directory_api_key_ref')
        .eq('org_id', orgId)
        .maybeSingle();
      if (error) throw new DialpadDbError(classifyDialpadRpcError(error), error.code ?? null);
      if (!data) return null;
      return {
        id: data.id,
        status: data.status,
        allowedOrigins: data.allowed_origins,
        companyId: data.dialpad_company_id,
        directoryKeyRef: data.directory_api_key_ref,
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
    async listRecentIntentIds(orgId, userId, sinceIso, limit) {
      const { data, error } = await client
        .from('dialpad_call_intents')
        .select('id')
        .eq('org_id', orgId)
        .eq('rep_user_id', userId)
        .not('dispatch_authorized_at', 'is', null)
        .gte('dispatch_authorized_at', sinceIso)
        .order('dispatch_authorized_at', { ascending: false })
        .limit(limit);
      if (error) throw new DialpadDbError(classifyDialpadRpcError(error), error.code ?? null);
      return (data ?? []).map((row) => row.id);
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

export interface DialpadPanelBootstrap {
  connectionId: string;
  allowedOrigins: string[];
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

/** Everything the panel needs to render, or null when this org/rep has no usable Dialpad connection. */
export async function loadDialpadPanelBootstrap(db: DialpadDispatchDb, actor: DialpadActor): Promise<DialpadPanelBootstrap | null> {
  const connection = await db.loadConnection(actor.orgId);
  if (!connection || connection.status !== 'active' || !isDialpadTargetOriginConfigured(connection.allowedOrigins)) return null;
  const [binding, grants] = await Promise.all([db.loadLiveBinding(actor.orgId, actor.userId), db.loadActiveGrants(actor.orgId, actor.userId)]);
  return {
    connectionId: connection.id,
    allowedOrigins: connection.allowedOrigins,
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

export interface DialpadCallTargets {
  contactId: string;
  phones: { slot: 1 | 2 | 3; masked: string }[];
  grants: DialpadPanelBootstrap['grants'];
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
        phoneNumber: string;
        customData: string;
        identityType: DialpadIdentityType | null;
        identityId: number | null;
        outboundCallerId: string | null;
      };
    }
  | { ok: true; dispatched: false; intentId: string }
  | DialpadFailure;

/**
 * Prepare (idempotent on the client key) then authorize in one server-side
 * step. Only the authorize call that first stamps the intent releases the dial
 * payload; every retry of the same key returns dispatched:false, so a retry can
 * never dial twice. The caller identity is never taken from client input.
 */
export async function startDialpadCall(db: DialpadDispatchDb, actor: DialpadActor, input: DialpadStartCallInput): Promise<DialpadStartCallResult> {
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
    if (prepared.callerIdentityId !== null && !Number.isSafeInteger(Number(prepared.callerIdentityId))) {
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
            phoneNumber: authorization.dial.phoneNumber,
            customData: authorization.dial.customData,
            identityType: authorization.dial.identityType,
            identityId: authorization.dial.identityId === null ? null : Number(authorization.dial.identityId),
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
        return fail('expired', 'This call request expired before it was sent. Start it again.');
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

/** Calls this rep dialed within the last hour, so a reloaded page resumes showing webhook-derived state. */
export async function listRecentDialpadCalls(
  db: DialpadDispatchDb,
  actor: DialpadActor,
  now: Date = new Date(),
): Promise<{ ok: true; calls: DialpadCallStatus[] } | DialpadFailure> {
  try {
    const ids = await db.listRecentIntentIds(actor.orgId, actor.userId, new Date(now.getTime() - RECENT_WINDOW_MS).toISOString(), 5);
    const calls = await Promise.all(ids.map(async (id) => parseDialpadCallStatus(await db.getCallStatus(actor.orgId, actor.userId, id))));
    return { ok: true, calls };
  } catch (error) {
    return failureFromDbError(error);
  }
}
