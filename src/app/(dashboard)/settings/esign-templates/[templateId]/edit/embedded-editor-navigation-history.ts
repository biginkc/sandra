const TEMPLATE_LIBRARY_PATH = "/settings/esign-templates";
const RETURN_ENTRY_STATE_KEY = "__sandraEsignEditorReturnEntry";
const GUARD_SEQUENCE_STATE_KEY = "__sandraEsignEditorGuardSequence";

type NavigationEntry = Readonly<{
  index: number;
  key: string;
  url: string | null;
}>;

type AppNavigation = Readonly<{
  currentEntry: NavigationEntry | null;
  entries(): readonly NavigationEntry[];
  traverseTo(key: string): Readonly<{ finished: Promise<unknown> }>;
}>;

type NavigationWindow = Window &
  typeof globalThis &
  Readonly<{ navigation?: AppNavigation }>;

type HistorySnapshot = Readonly<{
  currentEntryIndex: number | null;
  currentEntryKey: string | null;
  entryCount: number;
  firstEntryKey: string | null;
  historyLength: number;
  lastEntryKey: string | null;
}>;

/**
 * Keep cross-origin editor navigations from consuming Sandra's browser Back.
 *
 * Child-frame navigations are flattened into the tab's joint session history.
 * The Navigation API deliberately exposes only this top-level browsing
 * context, so a guard entry can detect Back and traverse directly to the
 * Sandra entry that opened the editor while retaining Forward to the editor.
 */
export function installEmbeddedEditorNavigationBoundary(
  iframe: HTMLIFrameElement,
  onBeforeReturnToLibrary?: () => void,
  targetWindow: NavigationWindow = window as NavigationWindow,
): () => void {
  const navigation = targetWindow.navigation;
  const currentEntry = navigation?.currentEntry;
  if (
    !navigation ||
    !currentEntry ||
    typeof navigation.entries !== "function" ||
    typeof navigation.traverseTo !== "function"
  ) {
    // Safe no-op outside Chromium's current Navigation API coverage. Firefox
    // before 147 and Safari before 26.2 do not expose the API this boundary
    // needs; their ordinary browser history behavior remains unchanged.
    return () => undefined;
  }

  const entries = navigation.entries();
  const storedReturnEntryKey = readStoredReturnEntryKey(
    targetWindow.history.state,
  );
  const returnEntry = storedReturnEntryKey
    ? entries.find((entry) => entry.key === storedReturnEntryKey)
    : findPrecedingTemplateLibraryEntry(entries, currentEntry);
  if (!returnEntry?.url) return () => undefined;

  const editorUrl = new URL(targetWindow.location.href);
  const returnUrl = new URL(returnEntry.url);
  if (
    returnUrl.origin !== editorUrl.origin ||
    returnUrl.pathname !== TEMPLATE_LIBRARY_PATH
  ) {
    return () => undefined;
  }

  let disposed = false;
  let traversing = false;
  let observedHistorySnapshot = getHistorySnapshot(targetWindow, navigation);
  let animationFrame = 0;
  let traversalTimer = 0;
  const arm = () => {
    if (
      disposed ||
      traversing ||
      targetWindow.location.href !== editorUrl.href
    ) {
      return;
    }
    // Back/Forward restoration can leave a real top-level destination ahead
    // of the editor. Pushing guards here would truncate that Forward history.
    if (hasLegitimateForwardEntry(navigation, editorUrl)) return;
    // Two adjacent top-level entries guarantee the first Back dispatches a
    // top-level popstate. A single entry can land directly on a child-frame
    // entry, where Chrome dispatches popstate only inside the provider frame.
    for (let guard = 0; guard < 2; guard += 1) {
      targetWindow.history.pushState(
        withBoundaryState(targetWindow.history.state, returnEntry.key),
        "",
        editorUrl.href,
      );
    }
    observedHistorySnapshot = getHistorySnapshot(targetWindow, navigation);
  };
  const watchHistory = () => {
    if (disposed) return;
    const nextSnapshot = getHistorySnapshot(targetWindow, navigation);
    if (
      nextSnapshot.currentEntryKey ===
        observedHistorySnapshot.currentEntryKey &&
      !historySnapshotsEqual(nextSnapshot, observedHistorySnapshot)
    ) {
      arm();
    } else {
      // A changed top-level key is Back/Forward itself, not a child-frame
      // navigation. Re-arming here would cancel the user's traversal.
      observedHistorySnapshot = nextSnapshot;
    }
    animationFrame = targetWindow.requestAnimationFrame(watchHistory);
  };
  const handlePopState = () => {
    if (
      disposed ||
      traversing ||
      targetWindow.location.href !== editorUrl.href
    ) {
      return;
    }
    traversing = true;
    // Let Chrome commit the one-step Back before starting the exact-entry
    // traversal. Starting both traversals in the same popstate task can abort
    // traverseTo nondeterministically.
    traversalTimer = targetWindow.setTimeout(() => {
      try {
        onBeforeReturnToLibrary?.();
        void navigation.traverseTo(returnEntry.key).finished.catch(() => {
          traversing = false;
        });
      } catch {
        traversing = false;
      }
    }, 0);
  };

  targetWindow.addEventListener("popstate", handlePopState);
  iframe.addEventListener("load", arm);
  animationFrame = targetWindow.requestAnimationFrame(watchHistory);

  return () => {
    disposed = true;
    targetWindow.cancelAnimationFrame(animationFrame);
    targetWindow.clearTimeout(traversalTimer);
    targetWindow.removeEventListener("popstate", handlePopState);
    iframe.removeEventListener("load", arm);
  };
}

function findPrecedingTemplateLibraryEntry(
  entries: readonly NavigationEntry[],
  currentEntry: NavigationEntry,
): NavigationEntry | undefined {
  return entries.findLast((entry) => {
    if (entry.index >= currentEntry.index || !entry.url) return false;
    try {
      return new URL(entry.url).pathname === TEMPLATE_LIBRARY_PATH;
    } catch {
      return false;
    }
  });
}

function hasLegitimateForwardEntry(
  navigation: AppNavigation,
  editorUrl: URL,
): boolean {
  const currentIndex = navigation.currentEntry?.index;
  if (currentIndex === undefined) return false;
  return navigation.entries().some((entry) => {
    if (entry.index <= currentIndex || !entry.url) return false;
    try {
      return new URL(entry.url).href !== editorUrl.href;
    } catch {
      return false;
    }
  });
}

function readStoredReturnEntryKey(state: unknown): string | null {
  if (!state || typeof state !== "object") return null;
  const value = (state as Record<string, unknown>)[RETURN_ENTRY_STATE_KEY];
  return typeof value === "string" ? value : null;
}

function withBoundaryState(
  state: unknown,
  returnEntryKey: string,
): Record<string, unknown> {
  const stateRecord =
    state && typeof state === "object"
      ? (state as Record<string, unknown>)
      : {};
  const priorSequence = stateRecord[GUARD_SEQUENCE_STATE_KEY];
  return {
    ...stateRecord,
    [RETURN_ENTRY_STATE_KEY]: returnEntryKey,
    [GUARD_SEQUENCE_STATE_KEY]:
      (typeof priorSequence === "number" ? priorSequence : 0) + 1,
  };
}

function getHistorySnapshot(
  targetWindow: NavigationWindow,
  navigation: AppNavigation,
): HistorySnapshot {
  const entries = navigation.entries();
  const currentEntry = navigation.currentEntry;
  return {
    currentEntryIndex: currentEntry?.index ?? null,
    currentEntryKey: currentEntry?.key ?? null,
    entryCount: entries.length,
    firstEntryKey: entries[0]?.key ?? null,
    historyLength: targetWindow.history.length,
    lastEntryKey: entries.at(-1)?.key ?? null,
  };
}

function historySnapshotsEqual(
  left: HistorySnapshot,
  right: HistorySnapshot,
): boolean {
  return (
    left.currentEntryIndex === right.currentEntryIndex &&
    left.currentEntryKey === right.currentEntryKey &&
    left.entryCount === right.entryCount &&
    left.firstEntryKey === right.firstEntryKey &&
    left.historyLength === right.historyLength &&
    left.lastEntryKey === right.lastEntryKey
  );
}
