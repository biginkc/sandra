import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { afterAll, beforeAll, describe, it, vi } from "vitest";

import { assertStack, FINAL, Receipt } from "./lib/env";
import { deliverWebhook, workflowSink, type WorkflowCall } from "./lib/driver";
import { BMH, createRunOrg, retirePriorRuns, seedLeads, setFlags, type Lead, type RunOrg } from "./lib/seed";
import { loadReplay, offsetToChicago, ProviderStubs, setClockOffset } from "./lib/stubs";

vi.mock("workflow/api", async (o) => (await import("./lib/wf-mock")).workflowMocks.api(o as never));
vi.mock("workflow", async (o) => (await import("./lib/wf-mock")).workflowMocks.core(o as never));

/** G4 (STRESS §4.1–4.3) on the stress stack: slot-time sweep, text lengths, stop conditions. */
const pg = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });
const data = loadReplay();
const stubs = new ProviderStubs(data);
let org: RunOrg;
const FLAGS = { questions_live: true, replies: true, drips: true, haiku: true, price_check: true, alert_on_time_only: true, model_stop_suppression: true, wrong_number_all: true, canary_percent: 100 };
const pending: Promise<unknown>[] = [];

beforeAll(async () => {
  assertStack();
  await pg.connect();
  stubs.install();
  setClockOffset(offsetToChicago(12, 0)); // business hours on the JS clock
  workflowSink.onStart = (c: WorkflowCall) => { pending.push(c.fn(c.params).catch((e) => ({ error: String(e) }))); };
  org = await createRunOrg(pg, `g4-${Date.now()}`, FLAGS);
  await retirePriorRuns(pg);
});
afterAll(async () => { setClockOffset(0); stubs.uninstall(); await pg.end(); });
const settle = async () => { while (pending.length) await Promise.all(pending.splice(0)); };

// ------------------------------------------------------------------ §4.1 slot times
describe("G4 §4.1 slot-time sweep", () => {
  it("pure planSlot + DB tick sweep across zones", async () => {
    const R = new Receipt("G4-4.1-slot-times.txt");
    const { planSlot } = await import("@/lib/sequences/routing-v2/slot-time");
    const { resolveSellerZone } = await import("@/lib/sequences/routing-v2/seller-timezone");
    const { ROUTING_V2_DRIPS } = await import("@/lib/sequences/routing-v2/drip-spec");
    const zones: Array<[string, string | null]> = [["MO", null], ["KS", "20091"], ["KS", "20181"], ["OH", null], ["CO", null], ["CA", null], ["", null], ["TX", null]];
    const wall = (d: Date, tz: string) => new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).format(d);
    const mins = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
    // A Wednesday in the future; sweep 96 ticks.
    const day0 = Date.UTC(2026, 10, 4, 0, 0);
    let checked = 0, late = 0, quiet = 0, outOfWindow = 0;
    const sendTimes: Record<string, Set<string>> = {};
    for (const [state, fips] of zones) {
      const z = resolveSellerZone({ state, fips });
      if (z.kind === "hold") { R.line(`zone ${state || "(blank)"} fips ${fips}: HOLD (fail closed, never guessed)`); continue; }
      for (const key of ["book_appointment", "said_theyd_call"] as const) {
        ROUTING_V2_DRIPS[key].steps.forEach((step, si) => {
          if (!step.slotWindow) return;
          for (let t = 0; t < 24 * 60 + 9 * 60; t += 15) {
            // ticks over the local day (UTC offset sweep covers every local quarter hour)
            const now = new Date(day0 + t * 60_000);
            let plan = planSlot(now, z.zone, step.slotWindow);
            let sendAt = now;
            if (plan.kind === "wait") { sendAt = plan.sendAt; plan = planSlot(sendAt, z.zone, step.slotWindow); }
            if (plan.kind !== "send_now") { R.line("FAIL re-plan at sendAt still waits", key, si, now.toISOString()); late++; continue; }
            checked++;
            const sendLocal = mins(wall(sendAt, z.zone)), slotLocal = mins(wall(plan.slotAt, z.zone));
            const lbl = plan.label.split(":"); const lblMin = (Number(lbl[0]) % 12) * 60 + Number(lbl[1]);
            if (slotLocal < sendLocal || plan.slotAt.getTime() < sendAt.getTime() || lblMin % 720 !== slotLocal % 720) late++;
            if (sendLocal < 8 * 60 || sendLocal >= 21 * 60) quiet++;
            const w = step.slotWindow === "morning" ? [600, 705] : step.slotWindow === "afternoon" ? [720, 1020] : [600, 1020];
            if (slotLocal < w[0]! || slotLocal > w[1]!) outOfWindow++;
            (sendTimes[`${key}#${si + 1}(${step.slotWindow})`] ??= new Set()).add(`${wall(sendAt, z.zone)}->${plan.label}`);
          }
        });
      }
    }
    R.check("pure sweep: text never sent after the time it names (label == slot, slot >= send)", late === 0, { checked, late });
    R.check("pure sweep: zero sends in quiet hours (seller-local 08:00–21:00)", quiet === 0, { checked, quiet });
    R.check("pure sweep: slot inside the step's window (morning 10:00–11:45, afternoon 12:00–17:00, any 10:00–17:00)", outOfWindow === 0, { outOfWindow });
    for (const [k, v] of Object.entries(sendTimes)) {
      const arr = [...v].sort();
      R.line(`send->slot pairs ${k}: ${arr.length} distinct; earliest ${arr[0]} latest ${arr[arr.length - 1]}`);
    }

    // DB sweep: real processEnrollmentTick at every 15-min tick of a Chicago day for each zone.
    const { processEnrollmentTick } = await import("@/lib/sequences/tick");
    const { getMockMessageLog, resetMockState } = await import("@/lib/messaging/providers/mock");
    const { createTestClient } = await import("@tests/integration/client");
    const db = createTestClient();
    const st = [{ state: "MO", fips: null }, { state: "KS", fips: "20091" }, { state: "OH", fips: null }, { state: "CO", fips: null }, { state: "CA", fips: null }, { state: "", fips: null }];
    const ticks = Array.from({ length: 96 }, (_, k) => k * 15);
    const leads = await seedLeads(pg, org, st.length * ticks.length, { state: (i) => st[i % st.length]!, address: (i) => `${i} Slot Sweep Rd` });
    // A prior inbound from each lead to the run's sender (no dispatch): the sticky "from" number a drip send needs.
    await pg.query("insert into public.messages (org_id, channel, direction, status, property_id, contact_id, from_address, to_address, body, created_at) select $1, 'sms', 'inbound', 'received', p, c, ph, $2, 'seed inbound (sticky sender)', now() - interval '2 hours' from unnest($3::uuid[], $4::uuid[], $5::text[]) t(p, c, ph)",
      [BMH, org.sender, leads.map((l) => l.propertyId), leads.map((l) => l.contactId), leads.map((l) => l.phone)]);
    const seq = (await pg.query("select id from sequences where org_id = $1 and routing_v2_key = 'book_appointment' and routing_v2_version = 1", [BMH])).rows[0]?.id;
    if (!seq) { R.line("FAIL no book_appointment v2 sequence"); return; }
    const outcomes: Record<string, number> = {};
    const lines: string[] = [];
    let dbLate = 0, dbQuiet = 0, dbSent = 0;
    const zoneOf: Record<string, string> = { MO: "America/Chicago", KS: "America/Chicago", OH: "America/New_York", CO: "America/Denver", CA: "America/Los_Angeles" };
    for (let k = 0; k < ticks.length; k++) {
      const tmin = ticks[k]!;
      setClockOffset(offsetToChicago(Math.floor(tmin / 60), tmin % 60));
      for (let s = 0; s < st.length; s++) {
        const lead = leads[k * st.length + s]!;
        const { rows: [{ id: enr }] } = await pg.query("select public.routing_v2_enroll($1, $2, $3, $4, null) id", [BMH, lead.propertyId, lead.contactId, seq]);
        const before = getMockMessageLog().length;
        const out = await processEnrollmentTick(db, { id: enr, org_id: BMH, sequence_id: seq, property_id: lead.propertyId, contact_id: lead.contactId, current_step_index: 0, enrolled_by_user_id: null, status: "active" } as never);
        const key = `${out.status}${"reason" in out ? ":" + String((out as { reason: string }).reason) : ""}`;
        outcomes[`${st[s]!.state || "blank"}|${key}`] = (outcomes[`${st[s]!.state || "blank"}|${key}`] ?? 0) + 1;
        const sent = getMockMessageLog().slice(before);
        for (const m of sent) {
          dbSent++;
          const tz = zoneOf[st[s]!.state]!;
          const local = wall(m.createdAt, tz);
          const lm = mins(local);
          const label = /at (\d{1,2}:\d{2})/.exec(m.body)?.[1];
          if (lm < 480 || lm >= 1260) dbQuiet++;
          if (label) { const [h, mm] = label.split(":").map(Number); let slot = (h! % 12) * 60 + mm!; if (slot < lm - 30) slot += 720; if (slot < lm) dbLate++; }
          lines.push(`${st[s]!.state} sent@${local} "${m.body.slice(0, 70)}"`);
        }
        await pg.query("begin; set local session_replication_role = replica; update public.sequence_enrollments set status = 'completed', next_run_at = null where id = $1; commit;".replace("$1", `'${enr}'`));
      }
    }
    setClockOffset(offsetToChicago(12, 0));
    R.line("DB tick outcomes by state (96 Chicago-clock ticks each, step 1 'any' window)", outcomes);
    R.check("DB sweep: sends never after the named time", dbLate === 0, { dbSent, dbLate });
    R.check("DB sweep: zero sends outside 08–21 property-local", dbQuiet === 0, { dbSent, dbQuiet });
    R.check("DB sweep: unknown state never sends (fail closed)", !Object.keys(outcomes).some((k) => k.startsWith("blank|sent")), Object.fromEntries(Object.entries(outcomes).filter(([k]) => k.startsWith("blank"))));
    R.line("actual sends (sample, first 40):"); for (const l of lines.slice(0, 40)) R.line("  " + l);
    void resetMockState;
  });
});

// ------------------------------------------------------------------ §4.2 lengths
describe("G4 §4.2 lengths", () => {
  it("renders every approved drip/reply text with the longest addresses and names", async () => {
    const R = new Receipt("G4-4.2-lengths.txt");
    const { renderTemplate } = await import("@/lib/sequences/render");
    const { smsSegments } = await import("@/lib/sequences/routing-v2/sms-segments");
    const { ROUTING_V2_DRIPS } = await import("@/lib/sequences/routing-v2/drip-spec");
    const { V2_REPLY_TEXTS, V2_REUSED_REPLY_TEXTS, V2_MULTI_SEGMENT_KEYS } = await import("@/lib/sms-classification/routing-v2/reply-texts");
    const { OPT_OUT_PHRASES } = await import("@/lib/sequences/opt-out");
    // Real addresses from the Oct outbound lines (data.json), plus long synthetic ones.
    const rows = JSON.parse(readFileSync(path.join(FINAL, "data.json"), "utf8")) as Array<{ our_last: string | null; thread: string[] }>;
    const addr = new Set<string>();
    const re = /\b(\d{1,6}(?: [NSEW]{1,2})?(?: [A-Za-z0-9.'-]+){1,5} (?:St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Ln|Lane|Ct|Court|Ter|Terrace|Blvd|Boulevard|Pl|Place|Way|Cir|Circle|Pkwy|Hwy|Trl|Pike|Loop)\.?(?: [NSEW]{1,2})?(?: (?:Apt|Unit|#) ?[A-Za-z0-9-]+)?)\b/gi;
    for (const r of rows) for (const line of [r.our_last ?? "", ...r.thread.filter((t) => t.startsWith("US: "))]) for (const m of line.matchAll(re)) addr.add(m[1]!.trim());
    const real = [...addr].sort((a, b) => b.length - a.length).slice(0, 50);
    const synthetic = ["12345 North Martin Luther King Junior Memorial Boulevard Apartment 1204", "1600 Old Kansas City-Leavenworth Road Building B Unit 22", "10312 East Thirtieth Terrace South"];
    const realNames = new Set<string>();
    for (const r of rows) for (const line of r.thread.filter((t) => t.startsWith("US: "))) { const m = /^US: Hi ([A-Z][A-Za-z'-]+),/.exec(line); if (m) realNames.add(m[1]!); }
    const longNames = [...realNames].sort((a, b) => b.length - a.length).slice(0, 5);
    R.line(`longest real first names: ${JSON.stringify(longNames)}`);
    const names = [...longNames, "Bartholomew-Christopherson", "there", ""];
    R.line(`real addresses extracted: ${addr.size}; longest real ${real[0]?.length} chars ("${real[0]}"); synthetic longest ${synthetic[0]!.length}`);
    const texts: Array<{ key: string; body: string; twoPart: boolean; slot: boolean }> = [];
    for (const [k, d] of Object.entries(ROUTING_V2_DRIPS)) d.steps.forEach((s, i) => texts.push({ key: `drip:${k}#${i + 1}`, body: s.body, twoPart: false, slot: !!s.slotWindow }));
    for (const [k, v] of Object.entries(V2_REPLY_TEXTS)) texts.push({ key: `reply:${k}`, body: v, twoPart: V2_MULTI_SEGMENT_KEYS.has(k as never), slot: false });
    for (const [k, v] of Object.entries(V2_REUSED_REPLY_TEXTS)) texts.push({ key: `reply(reused):${k}`, body: v, twoPart: false, slot: false });
    let fails = 0, nonGsm = 0, realFails = 0;
    const longestOpt = [...OPT_OUT_PHRASES].sort((a, b) => b.length - a.length)[0]!;
    for (const t of texts) {
      let worst = { units: 0, segs: 0, enc: "", addr: "", render: "" };
      for (const a of [...real, ...synthetic]) for (const n of names) {
        const out = renderTemplate(t.body, { property_address: a, first_name: n || null, slot_time: "12:45" });
        const s = smsSegments(out);
        if (s.units > worst.units || s.encoding !== "GSM-7") worst = { units: s.units, segs: s.segments, enc: s.encoding, addr: a, render: out };
      }
      const realOnly = real.map((a) => smsSegments(renderTemplate(t.body, { property_address: a, first_name: longNames[0] ?? "Pat", slot_time: "12:45" })));
      const realWorst = Math.max(...realOnly.map((s) => s.units));
      const usesAddr = /property_address/.test(t.body);
      const fixedLen = smsSegments(renderTemplate(t.body, { property_address: "", first_name: "Bartholomew-Christopherson", slot_time: "12:45" })).units;
      const breakAt = usesAddr ? 160 - fixedLen : null;
      if (worst.enc !== "GSM-7") nonGsm++;
      const ok = t.twoPart ? worst.segs === 2 && worst.enc === "GSM-7" : worst.segs === 1 && worst.enc === "GSM-7";
      const okReal = t.twoPart ? true : realWorst <= 160;
      if (!ok) fails++;
      if (!okReal) realFails++;
      R.line(`${ok ? "PASS" : okReal ? "FAIL(synthetic only)" : "FAIL"} ${t.key}: worst ${worst.units} units/${worst.segs} seg ${worst.enc} (real-address+real-name worst ${realWorst}${okReal ? "" : " OVER"}); breaks at address length > ${breakAt ?? "n/a"}; with longest opt-out footer +${longestOpt.length + 1} -> ${worst.units + longestOpt.length + 1}`);
      if (!ok) R.line(`   worst render: ${JSON.stringify(worst.render)}`);
    }
    R.check("every approved text <=160 GSM-7 one segment (how-it-works exactly 2) with synthetic+real longest addresses", fails === 0, { texts: texts.length, fails, failsWithRealDataOnly: realFails, nonGsm });
    const hiw = smsSegments(V2_REPLY_TEXTS.how_it_works);
    R.check("how-it-works is exactly 2 parts, GSM-7", hiw.segments === 2 && hiw.encoding === "GSM-7", hiw);
    const nonGsmChars = new Set<string>();
    for (const a of addr) for (const ch of a) if (smsSegments(ch).encoding !== "GSM-7") nonGsmChars.add(ch);
    R.line(`non-GSM characters found in real addresses: ${JSON.stringify([...nonGsmChars])}`);
    R.line("NOT COVERED: legacy drip texts copied from production (Book appointment steps >= 7, Listed not selling, Maybe later, Not interested, Asked who is texting, Confirmed owner) — no prod access; this stack has only placeholders. Addresses: no prod properties.address list (used data.json outbound lines instead).");
  });
});

// ------------------------------------------------------------------ §4.3 stop conditions
describe("G4 §4.3 stop conditions", () => {
  it("reply retire / stops / takeover / reroute / races / inbound call / drip end", async () => {
    const R = new Receipt("G4-4.3-stops.txt");
    const { createTestClient } = await import("@tests/integration/client");
    const { runSequenceTick } = await import("@/app/api/cron/sequence-tick/handlers");
    const { runRoutingV2OutboxReplies } = await import("@/lib/ai-responder/dispatch");
    const { getMockMessageLog } = await import("@/lib/messaging/providers/mock");
    const { isSmsPhoneSuppressed } = await import("@/lib/messaging/opt-out-phone");
    const { pauseHotBookAppointmentOnTakeover } = await import("@/lib/sequences/hot-lead-takeover");
    const db = createTestClient();
    await setFlags(pg, BMH, FLAGS);
    let n = 0;
    const say = async (lead: Lead, body: string, ext?: string) => {
      const st = await deliverWebhook({ externalId: ext ?? `${org.runId}-s-${n++}`, from: lead.phone, to: org.sender, body });
      await settle();
      return st;
    };
    const yes = (r: string) => r.includes("YESBOOK") ? { open_to_selling: 0.95 } : r.includes("NOTINT") ? { not_interested: 0.95 } : r.includes("LATER") ? { maybe_later: 0.95 } : r.includes("QUITPLS") ? { asked_stop: 0.95 } : r.includes("WHOQ") ? { asked_who: 0.95 } : null;
    stubs.jevOverride = yes;
    const enr = async (p: string) => (await pg.query("select e.id, e.status, e.pause_reason, e.ended_reason, s.routing_v2_key, e.current_step_index, e.next_run_at from sequence_enrollments e join sequences s on s.id = e.sequence_id where e.property_id = $1 order by e.status", [p])).rows;
    const makeDue = async (p: string) => pg.query("begin; set local session_replication_role = replica; update public.sequence_enrollments set next_run_at = now() - interval '1 minute' where property_id = '" + p + "' and status = 'active'; commit;");
    const sendsTo = (phone: string) => getMockMessageLog().filter((m) => m.to === phone);
    const tick = async () => { await runSequenceTick(db as never, { budgetMs: 20_000 }); };
    const leads = await seedLeads(pg, org, 30, { state: () => ({ state: "MO", fips: null }), address: (i) => `${i} Stop Case St` });
    const L = (i: number) => leads[i]!;

    // (1) Reply retires the drip within one tick; next step never sent.
    await say(L(0), "YESBOOK sure what's the offer");
    const e1 = await enr(L(0).propertyId);
    await makeDue(L(0).propertyId);
    await say(L(0), "NOTINT actually never mind");
    const before1 = sendsTo(L(0).phone).length;
    await makeDue(L(0).propertyId); await tick();
    const after1 = await enr(L(0).propertyId);
    const bookSends = sendsTo(L(0).phone).slice(before1).filter((m) => /slot|talk about|hold/.test(m.body) && !/placeholder Not interested/.test(m.body));
    R.check("reply -> prior drip retired (rerouted) before next tick; retired step never sent", after1.find((e) => e.id === e1[0]?.id)?.ended_reason === "rerouted" && bookSends.length === 0,
      { first: e1.map((e) => `${e.routing_v2_key}:${e.status}`), after: after1.map((e) => `${e.routing_v2_key}:${e.status}:${e.ended_reason ?? e.pause_reason ?? ""}`), bookSendsAfter: bookSends.length });

    // (2) Opt-outs: phone-wide suppression across two properties sharing one phone.
    // One owner (contact) on two properties: b's property moves to a's contact, and gets an active v2 drip.
    const bookSeq = (await pg.query("select id from sequences where org_id = $1 and routing_v2_key = 'book_appointment' and routing_v2_version = 1", [BMH])).rows[0].id;
    const shared = async (a: Lead, b: Lead) => {
      await pg.query("update public.properties set homeowner_contact_id = $1 where id = $2", [a.contactId, b.propertyId]);
      b.phone = a.phone; b.contactId = a.contactId;
      await pg.query("select public.routing_v2_enroll($1, $2, $3, $4, null)", [BMH, b.propertyId, a.contactId, bookSeq]);
    };
    for (const [label, body, i] of [["carrier STOP keyword", "STOP", 2], ["Jev stop (asked_stop 0.95, no keyword)", "QUITPLS I am all set for good, thanks", 5], ["legal (attorney)", "Contact my attorney, this is harassment under the TCPA", 8]] as const) {
      const a = L(i), b = L(i + 1);
      await shared(a, b);
      await say(a, body);
      await makeDue(a.propertyId); await makeDue(b.propertyId);
      const before = sendsTo(a.phone).length;
      await tick(); await runRoutingV2OutboxReplies(db, { limit: 50 });
      const suppressed = await isSmsPhoneSuppressed(db, a.phone, BMH).catch((e) => `error:${e}`);
      const active = (await enr(b.propertyId)).filter((e) => e.status === "active").length;
      const newSends = sendsTo(a.phone).slice(before);
      R.check(`${label}: phone-wide suppression, all drips on the phone stopped, zero further sends from any property`, suppressed === true && active === 0 && newSends.length === 0,
        { suppressed, otherPropertyActive: active, sendsAfter: newSends.map((m) => m.body.slice(0, 40)), otherEnr: (await enr(b.propertyId)).map((e) => `${e.routing_v2_key}:${e.status}:${e.pause_reason ?? e.ended_reason ?? ""}`),
          prop: (await pg.query("select needs_human_attention, last_ai_escalation_reason, outreach_dispo from properties where id = $1", [a.propertyId])).rows[0] });
    }

    // (3) Person takeover after inbound: drip paused/retired, no auto send.
    {
      const a = L(11);
      await say(a, "YESBOOK yes");
      await pauseHotBookAppointmentOnTakeover({ propertyIds: [a.propertyId], actor: { kind: "system" } as never });
      await makeDue(a.propertyId);
      const before = sendsTo(a.phone).length;
      await tick();
      R.check("person takeover -> no further auto drip send", sendsTo(a.phone).length === before, { enr: (await enr(a.propertyId)).map((e) => `${e.routing_v2_key}:${e.status}:${e.pause_reason ?? e.ended_reason ?? ""}`), sendsAfter: sendsTo(a.phone).length - before });
    }

    // (4) Every reply reroutes, incl. a PAUSED enrollment; never two active.
    {
      const a = L(13);
      await say(a, "YESBOOK yes");
      await pg.query("begin; set local session_replication_role = replica; update public.sequence_enrollments set status = 'paused', pause_reason = 'inbound_reply' where property_id = '" + a.propertyId + "' and status = 'active'; commit;");
      await say(a, "LATER maybe next year");
      const rows = await enr(a.propertyId);
      R.check("paused enrollment + new reply -> retired 'rerouted', new route applied, <=1 active, none left paused", rows.filter((e) => e.status === "active").length <= 1 && !rows.some((e) => e.status === "paused") && rows.some((e) => e.ended_reason === "rerouted"),
        rows.map((e) => `${e.routing_v2_key}:${e.status}:${e.pause_reason ?? e.ended_reason ?? ""}`));
    }

    // (5) Races.
    {
      const a = L(15);
      await say(a, "YESBOOK yes");
      const [r1, r2] = await Promise.all([
        deliverWebhook({ externalId: `${org.runId}-race-a`, from: a.phone, to: org.sender, body: "NOTINT no thanks" }),
        deliverWebhook({ externalId: `${org.runId}-race-b`, from: a.phone, to: org.sender, body: "LATER maybe later" }),
      ]);
      await settle();
      const rows = await enr(a.propertyId);
      const tr = (await pg.query("select inbound_message_id, outcome from routing_v2_reply_transitions where property_id = $1 order by transition_seq", [a.propertyId])).rows;
      R.check("2 concurrent replies -> one transition per inbound, <=1 active enrollment", rows.filter((e) => e.status === "active").length <= 1 && new Set(tr.map((t) => t.inbound_message_id)).size === tr.length,
        { webhook: [r1, r2], transitions: tr.map((t) => t.outcome), enr: rows.map((e) => `${e.routing_v2_key}:${e.status}:${e.ended_reason ?? ""}`) });
      const stamps = (await pg.query("select external_id, metadata->'processing'->'aiResponder'->>'outcome' o, metadata->'processing'->'aiResponder'->>'reason' r from messages where external_id = any($1)", [[`${org.runId}-race-a`, `${org.runId}-race-b`]])).rows;
      const propA = (await pg.query("select needs_human_attention, last_ai_escalation_reason from properties where id = $1", [a.propertyId])).rows[0];
      R.check("2 concurrent replies -> latest reply wins (a transition for the newer inbound; prior drip retired, not left paused)", tr.length > 1 && !rows.some((e) => e.status === "paused"),
        { transitionsForProperty: tr.length, stamps, enr: rows.map((e) => `${e.routing_v2_key}:${e.status}:${e.pause_reason ?? e.ended_reason ?? ""}`), property: propA });
      const b = L(17);
      await say(b, "YESBOOK yes", `${org.runId}-dupe`);
      await say(b, "YESBOOK yes", `${org.runId}-dupe`);
      const trb = (await pg.query("select count(*)::int n from routing_v2_reply_transitions where property_id = $1", [b.propertyId])).rows[0].n;
      R.check("duplicate webhook -> one transition", trb === 1, { transitions: trb });
      // reply vs tick in the same second
      const c = L(19);
      await say(c, "YESBOOK yes");
      await makeDue(c.propertyId);
      const before = sendsTo(c.phone).length;
      await Promise.all([tick(), deliverWebhook({ externalId: `${org.runId}-rvt`, from: c.phone, to: org.sender, body: "NOTINT not interested" })]);
      await settle(); await tick();
      const after = sendsTo(c.phone).slice(before);
      const stepSends = after.filter((m) => /Mel here|can I hold|talk about/.test(m.body));
      const enrC = await enr(c.propertyId);
      R.line(`reply vs tick same second: book-appointment step sends ${stepSends.length} (bodies ${JSON.stringify(stepSends.map((m) => m.body.slice(0, 40)))}), enrollments ${JSON.stringify(enrC.map((e) => `${e.routing_v2_key}:${e.status}:${e.ended_reason ?? ""}`))}`);
      const sentBeforeRetire = stepSends.length === 1 && enrC.some((e) => e.routing_v2_key === "book_appointment" && e.ended_reason === "rerouted");
      R.check("reply vs tick: retired step never sent after retirement (at most the step that won the per-property lock first)", stepSends.length <= 1, { stepSends: stepSends.length, tickWonLock: sentBeforeRetire });
      const stC = (await pg.query("select metadata->'processing'->'aiResponder'->>'outcome' o, metadata->'processing'->'aiResponder'->>'reason' r from messages where external_id = $1", [`${org.runId}-rvt`])).rows[0];
      const pC = (await pg.query("select needs_human_attention, last_ai_escalation_reason from properties where id = $1", [c.propertyId])).rows[0];
      R.check("reply vs tick: the reply is routed (drip retired 'rerouted', new route applied)", enrC.some((e) => e.ended_reason === "rerouted"), { stamp: stC, property: pC, enr: enrC.map((e) => `${e.routing_v2_key}:${e.status}:${e.pause_reason ?? e.ended_reason ?? ""}`) });
    }

    // (6) Inbound CALL must NOT pause a v2 drip (PR-H dropped).
    {
      const a = L(21);
      await say(a, "YESBOOK yes");
      const r = await pg.query("select * from public.pause_enrollments_for_inbound_call($1::uuid[])", [[a.contactId]]);
      const rows = await enr(a.propertyId);
      R.check("inbound call (pause_enrollments_for_inbound_call) leaves the v2 drip active", r.rowCount === 0 && rows.some((e) => e.status === "active"), { pausedRows: r.rowCount, enr: rows.map((e) => `${e.routing_v2_key}:${e.status}:${e.pause_reason ?? ""}`) });
    }

    // (7) Drip end (report only).
    {
      const a = L(23);
      await say(a, "YESBOOK yes");
      const steps = (await pg.query("select count(*)::int n from sequence_steps s join sequence_enrollments e on e.sequence_id = s.sequence_id where e.property_id = $1 and e.status = 'active'", [a.propertyId])).rows[0].n;
      await pg.query("begin; set local session_replication_role = replica; update public.sequence_enrollments set current_step_index = " + steps + ", next_run_at = now() - interval '1 minute' where property_id = '" + a.propertyId + "' and status = 'active'; commit;");
      await tick();
      R.line(`drip end (report only): after the last step the enrollment is ${JSON.stringify((await enr(a.propertyId)).map((e) => `${e.routing_v2_key}:${e.status}:${e.ended_reason ?? ""}`))}; no chain (thenKey null), no alert, no handoff`);
    }
    stubs.jevOverride = null;
  });
});
