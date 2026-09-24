#!/usr/bin/env python3
"""The rejection ledger, made mechanical.

Every pattern that has cost a previous project a rejection is a check here,
walked over the SOURCE AS SYNTAX (never grepped: the contract's own comments
mention `str.replace()` and `raise` in order to warn about them), plus checks
that EXECUTE the pure half of the contract, and the checks that tie the
repository to the chain: the sha256 of the contract file must equal what
deployments.json recorded at deploy time, and - with --onchain - the code
read back from the deployed address must equal the file byte for byte.

    python3 tools/audit.py              # exit 1 on any failure
    python3 tools/audit.py --onchain    # also read the code off Studio Dev
"""

import ast
import hashlib
import json
import subprocess
import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "contracts" / "PoolRisk.py"
SRC = SOURCE.read_text(encoding="utf8")
TREE = ast.parse(SRC)
DEP = json.loads((ROOT / "deployments.json").read_text())["deployments"]["studiodev"] \
    if (ROOT / "deployments.json").exists() else {}

results = []


def check(n, name, ok, detail=""):
    results.append((n, name, bool(ok), detail))


def cls(name):
    return [n for n in TREE.body if isinstance(n, ast.ClassDef) and n.name == name][0]


def methods(name):
    return {f.name: f for f in cls(name).body if isinstance(f, ast.FunctionDef)}


def fn(name):
    return [n for n in TREE.body if isinstance(n, ast.FunctionDef) and n.name == name][0]


def decos(f):
    return [ast.unparse(d) for d in f.decorator_list]


def text(f):
    return ast.unparse(f)


def const(name):
    node = [n for n in TREE.body if isinstance(n, ast.Assign)
            and getattr(n.targets[0], "id", "") == name][0]
    return ast.literal_eval(node.value)


# The pure half of the contract (everything before the first class), executed
# against an inert `genlayer` module. Nothing in that half touches storage.
_stub = types.ModuleType("genlayer")
_stub.gl = types.SimpleNamespace()
_names = ["Address", "u8", "u16", "u32", "u64", "u128", "u256", "i32", "i64", "bigint"]
for _n in _names:
    setattr(_stub, _n, str if _n == "Address" else int)
_stub.__all__ = _names
sys.modules.setdefault("genlayer", _stub)
_pure_tree = ast.parse(SRC)
_cut = next(i for i, n in enumerate(_pure_tree.body) if isinstance(n, ast.ClassDef))
_pure_tree.body = _pure_tree.body[:_cut]
P = types.ModuleType("poolrisk_pure")
exec(compile(_pure_tree, str(SOURCE), "exec"), P.__dict__)

M = methods("PoolRisk")
W = {k: f for k, f in M.items() if any(d.startswith("gl.public.write") for d in decos(f))}
V = {k: f for k, f in M.items() if "gl.public.view" in decos(f)}
VEC = list(P.VECTOR_STRS) + list(P.VECTOR_INTS) + list(P.VECTOR_BOOLS)
SCAN_FIELDS = [s.target.id for s in cls("Scan").body if isinstance(s, ast.AnnAssign)]


def blank(**kw):
    ev = P._blank_ev()
    ev.update({"bs_state": "OK", "ll_state": "OK", "verified": True, "created_ts": 10 ** 9,
               "window_n": 30, "window_unique": 20, "top_legs": 5, "window_oldest_ts": 10 ** 9,
               "window_end_ts": 10 ** 9 + 3600, "tvl_usd": 5 * 10 ** 7, "tvl_7d_usd": 5 * 10 ** 7,
               "apy_cp": 800, "snap_day": "2026-09-23", "owner_state": "NONE"})
    ev.update(kw)
    return ev


FACTS = {"pool_id": 1, "pool_address": "0x" + "5" * 40, "chain": "ethereum",
         "llama_id": "12345678-1234-1234-1234-1234567890ab", "now": 1790230445}

# 1 consensus binds every stored value
ws = text(M["_write_scan"])
check(1, "consensus binds every stored value: every Scan field is written from re-derived d[...]",
      "out.get(" not in ws and all("d['" + f + "']" in ws for f in SCAN_FIELDS
                                   if f not in ("scan_id", "pool_id")),
      ", ".join(f for f in SCAN_FIELDS if f not in ("scan_id", "pool_id") and "d['" + f + "']" not in ws))
check(2, "every stored Scan field is on the compared vector (or is the id / the composed reason)",
      all(f in VEC or f in ("scan_id", "reason") for f in SCAN_FIELDS),
      ", ".join(f for f in SCAN_FIELDS if f not in VEC and f not in ("scan_id", "reason")))
# 3 leader can't forge
coh = text(fn("_coherent"))
check(3, "leader cannot forge: _coherent re-derives from evidence + penalty and compares every field",
      "_derive(" in coh and "VECTOR_STRS" in coh and "VECTOR_INTS" in coh and "VECTOR_BOOLS" in coh
      and "_clean_ev(ev) != ev" in coh and "'reason'" in coh)
honest = P._ok(P._derive(FACTS, blank(), 0))
forged = []
for k in VEC:
    d = dict(honest)
    v = d[k]
    d[k] = (not v) if isinstance(v, bool) else (v + 1 if isinstance(v, int) else str(v) + "x")
    if P._coherent(d, FACTS):
        forged.append(k)
check(4, "a forgery of ANY single compared field is refused by _coherent (executed, all fields)",
      not forged and P._coherent(honest, FACTS), ", ".join(forged) + " " + str(len(VEC)) + " fields")
# 5 full vector
agr = text(fn("_agrees"))
check(5, "validators compare the FULL feature vector exactly, not just the verdict",
      len(VEC) >= 50 and all(k in agr for k in ("VECTOR_STRS", "VECTOR_INTS", "VECTOR_BOOLS"))
      and "TOLER" not in agr and "abs(" not in agr, str(len(VEC)) + " fields")
brief = ("blockscout_hash", "llama_hash", "age_score", "verification_score", "tvl_score",
         "stability_score", "activity_score", "concentration_score", "apy_score",
         "rug_flags_csv", "pool_identified")
check(6, "every field the brief names is on the compared axis",
      all(b in VEC for b in brief), ", ".join(b for b in brief if b not in VEC))
# 7 zero raise
raises = [n.lineno for n in ast.walk(TREE) if isinstance(n, ast.Raise)]
check(7, "zero raise statements", not raises, str(raises))
payable = sorted(k for k, f in W.items() if any(d.endswith("payable") for d in decos(f)))
check(8, "zero payable methods (no fee, no stake: a public good)", payable == [], ", ".join(payable))


def _first(f):
    body = f.body
    if isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant):
        body = body[1:]
    return ast.unparse(body[0])


check(9, "no trapped value: each write's first statement books incoming value to its sender (_bank)",
      all("self._bank()" in _first(f) for f in W.values()) and "refunds" not in text(M["_refuse"]))
bad = []
for name, f in W.items():
    ev = []
    for sub in ast.walk(f):
        if isinstance(sub, ast.Assign):
            for t in sub.targets:
                tx = ast.unparse(t)
                if tx.startswith(("self.total_", "self.last_request_at", "self.by_key", "p.")):
                    ev.append((sub.lineno, "c"))
        if isinstance(sub, ast.Call) and ast.unparse(sub.func) in ("self.pools.append_new_get",
                                                                   "self._run_scan"):
            ev.append((sub.lineno, "c"))
        if isinstance(sub, ast.Return) and sub.value is not None and "_refuse" in ast.unparse(sub.value):
            ev.append((sub.lineno, "r"))
    ev.sort()
    seen = False
    for _, k in ev:
        if k == "c":
            seen = True
        elif seen:
            bad.append(name)
            break
check(10, "no counter, register entry, rate-limit stamp or pool write before a refusal",
      not bad, ", ".join(bad))
chf = text(fn("_content_hash"))
check(11, "content hash present: hash(pool + chain + listing + blockscout_hash + llama_hash + rubric)",
      all(s in chf for s in ("pool_address", "chain", "llama_id", "bs_hash", "ll_hash", "RUBRIC_VERSION"))
      and "content_hash" in P.VECTOR_STRS and "content_hash" in SCAN_FIELDS)
ss = text(W["settle_stalled"])
check(12, "settle_stalled exists, is permissionless and works while paused",
      "paused" not in ss and "sender_address" not in ss and "owner" not in ss and "_gate" not in ss)
paused_readers = sorted({k for k, f in M.items() for s in ast.walk(f)
                         if isinstance(s, ast.Attribute) and s.attr == "paused"
                         and isinstance(s.ctx, ast.Load)} - {"get_stats", "get_config"})
check(13, "pause gates only new consensus rounds (_gate is the one reader)", paused_readers == ["_gate"],
      ", ".join(paused_readers))
reps = [n.lineno for n in ast.walk(TREE)
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == "replace"]
check(14, "no str.replace() calls", not reps, str(reps))
# 15 conservative
cons = True
for kw in ({"bs_state": "NOT_FOUND"}, {"bs_state": "NOT_CONTRACT"}, {"bs_state": "INCOMPLETE"},
           {"ll_state": "NO_ID"}, {"ll_state": "NOT_FOUND"}, {"ll_state": "UNMATCHABLE"},
           {"ll_state": "CHAIN_MISMATCH"}, {"ll_state": "ADDRESS_MISMATCH"},
           {"ll_state": "NO_SNAPSHOT"}):
    e = P._clean_ev(blank(**kw))
    d = P._derive(FACTS, e, 0)
    br = P._bracket(e)
    if d["risk_level"] != "INCONCLUSIVE" or d["overall_score"] != 0 or not br["pinned"]:
        cons = False
check(15, "conservative: if EITHER source is unavailable (9 ways) -> INCONCLUSIVE, score 0, no model",
      cons)
check(16, "a source that answers 5xx / 429 / garbage fails the round instead of entering the vector",
      P.TRANSIENT_STATUS == (401, 403, 408, 425, 429) and "status >= 500" in text(fn("_fetch"))
      and "retry" in text(fn("_collect")))
check(17, "no trapped funds: claim_refund pays every banked wei; balance == refundable published",
      "claim_refund" in W and "booked == refundable" in text(V["get_stats"])
      and "claim_refund" not in paused_readers)
callers = sorted({f.name for f in ast.walk(TREE) if isinstance(f, ast.FunctionDef)
                  for s in ast.walk(f) if isinstance(s, ast.Call) and isinstance(s.func, ast.Attribute)
                  and s.func.attr == "emit_transfer"})
check(18, "value leaves only through _pay (emit_transfer on gl.chain.Account)", callers == ["_pay"])
leaks = [k for k, f in M.items() for inner in ast.walk(f)
         if isinstance(inner, (ast.FunctionDef, ast.Lambda)) and inner is not f
         and "self" in {n.id for n in ast.walk(inner) if isinstance(n, ast.Name)}]
check(19, "nondet closures capture no storage (no `self`)", not leaks, ", ".join(leaks))
lines = SRC.split("\n")
check(20, "v0.6 header: '# v0.3.0' then the pinned Depends line, then imports",
      lines[0] == "# v0.3.0" and lines[1].startswith('# { "Depends": "py-genlayer:')
      and lines[2] == "import genlayer as gl" and lines[3] == "from genlayer import *")
check(21, "runner hash pinned (no :test / :latest)",
      "py-genlayer:test" not in SRC and "py-genlayer:latest" not in SRC
      and len(lines[1]) == len('# { "Depends": "py-genlayer:') + 52 + len('" }'))
bare = [n.lineno for n in ast.walk(TREE) if isinstance(n, ast.Name) and n.id in ("TreeMap", "DynArray")]
check(22, "class PoolRisk(gl.contract.Contract); storage only via gl.storage.* (no bare TreeMap)",
      "class PoolRisk(gl.contract.Contract)" in SRC and "@gl.storage.allow" in SRC and not bare,
      str(bare))
check(23, "time from gl.message.raw datetime (no block.timestamp), read once before consensus",
      'gl.message.raw.get("datetime"' in SRC and "'now': int(now)" in text(M["_facts"]))
# 24 model bounded
fj = text(fn("_prompt"))
calls = [f.name for f in ast.walk(TREE) if isinstance(f, ast.FunctionDef)
         for s in ast.walk(f) if isinstance(s, ast.Call) and ast.unparse(s.func) == "gl.nondet.exec_prompt"]
widths = set()
for top in range(0, 101):
    e = P._clean_ev(blank(window_n=100, top_legs=top))
    a = P._bracket(e)["allowed"]
    widths.add((len(a), a[-1] - a[0], a[-1] <= P.MAX_PENALTY))
check(24, "the model controls at most 3 of 100 points: one integer, two adjacent choices, weight 10%",
      calls == ["_collect"] and P.MAX_PENALTY == 3 and dict(P.WEIGHTS)["concentration"] == 10
      and widths == {(2, 1, True)} and "score" not in fj.split("Choose the concentration penalty")[1]
      .split("You may ONLY")[0].lower().replace("penalty", ""),
      str(widths))
check(25, "weights match the brief (15/20/20/15/10/10/10) and sum to 100",
      dict(P.WEIGHTS) == {"age": 15, "verification": 20, "tvl": 20, "stability": 15,
                          "activity": 10, "concentration": 10, "apy_risk": 10})
ladders_ok = (
    [P._age_score(d) for d in (6, 7, 29, 30, 89, 90, 179, 180, 364, 365)] == [0, 2, 2, 4, 4, 6, 6, 8, 8, 10]
    and [P._tvl_score(v) for v in (9999, 10000, 99999, 100000, 999999, 10 ** 6, 10 ** 7, 10 ** 8)]
    == [0, 2, 2, 4, 4, 6, 8, 10]
    and [P._stability_score(True, b) for b in (-5001, -5000, -2000, -500, 500, 501, 2001)]
    == [0, 2, 4, 6, 6, 8, 10]
    and [P._apy_score(c) for c in (100001, 100000, 10000, 5000, 2000, 500)] == [0, 2, 4, 6, 8, 10]
    and [P._verification_score(*a) for a in ((False, False, "NONE"), (True, True, "NONE"),
                                             (True, False, "OWNED"), (True, False, "NONE"))]
    == [0, 4, 8, 10])
check(26, "bucket boundaries match the brief (age, verification, TVL, stability, APY)", ladders_ok)
check(27, "risk levels match the brief (80 SAFE_POOL / 60 MODERATE / 40 HIGH_RISK / else RUG_WARNING)",
      [P._level(x) for x in (80, 79, 60, 59, 40, 39)]
      == ["SAFE_POOL", "MODERATE", "MODERATE", "HIGH_RISK", "HIGH_RISK", "RUG_WARNING"])
check(28, "the seven rug flags of the brief, deterministic, sorted",
      sorted(P.RUG_FLAGS) == sorted(["UNVERIFIED_SOURCE", "PROXY_CONTRACT", "VERY_NEW", "TVL_CRASH",
                                     "EXTREME_APY", "LOW_TVL", "LOW_ACTIVITY"])
      and "exec_prompt" not in text(fn("_flags")) and "out.sort()" in text(fn("_flags")))
check(29, "chain allowlist: ethereum, arbitrum, base, polygon on Blockscout",
      P.CHAIN_NAMES == ("ethereum", "arbitrum", "base", "polygon")
      and all(c[1].endswith(".blockscout.com") for c in P.CHAINS))
gate = text(M["_gate"])
check(30, "one scan per wallet per cooldown (scan_pool and rescan_pool), stamped after the last refusal",
      "last_request_at" in gate and "cooldown_s" in gate
      and "last_request_at[" in text(W["scan_pool"]) and "last_request_at[" in text(W["rescan_pool"]))
check(31, "address and listing validated: junk, zero address and non-UUID listing ids are refused",
      P._norm_addr("0x123") == "" and P._norm_addr("0x" + "g" * 40) == ""
      and "ZERO_ADDR" in text(W["scan_pool"]) and P._norm_uuid("not-a-uuid") == ""
      and P._norm_uuid("665dc8bc-c79d-4800-97f7-304bf368e547") != "")
check(32, "only burst-tolerant endpoints: no legacy /api?module=, no ?limit=, no lifetime counters",
      "/api?module=" not in SRC.split("CHAINS = (")[1] and "limit=" not in "".join(
          s.value for s in ast.walk(TREE) if isinstance(s, ast.Constant) and isinstance(s.value, str)
          and s.value.startswith(("/", "?", "&")))
      and '"/counters"' not in SRC)
check(33, "pinned data: the window sits before a grid-pinned block; TVL/APY from a completed day",
      "block_number=" in text(fn("_gather_contract")) and "_pin_block(" in text(fn("_gather_contract"))
      and "ts >= day0" in text(fn("_read_chart")))
d = P._ok(P._derive(FACTS, blank(), 0))
check(34, "no float crosses the consensus boundary", not any(isinstance(v, float) for v in d.values()))
vs = text(V["verify_score"])
check(35, "verify_score recomputes every derived field and all four hashes from storage",
      "_derive(" in vs and all(k in vs for k in ("overall_score", "risk_level", "rug_flags_csv",
                                                  "blockscout_hash", "llama_hash", "facts_hash",
                                                  "content_hash", "concentration_score")))
need_w = ("scan_pool", "rescan_pool", "settle_stalled")
need_v = ("get_pool", "get_pool_by_address", "get_pools_by_chain", "get_risky_pools", "get_stats",
          "get_config", "verify_score", "get_risk_history")
check(36, "every method the brief names exists", all(m in W for m in need_w) and all(m in V for m in need_v))
check(37, "owner has no withdraw/sweep/edit/score-setting method",
      not any(k in M for k in ("withdraw", "sweep", "rescue", "drain", "set_score", "set_weights",
                               "edit_scan", "delete_pool", "set_level")))
# 38-40: the repository and the chain
sha = hashlib.sha256(SOURCE.read_bytes()).hexdigest()
check(38, "source == deployed byte-for-byte (sha256 recorded at deploy, canonical + demo)",
      DEP.get("PoolRisk", {}).get("source_sha256") == sha
      and DEP.get("PoolRiskDemo", {}).get("source_sha256") == sha, sha[:16])
check(39, "canonical instance enforces the brief (120s per wallet); demo is the same bytes",
      DEP.get("PoolRisk", {}).get("cooldown_s") == 120
      and DEP.get("PoolRisk", {}).get("payable_methods") == 0
      and DEP.get("PoolRiskDemo", {}).get("source_bytes") == len(SOURCE.read_bytes()))
try:
    log = subprocess.run(["git", "log", "--format=%B"], cwd=ROOT, capture_output=True, text=True).stdout
except Exception:
    log = ""
check(40, "no AI attribution trailers in any commit message",
      not any(s in log.lower() for s in ("co-authored-by", "generated with", "claude-session")))
if "--onchain" in sys.argv:
    got = subprocess.run(["node", str(ROOT / "test" / "code_parity.mjs")], cwd=ROOT / "test",
                         capture_output=True, text=True)
    check(41, "code read back from BOTH deployed addresses == contracts/PoolRisk.py",
          got.returncode == 0, (got.stdout + got.stderr).strip()[-200:])

width = max(len(r[1]) for r in results)
for n, name, ok, detail in results:
    print(("  ✔ " if ok else "  ✘ ") + str(n).rjust(2) + "  " + name.ljust(width)
          + ("   " + detail if detail and not ok else ""))
failed = [r for r in results if not r[2]]
print("\n" + str(len(results) - len(failed)) + "/" + str(len(results)) + " checks pass")
sys.exit(1 if failed else 0)
