"use client";

import { CoachLiveView, type CoachLiveViewProps } from "./coach-live-view";

/**
 * The recommendation controller is intentionally view-owned. A new call must
 * therefore remount the view before it can paint anything retained by the
 * previous call's controller.
 */
export function KeyedCoachLiveView(props: CoachLiveViewProps) {
  return <CoachLiveView key={props.session.callId ?? "coach-no-call"} {...props} />;
}
