"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { InboxQueryIdentity } from "@/lib/inbox/workspace-query";
import type { AcceptedInboxAction, AcceptInboxActionRequest, InboxActionRecovery } from "@/lib/inbox/action-api-contract";
import { forgetRecoveryEntry, readRecoveryEntries, recoveryStorageKey, rememberRecoveryEntry } from "./recovery-registry";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const storageKey = (identity: InboxQueryIdentity) => recoveryStorageKey("inbox-action-recovery", identity);
type State = { kind: "checking" | "pending" | "accepting"; pair?: AcceptInboxActionRequest; error?: string } | { kind: "idle" } | { kind: "suspended" };
interface Options { identity: InboxQueryIdentity; enabled: boolean; onRecovered: (operation: AcceptedInboxAction) => void; onAccessLost: () => void; onExpired: () => void }
/** Deliberate narrow sessionStorage exception: only opaque preparation/key,
 * scoped to the authenticated identity. No selection, messages or labels. */
export function useInboxActionRecovery(options: Options) {
  const key = storageKey(options.identity);
  const [state, setState] = useState<State>({ kind: options.enabled ? "checking" : "idle" });
  const [notice, setNotice] = useState<string>();
  const current = useRef<AbortController | null>(null);
  useEffect(() => () => { current.current?.abort(); }, [key, options.enabled]);
  const lastPair = useRef<AcceptInboxActionRequest | null>(null);
  const latest = useRef(options);
  useEffect(() => { latest.current = options; }, [options]);
  const remove = useCallback((pair?: AcceptInboxActionRequest) => {
    try { if (pair) forgetRecoveryEntry(key, pair); else sessionStorage.removeItem(key); }
    catch { /* Storage is optional; in-memory idempotency remains intact. */ }
  }, [key]);
  // Access loss clears visible private state but preserves the opaque identity-scoped
  // pair. The same session must recover it; a different identity never reads it.
  const clear = useCallback(() => { current.current?.abort(); lastPair.current = null; setState({ kind: "suspended" }); setNotice(undefined); }, []);
  function remember(pair: AcceptInboxActionRequest) {
    lastPair.current = pair;
    try { rememberRecoveryEntry(key, pair); return true; }
    catch { setNotice("Keep this tab open until the action is confirmed; reload recovery is unavailable in this browser."); return false; }
  }
  function accepted(operation: AcceptedInboxAction) { current.current?.abort(); setState({ kind: "idle" }); latest.current.onRecovered(operation); }
  async function resolve(pair: AcceptInboxActionRequest, retryAccept = false) {
    current.current?.abort(); const controller = new AbortController(); current.current = controller;
    setState({ kind: retryAccept ? "accepting" : "checking", pair });
    try {
      const url = retryAccept ? "/api/inbox/actions/accept" : `/api/inbox/operations/recover?${new URLSearchParams(pair as unknown as Record<string, string>)}`;
      const response = await fetch(url, { method: retryAccept ? "POST" : "GET", ...(retryAccept ? { headers: { "content-type": "application/json" }, body: JSON.stringify(pair) } : {}), credentials: "same-origin", cache: "no-store", redirect: "error", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) });
      if (controller.signal.aborted) return;
      if (response.status === 401 || response.status === 403) { latest.current.onAccessLost(); return; }
      if (!response.ok) throw Error("The earlier action could not be checked. Its original identifiers are retained.");
      const value = await response.json(); if (controller.signal.aborted) return;
      const result: InboxActionRecovery = retryAccept ? { state: "accepted", operation: value } : value;
      if (result.state === "accepted" && result.operation && uuid.test(result.operation.operationId) && Number.isFinite(Date.parse(result.operation.acceptedAt))) {
        accepted(result.operation); return;
      }
      if (!retryAccept && result.state === "expired_not_accepted" && result.operation === null) {
        remove(pair); lastPair.current = null; setState({ kind: "idle" }); setNotice("The earlier review expired without starting an action. You can prepare it again."); latest.current.onExpired(); return;
      }
      if (!retryAccept && result.state === "pending" && result.operation === null) { setState({ kind: "pending", pair }); return; }
      throw Error("The earlier action response could not be verified.");
    } catch (error) { if (!controller.signal.aborted) setState({ kind: "pending", pair, error: error instanceof Error ? error.message : "Recovery unavailable." }); }
  }
  useEffect(() => {
    if (!options.enabled) return;
    try {
      const raw = sessionStorage.getItem(key);
      // Hydrate the external sessionStorage record after mount; SSR cannot read it.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (!raw) { setState({ kind: "idle" }); return; }
      if (raw.length > 16_384) throw Error("Invalid recovery record");
      const entry = readRecoveryEntries(key).find(value => uuid.test(value.preparationId) && uuid.test(value.idempotencyKey));
      if (!entry) throw Error("Invalid recovery record");
      const pair = { preparationId: entry.preparationId, idempotencyKey: entry.idempotencyKey };
      lastPair.current = pair; void resolve(pair);
    } catch { remove(); setState({ kind: "idle" }); }
    return () => { current.current?.abort(); };
    // Storage belongs to this exact authenticated identity; callbacks use the current committed options.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, options.enabled]);
  const completed = useCallback(() => { remove(lastPair.current ?? undefined); lastPair.current = null; }, [remove]);
  const panel = !options.enabled || state.kind === "suspended" ? undefined : state.kind !== "idle" ? <section aria-label="Recover earlier bulk action"><p role="status">{state.kind === "checking" ? "Checking an earlier action…" : state.kind === "accepting" ? "Retrying the same earlier action…" : "The earlier action has not been confirmed yet. Starting another bulk action is paused."}</p>{state.error && <p role="alert">{state.error}</p>}{state.kind === "pending" && state.pair && <><button type="button" onClick={() => void resolve(state.pair!)}>Check earlier action</button><button type="button" onClick={() => void resolve(state.pair!, true)}>Retry earlier action safely</button></>}<a href="/inbox/receipts">Open standalone recovery</a></section> : notice ? <p role="status">{notice}</p> : undefined;
  return { blocked: options.enabled && state.kind !== "idle", panel, remember, clear, accepted, check: (pair: AcceptInboxActionRequest) => { lastPair.current = pair; void resolve(pair); }, completed };
}
