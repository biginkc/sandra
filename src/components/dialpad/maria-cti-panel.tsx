"use client";

import { useEffect, useRef, useState } from "react";
import { DIALPAD_CTI_ORIGIN, dialpadCtiEnableCurrentTabMessage, parseDialpadCtiEvent } from "@/lib/dialpad-voice/cti-protocol";

/** Persistent dashboard embed. Native controls and audio still require live
 * acceptance; no browser event here writes activity or starts a Sandra call.
 */
export function MariaCtiPanel({ clientId, expectedUserId }: { clientId: string; expectedUserId: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [selectionRequested, setSelectionRequested] = useState(false);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const message = parseDialpadCtiEvent(event, frame.current?.contentWindow, expectedUserId);
      if (message?.type === "authentication") {
        setAuthenticated(message.authenticated);
        setSelectionRequested(false);
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [expectedUserId]);
  return <section aria-label="Maria Dialpad pilot" className="fixed right-4 bottom-4 z-40 w-[min(360px,calc(100vw-2rem))] rounded-lg border bg-background shadow-xl">
    <div className="flex items-center justify-between gap-2 p-3">
      <span className="font-semibold">Dialpad pilot</span>
      <button type="button" className="text-sm underline" aria-expanded={!collapsed} aria-controls="maria-dialpad-panel" onClick={() => setCollapsed(value => !value)}>{collapsed ? "Show" : "Collapse"}</button>
    </div>
    {/* Keep the browsing context alive across collapse and dashboard navigation. */}
    <div id="maria-dialpad-panel" hidden={collapsed}>
      <p role="status" className="px-3 text-sm">{authenticated ? "Maria signed in. Calling has not been verified." : "Sign in to Dialpad as Maria."}</p>
      <button type="button" disabled={!authenticated} className="m-3 rounded border px-3 py-2 text-sm disabled:opacity-50" onClick={() => {
        if (!authenticated || !frame.current?.contentWindow) return;
        frame.current.contentWindow.postMessage(dialpadCtiEnableCurrentTabMessage(), DIALPAD_CTI_ORIGIN);
        setSelectionRequested(true);
      }}>Use this Dialpad tab</button>
      {selectionRequested && <p className="px-3 text-sm">Tab selection requested. Audio readiness is not confirmed.</p>}
      <iframe ref={frame} title="Maria Dialpad calling panel" src={`${DIALPAD_CTI_ORIGIN}/apps/${encodeURIComponent(clientId)}`}
        className="h-[500px] w-full border-0" allow="microphone; speaker-selection; autoplay; camera; display-capture; hid"
        sandbox="allow-popups allow-scripts allow-same-origin allow-forms" onLoad={() => { setAuthenticated(false); setSelectionRequested(false); }} />
    </div>
  </section>;
}
