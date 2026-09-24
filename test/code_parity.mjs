/**
 * Proves the code AT EACH DEPLOYED ADDRESS is contracts/PoolRisk.py, byte for
 * byte. Reads gen_getContractCode off Studio Dev for every address in
 * deployments.json and compares sha256 against the file in the repository.
 *
 *   node code_parity.mjs          # exit 0 only if every address matches
 *
 * PolicyGate was rejected for a deployment one commit behind its source, with
 * the divergence documented. Documenting a difference does not make it not a
 * difference; this is the check that would have caught it.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createClient } from "genlayer-js";
import { CHAINS, retry } from "./harness.mjs";

const sha = (s) => createHash("sha256").update(s).digest("hex");
const file = readFileSync(new URL("../contracts/PoolRisk.py", import.meta.url));
const dep = JSON.parse(readFileSync(new URL("../deployments.json", import.meta.url))).deployments.studiodev;
const client = createClient({ chain: CHAINS.studiodev });

let bad = 0;
for (const name of ["PoolRisk", "PoolRiskDemo"]) {
  const addr = dep[name]?.address;
  if (!addr) { console.log(`${name}: no address`); bad++; continue; }
  const code = await retry(() => client.getContractCode(addr), { label: `${name} code` });
  const same = sha(Buffer.from(code, "utf8")) === sha(file);
  console.log(`${name} ${addr}: ${same ? "MATCH" : "DIFFER"}  chain ${sha(Buffer.from(code, "utf8")).slice(0, 16)}  file ${sha(file).slice(0, 16)}  (${code.length} / ${file.length} bytes)`);
  if (!same) bad++;
}
process.exit(bad ? 1 : 0);
