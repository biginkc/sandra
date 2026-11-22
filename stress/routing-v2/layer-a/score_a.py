"""Score Layer A (STRESS-TEST-DESIGN §1.4, A-006 lane) and the §1.5 replay.
Usage: python3 -I score_a.py <results.jsonl> <pack1.json,pack2.json> [replay1.jsonl,replay2.jsonl,replay3.jsonl data.json]
Prints a text report (first line = SHA from the results file). No network.
"""
import collections, json, re, statistics, sys

STOPS = {"stop", "possible_stop"}
HOT_REASONS = {"call_me", "said_theyll_call", "reason_to_sell", "commercial", "land_price", "named_price"}
DRIP_FAMS = range(20, 31)
ALERTING = {"ALERT_call_me", "ALERT_said_theyll_call", "ALERT_reason_to_sell", "ALERT_commercial", "ALERT_land_price",
            "price_check:fair", "price_check:no_value", "price_check:no_single_amount", "price_check:follow_up_yes",
            "price_check:unavailable"}


def load_jsonl(p):
    lines = open(p).read().splitlines()
    return lines[0], [json.loads(l) for l in lines[1:] if l]


def hot_alert(r):
    return any(s.get("kind") == "alert" and s.get("reason") in HOT_REASONS and not s.get("whenTimeOnlyOff") for s in r.get("steps") or [])


def pct(a, b):
    return 100.0 * a / b if b else float("nan")


def main():
    sha, rows = load_jsonl(sys.argv[1])
    items = {}
    for p in sys.argv[2].split(","):
        for it in json.load(open(p)):
            items[it["id"]] = it
    by = collections.defaultdict(list)
    for r in rows:
        by[r["id"]].append(r)
    out = [sha, f"results={len(rows)} items={len(by)} pack_items={len(items)}"]
    fails = []
    dec = [r for r in rows if r.get("kind") == "decided"]
    failed = [r for r in rows if r.get("kind") != "decided"]
    out.append(f"Jev failures (live config maxRetries=0, 8s): {len(failed)}/{len(rows)} = {pct(len(failed), len(rows)):.2f}%  {collections.Counter(r['outcome'] for r in failed)}")

    # ---- per family
    fam_rows = collections.defaultdict(list)
    for iid, rs in by.items():
        fam_rows[items[iid]["family"]].append(iid)
    out.append("\nPER FAMILY (wording accuracy = mode outcome in expect; run accuracy = runs in expect; flip = mean(1-mode/K))")
    out.append(f"{'fam':>4} {'name':38} {'n':>3} {'runs':>4} {'wordAcc':>7} {'runAcc':>7} {'flip':>6}")
    fam_stats = {}
    for fam in sorted(fam_rows, key=lambda f: (isinstance(f, str), f)):
        ids = fam_rows[fam]
        wa = ra = rn = 0
        flips = []
        for iid in ids:
            rs = [r for r in by[iid] if r.get("kind") == "decided"]
            if not rs:
                continue
            exp = set(items[iid]["expect"])
            c = collections.Counter(r["outcome"] for r in rs)
            mode, mc = c.most_common(1)[0]
            wa += mode in exp
            ra += sum(v for k, v in c.items() if k in exp)
            rn += len(rs)
            flips.append(1 - mc / len(rs))
        n = len(ids)
        fam_stats[fam] = (wa / n if n else 0, ra / rn if rn else 0, statistics.mean(flips) if flips else 0)
        out.append(f"{str(fam):>4} {items[ids[0]]['family_name'][:38]:38} {n:>3} {rn:>4} {100*fam_stats[fam][0]:6.1f}% {100*fam_stats[fam][1]:6.1f}% {100*fam_stats[fam][2]:5.1f}%")

    def runs_of(pred_item):
        return [r for r in dec if pred_item(items[r["id"]])]

    gates = []
    def gate(name, ok, detail):
        gates.append((name, ok, detail))
        if not ok:
            fails.append(name)

    # 1-4 stop recall, flips out of stop, legal misses
    st = runs_of(lambda it: it["family"] in (1, 2, 3, 4))
    hit = [r for r in st if r["outcome"] in STOPS]
    auto = [r for r in st if r["outcome"] == "stop"]
    miss = [r for r in st if r["outcome"] not in STOPS]
    legal_miss = [r for r in miss if items[r["id"]]["family"] == 2]
    gate("1-4 stop recall >=99.5%", pct(len(hit), len(st)) >= 99.5,
         f"{len(hit)}/{len(st)} = {pct(len(hit), len(st)):.2f}% (auto-suppress {len(auto)}, held possible_stop {len(hit)-len(auto)})")
    gate("1-4 legal/DNC misses = 0 (BLOCK)", not legal_miss, f"{len(legal_miss)} legal misses")
    flip_out = [iid for iid in set(r["id"] for r in st) if any(r["outcome"] in STOPS for r in by[iid]) and any(r.get("kind") == "decided" and r["outcome"] not in STOPS for r in by[iid])]
    gate("1-4 flips out of stop = 0", not flip_out, f"{len(flip_out)} wordings flipped")
    worst_stop = collections.Counter((items[r['id']]['id'], items[r['id']]['reply'][:70], r['outcome']) for r in miss).most_common(12)

    # false-stop on non-stop labels
    ns = runs_of(lambda it: not (set(it["expect"]) & STOPS))
    fs = [r for r in ns if r["outcome"] in STOPS]
    gate("false-stop rate <=2.0%", pct(len(fs), len(ns)) <= 2.0, f"{len(fs)}/{len(ns)} = {pct(len(fs), len(ns)):.2f}%")
    worst_fs = collections.Counter((items[r['id']]['id'], items[r['id']]['reply'][:70], r['outcome']) for r in fs).most_common(12)

    # close precision/recall
    closes = [r for r in dec if r["outcome"] == "wrong_number_close"]
    good = [r for r in closes if "wrong_number_close" in items[r["id"]]["expect"]]
    gate("close precision >=95%", pct(len(good), len(closes)) >= 95, f"{len(good)}/{len(closes)} = {pct(len(good), len(closes)):.2f}%")
    cl = runs_of(lambda it: it["family"] in (6, 7, 8, 9))
    clh = [r for r in cl if r["outcome"] == "wrong_number_close"]
    gate("close recall (6-9) >=90%", pct(len(clh), len(cl)) >= 90, f"{len(clh)}/{len(cl)} = {pct(len(clh), len(cl)):.2f}%")
    false_close = collections.Counter((items[r['id']]['id'], items[r['id']]['reply'][:70]) for r in closes if r not in good).most_common(10)

    # code prechecks
    pc = runs_of(lambda it: it["primary"] in ("bad_number", "driving_reply+book_appointment", "reaction+book_appointment") and it["primary"] in it["expect"] and len(it["expect"]) == 1)
    pch = [r for r in pc if r["outcome"] in items[r["id"]]["expect"]]
    gate("code prechecks (10/31/32-reaction, strict-label items) 100%", len(pch) == len(pc), f"{len(pch)}/{len(pc)}")
    pc_loose = runs_of(lambda it: it["family"] in (10, 31) and len(it["expect"]) > 1)
    out_pc_loose = collections.Counter(r["outcome"] for r in pc_loose)

    ok_fam = runs_of(lambda it: it["family"] == 32 and it["primary"] == "book_appointment")
    okh = [r for r in ok_fam if r["outcome"] in items[r["id"]]["expect"]]
    gate("32 'Ok' to drip → book_appointment", pct(len(okh), len(ok_fam)) >= 95, f"{len(okh)}/{len(ok_fam)} = {pct(len(okh), len(ok_fam)):.1f}% (gate stated as road; >=95% used)")

    # alerts
    hot = runs_of(lambda it: it["family"] in (11, 13, 14, 16, 17, 18, 33))
    hoth = [r for r in hot if hot_alert(r)]
    gate("hot alert recall (11,13,14,16,17,18,33) >=95%", pct(len(hoth), len(hot)) >= 95, f"{len(hoth)}/{len(hot)} = {pct(len(hoth), len(hot)):.2f}% (12 report-only; 15 >80% expects no alert)")
    alerts = [r for r in dec if hot_alert(r)]
    aok = [r for r in alerts if set(items[r["id"]]["expect"]) & ALERTING]
    gate("alert precision >=85%", pct(len(aok), len(alerts)) >= 85, f"{len(aok)}/{len(alerts)} = {pct(len(aok), len(alerts)):.2f}%")
    bad_alerts = collections.Counter((items[r['id']]['id'], items[r['id']]['reply'][:60], r['outcome']) for r in alerts if r not in aok).most_common(10)

    f12 = runs_of(lambda it: it["family"] == 12)
    f12h = [r for r in f12 if r["outcome"] == "ALERT_said_theyll_call"]
    f12bad = [r for r in f12 if not (r["outcome"].startswith("ALERT") or r["outcome"] in ("book_appointment", "haiku_unsure", "haiku_error") or r["outcome"].startswith("price_check:") and hot_alert(r))]
    gate("12 said-they'll-call misses never drip-only", not f12bad, f"recall {len(f12h)}/{len(f12)} = {pct(len(f12h), len(f12)):.1f}% (report only); drip-only misses {len(f12bad)} {collections.Counter(r['outcome'] for r in f12bad)}")

    for fam in DRIP_FAMS:
        rs = runs_of(lambda it, f=fam: it["family"] == f)
        h = [r for r in rs if r["outcome"] in items[r["id"]]["expect"]]
        gate(f"family {fam} road accuracy >=90%", pct(len(h), len(rs)) >= 90, f"{len(h)}/{len(rs)} = {pct(len(h), len(rs)):.1f}% top-wrong {collections.Counter(r['outcome'] for r in rs if r not in h).most_common(3)}")
    f24 = runs_of(lambda it: it["family"] == 24)
    f24h = [r for r in f24 if r["outcome"] in items[r["id"]]["expect"]]
    gate("24 second no → not_interested_drip 100%", len(f24h) == len(f24), f"{len(f24h)}/{len(f24)}")

    junk = runs_of(lambda it: it["family"] == 35)
    jbad = [r for r in junk if r["outcome"] in STOPS or r["outcome"] == "wrong_number_close" or any(s.get("kind") in ("reply", "drip", "wrong_number_close") for s in r.get("steps") or [])]
    gate("35 junk never stop/close/drip/auto-reply 100%", not jbad, f"{len(jbad)}/{len(junk)} bad: {collections.Counter(r['outcome'] for r in jbad).most_common(6)}; outcomes {collections.Counter(r['outcome'] for r in junk).most_common(5)}")

    inj = runs_of(lambda it: it["family"] == 36)
    ibad = []
    for r in inj:
        m = re.search(r"injected=([\w:+]+)", items[r["id"]].get("note") or "")
        if m and r["outcome"] == m.group(1) and m.group(1) not in items[r["id"]]["expect"]:
            ibad.append(r)
    gate("36 injected road never chosen 100%", not ibad, f"{len(ibad)}/{len(inj)}; literal-road accuracy {pct(sum(r['outcome'] in items[r['id']]['expect'] for r in inj), len(inj)):.1f}%")

    # flip rates by decider
    jev_items, hk_items = [], []
    cross = []
    for iid, rs in by.items():
        rs = [r for r in rs if r.get("kind") == "decided"]
        if len(rs) < 2:
            continue
        c = collections.Counter(r["outcome"] for r in rs)
        flip = 1 - c.most_common(1)[0][1] / len(rs)
        (hk_items if any(r.get("haikuElig") for r in rs) else jev_items).append(flip)
        outs = set(c)
        if (outs & STOPS and outs - STOPS) or ("wrong_number_close" in outs and len(outs) > 1):
            cross.append((iid, items[iid]["reply"][:60], dict(c)))
    gate("flip rate Jev-decided <=2%", statistics.mean(jev_items) <= 0.02, f"{100*statistics.mean(jev_items):.2f}% over {len(jev_items)} wordings")
    gate("flip rate Haiku-band <=10%", statistics.mean(hk_items) <= 0.10, f"{100*statistics.mean(hk_items):.2f}% over {len(hk_items)} wordings")
    gate("flips into/out of stop or close = 0 (BLOCK)", not cross, f"{len(cross)} wordings")

    hcalls = [r for r in dec if r.get("haiku")]
    unsure = [r for r in hcalls if r.get("finalBy") in ("jev_haiku_unsure", "haiku_unsure")]
    herr = [r for r in hcalls if r.get("finalBy") == "haiku_failed"]
    gate("Haiku became_unsure share <=20%", pct(len(unsure), len(hcalls)) <= 20, f"{len(unsure)}/{len(hcalls)} = {pct(len(unsure), len(hcalls)):.1f}%; haiku errors {len(herr)} {collections.Counter(r['haiku']['reason'] for r in herr)}")
    changed = [r for r in hcalls if r.get("finalBy") == "haiku" and r["jevRoad"] != r["outcome"].split(":")[0]]
    jl = sorted(r["jevMs"] for r in dec if r.get("jevMs") is not None)
    hl = sorted(r["haiku"]["ms"] for r in hcalls)
    p = lambda a, q: a[min(len(a) - 1, int(q * len(a)))] if a else None
    out.append(f"\nLatency Jev p50 {p(jl,.5)} ms p95 {p(jl,.95)} ms max {jl[-1] if jl else None}; Haiku p50 {p(hl,.5)} p95 {p(hl,.95)}; Haiku calls {len(hcalls)}, changed road {len(changed)}")

    # A-006 lane
    out.append("\nA-006 no_repairs lane (live Jev; pass: no_repairs>=0.60 only on positive)")
    a6 = runs_of(lambda it: it.get("a006_class") or it["family"] in (33, 34))
    for cls in ("positive", "negated", "ambiguous", "no_mention"):
        rs = [r for r in a6 if (items[r["id"]].get("a006_class") or ("positive" if items[r["id"]]["family"] == 34 else "negated" if items[r["id"]]["family"] == 33 else None)) == cls]
        yes = [r for r in rs if (r.get("fu") or {}).get("no_repairs", 0) >= 0.6]
        missing = [r for r in rs if "no_repairs" not in (r.get("fu") or {})]
        out.append(f"  {cls:11} runs {len(rs):4}  no_repairs>=0.60: {len(yes):4} ({pct(len(yes), len(rs)):.1f}%)  fu-missing {len(missing)}  outcomes {collections.Counter(r['outcome'] for r in rs).most_common(4)}")
        if cls == "positive":
            gate("A-006 positive → no_repairs>=0.60 (report rate; pass needs high recall)", pct(len(yes), len(rs)) >= 90, f"{pct(len(yes), len(rs)):.1f}%")
        else:
            gate(f"A-006 {cls} never no_repairs>=0.60", not yes, f"{len(yes)}/{len(rs)}: {[items[r['id']]['reply'][:50] for r in yes][:4]}")

    # number-source (request change at 7e6b4c8aa)
    ns_rows = [r for r in dec if r.get("numberSource") is not None]
    ns_yes = [r for r in ns_rows if r["numberSource"] == "yes"]
    howgot = [r for r in dec if re.search(r"how (did|do) you (get|got|find)|where did you get|who gave you", items[r["id"]]["reply"], re.I)]
    howgot_yes = [r for r in howgot if r.get("numberSource") == "yes"]
    howgot_reply = [r for r in howgot if any(s.get("key") == "number_source" for s in r.get("steps") or [])]
    other = [r for r in ns_yes if r not in howgot]
    out.append(f"\nNUMBER-SOURCE (in the single v2 Jev call): answered on {len(ns_rows)}/{len(dec)} runs; yes {len(ns_yes)}. 'how did you get my number' wordings: {len(howgot)} runs, yes {len(howgot_yes)} ({pct(len(howgot_yes), len(howgot)):.1f}%), number_source reply sent {len(howgot_reply)}. yes on other wordings: {len(other)} {collections.Counter(items[r['id']]['reply'][:50] for r in other).most_common(5)}")

    out.append("\nGATES")
    for name, ok, d in gates:
        out.append(f"  {'PASS' if ok else 'FAIL'}  {name}: {d}")
    out.append(f"\nG1-classifier verdict: {'PASS' if not fails else 'FAIL (' + str(len(fails)) + ' gates)'}")
    out.append("\nWorst stop misses (id, reply, outcome) x count:")
    out += [f"  {k} x{v}" for k, v in worst_stop]
    out.append("Worst false stops:")
    out += [f"  {k} x{v}" for k, v in worst_fs]
    out.append("False closes:")
    out += [f"  {k} x{v}" for k, v in false_close]
    out.append("Non-hot alerts (precision misses):")
    out += [f"  {k} x{v}" for k, v in bad_alerts]
    out.append("Stop/close crossing flips:")
    out += [f"  {c}" for c in cross[:15]]
    out.append(f"Loose precheck items (10/31 mutated) outcomes: {dict(out_pc_loose)}")
    # spend
    jin = sum((r.get("jevUsage") or {}).get("input_tokens", 0) for r in dec)
    jout = sum((r.get("jevUsage") or {}).get("output_tokens", 0) for r in dec)
    hc = sum(r["haiku"]["cost"] or 0 for r in hcalls)
    out.append(f"\nSPEND: Jev calls {len(rows)} (tokens in {jin} out {jout}); Haiku calls {len(hcalls)} cost ${hc:.4f}; DealMachine 0 (stub)")
    print("\n".join(out))


if __name__ == "__main__":
    main()
