#!/usr/bin/env python3
"""Run the contract's OWN extraction and scoring code against the live sources,
off chain. Stdlib only.

    python3 tools/local_scan.py <chain> <pool_address> <llama_pool_id> [--save]

It execs the pure half of contracts/PoolRisk.py (everything before the storage
classes) with `gl.nondet.web.request` bound to urllib, then runs `_gather` and
`_derive` exactly as a validator would - with the concentration penalty set to
the LOW end of its bracket, since no model runs here. It is a preview, not a
verdict: the chain's answer is the one that counts.

--save writes every fetched document to test/fixtures/<chain>_<address>/ so the
offline suite can drive the extractors with real bytes (the PackageGuard
lesson: fixtures chosen by the person who wrote the parser hide its bugs).
"""

import ast
import json
import sys
import time
import types
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "contracts" / "PoolRisk.py"

SAVED = {}


class _Res:
    def __init__(self, status, body):
        self.status_code = status
        self.body = body


def _request(url, method="GET", body=None, headers=None):
    data = body.encode() if isinstance(body, str) else body
    req = urllib.request.Request(url, data=data, method=method,
                                 headers=dict(headers or {}, **{"User-Agent": "poolrisk-local/1.0"}))
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            out = _Res(r.status, r.read())
    except urllib.error.HTTPError as e:
        out = _Res(e.code, e.read())
    SAVED[(method, url, body or "")] = out
    return out


def load():
    stub = types.ModuleType("genlayer")
    names = ["Address", "u8", "u16", "u32", "u64", "u128", "u256", "i32", "i64", "bigint"]
    for n in names:
        setattr(stub, n, str if n == "Address" else int)
    stub.__all__ = names
    web = types.SimpleNamespace(request=_request)
    stub.gl = types.SimpleNamespace(nondet=types.SimpleNamespace(web=web))
    sys.modules["genlayer"] = stub
    tree = ast.parse(SOURCE.read_text())
    cut = next(i for i, n in enumerate(tree.body) if isinstance(n, ast.ClassDef))
    tree.body = tree.body[:cut]
    mod = types.ModuleType("poolrisk_pure")
    exec(compile(tree, str(SOURCE), "exec"), mod.__dict__)
    mod.gl = stub.gl
    return mod


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    save = "--save" in sys.argv
    chain, addr = args[0], args[1].lower()
    lid = args[2] if len(args) > 2 else ""
    P = load()
    now = int(time.time())
    facts = {"pool_id": 0, "pool_address": addr, "chain": chain, "llama_id": lid, "now": now}
    t0 = time.time()
    ev, why = P._gather(facts)
    if why:
        print(json.dumps({"transient": why}))
        return 2
    e = P._clean_ev(ev)
    br = P._bracket(e)
    d = P._derive(facts, e, br["allowed"][0])
    d["_bracket"] = br["allowed"]
    d["_seconds"] = round(time.time() - t0, 1)
    print(json.dumps(d, indent=1))
    if save:
        folder = ROOT / "test" / "fixtures" / (chain + "_" + addr)
        folder.mkdir(parents=True, exist_ok=True)
        index = []
        for i, ((method, url, body), res) in enumerate(SAVED.items()):
            name = "%02d.json" % i
            (folder / name).write_bytes(res.body)
            index.append({"file": name, "method": method, "url": url, "body": body,
                          "status": res.status_code})
        (folder / "index.json").write_text(json.dumps({"now": now, "facts": facts, "fetches": index,
                                                       "expected_ev": e}, indent=1) + "\n")
        print("saved", len(index), "documents to", folder.relative_to(ROOT))
    return 0


if __name__ == "__main__":
    sys.exit(main())
