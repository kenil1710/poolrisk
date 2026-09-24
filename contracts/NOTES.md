# PoolRisk — design notes

The contract documents its rules where they live. This file is for the
reasoning: choices made against an alternative, the places where a
measurement overrode the brief, and the hazards a reader would otherwise
rediscover. The measurements themselves are in `docs/PROBE.md`.

## 1. What the model decides, and what it never does

GenLayer fetches from Blockscout and DeFi Llama independently and reaches
consensus on a combined feature vector. All scores are deterministic integer
functions of the agreed vector.

| value | who decides | compared |
|---|---|---|
| contract state, verified, proxy, owner(), creation time | code, from Blockscout + JSON-RPC | exactly |
| pin block, window end, legs, transactions, counterparties, top legs, top five, window hash | code, from the pinned window | exactly |
| listing state, project, symbol, exposure, IL risk, stablecoin | code, from DeFi Llama's listing | exactly |
| snapshot day, TVL, TVL a week earlier, APY, 30-day mean APY, history, first seen | code, from DeFi Llama's completed days | exactly |
| the concentration bracket (which two penalties are allowed) | code, from the top counterparty's share | exactly |
| **the concentration penalty** | **the model, one of two adjacent integers** | **exactly** |
| the seven scores, total, level, flags, pool_identified | code | exactly |
| blockscout_hash, llama_hash, facts_hash, content_hash | code | exactly |
| reason | code, composed from the agreed values | re-derived |

There is no tolerance anywhere in `_agrees`. "Bucket width is the consensus
margin" is implemented as coarse ladders and pinned inputs, never as a
comparison that accepts two different stored values
(`genlayer-validator-binding-pattern`: TrustGuard and ConsensusPrice were
both rejected for "close enough").

**The model controls at most 3 points of 100.** Concentration weighs 10%, is
scored 0–10, and the model's only lever is a penalty of 0–3 subtracted from
the arithmetic base. And it never gets the whole 0–3: `_bracket` fixes two
ADJACENT values from the top counterparty's share of the window
(< 34% → {0,1}, 34–66% → {1,2}, ≥ 67% → {2,3}), so in any one scan the model
moves the total by at most one point. Under 10 transfer legs, or with either
source missing, the penalty is pinned to 0 and no model runs.

What the model judges is the one thing a parser cannot: whether the dominant
counterparty is shared infrastructure (a router, an aggregator, a position
manager — heavy traffic from it is many users) or a single operator (a bare
wallet, an unverified contract, a label reading like a bot). The labels are
explorer name tags and contract names, chosen by whoever deployed or tagged
the address, so they reach the prompt between markers, sanitised to printable
ASCII, followed by the instruction that nothing inside is an instruction.

## 2. Where a measurement overrode the brief

Each of these is a place where following the brief literally would have
shipped a contract that is wrong, node-dependent, or unable to answer.

### 2.1 DeFi Llama's pool list carries no pool addresses

The brief: "Search `https://yields.llama.fi/pools` for the pool by address."
Measured (PROBE §2): all 17,187 rows of `/pools` identify pools by UUID only.
`pool` is a UUID, `underlyingTokens` are the tokens, not the pool.
`/poolsOld` answers **402 Payment Required**. Nothing in the free bulk list
can be matched to a contract address.

`/poolsEnriched?pool=<uuid>` does carry `pool_old`, and for AMMs it is the
pool contract: bare for Uniswap/Sushi/Aerodrome/QuickSwap, `address-chain`
for Curve, the 32-byte pool id (address + 12 bytes) for Balancer. So
`scan_pool(pool_address, chain, llama_pool_id)` takes the listing id as a
third, optional argument and **every validator checks that the listing's own
`pool_old` resolves to the scanned address on the scanned chain**. A caller
cannot pair a pool with somebody else's TVL: a mismatch is
`ADDRESS_MISMATCH` → INCONCLUSIVE (lifecycle step 3 does this on chain).
Uniswap v4 listings carry a 32-byte pool id with a `-chain-uniswap-v4`
suffix; v4 pools are not contracts, so those are `UNMATCHABLE`.

With no id the pool is not identified on DeFi Llama and the scan is
INCONCLUSIVE — which is what the brief asks for unlisted pools.

### 2.2 Activity is a rate over the pinned window, not a lifetime count

The brief: "activity_score: transaction count → bucket (<100 … >1M)".
Measured (PROBE §3), two independent problems:

- A pool's **direct** transactions undercount it by orders of magnitude.
  Uniswap V3 USDT/WETH (0x4e68…) has 121 direct transactions and 3.2 million
  token transfers: swaps reach a pool through routers.
- Blockscout's **`/counters` endpoint is recomputed in the background for the
  busiest pools**. Uniswap V3 USDC/WETH (0x88e6…) and Base's WETH/USDC answered
  `transactions_count: "0"` and a token-transfer count of ~1,600 that rose
  by two every second while the recount ran. A node reading it records its
  own moment of that recount; a round could never agree, and a pool with
  hundreds of millions in TVL would score as idle.

So activity is **token transfers per day over the pinned window**: the
window's legs divided by the time from its oldest transfer to the pin block's
timestamp. Same decade shape as the brief's ladder (<1/day: 0 … ≥10,000/day:
10), and LOW_ACTIVITY keeps its meaning — activity score 0. No counters
endpoint is read at all (`tools/audit.py` check 32).

### 2.3 The legacy Blockscout API cannot survive a consensus round

A consensus round is a burst by construction: every validator fires the same
requests at the same moment. Measured from one IP (PROBE §5): the v2 REST API
answered **20 concurrent requests with 20 × 200**; the legacy
`/api?module=…` endpoint answered **3 and then 429 to everything, for
minutes** — five-way bursts 15 seconds apart were all refused. The first
design used `getblocknobytime` and `getcontractcreation` from it. Both are
gone:

- the pin comes from `/api/v2/main-page/blocks` (§2.4),
- the creation time from `/api/v2/transactions/<creation hash>`,
- `owner()` goes to publicnode first (TokenScope measured it taking ten-way
  bursts that Blockscout's `/api/eth-rpc` refused), Blockscout second. On the
  probe, Arbitrum's `/api/eth-rpc` answered **504 after a long stall** from
  validator egress; publicnode answered at once.

### 2.4 Arbitrum's explorer is 1.5 days behind the chain

The first pin used the chain head from JSON-RPC. Measured (PROBE §6):
`arbitrum.blockscout.com` had indexed only up to a block stamped
2026-09-22T21:41 on 2026-09-24 — `/api/v2/blocks/<head − 10 min>` was a 404.
Every Arbitrum scan would have failed. The pin is therefore taken from **the
explorer's own indexed head**: `((head − lag) // grid) * grid`, grid ≈ one
hour of blocks, lag ≈ ten minutes. The window's end time is published
(`window_end_ts`), so an explorer that is behind shows up as an old window
rather than hiding.

### 2.5 Some pools have no creation transaction on Blockscout

Measured: `creation_transaction_hash` is `null` for factory pools on Arbitrum
and Base (Uniswap V3 WBTC/USDT on Arbitrum, the new Uniswap V2 pairs on
Base). Age then counts from **the first day DeFi Llama recorded the pool**.
That can only be later than the creation, so the fallback can only make a
pool look younger — the conservative direction. `age_source` publishes which
was used (`CREATION` / `LLAMA_FIRST_SEEN`).

### 2.6 "Renounced" means nobody can act as owner

The brief's top verification bucket is "verified + not proxy + renounced". A
Uniswap V3 pool has no `owner()` at all — it is administered by nobody. So
`owner()` is read with one `eth_call` and collapsed to four states: `NONE`
(execution reverted, or an empty return), `RENOUNCED` (a burn address),
`OWNED` (a live key), `UNKNOWN` (no host served eth_call). `NONE` and
`RENOUNCED` earn the 10; `UNKNOWN` does not. Curve 3pool has a live owner
(Curve's ownership agent) and scores 8.

## 3. Pinned inputs: why two nodes read the same numbers

| input | moves | how it is pinned |
|---|---|---|
| recent activity | every block | the 50 token transfers before the pin block; keyset pagination returns the same rows minutes later (PROBE §4) |
| pin block | every block | the explorer head, less ten minutes, floored to a one-hour grid: nodes seconds apart land on one grid line; a pair straddling a line (a few seconds an hour) fails that round and it runs again |
| TVL, APY | hourly on DeFi Llama, edge-cached | the last chart point stamped before today's UTC midnight — a completed day, identical all day; the live point is never read |
| week-ago TVL | — | the last point before midnight seven days earlier |
| age | — | a creation timestamp, and `now` from the transaction (identical on every node) |
| verified, proxy, owner | when the contract changes | read as of now; each collapses to a state |

## 4. Failure classes (TokenScope's lesson, kept)

"Did this source answer" is itself on the compared axis, so it must be as
deterministic as every other field.

| answer | class | effect |
|---|---|---|
| 200 + JSON | answer | extracted |
| 400 / 404 / 410 / 422 | absence every node shares | the source state records it (NOT_FOUND, INCOMPLETE, NO_SNAPSHOT…) → INCONCLUSIVE |
| 401 / 403 / 408 / 425 / 429, 5xx, no status, unparseable, 200 + "Too many requests" | this node's bad minute | retried once in-node; then the round fails, nothing is stored |
| a pin block the explorer cannot show | the explorer's own lag | transient, never "the pool is absent" |

A leader that reports an outage is agreed with only if the validator fails
too, on the same content (`_leader_failed`), so no leader can stall a scan by
claiming the model or a source was down.

## 5. Lifecycle

- `scan_pool` registers the pool **and** runs the first round in the same
  transaction. An undecided round rolls the whole transaction back (nothing is
  registered, no cooldown is spent). An agreed outage leaves the pool
  `PENDING`.
- `rescan_pool` is permissionless. It gives a PENDING or STALLED pool its
  first score, or rescans a scored one: the previous total is kept on the pool
  (`previous_score`, `previous_level`) and `risk_delta` is the change, set only
  when both scans were scored. A rescan that does not settle leaves the old
  scan in place. Every agreed scan stays in `get_risk_history`.
- `settle_stalled` closes a pool that has been PENDING past its stall window.
  Permissionless, and it works while paused: it never reads the pause, the
  caller or the owner.
- Pause stops new consensus rounds (`scan_pool`, `rescan_pool`) and nothing
  else. `_gate` is the only reader of `paused` (audit check 13).
- The cooldown (one scan or rescan per wallet per 120s) is stamped after the
  last refusal (rule 4).

## 6. No money, but a ledger anyway

There is no fee and no stake: this is a public good. No method is payable.
But a revert rolls back storage and not value, so if a runner ever let value
through to a write it must still have an owner and a way out. `_bank` (first
statement of every write) books it to the sender, `_refuse` credits nothing
further, and `claim_refund` pays it back. `balance_wei == refundable_wei` is
published by `get_stats` (GrantJudge NOTES §6, TOSGuard NOTES §7).

## 7. Hazards inherited

- The runner header is exactly two comment lines; nothing may sit between
  line 1 and the imports. `test/deploy.mjs` refuses to deploy otherwise.
- `from genlayer import *` does not bind `TreeMap` or `DynArray`; storage uses
  `gl.storage.*` only, and the offline stub withholds the bare names.
- A nondet closure that captures `self` pickles storage; `_facts` is the one
  boundary where plain values are copied out.
- `str.replace()` is rejected by the runner; nothing here uses it.
- Floats are not calldata-encodable (DeFiLens PROBE §2): TVL and APY become
  whole dollars and centi-percent before they leave `_read_chart`.
- `TreeMap[str, u32].get(missing)` is 0, not None: `by_key` treats 0 as absent.
- Studio's fee simulator would re-run every fetch of a scan; the scripts use
  the generic fee estimate, and no PoolRisk write posts a transfer except
  `claim_refund`.
