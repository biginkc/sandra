"use client";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createClient } from "@/lib/supabase/client";
import { loadPrecallContext } from "@/lib/coach/precall-context-actions";
import {
  EMPTY_SETUP,
  clearSetupDrafts,
  parseSetupDraft,
  setupDefaults,
  setupStorageKey,
  type SetupDraft,
  type SetupField,
  type SetupSelector,
  type PreparedCoachSetup,
} from "@/lib/coach/precall-setup";
import type { CoachCallContext } from "@/lib/coach/types";
import type { SoftphoneTarget } from "@/lib/dialer/actions";

type State = {
  collapsed: boolean;
  key: string;
  target: SoftphoneTarget | null;
  context: CoachCallContext | null;
  operatorId: string | null;
  draft: SetupDraft;
  loading: boolean;
  error: string | null;
};
const initial = (): State => ({
  collapsed: false,
  key: "",
  target: null,
  context: null,
  operatorId: null,
  draft: structuredClone(EMPTY_SETUP),
  loading: false,
  error: null,
});
export function usePrecallSetup(enabled: boolean, callerId: string | null) {
  const [state, setState] = useState<State>(initial);
  const current = useRef(state);
  useLayoutEffect(() => {
    current.current = state;
  }, [state]);
  const request = useRef(0);
  const memory = useRef(new Map<string, SetupDraft>());
  const operator = useRef<string | null>(null);
  const persist = useCallback((next: State) => {
    if (!next.operatorId || !next.key) return;
    const key = setupStorageKey(next.operatorId, next.key);
    memory.current.set(key, next.draft);
    try {
      localStorage.setItem(key, JSON.stringify(next.draft));
    } catch {
      /* In-memory draft remains usable. */
    }
  }, []);
  const load = useCallback(
    async (target: SoftphoneTarget | null, keep = false) => {
      const generation = ++request.current;
      const key = target
        ? target.propertyId
          ? `lead:${target.propertyId}`
          : `phone:${target.phoneE164}`
        : "unselected";
      setState((previous) => ({
        ...initial(),
        key,
        target,
        operatorId: operator.current,
        loading: true,
        collapsed: previous.key === key ? previous.collapsed : false,
        ...(keep && previous.key === key
          ? {
              draft: previous.draft,
              context: previous.context,
              operatorId: previous.operatorId,
            }
          : {}),
      }));
      try {
        const result = await loadPrecallContext({
          propertyId: target?.propertyId ?? null,
          sellerPhoneE164: target?.phoneE164 ?? null,
          repPhoneE164: callerId,
        });
        if (generation !== request.current) return;
        operator.current = result.operatorId;
        const storageKey = setupStorageKey(result.operatorId, key);
        let saved = memory.current.get(storageKey);
        if (!saved) {
          try {
            saved = parseSetupDraft(localStorage.getItem(storageKey));
          } catch {
            saved = structuredClone(EMPTY_SETUP);
          }
        }
        setState((previous) => {
          const draft =
            keep && previous.operatorId === result.operatorId
              ? previous.draft
              : saved!;
          const next = {
            collapsed: previous.collapsed,
            key,
            target,
            operatorId: result.operatorId,
            context: result.context,
            loading: false,
            error: result.error,
            draft: {
              ...draft,
              branches: {
                ...draft.branches,
                ...(previous.operatorId === null ||
                previous.operatorId === result.operatorId
                  ? previous.draft.branches
                  : {}),
              },
              edits: {
                ...draft.edits,
                ...(previous.operatorId === null ||
                previous.operatorId === result.operatorId
                  ? previous.draft.edits
                  : {}),
              },
            },
          };
          persist(next);
          return next;
        });
      } catch {
        if (generation === request.current)
          setState((previous) => ({
            ...previous,
            loading: false,
            error: "Could not load call details. You can still call.",
          }));
      }
    },
    [callerId, persist],
  );
  useEffect(() => {
    if (enabled) void load(current.current.target, true);
  }, [enabled, load]);
  useEffect(() => {
    const client = createClient();
    const { data } = client.auth.onAuthStateChange((event, session) => {
      if (
        event === "SIGNED_OUT" ||
        (session?.user.id &&
          session.user.id !== operator.current &&
          (operator.current !== null || event === "SIGNED_IN"))
      ) {
        ++request.current;
        if (event === "SIGNED_OUT" && operator.current) {
          try {
            clearSetupDrafts(operator.current, localStorage);
          } catch {}
        }
        memory.current.clear();
        operator.current = null;
        setState(initial());
      }
      // Remember the local draft owner even when coaching has not loaded yet.
      // Server actions still independently verify this identity before dialing.
      if (session?.user.id) operator.current = session.user.id;
    });
    return () => {
      // Invalidate all pending requests rather than a captured generation.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      ++request.current;
      data.subscription.unsubscribe();
    };
  }, []);
  const update = useCallback(
    (change: (draft: SetupDraft) => SetupDraft) =>
      setState((previous) => {
        const next = { ...previous, draft: change(previous.draft) };
        persist(next);
        return next;
      }),
    [persist],
  );
  const onField = useCallback(
    (key: SetupField, value: string) =>
      update((draft) => ({
        ...draft,
        edits: { ...draft.edits, [key]: value },
      })),
    [update],
  );
  const onBranch = useCallback(
    (key: SetupSelector, value: string) =>
      update((draft) => ({
        ...draft,
        branches: { ...draft.branches, [key]: value },
      })),
    [update],
  );
  const snapshot = useCallback((): PreparedCoachSetup | null => {
    const s = current.current;
    if (!s.target) return null;
    const context: CoachCallContext = s.context ?? {
      sellerName: s.target.name || null,
      propertyAddress: s.target.address || null,
      propertyCounty: null,
      repName: s.target.repName ?? null,
      authenticatedRepName: null,
      repPhoneE164: callerId,
      motivation: null,
      // The selected property identity is already authorized by inspection
      // and is revalidated again at the start boundary. Keep it available so
      // a temporary context-read failure cannot erase the file number.
      leadId: s.target.propertyId,
      sellerPhoneE164: s.target.phoneE164,
      coldCallerName: null,
      yearBuilt: null,
      leadSource: null,
      occupancy: null,
    };
    return structuredClone({
      ...s.draft,
      branches: { ...setupDefaults(context), ...s.draft.branches },
      context,
      operatorId: s.operatorId,
      targetKey: s.key,
      propertyId: s.target.propertyId,
      phoneE164: s.target.phoneE164,
    });
  }, [callerId]);
  const clear = useCallback((snapshot: PreparedCoachSetup | null) => {
    if (!snapshot?.operatorId) return;
    const key = setupStorageKey(snapshot.operatorId, snapshot.targetKey);
    memory.current.delete(key);
    try {
      localStorage.removeItem(key);
    } catch {}
    if (
      current.current.key === snapshot.targetKey &&
      current.current.operatorId === snapshot.operatorId
    ) {
      ++request.current;
      setState(initial());
    }
  }, []);
  return {
    ...state,
    onCollapsed: (collapsed: boolean) =>
      setState((previous) => ({ ...previous, collapsed })),
    draft: {
      ...state.draft,
      branches: {
        ...(state.context ? setupDefaults(state.context) : {}),
        ...state.draft.branches,
      },
    },
    load,
    onField,
    onBranch,
    snapshot,
    clear,
    onRetry: () => void load(current.current.target, true),
  };
}
