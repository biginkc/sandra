# Controlled Inbox workspace presentation

This component is a presentation foundation, not an activated route. It fills its containing browser viewport (`100dvh`), with a compact scope bar, virtual conversation list, independent detail scrolling and click/drop action rail. The supplied Claude Design workspace is the visual baseline; the original PRD's selection rules take precedence over handoff differences. No outcome taxonomy, AI recommendations, sequence operations, provider calls or fabricated network success is built in.

## Adapter contract

Mount `InboxWorkspace` from a **client adapter**. The locally bundled Next client/server guidance was read before implementation; these callback props cannot be passed as ordinary serialized Server Component props. The adapter owns authorization, Electric/TanStack DB collections, working-set pagination, search/filter controls, loaded detail identity, approved action availability, preparation/review and truthful pending/error/results. Action callbacks request the same review/preparation flow for clicks and drops; they must never bypass review or authorize a send.

Use `workspaceId(target)` for stable identity. It includes tenant, target kind and the persisted conversation/group ID. An unknown group's raw address is not its target ID. Remount the adapter/workspace on requester or tenant session changes, clear inaccessible cached content and revalidate every server action. Never derive permissions from selected highlights.

Props are controlled: `selectedIds`, `openId`, `onSelectionChange`, `onOpen`, action callbacks and status are supplied by the adapter. Detail content must include `targetId` matching `openId`; a mismatched response displays a loading state instead of the wrong conversation. Opening does not mark anything read; the later adapter must coordinate authorized post-render acknowledgment. `invalidatedIds` means authoritative deletion/access removal, not absent rows. These IDs are hidden and stripped from selection, action and Escape callbacks. Whole-workspace `permission_lost` removes protected content and abandons gestures without restoring their baseline.

The component explicitly opts out of React Compiler memoization with the bundled Next-documented `use no memo` directive because TanStack Virtual exposes mutable instance methods. The instance stays local; a narrow lint annotation records that intentional boundary.

Rows are a maximum **500 resident records**, not all database matches. TanStack React Virtual 3.14.12 renders a viewport plus five-row overscan with tenant/kind/ID keys and fixed 72px rows. Its initial 900×600 measurement is a first-render fallback; actual viewport observation replaces it. The subsequent data adapter must not download the full dataset. Selection outside the resident slice is described neutrally as **not loaded here**, because it may still match the current filter. An authoritative filtered-out count is not inferred.

## Interaction behavior

- Plain row click/release selects only that row. Shift-click toggles that individual row, never a contiguous range.
- Shift-drag crosses a four-pixel movement threshold, then adds encountered viewport-intersecting rows. There is no hold timer. Resident order and eligible identities freeze until the gesture ends; newly arriving records cannot join it. Updated facts for the same identity still render, and authoritative invalidations remove access immediately.
- Edge auto-scroll reveals additional rows from that bounded frozen working set. Rectangle geometry is rechecked as virtualization mounts rows, including at the scroll limit and on release. It never selects unseen database results.
- Dragging an already selected row preserves the group, including resident-external selected IDs. Dropping a group and clicking an action call the same callback. Shift-drag never executes an action. The rail reserves drag-status height so targets do not move after a drag begins.
- Escape, pointer cancellation, unexpected capture loss and window blur cancel the gesture. Escape restores the prior selection after authoritative invalidations are removed. A trailing click after cancellation is suppressed.
- Visible checkboxes support keyboard/touch scattered selection and removal. Enter on a focused row opens inspection; the separate Open button leaves selection alone. Opening focuses detail Close; closing returns focus to the row's Open button or list fallback if unmounted.
- Buttons, links, inputs, selects, textareas and editable controls are excluded from gesture initiation. Detail content is outside the selection surface. Touch scrolling uses normal browser behavior; touch selection/actions use controls.

At narrower widths, secondary row metadata collapses, detail becomes an overlay with Close, and the action rail becomes a horizontally scrollable bottom shelf. Independent scrolling and controls remain available without dragging. Browser/zoom assessment belongs to the real preview harness; RTL geometry substitutes are not visual evidence.

## Validation and limits

Focused unit tests cover identity isolation, movement thresholds, click/toggle semantics, group preservation, rectangle additions and new-arrival exclusion. Real-component RTL tests use the actual virtualizer (not a mocked implementation); only DOM geometry/PointerEvent gaps are supplied for jsdom. They cover selection/Open independence, checkbox removal, Enter/focus restoration, rectangle/Escape, click/drop parity, access invalidation, resident snapshot freezing and interactive-control exclusion.

Run:

```sh
npm test -- src/components/inbox-workspace/selection.test.ts
npm run test:rtl -- src/components/inbox-workspace/inbox-workspace.test.tsx
npm run typecheck
```

No route, database, provider, package manifest or preview harness is owned by this folder. The separate root-owned preview exercises real browser geometry. Passing these tests does not establish production first-open latency, real sync/reconnect behavior, durable selection/reply receipts, final accessibility certification or backend eligibility. Review-selection, filters, saved actions, detail tools and operation results remain adapter-supplied content/callbacks rather than fake enabled workflows.
