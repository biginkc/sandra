import {
  act,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { callbacks, callAction, createClient, createLeadNote } = vi.hoisted(() => {
  const callbacks = {} as Partial<
    Record<"INSERT", (payload: { new: unknown }) => void>
  >;
  return {
    callbacks,
    callAction: vi.fn(),
    createClient: vi.fn(() => {
      const channel = {
        on: vi.fn(
          (
            _kind: string,
            config: { event: "INSERT" },
            callback: (payload: { new: unknown }) => void,
          ) => {
            callbacks[config.event] = callback;
            return channel;
          },
        ),
        subscribe: vi.fn(() => channel),
      };
      return {
        auth: {
          getSession: vi.fn().mockResolvedValue({ data: { session: null } }),
        },
        realtime: { setAuth: vi.fn() },
        channel: vi.fn(() => channel),
        removeChannel: vi.fn(),
      };
    }),
    createLeadNote: vi.fn(),
  };
});

vi.mock("@/lib/supabase/client", () => ({ createClient }));
vi.mock("@/lib/errors/call-action", () => ({ callAction }));
vi.mock("../actions", () => ({ createLeadNote }));

import {
  AddNoteComposer,
  NoteEventCard,
  type Note,
  useLeadNotes,
} from "./notes-feed";

function makeNote(
  id: string,
  createdAt: string,
  authorUserId = "user-2",
): Note {
  return {
    id,
    property_id: "property-1",
    body: `note ${id}`,
    author_user_id: authorUserId,
    created_at: createdAt,
  } as Note;
}

beforeEach(() => {
  delete callbacks.INSERT;
  createClient.mockClear();
  callAction.mockReset();
  createLeadNote.mockReset();
});

describe("<NoteEventCard />", () => {
  it("does not mislabel an unresolved teammate as system", () => {
    render(
      <NoteEventCard
        note={makeNote("unknown-author", "2026-08-23T10:00:00.000Z")}
        authorEmail={null}
        isMine={false}
      />,
    );
    expect(screen.getByText("unknown teammate")).toBeInTheDocument();
    expect(screen.queryByText("system")).not.toBeInTheDocument();
  });
});

describe("useLeadNotes", () => {
  it("deduplicates realtime inserts and retains the newest bounded window", async () => {
    const initial = Array.from({ length: 200 }, (_, index) =>
      makeNote(
        `note-${index}`,
        `2026-08-23T10:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
      ),
    );
    const { result } = renderHook(() =>
      useLeadNotes({
        propertyId: "property-1",
        initial,
        authorEmails: {},
        currentUserId: "user-1",
        currentUserEmail: "operator@example.com",
      }),
    );
    await waitFor(() => expect(callbacks.INSERT).toBeDefined());

    const inserted = makeNote("note-new", "2026-08-23T14:00:00.000Z", "user-3");
    act(() => callbacks.INSERT!({ new: inserted }));
    act(() =>
      callbacks.INSERT!({ new: { ...inserted, body: "updated payload" } }),
    );

    expect(result.current.notes).toHaveLength(200);
    expect(result.current.notes.at(-1)).toMatchObject({
      id: "note-new",
      body: "updated payload",
    });
    expect(result.current.notes.some((note) => note.id === "note-0")).toBe(
      false,
    );
    expect(
      result.current.notes.filter((note) => note.id === "note-new"),
    ).toHaveLength(1);
  });
});

describe("<AddNoteComposer />", () => {
  it("notifies its owner only after the existing note action confirms success", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    createLeadNote.mockReturnValue(Promise.resolve("action-promise"));
    callAction.mockResolvedValue({ ok: true, data: { id: "note-1" } });

    render(<AddNoteComposer propertyId="property-1" onSaved={onSaved} />);
    await user.click(screen.getByText("+ Add note"));
    await user.type(screen.getByLabelText("Add a note"), "Seller needs a quick close");
    await user.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ id: "note-1" }));
    expect(createLeadNote).toHaveBeenCalledWith("property-1", "Seller needs a quick close");
  });

  it("keeps the draft and does not notify its owner after a failed action", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    createLeadNote.mockReturnValue(Promise.resolve("action-promise"));
    callAction.mockResolvedValue({
      ok: false,
      error: { code: "NOTE_CREATE_FAILED", message: "Note could not be saved" },
    });

    render(<AddNoteComposer propertyId="property-1" onSaved={onSaved} />);
    await user.click(screen.getByText("+ Add note"));
    await user.type(screen.getByLabelText("Add a note"), "Keep this draft");
    await user.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(screen.getByLabelText("Add a note")).toHaveValue("Keep this draft"));
    expect(onSaved).not.toHaveBeenCalled();
  });
});
