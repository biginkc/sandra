import { render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const lifecycle = vi.hoisted(() => ({ mounted: [] as string[], unmounted: [] as string[] }));

vi.mock("./coach-live-view", async () => {
  const React = await import("react");
  return {
    CoachLiveView: ({ session }: { session: { callId: string | null } }) => {
      const [mountedCallId] = React.useState(session.callId);
      React.useEffect(() => {
        lifecycle.mounted.push(mountedCallId ?? "none");
        return () => {
          lifecycle.unmounted.push(mountedCallId ?? "none");
        };
      }, [mountedCallId]);
      return <div data-testid="keyed-coach-probe">{mountedCallId}</div>;
    },
  };
});

import { KeyedCoachLiveView } from "./keyed-coach-live-view";

afterEach(() => {
  lifecycle.mounted.length = 0;
  lifecycle.unmounted.length = 0;
});

it("remounts the coach before a new call can reuse the previous controller", () => {
  const common = {
    callName: "Coach Test",
    callStatus: "live" as const,
    seconds: 1,
    muted: false,
    held: false,
    holdPending: false,
    onDigit: vi.fn(),
    onMute: vi.fn(),
    onHold: vi.fn(),
    onHangup: vi.fn(),
    onCollapse: vi.fn(),
  };
  const firstSession = { callId: "call-a" };
  const secondSession = { callId: "call-b" };
  const rendered = render(<KeyedCoachLiveView {...common} session={firstSession as never} />);

  expect(screen.getByTestId("keyed-coach-probe")).toHaveTextContent("call-a");
  rendered.rerender(<KeyedCoachLiveView {...common} session={secondSession as never} />);

  expect(screen.getByTestId("keyed-coach-probe")).toHaveTextContent("call-b");
  expect(lifecycle.unmounted).toEqual(["call-a"]);
  expect(lifecycle.mounted).toEqual(["call-a", "call-b"]);
});
