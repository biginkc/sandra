import { describe, expect, it, vi } from 'vitest';

import {
  buildEnableCurrentTabMessage,
  buildInitiateCallMessage,
  DIALPAD_CTI_TARGET_ORIGIN,
  isDialpadTargetOriginConfigured,
  parseDialpadIncomingMessage,
  postToDialpad,
  type DialpadDialPayload,
} from './protocol';

const iframeWindow = { id: 'iframe' };
const allowed = ['https://dialpad.com'];
const envelope = (method: string, payload?: unknown) => ({ api: 'opencti_dialpad', version: '1.0', method, ...(payload === undefined ? {} : { payload }) });
const ctx = { iframeWindow, allowedOrigins: allowed };
const token = `sandra.dialpad.v1.${'a'.repeat(48)}`;
const dial: DialpadDialPayload = { phoneNumber: '+18165440196', customData: token, identityType: null, identityId: null, outboundCallerId: null };

describe('parseDialpadIncomingMessage', () => {
  it('accepts user_authentication only from the iframe window on an allowed origin', () => {
    const message = envelope('user_authentication', { user_authenticated: true, user_id: 5551234 });
    expect(parseDialpadIncomingMessage({ origin: 'https://dialpad.com', source: iframeWindow, data: message }, ctx))
      .toEqual({ kind: 'user_authentication', authenticated: true, userId: '5551234' });
    expect(parseDialpadIncomingMessage({ origin: 'https://dialpad.com', source: {}, data: message }, ctx)).toEqual({ kind: 'ignored', reason: 'source' });
    expect(parseDialpadIncomingMessage({ origin: 'https://dialpad.com', source: null, data: message }, ctx)).toEqual({ kind: 'ignored', reason: 'source' });
    expect(parseDialpadIncomingMessage({ origin: 'https://dialpad.com', source: iframeWindow, data: message }, { iframeWindow: null, allowedOrigins: allowed }))
      .toEqual({ kind: 'ignored', reason: 'source' });
  });
  it('rejects look-alike, sub-domain, http and null origins', () => {
    const message = envelope('user_authentication', { user_authenticated: true, user_id: 1 });
    for (const origin of ['https://dialpad.com.evil.test', 'https://evil.dialpad.com', 'http://dialpad.com', 'null', '', 'https://dialpad.com:444']) {
      expect(parseDialpadIncomingMessage({ origin, source: iframeWindow, data: message }, ctx)).toEqual({ kind: 'ignored', reason: 'origin' });
    }
  });
  it('requires the documented envelope and an allowlisted method', () => {
    const at = (data: unknown) => parseDialpadIncomingMessage({ origin: 'https://dialpad.com', source: iframeWindow, data }, ctx);
    expect(at('string')).toEqual({ kind: 'ignored', reason: 'shape' });
    expect(at(null)).toEqual({ kind: 'ignored', reason: 'shape' });
    expect(at([])).toEqual({ kind: 'ignored', reason: 'shape' });
    expect(at({ ...envelope('call_ringing'), api: 'other' })).toEqual({ kind: 'ignored', reason: 'shape' });
    expect(at({ ...envelope('call_ringing'), version: '2.0' })).toEqual({ kind: 'ignored', reason: 'shape' });
    expect(at(envelope('initiate_call', { phone_number: '+1' }))).toEqual({ kind: 'ignored', reason: 'method' });
    expect(at(envelope('hang_up_all_calls'))).toEqual({ kind: 'ignored', reason: 'method' });
    expect(at(envelope('call_ringing', { state: 'on' }))).toEqual({ kind: 'call_ringing', state: 'on' });
  });
  it('never trusts an unsafe or non-numeric user_id or a false authentication flag', () => {
    const at = (payload: unknown) => parseDialpadIncomingMessage({ origin: 'https://dialpad.com', source: iframeWindow, data: envelope('user_authentication', payload) }, ctx);
    expect(at({ user_authenticated: true, user_id: 9007199254740993 })).toEqual({ kind: 'user_authentication', authenticated: false, userId: null });
    expect(at({ user_authenticated: true, user_id: '5' })).toEqual({ kind: 'user_authentication', authenticated: false, userId: null });
    expect(at({ user_authenticated: true, user_id: -4 })).toEqual({ kind: 'user_authentication', authenticated: false, userId: null });
    expect(at({ user_authenticated: false, user_id: 5 })).toEqual({ kind: 'user_authentication', authenticated: false, userId: null });
    expect(at({ user_authenticated: 'true', user_id: 5 })).toEqual({ kind: 'user_authentication', authenticated: false, userId: null });
  });
});

describe('outgoing messages', () => {
  it('builds enable_current_tab in the documented envelope', () => {
    expect(buildEnableCurrentTabMessage()).toEqual({ api: 'opencti_dialpad', version: '1.0', method: 'enable_current_tab' });
  });
  it('builds initiate_call with the frozen custom_data and outbound_caller_id when there is no identity', () => {
    expect(buildInitiateCallMessage(dial)).toEqual({
      api: 'opencti_dialpad', version: '1.0', method: 'initiate_call',
      payload: { phone_number: '+18165440196', enable_current_tab: true, custom_data: token },
    });
    expect(buildInitiateCallMessage({ ...dial, outboundCallerId: '+18165550100' }).payload).toMatchObject({ outbound_caller_id: '+18165550100' });
  });
  it('sends identity_type with identity_id and never both an identity and an outbound caller id', () => {
    expect(buildInitiateCallMessage({ ...dial, identityType: 'Office', identityId: 123 }).payload)
      .toMatchObject({ identity_type: 'Office', identity_id: 123 });
    expect(() => buildInitiateCallMessage({ ...dial, identityType: 'Office', identityId: 123, outboundCallerId: '+18165550100' })).toThrow();
    expect(() => buildInitiateCallMessage({ ...dial, identityType: 'Office', identityId: null })).toThrow();
    expect(() => buildInitiateCallMessage({ ...dial, identityType: null, identityId: 5 })).toThrow();
    expect(() => buildInitiateCallMessage({ ...dial, identityType: 'CallCenter', identityId: 9007199254740993 })).toThrow();
  });
  it('rejects malformed numbers and oversized custom_data', () => {
    expect(() => buildInitiateCallMessage({ ...dial, phoneNumber: '8165440196' })).toThrow();
    expect(() => buildInitiateCallMessage({ ...dial, customData: '' })).toThrow();
    expect(() => buildInitiateCallMessage({ ...dial, customData: 'x'.repeat(2001) })).toThrow();
    expect(() => buildInitiateCallMessage({ ...dial, outboundCallerId: 'nope' })).toThrow();
  });
});

describe('postToDialpad', () => {
  it('always uses the fixed Dialpad origin', () => {
    const postMessage = vi.fn();
    expect(postToDialpad({ postMessage }, buildEnableCurrentTabMessage())).toBe(true);
    expect(postMessage).toHaveBeenCalledWith(buildEnableCurrentTabMessage(), DIALPAD_CTI_TARGET_ORIGIN);
    expect(postMessage.mock.calls[0]![1]).toBe('https://dialpad.com');
  });
  it('does nothing without a target window', () => {
    expect(postToDialpad(null, buildEnableCurrentTabMessage())).toBe(false);
  });
  it('requires the fixed target origin to be in the connection allowlist', () => {
    expect(isDialpadTargetOriginConfigured(['https://dialpad.com'])).toBe(true);
    expect(isDialpadTargetOriginConfigured(['https://example.com'])).toBe(false);
    expect(isDialpadTargetOriginConfigured([])).toBe(false);
  });
});
