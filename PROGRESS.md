# Progress log

Blueprint: `Blueprint_DLMM_Signal_Engine_Simulator.docx` v1.0. Done: Phase 0–8 (tooling). Weight calibration itself waits for data: >= 5 clean data sessions.

## Phase 0 — Setup ✅
- TypeScript + Node 24 (`node:sqlite`, WAL), YAML config validated with zod (strict keys),
  `config_version = <label>+<sha256[0:10]>` stored in `config_versions` and on every session / position.
- pino JSON logs with daily/size rotation (`logs/`), URL redaction for RPC keys; secrets only in `.env`.
- Schema migration `src/db/migrations/001_init.sql` (all tables of blueprint §16 + ops tables).
- Tests: `test/phase0.test.ts`.

## Phase 1 — Collector & Storage ✅ (swap stream limited by the public RPC)
Collectors: discovery (API filters → on-chain verification), pool_state (5 s), bin_snapshot (30 s,
delta-encoded, lb_pair in the same request), pool_metrics (API, 60 s), OHLCV (5m/1h, chunked),
swap_stream (logsSubscribe + getSignaturesForAddress backfill + getTransaction), token_security
(mint/freeze authority, token-2022 transfer fee, top-10 holders, RugCheck), ecosystem (priority
fee percentiles, SOL/USD). Gap tracker (explicit + watchdog staleness), reconnect/backoff,
adaptive rate limiting, clean Ctrl+C shutdown, recovery of killed sessions.

Acceptance run `67908507…` (20 pools, 60.9 min, public RPC):
- pool_state 721 snapshots/pool (max interval 10 s), bin snapshots 120/pool (max 31.7 s),
  API metrics 60/pool, OHLCV, ecosystem: complete, **no gaps**.
- swap_stream: public RPC rate-limits getTransaction → 2 212 swaps stored, ~13 300 tx dropped,
  **all recorded as data gaps** (68 gaps). Needs a dedicated RPC for complete swaps.
- token_security: getTokenLargestAccounts always 429 on the public RPC → top-10 missing (errors stored).

## Phase 2 — Simulator core ✅ (see reconciliation notes)
Bin price, fee rate (== SDK), SDK strategy distribution, composition, fee attribution
(accumulator + swap events), costs, entry delay, PnL/IL, gap tainting, journal, replay.
Tests: `test/phase2.test.ts`.

Fee reconciliation, accumulator method vs **on-chain census** (every transaction of the window
fetched and decoded — ground truth):

| pool | window | chain LP fee | accumulator | accum vs chain | API vs chain |
|---|---|--:|--:|--:|--:|
| DJT-USDC | 19:15–20:00 | $19.61 | $19.08 | −2.7% | −19.7% |
| SOL-HYPE | 19:15–19:35 | $26.80 | $26.89 | +0.3% | −45.2% |
| DJT-USDC | 19:15–19:45 | $13.58 | $13.60 | +0.17% | −28.6% |
| cbBTC-USDC | 19:15–19:45 | $26.48 | $26.47 | −0.04% | −34.2% |
| JUP-SOL | 19:15–19:45 | $187.28 | $187.26 | −0.01% | −18.8% |
| ZEC-SOL | 19:15–19:45 | $154.27 | $156.11 | +1.19% | −9.4% |

→ **passes (±5%)** against the chain. The Meteora API 5m `volume/history` buckets are not a reliable
reference: they deviate −9…−45% from the chain and change between queries (late indexing).
Against the API alone, 11/20 pools were within ±5% (window 19:15–20:00).
`dlmm reconcile --census` uses the chain census as reference automatically.

## Phase 3 — Grid Runner & Session Manager ✅ (5 h acceptance run in progress)
- Grid from config: strategy × bins_per_side × sides × exit_policy × entry_mode
  (3×5×3×3 = 135 combos per pool per cohort). `signal_enter` / `signal_watch` wait for the
  Signal Engine (phase 5) and are skipped with a warning; the baseline runs.
- Cohorts: the whole grid opens at the start of the active phase and every
  `grid.cohort_interval_minutes` (default 60) until the closing phase; `grid.max_positions` cap.
- Exit policies: `hold_to_session_end`, `exit_out_of_range` (X min), `rebalance_out_of_range`
  (X min, max N; rebalance = full cost: tx + balancing swap + bin arrays + composition fee;
  after N rebalances → close `max_rebalances`).
- Session clock (blueprint 14.1): warm-up → active → closing → forced close (`session_end`;
  Ctrl+C → `session_aborted`), report written in both cases.
- Live: `dlmm session start` = collectors + simulator on the in-process bus; simulator errors
  can never stop collection. Replay: `dlmm sim replay` runs the same GridRunner on stored data
  (timing scaled to the collected span).
- Report (`reports/<session>/report.md`, `positions.csv`, `by_dimension.csv`): summary, data
  health, per-dimension tables (entry mode, strategy, width, sides, exit policy, category,
  cohort, close reason, pool), top/bottom 10 with the multiple-testing warning, limitations.
- Verified: replay of the 1 h / 20-pool session → 10 800 positions, 1 248 rebalances,
  993 policy exits, 21.6 s; live 7-min smoke session → 1 215 positions, all closed `session_end`.
- Tests: `test/phase3.test.ts` (71 tests total).

## Phase 4 — Features & Scoring ✅
- `src/features/`: `PoolTracker` (rolling, look-ahead-free state per pool, fed in time order),
  `compute.ts` (23 blueprint 8.2 features with module, direction, freshness),
  `normalize.ts` (winsorized percentile rank, cross-sectional blended with own history,
  direction applied), `edge.ts` (Monte Carlo GBM edge), `scorer.ts` (modules, safety gate,
  context multiplier, weights with redistribution, confidence, action, recommendation),
  `runner.ts` (decision grid + persistence), `scoreReplay.ts`.
- Scores + features are stored every `scoring.interval_seconds` (60 s) in `scores` / `features`
  (migration `002_scoring.sql`, keyed by session). Live sessions score on the same bus;
  `dlmm score -s <session>` re-scores stored data.
- **Look-ahead:** trackers only receive events with ts <= t, `assertNotAfter(t)` throws
  otherwise, markout only uses swaps older than 60 s, and a test proves scores/features at t are
  identical with and without the data after t (full pipeline, stored rows).
- **Edge model fix + validation:** fee = measured fee yield per $ of liquidity (active bin /
  neighbours) × our liquidity along GBM paths (the "constant pool fee flow × share" version
  overestimated ~50× when paths reached thin bins). Validated against simulator fees on the same
  data (20 pools, 100 comparisons): median predicted/realized **0.90**, Spearman **0.67**.
- Token security: RugCheck full report as fallback → top-10 (excl. AMM/locker/burn/reserves),
  wallet-cluster %, dev history proxy (creator tokens now worthless), rugged flag.
- Data availability on the public RPC (1 h session): flow features ~0% (swap stream gaps),
  holder data only via RugCheck (new sessions), everything else 77–100%.
- Tests: `test/phase4.test.ts` (84 tests total).

## Phase 5 — Signal & Exit Engine ✅
- `src/signals/signalEngine.ts`: every score -> a blueprint 11 signal (incl. LEWATI) in
  `signals` (full JSON in `payload`, `taken` = used by a signal-mode entry); recommended
  size_fraction = base (MASUK) / small (PANTAU) x confidence, capped.
- Entry modes run **in parallel at the same cohort time**: `all_pools_baseline` (every pool,
  control group), `signal_enter` (latest signal MASUK), `signal_watch` (PANTAU). Every position
  stores the pool's signal at entry (`signal_id`, `signal_action`, `matches_recommendation`), so
  skipped (LEWATI) pools are still simulated and judged.
- `src/signals/exitEngine.ts` (blueprint 15) as grid exit policy `exit_engine`: gate FAIL, whale
  sell > 2% supply / 10 min (sampled swaps), LP withdrawal > 30% within +-k in 5 min -> partial
  exit (then full), trending_down while holding X, |IL| > 1.5 x fee, fee < 0.02%/h over 30 min;
  out of range -> rebalance only if its cost < expected fee (edge), else exit; max rebalances.
  Decisions journaled as `exit_signal` events (TAHAN not journaled).
- Simulator: partial exits (withdrawn value held as cash), rebalance redeploys only the liquid
  part (bug found in replay: withdrawn cash was redeployed -> IL up to +$498; fixed + test).
- `src/signals/stack.ts`: scoring + signals + exit engine on one stream, shared by live and replay.
- Replay of the 1 h session: 14 940 positions (baseline 14 400 + signal_watch 540 in parallel),
  1 200 signals, exit engine 3 609 exits / 299 partial exits. No MASUK there (old data: no
  holder data, no flow, low confidence).
- Report: signals section, tables by signal action at entry, entry mode x action, recommendation match.
- Tests: `test/phase5.test.ts` (100 tests total).

## Phase 6 — Dashboard & Analytics ✅
- Session report (`reports/<session>/`): `report.md`, **`report.html`**, `positions.csv`,
  `by_dimension.csv`, **`metrics.json`**. Covers blueprint 18: net PnL ($/%), fee, IL, cost,
  **fee/IL**, in-range, **max drawdown**, duration, win rate per strategy / width / sides / exit
  policy / category / **regime at entry** / **entry hour (WIB)** / cohort / close reason / pool;
  **signal vs baseline cohort by cohort** (main measure); **score calibration** buckets
  (<60, 60-70, 70-80, 80-90, 90-100) with a monotonicity verdict; top/bottom 10 with the
  multiple-testing warning; **fee reconciliation** (stored in `reconcile_results`, run
  automatically at the end of a live session against the API; `dlmm reconcile --census` for chain
  truth); data health (gaps, HTTP/credits); limitations.
- Dashboard: `dlmm dashboard` (terminal, refreshes) and `dlmm dashboard --web` (local page on
  127.0.0.1:8787). Live sessions write a heartbeat (`session_heartbeat`): phase, time left,
  positions, running mark-to-market PnL by entry mode / strategy / exit policy, credits, WS state,
  open gaps, latest signals. Older sessions fall back to DB aggregates.
- CLI: `dlmm session stop` (clean stop of a session running in another terminal, via
  `session_control`), `dlmm export` (CSV / JSONL per table for pandas/DuckDB), `dlmm analyze`
  (cross-session: signal vs baseline, calibration, consistency per dimension, holdout kept apart).
- Bugs found with the dashboard: (1) live scorer never learned that a gap had closed → after an
  internet drop (06:52 WIB, DNS failure) every score stayed 0 until session end (fixed: gap close
  is propagated); (2) RugCheck reported a 128k-account "insider network" = 332% of supply (fixed:
  networks > 1 000 accounts ignored, >100% invalid).
- Tests: `test/phase6.test.ts` (109 tests total).

## Phase 7 — P1/P2 modules ✅
- New collectors (`src/collectors/extraCollectors.ts`), each switchable in `collectors.*`:
  `venues` (DexScreener: every pair of each risk token across DEXes -> volume share),
  `attention` (CoinGecko trending by symbol — a proxy), `macro` (BTC price + dominance, Fear &
  Greed, USD/IDR for reporting, DefiLlama Solana DEX volume + stablecoins, network TPS, new DLMM /
  launchpad pools per hour). Migration `005_p1_modules.sql`.
- New features: flow `markout_30s`, `markout_300s`, `wash_share`, `whale_share`,
  `lp_net_flow_1h`; competition `pool_volume_share` (now sourced), `venue_count`; attention
  `trending_score`, `boosts_active`, `social_presence`, `launchpad_heat`; regime `btc_trend_er`,
  `btc_return_1h` (+ BTC trend penalty); context `fear_greed`, `sol_dex_change_1d`, `network_tps`.
  All read look-ahead-free (`src/features/extraLookup.ts`, rows with ts <= t, max age).
- Attention module implemented but **off by default** (`scoring.modules.attention: false`): data
  is collected so its value can be measured before it gets weight. Not available (no reliable
  free source): X/Twitter mentions, news/exploit alerts, funding / open interest.
- Macro calendar: `config/macro_events.yaml` + `dlmm macro import` (FOMC dates included, marked
  "verify"; CPI to fill in). Report shows total net PnL in rupiah (USD/IDR).
- Criterion test: all 64 on/off combinations of the 6 scoring modules score without error and the
  weights follow the switches; every P1/P2 collector can be disabled.
- **Robustness bugs found and fixed while running sessions in parallel:**
  - A replay held one SQLite transaction for minutes -> "database is locked" crashed the live
    Phase 5 session. Now: replays / re-scoring commit every ~250 ms (`beginBatch/yieldBatch`),
    busy_timeout 60 s, periodic tasks survive a failing tick, WebSocket listener errors are caught,
    and the collector logs (not dies on) uncaught errors (stops cleanly after > 50 in 10 min).
    Verified: live collection + concurrent replay -> 0 gaps, 0 errors.
  - The old 5 h session hung at 06:31 WIB because its stdout was piped to a process of the ended
    Claude session (Windows pipe writes are synchronous). New `--quiet` flag; run unattended
    sessions with output redirected to a file.
- Re-simulated with the full stack: `phase3-full-5h` data (107 min, public RPC) and
  `phase5-helius` data (47 min until the crash). Signals still mostly LEWATI/PANTAU; score
  calibration not monotonic yet; signal_watch vs baseline mixed (-0.08 pp and +2.66 pp on tiny n).
  Not conclusive — needs many clean sessions (blueprint 18.2: 200-300 signal_enter positions).
- Tests: `test/phase7.test.ts` (119 tests total).

## Phase 8 — Calibration ✅ (tooling; real weights not changed yet — too little data)
- `dlmm calibrate [--write] [--force]` (`src/calibration/`), blueprint 18.2:
  - dataset: clean baseline positions (they ignore the signal -> no selection bias), averaged per
    pool x cohort (positions of one pool in one cohort share signal + price path); the newest
    simulation run per data session only (replays of the same data are not new evidence);
  - candidate weights per category: ridge regression of net PnL % on standardized module scores,
    non-negative (negative modules dropped + refit), rescaled to 100;
  - walk-forward (train on older sessions, test on the next) + holdout (newest sessions, never
    fitted); metrics: Spearman(score, net %) and uplift = top-30% mean minus all-pool mean;
  - accepted only if better than the current weights in walk-forward AND on the holdout AND the
    selection beats the average pool; then `config/calibrated/cal_<stamp>.yaml` (`extends:
    default`, new weights profile) is written and registered as a new config_version.
    Too few sessions -> refused; `--force` evaluates but never writes.
- Verified on synthetic journals (outcome driven by edge + regime): recovers edge > regime >> noise,
  accepted via walk-forward + holdout, writes a loadable config; refuses when the current weights
  are already right or data is insufficient.
- Real data (2026-09-29): 3 distinct data sessions, 191 observations -> "insufficient data";
  the fitted candidate was worse than the blueprint weights on the holdout (Spearman 0.10 vs 0.26;
  uplift of the current weights on the holdout +0.5 pp). Current weights stay.
- Tests: `test/phase8.test.ts` (125 tests total).

## Phase 9 — Exit policies, strategy variants, Meridian preset (addendum v1.1)
- New exit policies (`src/sim/policies.ts`, `grid.exit_policies`); list values expand into several
  grid policies (trailing trigger/drop are paired: 2/1, 3/1.5, 5/3):
  `take_profit` (net PnL, or `basis: fee`), `stop_loss`, `trailing_tp`, `tp_sl_combo`,
  `low_yield_exit`. PnL policies are evaluated every `simulation.pnl_eval_seconds` (30 s) by the
  grid runner, not only on swaps; out-of-range rules still run on every pool state.
- Trailing TP, two-stage confirmation (pure function `trailingStep`): a drop ≥ drop_pct from the
  peak becomes `pending_trailing_exit` (journaled with the PnL); after `confirm_seconds` it exits
  if the drop still holds within `tolerance_pct` (drop ≥ drop × (1 − tol%)), else it is cancelled.
  New peaks need the same confirmation, so a short spike does not lift the peak.
- Strategy variants: a new grid dimension `grid.variants`, applied on top of the shape, not added
  to `strategies` as the addendum example does, so every variant runs with every shape. Every
  extra action is charged in the simulator:
  - `partial_harvest`: withdraw 50% at +10% return, once. Charged a close tx and an exit swap when
    `exit_to: quote`.
  - `fee_compounding`: claim the fees and add them back with the same shape when fees reach $5 or
    after 30 min. Charged a claim tx, add tx(s), and a swap of the part of the fees that does not
    match the position's composition. The reported fee includes compounded fees, and the HODL
    basket includes the reinvested tokens.
  - `single_sided_reseed`: when the price falls below the range and the position is at least 99%
    base, reopen it base-only above the new active bin with the same number of bins, at most 3
    times. Charged like a rebalance.
  - `wide_range`: its own widths (69/100/150 per side, spot shape).
- Wide positions need several transactions per operation: tx cost × ceil(bins / `costs.bins_per_tx`
  (70)) for open, close, rebalance, claim and add. This also applies to the existing wide grid
  ranges, which makes them slightly more expensive than before. A new op, `add`, is in
  `costs.signatures` and `costs.compute_units`.
- Grid sampling (`grid.sampling`, `mode: balanced`): strategy × bins × sides × exit policy ×
  variant is 4725 combinations per pool, so the grid draws a balanced sample of at most
  `max_combos` (180). Each dimension's levels are cycled and shuffled independently with a seeded
  PRNG, so every level appears about equally often. The same sample is used for every pool and
  entry mode, which keeps the comparisons paired. `mode: full` gives the whole cartesian grid.
  `grid.max_positions` still caps the total.
- Meridian preset as the second baseline (`presets/meridian.yaml`, entry mode `meridian_preset`,
  `src/sim/meridian.ts`). Each cohort it screens every ready pool with Meridian's default pool and
  token filters, ranks them by fee_tvl×1000 + organic×10 + volume/100 + holders/100, and opens the
  preset position in the top 3:
  - position: bid-ask, quote-only, 69 bins below;
  - exit (`tp_sl_combo`): SL −15%, TP when fees reach 5% of capital, trailing 3/1.5, exit after
    30 min out of range.
  Where the preset inputs come from:
  - fee/active-TVL: from the bin fee accumulators over 5 min divided by the liquidity at active ±k,
    or from the API hourly figure scaled to 5 min;
  - volume: API 1h volume × 5/60;
  - market cap: supply × price (an FDV proxy);
  - holders and top-10: from token security.
  Organic score and bot holders need phase 10, so every preset position is `preset_partial` and
  lists the skipped filters.
- Migration `006_grid_dimensions` (additive `ALTER TABLE ... ADD COLUMN` only, safe for old rows):
  `sim_positions.exit_policy_params`, `strategy_params`, `cooldown_enabled` (phase 10) and
  `entry_filter` (phase 13).
- Report: a new section, "Baseline vs Meridian preset vs signal", with two tables:
  - groups with clean and all counts;
  - the pool-selection effect: identical baseline positions in the pools a group picked vs in all
    pools of the same cohorts.
  New dimension tables cover the exit policy type and the strategy variant; top/bottom combinations
  include the variant.
- Replay check on a DB copy (phase5-helius, 47 min, 20 pools): 15,670 positions in 86 s, 0 failed.
  - exits: 641 stop losses, 275 take profits, 220 trailing TP, 104 low-yield;
  - variants: 3,507 compounds, 3,423 reseeds, 37 harvests;
  - preset: 10 positions opened, all partial.
- Tests: `test/phase9.test.ts` (25 new, 150 total).
- Prerequisites the addendum puts before phase 9 counts as done are still open:
  - the first full 2 h session (`helius-2h-1`) and a check of its report;
  - fee reconciliation passing;
  - one test session with the new grid running without error.

## RPC: Helius Free + swap stream redesign (2026-09-29)
- `.env` points to Helius (Free: 1M credits/month, 10 rps). Rate limits: critical 3 rps +
  swap stream 5 rps + token security 0.75 rps.
- Measured on Helius (6 memecoin pools, 5 min): the socket delivered ~550 tx/s mentioning the
  pools; only ~29% of fetched transactions contained a swap in the pool (arbitrage/MEV bots).
  Fetching every swap is impossible on Free (and hard on paid plans without Enhanced WebSockets).
- **Swap stream = sampling mode** (default): per pool a uniform random sample of
  `sample_per_minute` (8) swap-like transactions per minute, probability = target / EWMA rate,
  capped at 2x. Every candidate is still counted per minute in `swap_activity` (free, complete).
  Skipped transactions are not gaps; a gap is recorded only when the socket is down.
- Flow features from the sample (ratios): `trader_diversity` (distinct wallets / sampled swaps,
  replaces unique_traders_1h), `top5_wallet_share`, `markout_60s`, `buy_sell_balance`; plus
  `swap_tx_rate_1h` from the complete activity count (informational).
- **Swap stream only for memecoin pools** (`swap_stream.include_categories`, include/exclude
  lists); scoring knows which pools have no stream (flow = unavailable, not zero).
- **Credit budget per session:** `swap_stream.credit_budget` (50k) paced evenly over the session
  (+10% burst) and `rpc.quota.session_credit_budget` (65k) for everything; when spent the swap
  stream stops (gap "credit budget reached"), core collectors continue.

## Verified facts about Meteora (2026-09-29)
- Program `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo`, IDL lb_clmm 0.12.0 (SDK @meteora-ag/dlmm 1.9.14).
- Swap events are emitted via self-CPI (`emit_cpi`), NOT in logs → need `getTransaction`
  (with `maxSupportedTransactionVersion: 1`; v1 transactions exist on mainnet now).
- Every swap emits BOTH `Swap` and `Swap2Evt` (same swap) → de-duplicate. `fee_bps` = fee rate × 1e9.
- Bins carry cumulative `fee_amount_{x,y}_per_token_stored` (Q64.64) → gap-proof fee attribution.
  Bin value / (supply >> 64) ≈ 1.000–1.001 on mainnet.
- Data API: OHLCV timeframes 5m..24h only (no 1m), max ~72–100 candles per request
  ("time range too large"). `filter_by=pool_address=[a,b]` needs commas (docs say `|`).
  API `fees` = LP share; `pool_config.protocol_fee_pct` disagrees with on-chain protocol_share
  (SOL-USDC: API 5, chain 1000 bps = 10%) → use chain.
- Position: 70 bins default, max 1400; each extra bin +112 bytes rent.
