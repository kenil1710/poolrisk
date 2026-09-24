/**
 * PROBE FIRST. Deploys contracts/_probe.py to Studio Dev and, for every
 * candidate pool, has a validator fetch every document PoolRisk reads - from
 * validator egress, not from a laptop. Writes docs/probe-results.json.
 *
 *   node probe.mjs [--address=0x..]
 *
 * A candidate is SEEDABLE only if both Blockscout and DeFi Llama answered 200
 * for every document it needs and the DeFi Llama listing points back at the
 * pool's own address on the right chain.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { connect, deploy, fundOnStudio, argOf, estimateFees } from "./harness.mjs";

export const CANDIDATES = [
  { chain: "ethereum", address: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640", llama: "665dc8bc-c79d-4800-97f7-304bf368e547", note: "Uniswap V3 USDC/WETH 0.05% - high TVL" },
  { chain: "ethereum", address: "0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7", llama: "25171c4c-1877-449a-9f88-45a9f153ee31", note: "Curve 3pool DAI/USDC/USDT - stable, high TVL" },
  { chain: "arbitrum", address: "0x299c7d6f2ef82cb52b2ab83b14f05c6b2b803aba", llama: "22a4a964-ea4c-4c5e-bdbf-c43342f61f3b", note: "Camelot V3 PEAR/USDC - smaller Arbitrum pool" },
  { chain: "arbitrum", address: "0x5969efdde3cf5c0d9a88ae51e47d721096a97203", llama: "af3cd3a9-a9b8-483e-82c6-bf4fceb66584", note: "Uniswap V3 WBTC/USDT - mid Arbitrum pool" },
  { chain: "base", address: "0xe03cce449932219fc0ca28f3a4f784ce55de0c4e", llama: "f7583a03-2f3b-5b32-b87f-f9a9b343af29", note: "Uniswap V3 W0G/USDC - days-old Base pool" },
  { chain: "base", address: "0xdd0c3e440af8678f6f03a9b9c5daa01282c3905b", llama: "ec8b7fe5-f720-5f7d-b967-77231996fe45", note: "Uniswap V2 WETH/BELONG - new, unverified Base pair" },
  { chain: "base", address: "0xe30d5bf485f7476ac15884a28ffb3c9cea635dcb", llama: "eb27d0be-9de4-4ed9-8d36-a754e18d3358", note: "Aerodrome Slipstream AVNT/USDC - extreme APY" },
  { chain: "polygon", address: "0x853ee4b2a13f8a742d64c8f088be7ba2131f670d", llama: "f8adcdd5-71d2-4460-956e-7ccdd53b16fa", note: "QuickSwap USDC/WETH - Polygon" },
];

const HOSTS = {
  ethereum: ["https://eth.blockscout.com", "https://ethereum-rpc.publicnode.com", 300, 50],
  arbitrum: ["https://arbitrum.blockscout.com", "https://arbitrum-one-rpc.publicnode.com", 14400, 2400],
  base: ["https://base.blockscout.com", "https://base-rpc.publicnode.com", 1800, 300],
  polygon: ["https://polygon.blockscout.com", "https://polygon-bor-rpc.publicnode.com", 1800, 300],
};

/** The same eight documents PoolRisk._gather reads, with the pin computed
 *  from the explorer's head as seen from here. */
export async function requestsFor(c) {
  const [bs, rpc, grid, lag] = HOSTS[c.chain];
  const head = (await (await fetch(`${bs}/api/v2/main-page/blocks`)).json())[0].height;
  const pin = Math.floor((head - lag) / grid) * grid;
  const addr = await (await fetch(`${bs}/api/v2/addresses/${c.address}`)).json();
  const reqs = [
    { url: `${bs}/api/v2/addresses/${c.address}` },
    { url: `${bs}/api/v2/main-page/blocks` },
    { url: `${bs}/api/v2/blocks/${pin}` },
    { url: `${bs}/api/v2/addresses/${c.address}/token-transfers?block_number=${pin}&index=0` },
  ];
  if (addr.creation_transaction_hash) reqs.push({ url: `${bs}/api/v2/transactions/${addr.creation_transaction_hash}` });
  const call = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: c.address, data: "0x8da5cb5b" }, "latest"] });
  reqs.push({ url: rpc, post: call });
  reqs.push({ url: `${bs}/api/eth-rpc`, post: call });
  if (c.llama) {
    reqs.push({ url: `https://yields.llama.fi/poolsEnriched?pool=${c.llama}` });
    reqs.push({ url: `https://yields.llama.fi/chart/${c.llama}` });
  }
  return reqs;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let address = argOf("address");
  const base = connect({ address: address ?? "0x0000000000000000000000000000000000000000" });
  await fundOnStudio(base.chain, base.account.address, 1000n * 10n ** 18n);
  if (!address) {
    const code = readFileSync(new URL("../contracts/_probe.py", import.meta.url));
    const res = await deploy({ chain: base.chain, wallet: base.wallet, read: base.read, code, args: [], label: "probe deploy" });
    if (!res.ok) { console.error("deploy failed", res.out?.status, res.out?.stderr?.slice(-2000)); process.exit(1); }
    address = res.address;
  }
  console.log("probe at", address);
  const c = connect({ address });
  const path = new URL("../docs/probe-results.json", import.meta.url);
  let out = { probe_address: address, at: new Date().toISOString(), pools: [] };
  try {
    const prev = JSON.parse(readFileSync(path, "utf8"));
    if (prev.probe_address === address) out = prev;
  } catch { /* first run */ }
  const only = argOf("only");
  for (const cand of CANDIDATES) {
    if (only && !cand.address.startsWith(only)) continue;
    if (out.pools.some((p) => p.address === cand.address)) continue;
    if (!cand.llama) continue;
    const reqs = await requestsFor(cand);
    const label = `${cand.chain}:${cand.address}`;
    const t0 = Date.now();
    // The GENERIC fee estimate: simulating a probe would run every fetch
    // again first, and Arbitrum's /api/eth-rpc stalls ~3 minutes before 504.
    const tx = await c.send("probe", [label, JSON.stringify(reqs)], 0n, { fees: await estimateFees(c.wallet, "probe fee") });
    const rows = JSON.parse((await c.view("get", [label])) || "[]");
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    console.log(`\n${label}  ${cand.note}  (${tx.status}, ${secs}s, tx ${tx.hash})`);
    for (const r of rows) console.log(`  ${String(r.status).padStart(4)} ${String(r.bytes ?? "").padStart(8)}  ${r.url.slice(0, 118)}${r.post ? " [POST]" : ""}  ${r.shape?.slice(0, 60) ?? r.error ?? ""}`);
    out.pools.push({ ...cand, tx: tx.hash, seconds: Number(secs), rows });
    writeFileSync(path, JSON.stringify(out, null, 1) + "\n");
  }
}
