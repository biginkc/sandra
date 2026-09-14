# Sandra QA browser receive capture

The Sandra Jitter transport can persist media presented to its remote audio element during an explicitly scoped canary call. This is a QA evidence path, not a user-facing recorder. It does not prove that a physical headset speaker produced sound.

Before starting the owned test call, set `sessionStorage["sandra:reliability-capture:v1"]` in the same browser tab to JSON with `runId`, `destinationE164`, `callerIdE164`, and `expiresAtEpochMs`. The run ID must be 8–80 letters, digits, underscores or hyphens. The expiry must be in the future and no more than two hours away. Both E.164 numbers must exactly match the call target. The transport consumes a matching configuration once when the call starts; a mismatch leaves it unused. Use only a run-owned destination and the caller ID assigned to that test seat.

After the browser leg plays, the transport captures the playback element with `captureStream` and `MediaRecorder`. Chunks and monotonic/epoch receipt markers go to IndexedDB database `sandra-reliability-capture-v2`, keyed by run ID, call ID, segment and sequence. Reconnection starts a new segment. `readReliabilityCapture(runId, callId)` in `src/lib/dialer/reliability-capture-store.ts` reads just that call's chunks and events. The browser page must stay alive during capture, including hidden-window tests; detaching the automation observer is allowed.

Before scoring a run, require a `started` event, contiguous nonempty chunks, a `stopped` event after teardown, and no `error`, `unsupported`, or `no_audio_track` event. A paused or muted playback element is reported as an error even if its captured media still contains speech. Also inspect `sessionStorage["sandra:reliability-capture-error:<runId>:<callId>"]`; any value is a capture failure. A missing marker or incomplete media makes browser audio evidence inconclusive, never a pass. Chunks are test audio and must be exported into the run evidence before clearing browser storage. Keep the independent destination-side receiver capture and emission log separate; this path measures only what reached Sandra's browser media element.

For a browser launched with a local Chrome DevTools port, export **after the call has ended** while the original tab remains open:

```sh
node scripts/export-reliability-browser-capture.mjs \
  --cdp=http://127.0.0.1:9222 \
  --origin=https://YOUR-SANDRA-ORIGIN \
  --run=EXACT_RUN_ID \
  --call=EXACT_CALL_UUID \
  --out=/absolute/path/to/new-empty-export-directory
```

The exporter reads the exact run/call key without clicking the page or clearing IndexedDB. It refuses missing/error events and incomplete or noncontiguous segments, then writes one media file per segment plus a manifest with event/chunk clocks and SHA-256 hashes. The output directory must not already exist. A successful export proves that the stored browser-side media can be recovered; decoding the audio and scoring unique probes still require the independent receiver and emission evidence. A failed or interrupted export has no completed manifest and cannot be scored.
