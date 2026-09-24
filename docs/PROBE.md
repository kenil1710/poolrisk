# Probe findings

Everything in PoolRisk is written against what the sources were **measured**
doing — from a laptop first, then from **validator egress** on Studio Dev —
not against what their docs say. Measured 2026-09-24.

- Local previews: `tools/local_scan.py` runs the contract's own pure code
  against the live hosts; `--save` captured the real documents in
  `test/fixtures/` that the offline suite replays.
- Validator egress: `contracts/_probe.py` (a throwaway, not part of PoolRisk),
  deployed at `0x73a930669f3481A4b281997AeD8b7DFe23aBafba`, driven by
  `test/probe.mjs`. Raw results: `docs/probe-results.json`, console:
  `docs/probe-console.log`, `docs/probe-console-2.log`.

**The probe ran before any pool was seeded, and only pools where both
sources answered were seeded.** Section 7 is the table.

---

## §1 — Validator egress reaches every document

Every GET PoolRisk makes answered **200** from validator egress for all eight
candidate pools on all four chains: the Blockscout v2 address, head, block,
token-transfer and transaction documents, and DeFi Llama's `poolsEnriched`
and `chart`. The largest single document is a DeFi Llama chart (~266 KB for a
pool listed since 2022); a token-transfer page is ~116–146 KB.

## §2 — DeFi Llama's bulk list has no pool addresses

`https://yields.llama.fi/pools`: 11.8 MB, **17,187 rows, zero addresses**.
Every `pool` is a UUID; `underlyingTokens` are the pair's tokens.
`/poolsOld` answers **402 Payment Required**. `/poolsEnriched` without a
`pool=<uuid>` answers `400 "invalid configID!"`, and so does any non-UUID.

`/poolsEnriched?pool=<uuid>` (~1 KB) carries `pool_old`, sampled over 48
listings across 11 DEXes and 4 chains:

| shape | projects | contract? |
|---|---|---|
| `0x4e68…fa36` | Uniswap v2/v3, Sushi, PancakeSwap v3, Camelot, Aerodrome, QuickSwap | the pool |
| `0xbEbc…F1C7-ethereum` | Curve | the pool, + `-chain` |
| `0x3de2…9f29000200000000000000000588` | Balancer v2 | 32-byte pool id; first 20 bytes are the pool |
| `0xe63e…5d45-ethereum-uniswap-v4` | Uniswap v4 | a pool id, **not** a contract |

So the listing is named by the caller and **proved** by the validators
(`_pool_old_address`, `_read_listing`) — NOTES §2.1.

The chart (`/chart/<uuid>`) has one point per day stamped ~23:02 UTC, plus a
live point for today that is rewritten through the day and served through a
CDN (`cf-cache-status: HIT`, `age: 191`). Only completed days are read.

## §3 — Activity: direct transactions undercount, counters recount

`/api/v2/addresses/<pool>/counters`, five large pools, same minute:

| pool | transactions_count | token_transfers_count |
|---|---:|---:|
| Uniswap V3 USDT/WETH (eth) | 121 | 3,268,437 |
| Curve 3pool (eth) | 127,786 | 1,834,468 |
| Uniswap V3 USDC/WETH (eth) | **0** | **1,643 → 1,645 → 1,647** (two seconds apart) |
| Uniswap V3 WBTC/WETH (arbitrum) | 61 | 25,936,465 |
| Uniswap V3 WETH/USDC (base) | **0** | **1,544** |

Direct transactions miss everything routed through a router, and for the
busiest pools the counters are **being recomputed while you read them**. A
lifetime count is not usable on the consensus axis; activity is a rate over
the pinned window instead (NOTES §2.2). `tabs-counters` is capped at 51.

`?limit=10` on `/transactions` answers **422** `Unexpected field: limit` —
the same trap TokenScope found with `?type=`.

## §4 — The window can be pinned

`/api/v2/addresses/<pool>/token-transfers?block_number=B&index=0` returns the
50 transfers strictly before block B. Fetched twice, three seconds apart, for
Uniswap V3 USDT/WETH: **identical rows** (same transaction hashes and log
indexes, in the same order). The ~2-byte difference in body size is embedded
token metadata; nothing PoolRisk reads.

## §5 — The legacy API throttles a burst; v2 does not

From one IP:

| request | result |
|---|---|
| 20 concurrent `GET /api/v2/addresses/<pool>` | **20 × 200** |
| 15 sequential `GET /api?module=block&action=getblocknobytime` | 3 × 200, then **12 × 429** |
| three bursts of 5, 15 s apart, 30 s after that | **15 × 429** |
| 8 sequential, 1.2 s apart | **8 × 429** |

The 429 body is `{"message":"Too many requests. Increase limits now at …",
"result":null,"status":"0"}`, and it is also what a throttled 200 looks like
on some hosts (`_throttled`). A consensus round is five nodes firing the same
requests at once, so nothing in PoolRisk touches `/api?module=` (audit
check 32). `getcontractcreation` was also found to answer
`{"message":"OK","result":[],"status":"1"}` — an empty success — for factory
pools whose creation Blockscout never indexed.

Blockscout's own JSON-RPC (`/api/eth-rpc`) from validator egress: **429** on
Base and Arbitrum and one **504 after ~3 minutes** on Arbitrum. publicnode
answered **200 on all four chains**. publicnode leads; Blockscout is the
fallback.

## §6 — Arbitrum's explorer is 1.5 days behind

`arbitrum-one-rpc.publicnode.com` head: 508,356,835.
`arbitrum.blockscout.com/api/v2/main-page/blocks` newest: **507,912,969,
stamped 2026-09-22T21:41:36Z** — on 2026-09-24. `/api/v2/blocks/<RPC head −
3000>` → 404. The pin is taken from the explorer's own head (NOTES §2.4), and
the window's end time is stored so the lag is visible (`window_end_ts`).

## §7 — The candidates

| pool | chain | every required document | Blockscout RPC fallback | seeded |
|---|---|---|---|---|
| Uniswap V3 USDC/WETH 0.05% `0x88e6…5640` | ethereum | 200 | 200 | yes |
| Curve 3pool `0xbebc…f1c7` | ethereum | 200 | 200 | yes |
| Camelot V3 PEAR/USDC `0x299c…3aba` | arbitrum | 200 | 504 | yes |
| Uniswap V3 WBTC/USDT `0x5969…7203` | arbitrum | 200 | 429 | lifecycle (no listing id → INCONCLUSIVE) |
| Uniswap V3 W0G/USDC `0xe03c…0c4e` | base | 200 | 429 | yes |
| Uniswap V2 WETH/BELONG `0xdd0c…905b` | base | 200 | 429 | yes |
| Aerodrome Slipstream AVNT/USDC `0xe30d…5dcb` | base | 200 | 429 | yes |
| QuickSwap USDC/WETH `0x853e…670d` | polygon | 200 | 200 | yes (and lifecycle rescan on the demo instance) |

Candidates considered and set aside before probing: Uniswap v4 pools (a
listing id that is not a contract — `UNMATCHABLE`), and any pool not listed
on DeFi Llama at all.

## §8 — What the probe changed

1. Search-by-address on `/pools` → caller-named listing, validator-proved via
   `pool_old`.
2. Lifetime counters → a transfers-per-day rate over a pinned window.
3. Legacy `getblocknobytime` / `getcontractcreation` → v2 head, v2 block,
   v2 transaction.
4. RPC chain head → the explorer's indexed head.
5. Creation time missing → DeFi Llama first-seen, labelled, younger-only.
6. Live TVL/APY → the last completed daily snapshot.
