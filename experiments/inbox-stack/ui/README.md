# Inbox selection state machine

Pure TypeScript state transitions in `selection.ts`, independent of React, sync, command execution and DOM ownership. Only this experiment's `ui/` directory was changed. No visual interaction has been verified.

## Adapter contract

- Store stable typed targets: organization + conversation ID, or organization + unknown sender-group ID. Do not identify rows by index or DOM position.
- Call `begin` on primary pointerdown, supplying point, optional row target, Shift state, and the current authorized workset's eligible IDs. Supply `fromInputControl: true` for inputs, textareas, selects, contenteditable elements, links and buttons; the adapter identifies those DOM ancestors. Use explicit Open separately.
- Call `move` with pointer coordinates and currently mounted row rectangles in ONE consistent coordinate space. Crossing four pixels engages dragging immediately; there is no hold timer. For scrolling, transform both stored origin and row geometry to a stable content-space coordinate system before calling the engine. Keep pointer capture at a stable parent, not a row that virtualization can unmount.
- Shift-drag adds touched eligible rows to the existing selection. Touched rows remain selected if the rectangle subsequently shrinks. This implements the assigned additive-touched-ID contract. No inferred offscreen geometry is used. Newly mounted rows from the frozen workset may participate; records arriving after pointerdown cannot.
- A normal click replaces selection. Shift-click toggles just its row. A normal drag beginning on a selected row preserves the group; beginning on an unselected row selects only it. Suppress the DOM click that follows pointerup so it does not apply a second transition.
- Call `end` on pointerup; inspect `gesture.mode` and selected targets before ending if the adapter needs to offer a drop. This engine never executes an action or classifies a drop as authorized. Invalid/no-action drops do not invoke a command. Use `cancel` for pointercancel, unexpected lostpointercapture, or an explicit cancellation; it restores pregesture selection. Expected lost capture after `end` is a no-op.
- Map focused-row keyboard Space to `toggle`, except within input controls; keyboard Open calls `open`. Ignore toggles while a pointer gesture is active. Accessibility focus and roving tabindex belong to the adapter.
- Escape priority: modal/dialog/menu consumes first; otherwise cancel an active gesture; otherwise clear selection; otherwise close active inspection. One press performs one level, not all levels.
- Filters, pagination and mounted-row changes perform NO selection pruning. Only an authoritative `remove(target, deleted|inaccessible)` event removes a target. The same event prunes active gesture snapshots so cancellation or pointerup cannot resurrect it. `removals` is a notification history; adapter may clear consumed entries by creating a new state.
- No local absence is classified as outside-filter. Hidden-by-filter counts must come from authoritative filter membership or separately tracked verified membership, not this engine. Mixed known/unknown selection is representable; action compatibility checks belong to command preparation.

## Verification

Run from `experiments/inbox-stack`:

```
./node_modules/.bin/tsx ui/selection.test.ts
./node_modules/.bin/tsc --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext --skipLibCheck ui/selection.ts ui/selection.test.ts
```

Eleven Node-assert cases pass; focused strict typecheck passes. `result.json` records cases. Tests cover replace/toggle/removal, gesture threshold, additive rectangle, ordinary drag group semantics, cancellation/lost capture transition, arrivals, virtualization absence, authoritative deletion/revocation, independent Open, typed identity, keyboard/input handling and Escape order. Actual pointer capture, browser hit testing, scroll geometry, keyboard focus, accessibility and touch behavior remain integration tests; these results do not prove those behaviors.
