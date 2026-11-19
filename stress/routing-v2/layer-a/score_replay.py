"""§1.5 live replay vs the v7 single-source table (BUILD-PLAN §3). Usage: score_replay.py r1.jsonl,r2.jsonl,r3.jsonl data.json"""
import collections, json, sys
V7 = dict(not_interested_drip=783, book_appointment=242, price_check=186, wrong_number_close=109, stop=107, ALERT_call_me=93,
          listed_drip=35, who_reply_drip=35, maybe_later_drip=27, ALERT_haiku_unsure=26, which_property_reply=22, vacant_land_drip=19,
          ALERT_commercial=17, ALERT_reason_to_sell=10, location_reply=10, text_only_reply=9, **{"reaction+book_appointment": 7},
          confirmed_owner_drip=4, ALERT_land_price=3, **{"driving_reply+book_appointment": 3}, ALERT_said_theyll_call=2,
          how_it_works_reply=2, bad_number=1)
def norm(o):
    if o.startswith("price_check:"): return "price_check"
    if o == "possible_stop": return "stop"
    if o == "haiku_unsure": return "ALERT_haiku_unsure"
    return o
files = sys.argv[1].split(","); data = {r["run_id"]: r for r in json.load(open(sys.argv[2]))}
sha = None; runs = []
for f in files:
    lines = open(f).read().splitlines(); sha = sha or lines[0]
    if lines[0] != sha: print("SHA MISMATCH", f)
    runs.append([json.loads(l) for l in lines[1:] if l])
print(sha); fails = []
stopsets = []
for i, rows in enumerate(runs, 1):
    c = collections.Counter(norm(r["outcome"]) for r in rows)
    hc = sum(1 for r in rows if r.get("haiku")); herr = sum(1 for r in rows if r.get("finalBy") == "haiku_failed")
    jfail = sum(1 for r in rows if r.get("kind") != "decided")
    hold_stop = sum(1 for r in rows if r["outcome"] == "possible_stop")
    stopsets.append({r["id"] for r in rows if norm(r["outcome"]) == "stop"})
    print(f"\nRUN {i}: n={len(rows)} jev_failed={jfail} haiku_calls={hc} haiku_errors={herr} possible_stop(held)={hold_stop}")
    print(f"{'road':34}{'v7':>6}{'live':>6}{'diff%':>8}  gate(±10%, min ±3)")
    for road in sorted(set(V7) | set(c), key=lambda k: -V7.get(k, 0)):
        v, l = V7.get(road, 0), c.get(road, 0)
        tol = max(0.10 * v, 3)
        ok = abs(l - v) <= tol
        if not ok: fails.append((i, road, v, l))
        print(f"{road:34}{v:6}{l:6}{(100*(l-v)/v if v else float('inf')):8.1f}  {'ok' if ok else 'FAIL'}")
    ok = abs(hc - 275) <= 27.5
    if not ok: fails.append((i, "haiku_calls", 275, hc))
    print(f"haiku calls {hc} vs 275 ±10%: {'ok' if ok else 'FAIL'}; haiku_errors {herr} (gate 0): {'ok' if herr == 0 else 'FAIL'}")
    if herr: fails.append((i, "haiku_errors", 0, herr))
    st = len(stopsets[-1]); okst = 100 <= st <= 120
    if not okst: fails.append((i, "stop count 100-120", "", st))
    print(f"stop count {st} (100–120): {'ok' if okst else 'FAIL'}")
    # alerts on 2026-10-28 (hot alerts + Jarrad-check alerts incl. possible_stop/haiku_unsure, opportunity deduped)
    def alerted(r):
        st_ = r.get("steps") or []
        return any(s.get("kind") == "alert" and not s.get("whenTimeOnlyOff") for s in st_) or r.get("opp")
    d28 = [r for r in rows if data[r["id"]]["created_at"].startswith("2026-10-28")]
    print(f"alerts total {sum(map(alerted, rows))} (v7 174 ±10%); on 2026-10-28 {sum(map(alerted, d28))} (v7 149 ±10%)")
inter = set.intersection(*stopsets); union = set.union(*stopsets)
print(f"\nstop-set identical across runs: {'YES' if inter == union else 'NO'} (|∩|={len(inter)} |∪|={len(union)}; differing {len(union - inter)})")
if inter != union: fails.append(("all", "stop set identical", len(inter), len(union)))
print("\nREPLAY VERDICT:", "PASS" if not fails else f"FAIL {fails}")
