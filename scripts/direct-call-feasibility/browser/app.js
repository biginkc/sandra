/* eslint-disable */
// Local test page logic. Logs call IDs/options BEFORE answering. No secrets are stored.
(async () => {
  const $ = (id) => document.getElementById(id);
  const out = $("out");
  const say = (s) => { out.textContent += s + "\n"; out.scrollTop = out.scrollHeight; };
  const post = (type, data, callControlId) =>
    fetch("/browser-log", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, data, callControlId }) }).catch(() => {});
  const safe = (o) => JSON.parse(JSON.stringify(o, (k, v) => (/pass|token|stream|element/i.test(k) ? undefined : v)));

  const { token, sipUsername } = await (await fetch("/token")).json();
  const client = new TelnyxWebRTC.TelnyxRTC({ login_token: token });
  // Remote audio MUST have an output element, or the rep hears nothing. Set before any call.
  const audio = document.createElement("audio");
  audio.id = "remoteAudio";
  audio.autoplay = true;
  audio.setAttribute("autoplay", "");
  document.body.appendChild(audio);
  client.remoteElement = audio;
  let current = null;
  let statsTimer = null;

  // Evidence for F1 two-way audio: WebRTC inbound/outbound audio counters, exposed on the page.
  const audioStats = { inboundBytes: 0, inboundPackets: 0, audioLevel: 0, maxAudioLevel: 0, outboundBytes: 0, samples: 0 };
  window.audioStats = audioStats;
  async function collectAudioStats(call) {
    const pc = call && ((call.peer && call.peer.instance) || (call.peer && call.peer.peerConnection));
    if (!pc || typeof pc.getStats !== "function") return audioStats;
    const report = await pc.getStats();
    report.forEach((r) => {
      if (r.kind !== "audio") return;
      if (r.type === "inbound-rtp") {
        audioStats.inboundBytes = r.bytesReceived || 0;
        audioStats.inboundPackets = r.packetsReceived || 0;
        if (typeof r.audioLevel === "number") { audioStats.audioLevel = r.audioLevel; audioStats.maxAudioLevel = Math.max(audioStats.maxAudioLevel, r.audioLevel); }
      } else if (r.type === "outbound-rtp") audioStats.outboundBytes = r.bytesSent || 0;
      else if (r.type === "media-source" && typeof r.audioLevel === "number") audioStats.maxAudioLevel = Math.max(audioStats.maxAudioLevel, r.audioLevel);
    });
    audioStats.samples++;
    return audioStats;
  }
  window.collectAudioStats = () => collectAudioStats(current);
  function startStats() {
    if (statsTimer) return;
    statsTimer = setInterval(async () => {
      try {
        await collectAudioStats(current);
        const line = "audio in=" + audioStats.inboundBytes + "B level=" + audioStats.audioLevel.toFixed(3) + " out=" + audioStats.outboundBytes + "B";
        $("stats") && ($("stats").textContent = line);
        post("audio.stats", { ...audioStats });
      } catch (e) {}
    }, 2000);
  }
  function stopStats() { clearInterval(statsTimer); statsTimer = null; }
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
    if (call.state === "active") { startStats(); if (!timer) timer = setTimeout(() => call.hangup(), MAX_MS); }
    if (call.state === "destroy" || call.state === "hangup") { clearTimeout(timer); timer = null; current = null; stopStats(); }
  });
  addEventListener("pagehide", () => { try { current && current.hangup(); } catch (e) {} });
  client.connect();

  $("answer").onclick = () => current && current.answer();
  $("hangup").onclick = () => current && current.hangup();
  $("hold").onclick = async () => { const r = await (current && current.hold()); say("hold() => " + r); post("hold.result", { r }); };
  $("unhold").onclick = async () => { const r = await (current && current.unhold()); say("unhold() => " + r); };
  $("sendDtmf").onclick = () => current && current.dtmf($("dtmf").value);

  // F2 escape probes. Buttons stay DISABLED until the local server says containment is confirmed
  // for this run, and every probe is started through the server, which reserves budget and
  // allows one outstanding probe at a time. The page never holds the target before the server grants it.
  const labels = await (await fetch("/escape-targets")).json();
  const box = $("escapes");
  const buttons = [];
  let busy = false;
  const setEnabled = (ready, serverBusy) => buttons.forEach((b) => { b.disabled = !(ready && !serverBusy && !busy); });
  async function refreshGate() {
    try { const s = await (await fetch("/probe/status")).json(); setEnabled(!!s.ready, !!s.busy); } catch (e) { setEnabled(false, true); }
  }
  async function runProbe(label, run) {
    if (busy) return;
    busy = true; setEnabled(false, true);
    let grant = null;
    try {
      const r = await fetch("/probe/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label }) });
      if (!r.ok) { const e = await r.json().catch(() => ({})); say("probe refused: " + (e.error || r.status)); return; }
      grant = await r.json();
      post("escape.attempt", { label, probeId: grant.probeId, targetLabel: grant.targetLabel });
      try { await run(grant.target, grant); } catch (e) { say("probe threw: " + e.message); post("escape.error", { label, message: e.message }); }
    } finally {
      // Reporting finish does not release the gate; the server reconciles legs first, and /probe/status stays busy until then.
      if (grant) await fetch("/probe/finish", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ probeId: grant.probeId }) }).catch(() => {});
      busy = false; refreshGate();
    }
  }
  for (const label of labels) {
    const b = document.createElement("button");
    b.disabled = true;
    b.textContent = (label === "transfer" ? "" : "dial ") + label;
    b.onclick = () => runProbe(label, (target, grant) => new Promise((resolve) => {
      if (label === "transfer") {
        if (!current || typeof current.transfer !== "function") { say("transfer NOT EXECUTED (no active source call or no SDK support): counts as untested"); post("escape.transfer.not_executed", { probeId: grant.probeId }); return resolve(); }
        say("transfer to: " + grant.targetLabel);
        post("escape.transfer", { probeId: grant.probeId, targetLabel: grant.targetLabel });
        current.transfer(target);
        return setTimeout(resolve, 20000);
      }
      const c = client.newCall({ destinationNumber: target, callerNumber: "", remoteElement: audio });
      say("escape dial started: " + label);
      setTimeout(() => { try { c.hangup(); } catch (e) {} resolve(); }, 20000); // page hangs up its own call
    }));
    box.appendChild(b);
    buttons.push(b);
  }
  refreshGate();
  setInterval(refreshGate, 2000);
})();
