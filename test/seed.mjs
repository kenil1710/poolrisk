/**
 * Seeds the CANONICAL PoolRisk instance with real pools through real
 * consensus rounds on Studio Dev, then reads every record back and runs
 * verify_score on each.
 *
 *   node seed.mjs [--run=1] [--tries=4]
 *
 * ONLY PROBED POOLS. Every seed below was fetched by a validator first
 * (test/probe.mjs -> docs/probe-results.json) and kept only where Blockscout
 * AND DeFi Llama both answered 200 for every document, with the listing's
 * pool_old pointing back at the pool itself.
 *
 * Each liquidity provider wallet scans one pool (the cooldown is one scan per
 * wallet per 120s). A round that does not settle stores nothing; it is retried
 * with rescan_pool from a wallet whose cooldown has passed - rescans are
 * permissionless.
 *
 * RESUMABLE: pool ids are read back from get_pool_by_address, so a rerun
 * never registers a pool twice (the contract would refuse it anyway).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { connect, fundOnStudio, returnedJson, argOf, sleep, estimateFees } from "./harness.mjs";

const dep = JSON.parse(readFileSync(new URL("../deployments.json", import.meta.url))).deployments.studiodev;
const address = argOf("address", dep.PoolRisk.address);
const run = Number(argOf("run", "1"));
const tries = Number(argOf("tries", "4"));
const plain = (x) => JSON.parse(JSON.stringify(x, (k, v) => (typeof v === "bigint" ? v.toString() : v instanceof Map ? Object.fromEntries(v) : v)));

export const SEEDS = [
  { role: "lp1", chain: "ethereum", address: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640", llama: "665dc8bc-c79d-4800-97f7-304bf368e547", note: "Uniswap V3 USDC/WETH 0.05% (Ethereum)" },
  { role: "lp2", chain: "ethereum", address: "0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7", llama: "25171c4c-1877-449a-9f88-45a9f153ee31", note: "Curve 3pool DAI/USDC/USDT (Ethereum)" },
  { role: "lp3", chain: "arbitrum", address: "0x299c7d6f2ef82cb52b2ab83b14f05c6b2b803aba", llama: "22a4a964-ea4c-4c5e-bdbf-c43342f61f3b", note: "Camelot V3 PEAR/USDC (Arbitrum, smaller)" },
  { role: "lp4", chain: "base", address: "0xe03cce449932219fc0ca28f3a4f784ce55de0c4e", llama: "f7583a03-2f3b-5b32-b87f-f9a9b343af29", note: "Uniswap V3 W0G/USDC (Base, days old)" },
  { role: "lp5", chain: "base", address: "0xdd0c3e440af8678f6f03a9b9c5daa01282c3905b", llama: "ec8b7fe5-f720-5f7d-b967-77231996fe45", note: "Uniswap V2 WETH/BELONG (Base, new + unverified)" },
  { role: "lp6", chain: "base", address: "0xe30d5bf485f7476ac15884a28ffb3c9cea635dcb", llama: "eb27d0be-9de4-4ed9-8d36-a754e18d3358", note: "Aerodrome Slipstream AVNT/USDC (Base, extreme APY)" },
  { role: "lp7", chain: "polygon", address: "0x853ee4b2a13f8a742d64c8f088be7ba2131f670d", llama: "f8adcdd5-71d2-4460-956e-7ccdd53b16fa", note: "QuickSwap USDC/WETH (Polygon)" },
];

const only = (argOf("only", "") || "").split(",").filter(Boolean);
const seeds = only.length ? SEEDS.filter((s) => only.includes(s.role)) : SEEDS;

const log = [];
const note = (line) => { console.log(line); log.push(line); };
const trg = connect({ address, role: "trigger" });
await fundOnStudio(trg.chain, trg.account.address, 100n * 10n ** 18n);
note(`PoolRisk seed run ${run} → ${address}  (${new Date().toISOString()})`);

// Wallets free to send a rescan, with the time each last wrote.
const lastWrite = {};
const retryRoles = ["trigger", "lp8", "outsider"];

async function poolIdOf(s) {
  const r = plain(await trg.view("get_pool_by_address", [s.address, s.chain]));
  return r.found ? r.pool_id : null;
}

async function feesFor() {
  // The GENERIC estimate: a simulated scan would fetch every document again,
  // and no PoolRisk write posts a transfer.
  return estimateFees(trg.wallet, "fee");
}

async function scanOnce(s) {
  const existing = await poolIdOf(s);
  if (existing) {
    note(`already registered ${s.note} as pool #${existing}`);
    return existing;
  }
  const c = connect({ address, role: s.role });
  await fundOnStudio(c.chain, c.account.address, 20n * 10n ** 18n);
  const out = await c.send("scan_pool", [s.address, s.chain, s.llama], 0n, { fees: await feesFor() });
  lastWrite[s.role] = Date.now();
  const ret = returnedJson(out);
  await sleep(10_000);
  const pid = ret?.pool_id ?? (await poolIdOf(s));
  note(`scan_pool ${s.chain} ${s.address} by ${s.role}: ${out.status} ${out.seconds.toFixed(0)}s tx ${out.hash} → pool #${pid ?? "?"} ${ret ? JSON.stringify(ret) : "(return unreadable)"}`);
  return pid;
}

async function nextRetryRole() {
  for (;;) {
    for (const r of retryRoles) {
      if (!lastWrite[r] || Date.now() - lastWrite[r] > 125_000) return r;
    }
    await sleep(5_000);
  }
}

async function settle(pid, s) {
  for (let i = 1; i <= tries; i++) {
    const p = plain(await trg.view("get_pool", [pid]));
    if (p.status !== "PENDING") return p;
    const role = await nextRetryRole();
    const c = connect({ address, role });
    await fundOnStudio(c.chain, c.account.address, 20n * 10n ** 18n);
    const out = await c.send("rescan_pool", [pid], 0n, { fees: await feesFor() });
    lastWrite[role] = Date.now();
    const ret = returnedJson(out);
    note(`  rescan_pool(${pid}) try ${i} by ${role}: ${out.status} ${out.seconds.toFixed(0)}s tx ${out.hash} → ${ret ? JSON.stringify(ret) : "(return unreadable)"}`);
    await sleep(10_000);
  }
  return plain(await trg.view("get_pool", [pid]));
}

const results = {};
for (const s of seeds) {
  note(`\n== ${s.note}`);
  let pid = await scanOnce(s);
  if (!pid) {
    // The registering write itself never landed (an UNDETERMINED round
    // stores nothing, not even the registration). Try once more.
    await sleep(15_000);
    pid = await scanOnce(s);
  }
  if (!pid) { note(`  NOT REGISTERED`); continue; }
  const p = await settle(pid, s);
  const v = plain(await trg.view("verify_score", [pid]));
  results[s.role] = { seed: s, pool: p, verified: v.verified === true };
  const l = p.latest ?? {};
  note(`  #${pid} ${p.status} ${l.risk_level ?? "-"} ${l.overall_score ?? "-"}/100 flags [${(l.rug_flags ?? []).join(",")}] verify ${v.verified}`);
  if (l.scores) note(`  scores ${JSON.stringify(l.scores)}`);
  if (l.concentration) note(`  concentration ${JSON.stringify(l.concentration)}`);
  if (l.reason) note(`  reason: ${l.reason}`);
  if (l.content_hash) note(`  hashes: content ${l.content_hash} blockscout ${l.blockscout_hash} llama ${l.llama_hash}`);
  writeFileSync(new URL(`../docs/seed-run${run}-evidence.json`, import.meta.url), JSON.stringify({ address, run, results }, null, 1) + "\n");
}

const stats = plain(await trg.view("get_stats", []));
note(`\nstats: ${JSON.stringify(stats)}`);
writeFileSync(new URL(`../docs/seed-run${run}-evidence.json`, import.meta.url), JSON.stringify({ address, run, results, stats }, null, 1) + "\n");
writeFileSync(new URL(`../docs/seed-run${run}.log`, import.meta.url), log.join("\n") + "\n");
note(`wrote docs/seed-run${run}.log and docs/seed-run${run}-evidence.json`);
