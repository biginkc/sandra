import { describe, expect, it } from "vitest";

import type { CallActivityRollupRow } from "./lead-call-summary";
import type { Message } from "./messages-thread";
import type { Note } from "./notes-feed";
import {
  buildLeadActivitySnapshot,
  normalizeLeadActivityEvents,
  upsertBoundedActivityRow,
} from "./lead-activity";

const message = {
  id: "message-b",
  created_at: "2026-08-23T10:00:00.000Z",
} as Message;
const note = {
  id: "note-a",
  created_at: "2026-08-23T09:00:00.000Z",
} as Note;
const call = {
  id: "call-c",
  created_at: "2026-08-23T08:00:00.000Z",
  started_at: "2026-08-23T11:00:00.000Z",
} as CallActivityRollupRow;

describe("normalizeLeadActivityEvents", () => {
  it("normalizes all sources into ascending chat order", () => {
    expect(
      normalizeLeadActivityEvents([message], [note], [call]),
    ).toMatchObject([
      { source: "note", id: "note-a" },
      { source: "message", id: "message-b" },
      { source: "call", id: "call-c" },
    ]);
  });

  it("uses call created_at when started_at is missing", () => {
    const fallbackCall = { ...call, started_at: null };
    expect(
      normalizeLeadActivityEvents([message], [note], [fallbackCall])[0],
    ).toMatchObject({ source: "call", timestamp: call.created_at });
  });

  it("breaks timestamp ties deterministically by source and id", () => {
    const tiedNote = { ...note, id: "note-z", created_at: message.created_at };
    const tiedCall = {
      ...call,
      id: "call-a",
      started_at: message.created_at,
    };
    expect(
      normalizeLeadActivityEvents([message], [tiedNote], [tiedCall]).map(
        (event) => event.source,
      ),
    ).toEqual(["message", "note", "call"]);
  });

  it("preserves Postgres sub-millisecond precision when ordering", () => {
    const earlier = {
      ...message,
      id: "microsecond-earlier",
      created_at: "2026-08-23T10:00:00.000001Z",
    };
    const later = {
      ...message,
      id: "microsecond-later",
      created_at: "2026-08-23T10:00:00.000002Z",
    };
    expect(
      normalizeLeadActivityEvents([later, earlier], [], []).map(
        (event) => event.id,
      ),
    ).toEqual(["microsecond-earlier", "microsecond-later"]);
  });

  it("deduplicates duplicate source rows by id", () => {
    expect(
      normalizeLeadActivityEvents([message, message], [], []),
    ).toHaveLength(1);
  });
});

describe("buildLeadActivitySnapshot", () => {
  it("keeps successful source events when another source fails", () => {
    const snapshot = buildLeadActivitySnapshot([message], [note], [], {
      message: null,
      note: null,
      call: "Call history timed out",
    });

    expect(snapshot.events.map((event) => event.source)).toEqual([
      "note",
      "message",
    ]);
    expect(snapshot.failures).toEqual([
      { source: "call", detail: "Call history timed out" },
    ]);
  });

  it("orders multiple source failures deterministically above the timeline", () => {
    const snapshot = buildLeadActivitySnapshot([], [], [], {
      message: "Messages failed",
      note: null,
      call: "Calls failed",
    });

    expect(snapshot.failures.map((failure) => failure.source)).toEqual([
      "message",
      "call",
    ]);
  });

  it("marks the honest merged-window floor when a source reaches its bound", () => {
    const messages = Array.from({ length: 200 }, (_, index) => ({
      ...message,
      id: `message-${index}`,
      created_at: `2026-08-23T${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}:00.000Z`,
    }));
    const snapshot = buildLeadActivitySnapshot(messages, [note], [call], {
      message: null,
      note: null,
      call: null,
    });

    expect(snapshot.trustFloor).toBe(messages[0].created_at);
    expect(snapshot.trustBoundaryIndex).toBeGreaterThanOrEqual(0);
  });
});

describe("upsertBoundedActivityRow", () => {
  it("handles realtime inserts, updates, deduplication, and limits", () => {
    expect(
      upsertBoundedActivityRow(
        [
          { id: "a", value: 1 },
          { id: "b", value: 2 },
        ],
        { id: "a", value: 3 },
        2,
      ),
    ).toEqual([
      { id: "a", value: 3 },
      { id: "b", value: 2 },
    ]);
  });
});
