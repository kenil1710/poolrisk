# v0.3.0
# { "Depends": "py-genlayer:5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng" }
import genlayer as gl
from genlayer import *

import json

# Throwaway diagnostic, NOT part of PoolRisk. It answers the question the
# whole project stands on: what does a VALIDATOR get back when it asks
# Blockscout and DeFi Llama for a pool's documents? Status, size and shape of
# every document PoolRisk reads, fetched from validator egress rather than
# from a laptop. Only pools where BOTH sources answer here are seeded.


class Probe(gl.contract.Contract):
    results: gl.storage.TreeMap[str, str]

    def __init__(self):
        pass

    @gl.public.write
    def probe(self, label: str, requests_json: str) -> None:
        reqs = json.loads(str(requests_json))

        def leader_fn() -> str:
            out = []
            for r in reqs:
                url = str(r.get("url", ""))
                post = str(r.get("post", ""))
                row = {"url": url, "post": post != ""}
                try:
                    if post != "":
                        res = gl.nondet.web.request(
                            url, method="POST", body=post,
                            headers={"Content-Type": "application/json"})
                    else:
                        res = gl.nondet.web.request(url, method="GET")
                    st = getattr(res, "status_code", None)
                    if st is None:
                        st = getattr(res, "status", 0)
                    body = getattr(res, "body", b"")
                    if isinstance(body, bytes):
                        body = body.decode("utf-8", errors="ignore")
                    body = str(body)
                    row["status"] = int(st)
                    row["bytes"] = len(body)
                    row["head"] = body[:240]
                    try:
                        doc = json.loads(body)
                        if isinstance(doc, dict):
                            row["shape"] = "dict{" + ",".join(
                                sorted([str(k) for k in doc.keys()])[:40]) + "}"
                        elif isinstance(doc, list):
                            row["shape"] = "list[" + str(len(doc)) + "]"
                        else:
                            row["shape"] = type(doc).__name__
                    except Exception:
                        row["shape"] = "not json"
                except Exception as e:
                    row["status"] = -1
                    row["error"] = str(e)[:300]
                out.append(row)
            return json.dumps(out)

        def validator_fn(leader_result) -> bool:
            return isinstance(leader_result, gl.vm.Return)

        self.results[str(label)] = gl.vm.run_nondet(leader_fn, validator_fn)

    @gl.public.view
    def get(self, label: str) -> str:
        return self.results.get(str(label)) or ""
