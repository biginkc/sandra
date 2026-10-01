/* eslint-disable */
// Local test page logic. Logs call IDs/options BEFORE answering. No secrets are stored.
(async () => {
  const out = document.getElementById("out");
  const say = (s) => { out.textContent += s + "\n"; out.scrollTop = out.scrollHeight; };
  const post = (type, data, callControlId) =>
    fetch("/browser-log", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, data, callControlId }) }).catch(() => {});
  const safe = (o) => JSON.parse(JSON.stringify(o, (k, v) => (/pass|token|stream|element/i.test(k) ? undefined : v)));

  const { token, sipUsername } = await (await fetch("/token")).json();
  const client = new TelnyxWebRTC.TelnyxRTC({ login_token: token });
  let current = null;
  const MAX_MS = 180000;
  let timer = null;

  client.on("telnyx.ready", () => { say("registered as " + sipUsername); post("registered", { at: Date.now() }); });
  client.on("telnyx.error", (e) => { say("error: " + (e && e.message)); post("error", { message: String(e && e.message) }); });
  client.on("telnyx.notification", (n) => {
    if (n.type !== "callUpdate" || !n.call) return;
    const call = n.call;
    current = call;
    if (call.state === "ringing" || call.state === "new") {
      // Logged BEFORE answering (F3).
      const ids = safe(call.telnyxIDs || {});
      const opts = safe(call.options || {});
      say("incoming: telnyxIDs=" + JSON.stringify(ids) + " options=" + JSON.stringify(opts));
      post("call.incoming", { telnyxIDs: ids, options: opts, state: call.state }, ids.telnyxLegId || ids.legId);
    } else {
      post("call.state", { state: call.state });
      say("state: " + call.state);
    }
    if (call.state === "active" && !timer) timer = setTimeout(() => call.hangup(), MAX_MS);
    if (call.state === "destroy" || call.state === "hangup") { clearTimeout(timer); timer = null; current = null; }
  });
  addEventListener("pagehide", () => { try { current && current.hangup(); } catch (e) {} });
  client.connect();

  const $ = (id) => document.getElementById(id);
  $("answer").onclick = () => current && current.answer();
  $("hangup").onclick = () => current && current.hangup();
  $("hold").onclick = async () => { const r = await (current && current.hold()); say("hold() => " + r); post("hold.result", { r }); };
  $("unhold").onclick = async () => { const r = await (current && current.unhold()); say("unhold() => " + r); };
  $("sendDtmf").onclick = () => current && current.dtmf($("dtmf").value);

  // F2 escape attempts. Targets are only those served by the local server (developer-owned).
  const targets = await (await fetch("/escape-targets")).json();
  const box = $("escapes");
  for (const t of targets) {
    const b = document.createElement("button");
    b.textContent = "dial " + t.label;
    b.onclick = () => {
      post("escape.attempt", { label: t.label });
      try {
        const c = client.newCall({ destinationNumber: t.target, callerNumber: "" });
        say("escape dial started: " + t.label);
        setTimeout(() => { try { c.hangup(); } catch (e) {} }, 20000); // page hangs up its own call
      } catch (e) { say("escape dial threw: " + e.message); post("escape.error", { label: t.label, message: e.message }); }
    };
    box.appendChild(b);
  }
  const tr = document.createElement("button");
  tr.textContent = "transfer attempt";
  tr.onclick = () => {
    const t = targets[0];
    if (!current || typeof current.transfer !== "function") return say("transfer unavailable in this SDK or no call");
    try { current.transfer(t.target); post("escape.attempt", { label: "transfer" }); } catch (e) { say("transfer threw: " + e.message); }
  };
  box.appendChild(tr);
})();
