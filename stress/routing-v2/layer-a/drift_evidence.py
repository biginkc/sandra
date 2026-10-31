"""Replay-drift evidence: is the v7 benchmark expectation wrong or the behaviour wrong?
Compares every live replay run to (1) the v7 gate counts and (2) the v8 re-recording (v7 Jev + the
approved v8 Haiku option order, final/report_v8.json), and measures run-to-run spread of the SAME
config. Usage: drift_evidence.py <stress-work dir> <final dir> <ab.jsonl>"""
import collections, json, statistics, sys
W, F, AB = sys.argv[1], sys.argv[2], sys.argv[3]
V8 = {k: v["v8"] for k, v in json.load(open(F + "/report_v8.json"))["roads"].items()}
V7 = {k: v["v7"] for k, v in json.load(open(F + "/report_v8.json"))["roads"].items()}
def norm(o):
    if o.startswith("price_check:"): return "price_check"
    if o == "possible_stop": return "stop"
    if o == "haiku_unsure": return "ALERT_haiku_unsure"
    return o
def counts(rows): return collections.Counter(norm(r["outcome"]) for r in rows)
configs = {}
for head in ("7e6b4c8aa64e", "dbdd5940e032", "64ba15bb65c0", "84eda34d5213", "72229239848d"):
    runs = []
    for i in (1, 2, 3):
        try: runs.append(counts([json.loads(l) for l in open(f"{W}/replay-{i}-{head}.jsonl").read().splitlines()[1:]]))
        except FileNotFoundError: pass
    if runs: configs[f"live@{head}"] = runs
ab = [json.loads(l) for l in open(AB).read().splitlines()[1:]]
for arm in "abcd":
    configs[f"A/B arm {arm}@64ba"] = [counts([r for r in ab if r["arm"] == arm and r["src"] == "replay" and r["rep"] == rep]) for rep in (0, 1)]
roads = sorted(set(V7) | {k for runs in configs.values() for c in runs for k in c}, key=lambda k: -V7.get(k, 0))
tol = lambda base: max(0.10 * base, 3)
print("Benchmark provenance: v7 = v7 Jev + v7 Haiku option list (no text_only/how_it_works options; asked_call after listed).")
print("v8 = SAME v7 Jev answers + the approved v8 Haiku option order (ORDER-TABLE; SELF-APPROVED-TEXT-LOG row 3), one recorded pass, 2026-10-30.\n")
print("v7 vs v8 (same Jev, only the Haiku option list differs): roads outside the gate tolerance:",
      [(k, V7.get(k, 0), V8.get(k, 0)) for k in roads if abs(V8.get(k, 0) - V7.get(k, 0)) > tol(V7.get(k, 0))])
print()
print(f"{'config':26}{'runs':>5}  fails vs v7 (per run)        fails vs v8 (per run)")
for name, runs in configs.items():
    f7 = [sorted(k for k in roads if abs(c.get(k, 0) - V7.get(k, 0)) > tol(V7.get(k, 0))) for c in runs]
    f8 = [sorted(k for k in roads if abs(c.get(k, 0) - V8.get(k, 0)) > tol(V8.get(k, 0))) for c in runs]
    print(f"{name:26}{len(runs):>5}  {[len(x) for x in f7]!s:28} {[len(x) for x in f8]!s}")
    print(f"{'':33}v7 fails: {f7}")
    print(f"{'':33}v8 fails: {f8}")
print("\nRun-to-run spread of the SAME config (max-min across repeats), small roads (<40 in v7):")
small = [k for k in roads if 0 < V7.get(k, 0) < 40 or k in ("how_it_works_reply", "haiku_error")]
print(f"{'road':30}{'v7':>4}{'v8':>4}{'tol':>5}  " + "  ".join(f"{n[:18]:>18}" for n in configs))
for k in small:
    cells = []
    for runs in configs.values():
        vals = [c.get(k, 0) for c in runs]
        cells.append(f"{min(vals)}-{max(vals)}(Δ{max(vals)-min(vals)})")
    print(f"{k:30}{V7.get(k,0):>4}{V8.get(k,0):>4}{tol(V7.get(k,0)):>5.1f}  " + "  ".join(f"{c:>18}" for c in cells))
