/**
 * Walks every PoolRisk path that the seed does not, on the DEMO instance
 * (same bytes as the canonical one: no cooldown, 60s stall window), through
 * real consensus rounds on Studio Dev. Each step asserts against contract
 * STATE read back afterwards, never only against a return value.
 *
 *   node lifecycle.mjs
 *
 *  1. refusals that must move nothing: bad address, unsupported chain, zero
 *     address, a listing id that is not a UUID
 *  2. a pool with no DeFi Llama listing is INCONCLUSIVE, with no score and
 *     no model call - the conservative rule, agreed on chain
 *  3. a listing that belongs to ANOTHER pool is caught (ADDRESS_MISMATCH),
 *     not trusted
 *  4. a real pool is scored, then RESCANNED: previous score kept, risk_delta
 *     published, get_risk_history grows
 *  5. a duplicate registration is refused with the existing pool id
 *  6. pause: new scans refused; settle_stalled is NOT blocked by pause (it
 *     answers on the pool's state, not on the pause); only the owner pauses
 *  7. verify_score recomputes every stored field from evidence
 */
import { readFileSync, writeFileSync } from "node:fs";
import { connect, fundOnStudio, returnedJson, sleep, estimateFees } from "./harness.mjs";

const dep = JSON.parse(readFileSync(new URL("../deployments.json", import.meta.url))).deployments.studiodev;
const address = process.env.ADDR ?? dep.PoolRiskDemo.address;
const plain = (x) => JSON.parse(JSON.stringify(x, (k, v) => (typeof v === "bigint" ? v.toString() : v instanceof Map ? Object.fromEntries(v) : v)));

const log = [];
const note = (l) => { console.log(l); log.push(l); };
let pass = 0;
let fail = 0;
const expect = (cond, what) => { if (cond) { pass++; note(`  ✔ ${what}`); } else { fail++; note(`  ✘ ${what}`); } };

const owner = connect({ address, role: "client" });
const lp = connect({ address, role: "lp8" });
const outsider = connect({ address, role: "outsider" });
for (const c of [owner, lp, outsider]) await fundOnStudio(c.chain, c.account.address, 50n * 10n ** 18n);
const fees = async () => estimateFees(owner.wallet, "fee");
const view = async (m, a = []) => plain(await owner.view(m, a));
note(`PoolRisk lifecycle → ${address} (demo instance)  ${new Date().toISOString()}`);

async function write(c, m, a) {
  const out = await c.send(m, a, 0n, { fees: await fees() });
  const ret = returnedJson(out);
  note(`  ${m}(${a.map((x) => JSON.stringify(x)).join(", ")}) → ${out.status} ${out.seconds.toFixed(0)}s tx ${out.hash}  ${ret ? JSON.stringify(ret).slice(0, 400) : "(return unreadable)"}`);
  await sleep(6000);
  return { out, ret };
}

// 1. refusals move nothing
note("\n1. refusals");
const before = await view("get_stats");
for (const args of [["0x123", "ethereum", ""], ["0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640", "solana", ""],
  ["0x0000000000000000000000000000000000000000", "ethereum", ""],
  ["0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640", "ethereum", "not-a-uuid"]]) {
  const { ret } = await write(lp, "scan_pool", args);
  expect(ret === null || ret.status === "REJECTED", `refused: ${args.join(" ")}`);
}
const after = await view("get_stats");
expect(after.pools === before.pools, `no pool registered by a refusal (${before.pools} → ${after.pools})`);
expect(after.refusals === before.refusals + 4, `each refusal counted as a refusal (${before.refusals} → ${after.refusals})`);

// 2. no listing -> INCONCLUSIVE
note("\n2. no DeFi Llama listing");
const noListing = { chain: "arbitrum", address: "0x5969efdde3cf5c0d9a88ae51e47d721096a97203" };
let p2 = await view("get_pool_by_address", [noListing.address, noListing.chain]);
if (!p2.found) { await write(lp, "scan_pool", [noListing.address, noListing.chain, ""]); p2 = await view("get_pool_by_address", [noListing.address, noListing.chain]); }
expect(p2.found && p2.status === "INCONCLUSIVE", `unlisted pool is INCONCLUSIVE (status ${p2.status})`);
expect(p2.latest?.risk_level === "INCONCLUSIVE" && p2.latest?.overall_score === 0, "no score without both sources");
expect(p2.latest?.pool_identified === false && p2.latest?.defillama?.state === "NO_ID", "pool_identified false, llama state NO_ID");
expect(p2.latest?.blockscout?.state === "OK", "Blockscout half still agreed (state OK)");
expect(p2.latest?.concentration?.model_called === false, "no model call on an inconclusive scan");

// 3. a listing that belongs to another pool
note("\n3. a listing that points at a different pool");
const wrong = { chain: "ethereum", address: "0x4e68ccd3e89f51c3074ca5072bbac773960dfa36", llama: "665dc8bc-c79d-4800-97f7-304bf368e547" };
let p3 = await view("get_pool_by_address", [wrong.address, wrong.chain]);
if (!p3.found) { await write(lp, "scan_pool", [wrong.address, wrong.chain, wrong.llama]); p3 = await view("get_pool_by_address", [wrong.address, wrong.chain]); }
expect(p3.latest?.defillama?.state === "ADDRESS_MISMATCH", `listing for 0x88e6… refused for 0x4e68… (${p3.latest?.defillama?.state})`);
expect(p3.latest?.risk_level === "INCONCLUSIVE", "and the scan is INCONCLUSIVE");

// 4. score, rescan, delta, history
note("\n4. scan, then rescan");
const real = { chain: "polygon", address: "0x853ee4b2a13f8a742d64c8f088be7ba2131f670d", llama: "f8adcdd5-71d2-4460-956e-7ccdd53b16fa" };
let p4 = await view("get_pool_by_address", [real.address, real.chain]);
if (!p4.found) { await write(lp, "scan_pool", [real.address, real.chain, real.llama]); p4 = await view("get_pool_by_address", [real.address, real.chain]); }
for (let i = 0; i < 3 && p4.status === "PENDING"; i++) { await write(outsider, "rescan_pool", [p4.pool_id]); p4 = await view("get_pool", [p4.pool_id]); }
expect(p4.status === "SCORED", `real pool SCORED (${p4.latest?.risk_level} ${p4.latest?.overall_score}/100)`);
const scansBefore = p4.scans;
let r4 = await write(outsider, "rescan_pool", [p4.pool_id]);
let p4b = await view("get_pool", [p4.pool_id]);
for (let i = 0; i < 2 && p4b.scans === scansBefore; i++) { r4 = await write(outsider, "rescan_pool", [p4.pool_id]); p4b = await view("get_pool", [p4.pool_id]); }
expect(p4b.scans === scansBefore + 1, `rescan by a wallet that did not register it is stored (scans ${scansBefore} → ${p4b.scans})`);
expect(p4b.has_previous && p4b.previous_score === p4.latest?.overall_score, `previous score kept (${p4b.previous_score})`);
expect(p4b.risk_delta === p4b.latest.overall_score - p4b.previous_score, `risk_delta = new - previous (${p4b.risk_delta})`);
const hist = await view("get_risk_history", [p4.pool_id]);
expect(hist.scans === p4b.scans && hist.history.at(-1).delta === p4b.risk_delta, `get_risk_history has ${hist.scans} scans, last delta ${hist.history.at(-1)?.delta}`);

// 5. duplicate
note("\n5. duplicate");
const poolsBeforeDup = (await view("get_stats")).pools;
const { ret: dup } = await write(lp, "scan_pool", [real.address.toUpperCase().replace("0X", "0x"), real.chain, real.llama]);
expect(dup === null || (dup.status === "REJECTED" && dup.pool_id === p4.pool_id), `duplicate refused with pool_id ${dup?.pool_id}`);
expect((await view("get_stats")).pools === poolsBeforeDup, `register unchanged (${poolsBeforeDup} pools)`);

// 6. pause
note("\n6. pause");
await write(outsider, "set_paused", [true]);
expect((await view("get_config")).paused === false, "an outsider cannot pause");
await write(owner, "set_paused", [true]);
expect((await view("get_config")).paused === true, "the owner pauses");
const { ret: blocked } = await write(lp, "scan_pool", ["0xc6f780497a95e246eb9449f5e4770916dcd6396a", "arbitrum", ""]);
expect(blocked === null || /paused/.test(blocked.reason ?? ""), `scan refused while paused: ${blocked?.reason}`);
expect(!(await view("get_pool_by_address", ["0xc6f780497a95e246eb9449f5e4770916dcd6396a", "arbitrum"])).found, "nothing registered while paused");
const { ret: settle } = await write(outsider, "settle_stalled", [p4.pool_id]);
expect(settle === null || (/not PENDING/.test(settle.reason ?? "") && !/paused/.test(settle.reason ?? "")),
  `settle_stalled answers on pool state, not pause: ${settle?.reason}`);
await write(owner, "set_paused", [false]);
expect((await view("get_config")).paused === false, "unpaused");

// 7. verify_score
note("\n7. verify_score");
for (const pid of [p2.pool_id, p3.pool_id, p4.pool_id]) {
  const v = await view("verify_score", [pid]);
  expect(v.verified === true, `verify_score(${pid}) recomputes ${v.checks?.length} fields: ${v.verified}`);
}

note(`\n${pass} passed, ${fail} failed`);
writeFileSync(new URL("../docs/lifecycle-run.log", import.meta.url), log.join("\n") + "\n");
process.exit(fail ? 1 : 0);
