# DLMM Signal Engine + Simulator (v1, read-only)

Local tool for Meteora DLMM (Solana): collects mainnet data, runs virtual LP positions on it
and journals everything for calibration. Built phase by phase from
`Blueprint_DLMM_Signal_Engine_Simulator.docx` (v1.0). **Status: Phase 0–8 done** (calibration waits for enough sessions) — see `PROGRESS.md`.

> Not financial advice. Version 1 never holds keys, never signs, never sends transactions
> (the RPC client refuses `sendTransaction`). All positions are virtual.

## Setup

```bash
npm install
cp .env.example .env        # put your RPC_URL / WS_URL here (never in config or code)
npm run dlmm -- config validate
npm run dlmm -- db migrate
npm test
```

Helius Free works: `RPC_URL=https://mainnet.helius-rpc.com/?api-key=…` and the same URL with
`wss://` for `WS_URL`. Swap transactions are sampled (`collectors.swap_stream.mode: sample`) and
the swap stream has a per-session credit budget, so one 5-hour session with 20 pools stays around
40–65k credits. A dedicated RPC is strongly recommended over the public endpoint. Swap events are only
available by fetching each swap transaction (`getTransaction`), and the public
`api.mainnet-beta.solana.com` endpoint rate-limits that heavily (HTTP 429). With the public
endpoint, pool state, bin snapshots, API metrics, OHLCV and fee attribution still work, but the
swap stream falls behind and records data gaps.

## Commands

| Command | What it does |
|---|---|
| `dlmm config validate` | validate config, print `config_version` |
| `dlmm db migrate` / `db info` / `db recover` | schema, row counts, mark killed sessions aborted |
| `dlmm discover [--max-pools N]` | run pool discovery once and print the pool list |
| `dlmm collect [-d MIN] [--max-pools N] [-l LABEL]` | collect data (Ctrl+C stops cleanly) |
| `dlmm status [-s SESSION]` | per-pool row counts, data gaps, HTTP usage of a collection session |
| `dlmm audit-swaps -p POOL [-s SESSION]` | independent completeness check of the swap stream |
| `dlmm session start [-d MIN] [--max-pools N] [-l LABEL]` | full demo session: collect + grid of virtual positions + report |
| `dlmm sim replay [-s SESSION] [--duration/--warmup/--stop-before/--cohort-interval] [--no-signals]` | same grid (+ scoring, signals, exit engine) on stored data |
| `dlmm score [-s SESSION]` | features + scores on the decision grid over stored data (no look-ahead) |
| `dlmm dashboard [--web] [-s SESSION]` | real-time status (terminal, or local web page on 127.0.0.1:8787) |
| `dlmm session stop [-s SESSION]` | stop a running session cleanly from another terminal |
| `dlmm export -s SESSION [--all] [-f csv\|jsonl]` | export tables for Python / DuckDB |
| `dlmm analyze [--last N] [--holdout K]` | cross-session analytics (signal vs baseline, calibration, consistency) |
| `dlmm macro import [-f FILE]` | load scheduled macro events (FOMC, CPI) used as a time filter |
| `dlmm calibrate [--write] [--force]` | fit module weights, walk-forward + holdout, new config_version only when proven |
| `dlmm report [-s SESSION]` | (re)write `reports/<session>/report.md`, `positions.csv`, `by_dimension.csv` |
| `dlmm reconcile [-s SESSION] [--census]` | fee reconciliation; `--census` fetches every tx as ground truth |

Run with `npm run dlmm -- <command>`. Use `-c path.yaml` for another config; a config file with
`extends: default` only needs the keys it overrides.

## Layout

```
config/default.yaml        every tunable number (weights/thresholds are starting points)
src/config/                zod schema (strict) + loader, config_version = label + sha256
src/db/                    node:sqlite (WAL), migrations, session / config version helpers
src/chain/                 JSON-RPC client (rate limit, AIMD backoff, retry, usage), WebSocket
                           client (reconnect, heartbeat), lb_clmm account + event decoding
src/api/                   Meteora Data API client
src/collectors/            discovery, pool state, bin snapshots, API metrics, OHLCV, swap stream,
                           token security, ecosystem, gap tracker, runner
src/math/                  bin price, fee rate (verified against the SDK)
src/sim/                   distribution (SDK helpers), virtual position, fee attribution, costs,
                           PoolSimulator engine, replay, DB journal
src/features/              feature tracker, features, normalization, edge (Monte Carlo), scorer
src/signals/               signal engine, exit engine, decision stack (scoring -> signals -> exits)
src/session/               live session manager (collectors + simulator + scoring + signals)
src/analysis/              fee reconciliation, swap audit
test/                      unit tests (phase0/1/2) + real mainnet fixtures
```

## How the simulator values a position

* **Distribution**: the SDK's own strategy code (`buildLiquidityStrategyParameters` +
  `toAmountIntoBins`), so Spot / Curve / Bid-Ask shapes match what the UI deposits.
* **Composition**: DLMM bins are constant-sum. Each virtual bin keeps its liquidity
  `L = P·x + y`. Bins below the active bin hold only Y, bins above only X, and the active bin splits like
  the real active bin.
* **Fees** (`simulation.fee_attribution`):
  * `accumulator` (default): bins carry cumulative `fee_amount_{x,y}_per_token_stored`. The fee a
    virtual liquidity L earned between two snapshots is `L·ΔFPT·S/(S+L)`, which includes our own dilution.
    It is exact for every swap, even ones the swap stream missed. Accrual only covers snapshot
    intervals fully inside the position's life, which is slightly pessimistic.
  * `swap_events`: each swap's LP fee (`mm_fee`) is spread over the bins it crossed using the last
    bin snapshot, then diluted the same way (blueprint 12.3).
* **Entry delay**: a position becomes active on the first state update ≥ request + delay, and
  uses the price at that moment.
* **Costs**: base and priority fee (percentile from `getRecentPrioritizationFees`, with a floor), grossed up by the
  failure rate. Also position rent (refundable, reported separately), bin array initialization (sunk),
  the balancing swap (pool fee + slippage margin), and the composition fee in the active bin.
* **PnL**: `net = value + fees − capital − sunk costs`. `IL = value − HODL value`. X is valued at the
  active-bin price.
* **Exit policies** (`grid.exit_policies`):
  * hold to the session end;
  * out-of-range exit or rebalance;
  * exit engine;
  * take profit (net or fee-based) and stop loss;
  * trailing TP with a two-stage confirmation;
  * TP/SL combo;
  * low-yield exit.

  PnL rules are evaluated every `simulation.pnl_eval_seconds`.
* **Strategy variants** (`grid.variants`, addendum v1.1):
  * `partial_harvest`: withdraw 50% at +10%;
  * `fee_compounding`: re-add fees to the position;
  * `single_sided_reseed`: reopen base-only above the price after a fall;
  * `wide_range`: 69/100/150 bins per side.

  Every extra action pays its transactions and swaps. A position wider than `costs.bins_per_tx`
  pays several transactions per operation.
* **Grid sampling** (`grid.sampling`): a balanced, seeded sample of at most `max_combos`
  combinations, the same for every pool and entry mode (`mode: full` = the whole grid).
* **Meridian preset** (`presets/meridian.yaml`, entry mode `meridian_preset`): a second baseline
  that copies Meridian's default screen, ranking and exit rules in the top 3 pools per cohort.
  Until the Jupiter audit exists (phase 10), results are flagged `preset_partial`.

Known limitations (blueprint 12.6): our liquidity does not change routing or other LPs' behaviour.
Failed transactions are an assumption rather than observed. The composition of the active bin between
snapshots is estimated.

## Running a session on the laptop (blueprint 14.3)

```bash
npm run dlmm -- session start            # 5 h default: 15 min warm-up, no new positions in the last 60 min
npm run dlmm -- -c config/session-2h.yaml session start -q > session.out 2>&1   # 2 h profile
```

After pulling new code run `npm run dlmm -- db migrate` once, while no session is running.
Migrations only add tables and columns, so old data stays readable.

Disable sleep/hibernate and keep the charger connected while it runs. For unattended runs,
redirect the output to a file (`... session start -q > session.out 2>&1`) and watch it with
`npm run dlmm -- dashboard` (or `--web`): never pipe a long session into another program — on
Windows a full pipe blocks the process. Ctrl+C stops cleanly: open
positions are force-closed as `session_aborted` and the report is still written. A session killed
hard (power loss) is marked `aborted` at the next start (or with `dlmm db recover`).

## Workflow after setup

1. Run sessions regularly at different hours/days: `npm run dlmm -- session start -q > s.out 2>&1`
   (5 h; watch with `npm run dlmm -- dashboard`). Each writes `reports/<session>/report.html`.
2. `npm run dlmm -- analyze --holdout 1` — consistency across sessions, signal vs baseline, score calibration.
3. When there are >= 5 clean sessions: `npm run dlmm -- calibrate --write`. If accepted, use the new
   config: `npm run dlmm -- -c config/calibrated/<profile>.yaml session start`.
4. Repeat monthly; keep the holdout honest.
