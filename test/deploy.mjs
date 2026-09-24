/**
 * Deploys PoolRisk to Studio Dev (chain 61997).
 *
 *   node deploy.mjs            # canonical instance (the brief: 120s cooldown, 1h stall)
 *   node deploy.mjs --demo     # demo instance, SAME BYTES: no cooldown, 60s stall
 *   node deploy.mjs --both
 *
 * WHY A DEMO INSTANCE. settle_stalled is only callable an hour after a pool
 * is registered on the canonical instance, which cannot be watched in one sitting.
 * A path nobody has watched execute is a path nobody has tested, so the same
 * source is deployed with the constructor's clocks shortened. Every rule,
 * gate and line of consensus is identical; `tools/audit.py` checks that both
 * records carry the same sha256 as contracts/PoolRisk.py.
 *
 * Every deploy estimates its fee first and the record is persisted after EACH
 * contract, so a partial failure never loses a live address.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { createClient, createAccount } from "genlayer-js";
import { CHAINS, argOf, accounts, fundOnStudio, deploy, gen } from "./harness.mjs";

const networkName = argOf("network", "studiodev");
const chain = CHAINS[networkName];
const both = process.argv.includes("--both");
const demoOnly = process.argv.includes("--demo");
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

const acc = accounts();
const account = createAccount(acc.client.key);
const wallet = createClient({ chain, account });
const read = createClient({ chain });

console.log(`\nPoolRisk deploy → ${networkName}`);
console.log(`  signer     ${account.address} (client)`);
await fundOnStudio(chain, account.address, 2000n * 10n ** 18n);
console.log(`  balance    ${gen(await read.getBalance({ address: account.address }))} GEN`);

const path = new URL("../deployments.json", import.meta.url);
const doc = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
doc.deployments = doc.deployments || {};
const record = doc.deployments[networkName] || { network: networkName, chain_id: chain.id };
function persist() {
  record.explorer = "https://explorer-studio-dev.genlayer.com/";
  doc.deployments[networkName] = record;
  writeFileSync(path, JSON.stringify(doc, null, 2) + "\n");
}

const code = readFileSync(new URL("../contracts/PoolRisk.py", import.meta.url));
const rubric = String(code).match(/^RUBRIC_VERSION\s*=\s*"([^"]+)"/m)[1];
if (!/^# v0\.3\.0\n# \{ "Depends": "py-genlayer:[0-9a-z]{52}" \}\n/.test(String(code))) {
  console.error("refusing to deploy: the two-line runner header is not the first thing in the file");
  process.exit(1);
}

// (cooldown_s, stall_ttl_s) — both immutable after deploy.
const VARIANTS = {
  PoolRisk: { label: "canonical (the brief: one scan per wallet per 120s, 1h stall)", args: [120, 3600] },
  PoolRiskDemo: { label: "demo (same source: no cooldown, 60s stall)", args: [0, 60] },
};
const wanted = both ? ["PoolRisk", "PoolRiskDemo"] : demoOnly ? ["PoolRiskDemo"] : ["PoolRisk"];

for (const name of wanted) {
  const { label, args } = VARIANTS[name];
  console.log(`\n  ${name}  ${label}`);
  console.log(`  source     contracts/PoolRisk.py (${code.length.toLocaleString()} bytes, sha256 ${sha256(code).slice(0, 16)}…)`);
  const res = await deploy({ chain, wallet, read, code, args, label: `${name} deploy` });
  if (!res.ok) {
    console.error(`\n${name} deploy FAILED: ${res.out?.status} ${res.reason ?? ""} ${res.out?.revertReason ?? ""}`);
    console.error((res.out?.stderr ?? "").split("\n").slice(-25).join("\n"));
    persist();
    process.exit(1);
  }
  console.log(`  address    ${res.address}`);
  record[name] = {
    address: res.address,
    deploy_tx: res.hash,
    source_bytes: code.length,
    source_sha256: sha256(code),
    owner: account.address,
    rubric_version: rubric,
    cooldown_s: args[0],
    stall_ttl_s: args[1],
    payable_methods: 0,
    deployed_at: new Date().toISOString(),
  };
  persist();
}
console.log(`\nwrote deployments.json`);
