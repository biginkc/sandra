"""Score the Haiku 4-arm A/B (haiku-ab.test.ts). Usage: score_ab.py <ab.jsonl> <results_v7.json>"""
import collections, json, sys

V7C = dict(not_interested_drip=783, book_appointment=242, price_check=186, wrong_number_close=109, stop=107, ALERT_call_me=93,
           listed_drip=35, who_reply_drip=35, maybe_later_drip=27, ALERT_haiku_unsure=26, which_property_reply=22, vacant_land_drip=19,
           ALERT_commercial=17, ALERT_reason_to_sell=10, location_reply=10, text_only_reply=9, confirmed_owner_drip=4, ALERT_land_price=3,
           ALERT_said_theyll_call=2, how_it_works_reply=2, bad_number=1, **{"reaction+book_appointment": 7, "driving_reply+book_appointment": 3})
def norm(o):
    if o.startswith("price_check:"): return "price_check"
    if o == "possible_stop": return "stop"
    if o == "haiku_unsure": return "ALERT_haiku_unsure"
    return o
lines = open(sys.argv[1]).read().splitlines(); sha = lines[0]
rows = [json.loads(l) for l in lines[1:] if l]
v7 = json.load(open(sys.argv[2]))
print(sha)
summary = {}
for arm in sorted({r["arm"] for r in rows}):
    R = [r for r in rows if r["arm"] == arm]
    H = [r for r in R if r.get("haiku")]
    err = [r for r in H if r.get("finalBy") == "haiku_failed"]
    unsure = [r for r in H if r.get("finalBy") in ("jev_haiku_unsure", "haiku_unsure")]
    strict_bad = [r for r in H if r["haiku"].get("strictOk") is False]
    cost = sum(r["haiku"]["cost"] or 0 for r in H)
    lat = sorted(r["haiku"]["ms"] for r in H)
    p95 = lat[int(.95 * len(lat))] if lat else None
    out_tok = sum(r["haiku"]["out"] or 0 for r in H) / max(1, len(H))
    print(f"\n=== ARM {arm}: haiku calls {len(H)}  errors {len(err)} {dict(collections.Counter(r['haiku']['reason'] for r in err))}  pre-A-3-strict-parser rejects {len(strict_bad)}")
    print(f"  unsure share {len(unsure)}/{len(H)} = {100*len(unsure)/max(1,len(H)):.1f}% (gate <=20%)  needs_person {sum(1 for r in H if r['haiku']['option']=='needs_person')}  cost ${cost:.4f}  p95 {p95} ms  avg out tokens {out_tok:.0f}")
    for src in ("replay", "pack"):
        HS = [r for r in H if r["src"] == src]
        US = [r for r in HS if r.get("finalBy") in ("jev_haiku_unsure", "haiku_unsure")]
        print(f"  {src}: haiku {len(HS)} unsure {len(US)} ({100*len(US)/max(1,len(HS)):.1f}%)")
    reps = sorted({r["rep"] for r in R if r["src"] == "replay"})
    stopsets, callme, drift_fail, agree = [], [], [], []
    for rep in reps:
        RR = [r for r in R if r["src"] == "replay" and r["rep"] == rep]
        c = collections.Counter(norm(r["outcome"]) for r in RR)
        fails = [(k, V7C.get(k, 0), c.get(k, 0)) for k in set(V7C) | set(c) if abs(c.get(k, 0) - V7C.get(k, 0)) > max(0.10 * V7C.get(k, 0), 3)]
        drift_fail.append(fails)
        callme.append(c.get("ALERT_call_me", 0))
        stopsets.append({r["key"] for r in RR if norm(r["outcome"]) == "stop"})
        hk = [r for r in RR if r.get("haiku")]
        agree.append(sum(1 for r in hk if norm(r["outcome"]) == norm(v7[r["key"].split(":", 1)[1]]["road"])) / max(1, len(hk)))
        print(f"  replay rep{rep}: n={len(RR)} call_me {c.get('ALERT_call_me',0)} (93 ±5% = 88–98) haiku_unsure {c.get('ALERT_haiku_unsure',0)} haiku_error {c.get('haiku_error',0)} stop {c.get('stop',0)}  Haiku-row agreement with v7 road {100*agree[-1]:.1f}%")
        print(f"     drift FAILS (±10%, min ±3): {sorted(fails)}")
    inter = set.intersection(*stopsets) if stopsets else set(); union = set.union(*stopsets) if stopsets else set()
    print(f"  stop set across reps ∩{len(inter)} / ∪{len(union)}")
    pk = [r for r in R if r["src"] == "pack"]
    summary[arm] = dict(calls=len(H), errors=len(err), unsure=100 * len(unsure) / max(1, len(H)), callme=callme, drift=[len(f) for f in drift_fail],
                        stop=(len(inter), len(union)), cost=cost, agree=[round(100 * a, 1) for a in agree], p95=p95)
print("\nSUMMARY", json.dumps(summary))
