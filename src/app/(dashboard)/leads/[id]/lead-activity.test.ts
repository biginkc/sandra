import { describe, expect, it } from "vitest";

import type { CallActivityRollupRow } from "./lead-call-summary";
import type { Message } from "./messages-thread";
import type { Note } from "./notes-feed";
import type { LeadEvent } from "./lead-events";
import {
  buildLeadActivitySnapshot,
  normalizeLeadActivityEvents,
  selectLatestCallActivityRows,
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
const leadEvent = {
  id: "event-d",
  property_id: "property-1",
  actor_type: "system",
  actor_id: null,
  event_type: "qualified",
  payload: {},
  created_at: "2026-08-23T09:30:00.000Z",
} as LeadEvent;

describe("normalizeLeadActivityEvents", () => {
  it("normalizes all sources into ascending chat order", () => {
    expect(
      normalizeLeadActivityEvents([message], [note], [call], [leadEvent]),
    ).toMatchObject([
      { source: "note", id: "note-a" },
      { source: "event", id: "event-d" },
      { source: "message", id: "message-b" },
      { source: "call", id: "call-c" },
    ]);
  });

  it("uses call created_at when started_at is missing", () => {
    const fallbackCall = { ...call, started_at: null };
    expect(
      normalizeLeadActivityEvents([message], [note], [fallbackCall], [])[0],
    ).toMatchObject({ source: "call", timestamp: call.created_at });
  });

  it("breaks timestamp ties deterministically by source and id", () => {
    const tiedNote = { ...note, id: "note-z", created_at: message.created_at };
    const tiedCall = {
      ...call,
      id: "call-a",
      started_at: message.created_at,
    };
    const tiedEvent = { ...leadEvent, created_at: message.created_at };
    expect(
      normalizeLeadActivityEvents(
        [message],
        [tiedNote],
        [tiedCall],
        [tiedEvent],
      ).map((event) => event.source),
    ).toEqual(["message", "note", "call", "event"]);
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
      normalizeLeadActivityEvents([later, earlier], [], [], []).map(
        (event) => event.id,
      ),
    ).toEqual(["microsecond-earlier", "microsecond-later"]);
  });

  it("treats equivalent Z and +00:00 timestamps as the same instant", () => {
    const equivalentEvent = {
      ...leadEvent,
      created_at: "2026-08-23T10:00:00.000+00:00",
    };
    expect(
      normalizeLeadActivityEvents([message], [], [], [equivalentEvent]).map(
        (event) => event.source,
      ),
    ).toEqual(["message", "event"]);
  });

  it("orders mixed-offset microseconds by the exact instant", () => {
    const earlier = {
      ...leadEvent,
      id: "mixed-earlier",
      created_at: "2026-08-23T10:00:00.000001+01:00",
    };
    const later = {
      ...leadEvent,
      id: "mixed-later",
      created_at: "2026-08-23T09:00:00.000002Z",
    };
    expect(
      normalizeLeadActivityEvents([], [], [], [later, earlier]).map(
        (event) => event.id,
      ),
    ).toEqual(["mixed-earlier", "mixed-later"]);
  });

  it("deduplicates duplicate source rows by id", () => {
    expect(
      normalizeLeadActivityEvents(
        [message, message],
        [],
        [],
        [leadEvent, leadEvent],
      ),
    ).toHaveLength(2);
  });
});

describe("buildLeadActivitySnapshot", () => {
  it("keeps successful source events when another source fails", () => {
    const snapshot = buildLeadActivitySnapshot(
      [message],
      [note],
      [],
      [leadEvent],
      {
        message: null,
        note: null,
        call: "Call history timed out",
        event: null,
      },
    );

    expect(snapshot.events.map((event) => event.source)).toEqual([
      "note",
      "event",
      "message",
    ]);
    expect(snapshot.failures).toEqual([
      { source: "call", detail: "Call history timed out" },
    ]);
  });

  it("orders multiple source failures deterministically above the timeline", () => {
    const snapshot = buildLeadActivitySnapshot([], [], [], [], {
      message: "Messages failed",
      note: null,
      call: "Calls failed",
      event: "Activity failed",
    });

    expect(snapshot.failures.map((failure) => failure.source)).toEqual([
      "message",
      "call",
      "event",
    ]);
  });

  it("marks the honest merged-window floor when a source reaches its bound", () => {
    const messages = Array.from({ length: 200 }, (_, index) => ({
      ...message,
      id: `message-${index}`,
      created_at: `2026-08-23T${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}:00.000Z`,
    }));
    const snapshot = buildLeadActivitySnapshot(messages, [note], [call], [], {
      message: null,
      note: null,
      call: null,
      event: null,
    });

    expect(snapshot.trustFloor).toBe(messages[0].created_at);
    expect(snapshot.trustBoundaryIndex).toBeGreaterThanOrEqual(0);
  });

  it("includes the bounded lead-event window in the trust floor", () => {
    const leadEvents = Array.from({ length: 200 }, (_, index) => ({
      ...leadEvent,
      id: `event-${index}`,
      created_at: `2026-08-24T10:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
    }));
    const snapshot = buildLeadActivitySnapshot([], [], [], leadEvents, {
      message: null,
      note: null,
      call: null,
      event: null,
    });

    expect(snapshot.trustFloor).toBe(leadEvents[0].created_at);
  });
});

describe("selectLatestCallActivityRows", () => {
  it("merges started and created-at fallback windows into the canonical top 20", () => {
    const started = Array.from(
      { length: 20 },
      (_, index) =>
        ({
          ...call,
          id: `started-${String(index).padStart(2, "0")}`,
          created_at: "2026-08-01T00:00:00.000Z",
          started_at: `2026-08-01T00:${String(index).padStart(2, "0")}:00.000Z`,
        }) as CallActivityRollupRow,
    );
    const recentFallback = {
      ...call,
      id: "recent-fallback",
      created_at: "2026-08-23T12:00:00.000Z",
      started_at: null,
    } as CallActivityRollupRow;

    const selected = selectLatestCallActivityRows([...started, recentFallback]);

    expect(selected).toHaveLength(20);
    expect(selected[0]?.id).toBe("recent-fallback");
    expect(selected.some((row) => row.id === "started-00")).toBe(false);
  });

  it("breaks canonical timestamp ties by descending id", () => {
    const tied = ["call-a", "call-c", "call-b"].map(
      (id) => ({ ...call, id }) as CallActivityRollupRow,
    );
    expect(selectLatestCallActivityRows(tied).map((row) => row.id)).toEqual([
      "call-c",
      "call-b",
      "call-a",
    ]);
  });
});
