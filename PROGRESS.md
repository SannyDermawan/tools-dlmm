# Progress log

Blueprint: `Blueprint_DLMM_Signal_Engine_Simulator.docx` v1.0. Done: Phase 0–13 (tooling; addendum v1.1 complete). Weight calibration itself waits for data: >= 5 clean data sessions.

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

## Phase 10 — Safety filters, blocklist, pool memory (addendum v1.1 §3) ✅ (code + tests; no live run yet)
- **Jupiter token audit** (`src/collectors/tokenAudit.ts`, collector `token_audit`, every 15 min, one
  batch request per 50 mints): organic score, holders, mcap, launchpad, dev wallet, token / first
  pool age, top holders, dev balance, `isSus`; bot holders + bundlers from the **unofficial** datapi
  (`api.jupiter.use_datapi`). PVP rivals = other mints with the same symbol / name and >= $10k 24 h
  volume. Rows in `token_audit` (migration `007_safety_memory`); readers take the latest row <= t
  younger than `scoring.max_age_seconds.audit` (45 min).
- **Audit gate** (`src/features/auditGate.ts`) on top of the blueprint gate: bot holders > 30%,
  `isSus`, launchpad allow / block lists, token age min / max -> GAGAL; PVP -> penalty / fail /
  ignore; organic score < 50 -> safety-score penalty. Missing audit never vetoes. Bluechip pools
  only check the blocklist. Every veto is tagged with a filter name.
- **Blocklist** (tokens + dev wallets, `dlmm blocklist add|remove|list`): checked first, a blocked
  pool is LEWATI without computing features. Entries are time-stamped and removal is a soft delete,
  so replays of older sessions are not changed by later edits.
- **Automatic rug detection** (`src/features/rugDetector.ts`, `rug_detection`), every scoring
  round: price −50% within 15 min AND −50% liquidity, or the dev balance −50% (audit) -> token and
  dev blocklisted with `source = auto_rug`, effective from that time on. The liquidity measure is
  price-invariant (token reserves of the observed bins valued at the window-start price): a first
  version used USD depth near the active bin and flagged every plain crash as a rug; the test
  caught it.
- **Pool memory + cooldown** (`src/features/memory.ts`, `pool_memory`): closes of `signal_enter`
  drive cooldowns — one low-yield close -> pool cooldown 4 h; 3 out-of-range cohorts in a row
  (the cohort is the unit: its first decisive close counts) -> pool + token cooldown 12 h. Pool
  history features (`pool_hist_net_pct`, `pool_hist_win_rate`) come from clean **baseline**
  positions only (no selection bias). Live sessions persist one row per pool / token at the end;
  readers see a session only after it ended (look-ahead safe). Replays use in-session cooldowns
  but never persist (replays are not new data).
- **Grid dimension `cooldown_enabled`**: signal modes run with and without the cooldown on the
  same combinations (baseline never), stored in `sim_positions.cooldown_enabled`. Note: with the
  default `[true, false]` the signal-mode position count doubles.
- **Decision log**: signals store `risks` (every identified risk, veto or not) and, for MASUK /
  PANTAU, `rejected_candidates` (the round's LEWATI pools with their main reason).
- **Meridian preset** now gets organic score and bot holders from the audit, so presets are no
  longer always `preset_partial` when the audit has data.
- Report: new section "Safety filters, blocklist and pool memory": pools removed per filter,
  signal modes with vs without cooldown, automatic blocklist entries, audit coverage; new
  dimension table "pool cooldown".
- Fixed while wiring: a scorer variable shadowing (`blocked`) that broke every scoring call; the
  blocklist cache keyed by minute (could return a stale "not blocked" within the same minute).
- Tests: `test/phase10.test.ts` (19).
- Verified live (cloud session `c604212c`, 15 min, 8 pools): 4/4 risk tokens audited with organic
  score and bot holders; the blueprint gate vetoed the PARASITE pools (−40% crash during the run)
  and signal_watch avoided them; **meridian_preset ran in full (preset_parsial 0)**.
- Found live: Jupiter search takes comma-separated **mints** only; comma-separated symbols return
  nothing, so PVP rival counts were always empty. Now one search per symbol (test updated).
- Added after the first version: `simulation.avoid_bin_array_init` is honoured (signal modes skip
  ranges needing a new bin array; the baseline still opens and pays); PVP handling variants as
  replay configs (`config/variants/pvp-fail.yaml`, `pvp-ignore.yaml`).

## Phase 11 — Real LP positions of other wallets (addendum 4) ✅
- Sources verified 2026-09-29 against `dlmm.datapi.meteora.ag/api-docs/openapi.json`:
  `/positions/{pool}/pnl?user=` (per wallet: range, deposits, withdrawals, fees, PnL, open / close
  time, closed ones included) and `/positions/{address}/historical` (add / remove / claim events).
  There is no "all positions of a pool" endpoint, so wallets come from chain.
- `RealLpCollector` (`src/collectors/realLp.ts`, in sessions every `real_lp.scan_minutes`, or
  `dlmm lp collect`):
  1. `getProgramAccounts` on the DLMM program, `memcmp` lb_pair, `dataSlice` = owner only →
     `lp_position_sightings`; diffing scans shows positions opened / closed while we watched;
  2. shape of newly opened positions from their on-chain liquidity shares (spot / curve / bidask,
     each side of the price normalized separately — a first version missed two-sided shapes);
  3. wallet queue: wallets of opened / closed positions first, then never-fetched, then stale
     (smart first); positions upserted into `real_lp_positions` (migration `008_real_lp`);
  4. event history of closed positions inside our data → add / remove / claim counts, `simple`;
  5. pool state and our score at their open from our own snapshots.
- Smart LPs: `lp_wallets` (closed positions ≥ 10, win rate ≥ 60%, mean PnL ≥ 1%). Feature
  `smart_lp_present` (competition module, switch `scoring.features.smart_lp`) is look-ahead safe:
  smart status from closes before t, presence = opened ≤ t and not closed by t.
- Realism check (`dlmm lp realism`, report section): simple real positions whose whole life lies in
  one of our data sessions are replayed with the same range, shape, sides, token split and capital;
  fee and PnL (before costs) compared, stored in `sim_realism_checks`.
- Calibration on real positions, kept separate: `dlmm calibrate --source real_lp`.
- Live (cloud, Helius): 8 pools = 10.7k open positions; one in-session scan 14 min after the first
  saw 110 opened / 153 closed, decoded 109 shapes (60 bidask, 46 spot, 3 curve).
- First realism check (validation session `03902546`, 30 min, 8 pools, 0 gaps, ~1.7k Helius
  credits): 17 simple real positions replayed; fee median −0.1%, mean |diff| 16%; PnL −2.7 pp of
  capital, the whole bias from 4 quote-only positions labelled "curve". Cause: shapes were anchored
  on the price at scan time; fixed (price-side edge / price at open). Re-run with every shape
  unknown (spot): fee mean |diff| 210% — the shape matters a lot, so realism is only measured on
  positions scanned with the fixed classifier.
- Tests: `test/phase11.test.ts` (18).

## Phase 12 — Telegram, read-only (addendum 5) ✅ (no bot token here: tested with a fake client)
- `src/notify/` works only from the database, so it runs inside a live session
  (`telegram.in_session`) or alone (`dlmm telegram run`). Bot API 10.3 verified 2026-09-29.
- Notifications: session start / end with the result (baseline vs signal vs preset, best / worst
  strategy and exit policy), MASUK signals above score 80 and confidence 0.7 batched per minute
  (pool, strategy, range, expectations, reasons, risks), alerts (data gap open ≥ 5 min, RPC quota,
  WebSocket down, stale heartbeat, error bursts; each at most once per hour), daily briefing 08:00
  WIB (+ an Indonesian LLM summary when the LLM layer is active).
- Commands `/status /positions /signals /report /stop /help`, accepted only from allowed chat AND
  user ids (`.env`); `/stop` uses the existing clean-stop request. Nothing changes configuration or
  touches funds. Rate limits (min interval, hourly cap never dropping replies), `notifications_log`,
  restart-safe cursors in `telegram_state` (migration `009_telegram`). The token never reaches logs.
- Setup: README "Optional services". Tests: `test/phase12.test.ts` (11).

## Phase 13 — Indicators + conditional LLM layer (addendum 6) ✅
- Indicators from our own 5m OHLCV (15m aggregated), look-ahead safe (only closed candles):
  RSI, Supertrend, Bollinger %B, Fibonacci position → regime features with weight 0 until the grid
  proves them. Grid dimension `entry_filter` (none, supertrend_break, rsi_reversal,
  bollinger_reversion) inside the balanced sample; report section "with vs without filter".
- LLM layer (`src/llm/`), **off** and inactive until 10 clean sessions since phase 10:
  Anthropic SDK (`claude-opus-5-5`, structured outputs, effort `low`, server-side refusal fallback
  `fallbacks: "default"`) or an OpenAI-compatible / local endpoint (temperature 0). Daily budget
  ($1) and hourly cap, cache per role + token + input, sanitized external text as data, strict
  schema validation (invalid output rejected, logged), every call in `llm_calls` (migration
  `010_llm`), prompt version in the config. Roles: token social quality (safety feature) and an
  explainer for the briefing (a narrative role was removed later: no free post source). `dlmm llm status`.
  With / without LLM features: replay variant `config/variants/llm-on.yaml`.
- Not called live (no API key here; every call costs money) — provider request shapes are tested
  with mocked HTTP. Tests: `test/phase13.test.ts` (18). 215 tests total.
- Next per the addendum: after enough sessions, `dlmm calibrate` and `dlmm calibrate --source real_lp`.

## Revisions after the cloud test runs (2026-09-29) ✅
Evidence: sessions `c604212c` (15 min), `03902546` (30 min), `7cf8d3ff` (45 min), 8 pools each,
Helius, 0 data gaps in the last two; realism checks against real LP positions of other wallets.
1. **Swap cost from the aggregator.** Balancing / exit swaps were charged the DLMM pool fee + 0.3%;
   they now use Jupiter round-trip quotes per pool (`SwapQuoteCollector`, every 5 min, $500,
   one-way cost = 1 − √(returned / sent)), capped by the pool fee, fallback 0.5% when no fresh quote,
   margin 0.1% (`simulation.costs.swap_model: aggregator`, `pool` keeps the old model). Stored in
   `swap_quotes` and replayed. Live quotes: bluechip ≈ 0.000–0.003% (old model 0.01–0.1% + 0.3%),
   memecoins 0.25–1.56% (pool fee 0.25–1.88%) — the big correction is on bluechip pools; memecoin
   swaps really are expensive.
2. **Realism after costs** (migration `011_costs_realism`): the replay runs without a balancing
   swap (real LPs deposit what they hold); both sides pay the same open / close transactions.
   One-sided ranges reaching past the price (or ending ≤ 3 bins before it) are replayed instead of
   skipped. The headline uses positions whose shape was read on chain; unknown shapes are reported
   apart. Result (25 known-shape positions): **fee median −8.5%, mean |diff| 9.9%; PnL −0.33 pp of
   capital before costs, −0.34 pp after**. Unknown shapes replayed as spot: fee mean |diff| 162%.
3. **Real LP scans every 5 min** (was 30; ~10 credits per pool per scan): more positions are seen
   while open, so their shape is known.
4. **Cooldown dimension only in sessions ≥ 120 min** (`grid.cooldown_min_session_minutes`); in the
   short sessions it never triggered and only doubled the signal-mode positions.
5. **Baseline uses the first 90 combinations** of the same balanced sample
   (`grid.sampling.baseline_max_combos`); signal modes keep all 180 — lighter load, same pairing.
6. **LLM narrative role removed** (no free post source); returns with a source.
7. **Indicator entry filters on hold** (`grid.entry_filter: [none]`; code and features kept): in a
   30-min session up to half of their evaluations had too few candles.
Not changed on purpose: narrow ranges (5–10 bins) and stop-loss policies were worst in both short
sessions, but two sessions (one −40% crash, one +9% pump) are not enough to drop grid levels —
that decision is left to `dlmm analyze` / `dlmm calibrate` after ≥ 5 sessions of 2 h.
Tests: `test/costs.test.ts` (4); 220 tests total.

## Data gaps: proportional taint, deferred actions, realism stats (2026-09-29, after the first laptop 2 h session)
Session `1b7a58fc` (2 h, 20 pools, 6,449 positions) had 95% of its positions gap-tainted. What
the log showed:
- Every gap was a network outage on the laptop, not rate limiting: there was no HTTP 429 in the
  whole session.
- The logs had "fetch failed" and timeouts on every host at the same moment (Helius, Meteora,
  Jupiter).
- There were about 14 outages of 1–4 min, each hitting all 20 pools. Wi-Fi fully disconnected at
  13:41 and 13:52. The laptop uses a 4G modem (2.4 GHz, signal 65%).

Retry logs now include the network cause hidden behind "fetch failed" (`errText`: ENOTFOUND = DNS,
ECONNRESET, UND_ERR_CONNECT_TIMEOUT...). That tells the next outage apart: DNS, Wi-Fi or the 4G
uplink.

**Taint rule** (`simulation.gap_taint`, `src/sim/taint.ts`). The old rule tainted a position on any
overlap with a gap. The clean set was then only positions that lived about 2 minutes (early
stop-outs), which is a strongly biased sample. A DLMM position's value depends only on the current
active bin, and fees come from the gap-proof bin accumulators. So a gap in the middle of a position
changes neither its fee nor its final value.

A position is now tainted only when:
- **an action happened during a price-data gap**: open, rebalance, partial exit, compound or close
  while `pool_state` was stale. The interval is half-open `[start, end)`, so an action on the fresh
  update that ends a gap stays clean;
- **one gap was longer than `max_single_gap_minutes`** (5): exit rules could not react.

A "share of the life without data" rule exists (`max_fraction`) but is off (1). It is biased:
- **short-lived positions:** with the same gap minutes, positions stopped out early cross it and
  get dropped. At 25% the dropped positions averaged −2.2%.
- **gap sources:** `bin_snapshot` gaps do not make an action stale, because the price comes from
  `pool_state`.

**Deferred actions** (`gap_taint.defer_actions`). Rebalances during a price gap averaged −5.5%.
The simulator re-centred on a stale price, and the position was out of range again when data came
back. A real bot cannot trade without data either. So while a pool's `pool_state` is in a gap the
grid runner and the exit engine now take no action: no entry, rebalance, exit or variant action.
They act on the first fresh update. Other behaviour during and after an outage:
- a cohort due during an outage that stops every pool opens on the first fresh tick;
- a pool that alone is stale gets its entry deferred, keeping its cohort number;
- session-end closes still happen.

**Session 1b7a58fc re-evaluated.** `dlmm sim retaint` recomputes the taint from the journal and
`data_gaps`, without re-simulating.

| | tainted | clean avg net % | baseline | signal_watch | meridian_preset |
|---|--:|--:|--:|--:|--:|
| live run, old rule | 95% | −3.03 (312 positions, avg life 2 min) | | | |
| live run, new rule | 3% | +0.165 | +0.18% | +0.10% | +1.76% (5) |

Replayed with deferred actions (`-c config/session-2h.yaml sim replay`), session `53651a35`:
- 6,797 positions, 3 cohorts, 0.7% tainted;
- clean positions averaged +0.199%;
- baseline +0.10%, signal_watch +0.60%, meridian_preset +1.71% (5 positions);
- the pools the Meridian preset picked were worse than average for identical baseline positions
  (−4.9 pp).

This is one session and proves nothing about strategies.

**Realism stats.** Relative fee differences are only computed when the real fee is material
(≥ 0.01% of the deposit and ≥ $0.01). A real fee of $0.0001 had turned the mean into 16,818,597%.
There is a new column with the fee difference in percentage points of the deposit.

| | median fee diff | mean abs fee diff | PnL diff |
|---|--:|--:|--:|
| shape known (85 material fees) | −0.4% | 13.6% | 0.00 pp (mean abs 0.10) |

Tests: `test/gapTaint.test.ts` (12). `test/phase2.test.ts` › "gap during a position taints it"
still asserts the old any-overlap rule and fails. It must be updated to the new rule (a short
middle gap no longer taints; see `gapTaint.test.ts`).

## Friday's scalp playbook, stage 1 (2026-09-29)
Friday is a manual DLMM trader who shares his playbook. Two things differ from our setup:
- **Pools:** fresh memecoin pools with bin step 100 and base fee 2%.
- **Positions:** Spot, two-sided, 69 bins. He exits on one flow trigger checked every minute,
  closes near 15 min, and exits when the price leaves the range.

Stage 1 makes this testable in the grid; nothing is adopted as a rule. It adds five parts.

**Exit policies.**
- `time_stop` (5 / 15 / 30 min).
- `exit_out_of_range` also at 0 min (exit on the first update out of range).
- `scalp`: time stop, out of range, and an optional stop loss.

**Fresh lane** (`discovery.fresh_lane`). The Meteora API was verified on 2026-09-29: it can filter
on `pool_created_at` (in ms) and `bin_step`, but not on base fee, so base fee is filtered on our
side. The lane:
- finds memecoin pools created in the last 6 h with bin step 100, a base fee of 1–5%, TVL ≥ $1k and
  1 h volume ≥ $2k;
- runs at session start and every 5 min **during** the session;
- takes up to 4 fresh pools at once and 8 added per session, which bounds the RPC budget.

Added pools join every collector: gaps, swap stream, and an immediate security and audit check.
They also get a simulator and a scorer tracker. They enter the current cohort as soon as their data
is complete, instead of waiting up to 30 min for the next cohort. Pools that have no data at cohort
time now enter the same way. At the time of the check, new DLMM pools were rare: 2 in the last hour
with bin step 80–125, with base fees of 1% and 0.8%, not 2%.

**Entry mode `friday_scalp`** (`presets/friday.yaml`, `src/sim/friday.ts`).
- **Screen:** bin step 100, base fee 2% (computed from base_factor × bin_step; widened to a 1–3%
  range on 2026-09-29 because no pool passed at exactly 2% in the live sessions — positions journal
  `base_fee_pct`, so the report can still compare 1 / 2 / 3%), age ≤ 6 h,
  TVL ≥ $1k, no mint or freeze authority. A pool without a security row is skipped.
- **Position:** Spot, two-sided, 34 + 1 + 34 bins, exit `scalp:ts15m:oor0m`.
- **Re-entry:** a new scalp in the same pool 5 min after the previous one closed, up to 6 per pool.
- **Journal:** failures per filter are counted. Positions record trade number, pool age, base fee
  and collect fee mode.
- **Partial:** every position is flagged `preset_partial`. The 1-minute flow confirmation and the
  four flow exits are stage 2.

Reports and Telegram treat it as a baseline, like Meridian.

**First look** (one replay of session 1b7a58fc, established pools, not Friday's kind of pool):

| exit policy | avg net % |
|---|--:|
| hold_to_session_end | +0.69% |
| exit_out_of_range 15 min | +0.19% |
| exit_out_of_range 0 min | −0.10% |
| time_stop 30 min | −0.29% |
| time_stop 5 min | −0.66% |
| time_stop 15 min | −0.95% |

Fixed costs (about 0.3% of capital per round trip) dominate short holds unless the fee capture is
large. That matches his own cost guide: a tracker PnL of +4.1% is needed just to break even. This
is one session and proves nothing.

Tests: `test/friday.test.ts` (11), 242 total. The one failure is the old `test/phase2.test.ts`
taint test (see above).

## Friday's scalp playbook, stage 2: one-minute flow (2026-09-29)
**Pool flow per minute** comes from our own bin snapshots (`PoolTracker.minuteFlow`). It counts every
swap, whether or not the swap stream sampled it.
- **Volume** = LP fee from the bin accumulators ÷ LP fee rate.
- **Net buy** = the change in Y reserves over bins whose supply did not change. Bins whose supply
  changed are excluded, because an LP added or removed liquidity there.
- A minute counts only when snapshots cover at least 80% of it.
- For a pool whose risk token is Y, a Y inflow counts as a sell.

**Token flow per minute** (`token_flow`, collector `collectors.token_flow`): one batch per minute to
Jupiter.
- From tokens v2: holders, plus 5-minute buy and sell stats.
- From the unofficial datapi: bundler holding %.
- Checked live: 15 tokens per request. `bundlerStats.holdingPct` is **already a percentage**
  (values up to 4.3), not a fraction. Phase 10 had stored it ×100; migration `013_bundler_units`
  corrects the old rows, which fed no decision.

**Flow exits** (`src/sim/flow.ts`), Friday's numbers as defaults:
- bundler −2 points in a minute;
- net buy ≤ −$5,000 in the last minute;
- holders −10% vs a minute earlier;
- volume −20% vs the previous minute;
- our relative variant `net_buy_rel`: net sell ≥ 5% of TVL.

How they run:
- Missing data never fires a trigger.
- The first check is one minute after the open.
- `confirm_seconds` (0 = Friday's "no second confirmation") is optional.
- Grid policy `flow_trigger` has one level per trigger plus `all` (his four), so each trigger is
  measured separately. `scalp` can carry a flow exit.

**Entry confirmation** (`flowConfirm`):
- The checks: volume rose in each of the last 2 minutes, net buy > 0 in the current minute, holders
  growing, and bundlers "stable or falling slowly" (−2 to +0.5 points).
- Pool-level checks must have data. A token check without data is skipped and the position is
  flagged partial.
- `friday_scalp` now enters **whenever** the confirmation passes (checked every 30 s), not only at
  cohorts. The grid can use it as `entry_filter: flow_confirm`, which stays off by default.

`friday_scalp` runs the whole playbook. It is `preset_partial` only when a token input was missing.

**First replay** of session 1b7a58fc (established pools):

| flow exit level | positions it closed | avg hold | avg net % |
|---|--:|--:|--:|
| hold_to_session_end (reference) | – | – | +0.96% |
| net_buy −$5,000 | 54% | 39 min | +0.38% |
| net_buy_rel | 4% | – | +0.39% |
| volume −20% | 100% | 2 min | −0.57% |
| all four | 100% | 2 min | −0.59% |

Minute-to-minute volume is noise, so a 20% drop happens almost every minute. That confirms the
concern about this trigger. There was no token data for that session yet, so the holders and
bundler levels behaved like hold and **must not be read** from this replay. It was one session, not
Friday's kind of pool, and proves nothing.

Tests: `test/friday.test.ts` (32 with stage 1); 251 total. The one failure is still the old
`phase2` taint test.

Two noise-robust volume variants are extra grid levels; Friday's original stays:
- `volume_avg3`: the last minute vs the mean of the 3 before;
- `flow:volume:c60s`: the drop must still hold 60 s later.

Replay of 1b7a58fc, clean positions:

| exit level | positions it closed | avg hold | avg net % |
|---|--:|--:|--:|
| net_buy_rel | 3% | – | +0.97% |
| hold_to_session_end (reference) | – | – | +0.65% |
| net_buy | 53% | – | +0.33% |
| volume c60s | 82% | 25 min | −0.32% |
| volume_avg3 | 100% | 5 min | −0.31% |
| volume (Friday) | 100% | 2 min | −0.45% |

Every volume trigger still loses against holding in established pools. Keep them in the grid only
to measure them in fresh pools.

## Stage 3: cost realism (2026-09-29, cloud) ✅
Goal: the simulator should not flatter trades that a real account could not make. All parts are
config switches (`simulation.*`), each one measured in the report.
1. **Price impact by size, taken at the exit.** A swap now pays, on top of the aggregator quote,
   the impact of its size beyond the quoted trade: `V / (depth_factor x TVL) - quote_notional /
   (depth_factor x TVL)` (constant-product depth, `depth_factor` 2, capped at 30%). TVL is the pool's
   TVL **at the moment of the swap** (metrics event), so a pool emptied by a dump makes the exit
   expensive. `exit_to` now defaults to **`quote`**: the tokens left in a position are sold at that
   size and TVL. With `none` a dumped position is marked at the mid price (what the Meteora tracker
   shows); the realism check keeps `none` on purpose. Note: this lowers PnL of every position that
   ends in the risky token, so old and new sessions are not comparable without a replay.
2. **Token-2022 transfer tax** (`costs.transfer_tax`): the token's transfer fee (token_security)
   is charged on every transfer of that token: deposit, withdrawal, claim, and each swap leg (open
   with a balancing swap = 2 transfers of the X part; close with `exit_to: quote` = withdrawal + swap
   leg). Rare on memecoins (1 of 20 tokens had the extension, at 0%); the per-transfer fee cap is ignored.
3. **Collect fee mode: nothing to change.** Checked on live bins: in a quote-only pool
   (PARASITE-SOL, mode 1) `fee_x_per_token` did not move and `fee_y_per_token` did, so the bin fee
   accumulators already carry the mode (swap-event attribution follows it through `feeOnTokenX`). A
   test pins both. The report has a "pool fee mode" dimension.
4. **Size vs liquidity** (`simulation.size_limit`, default `flag`): the position's size as % of the
   pool TVL at the open is journaled; `cap` shrinks it to `max_pct_of_tvl` (2%), `skip` refuses it
   (`oversized_vs_tvl`). Report dimension "size vs TVL at open".
5. **Report:** every table has *tracker %* (PnL before costs, what a tracker shows) and *break-even %*
   (the trade's cost in % of capital); a new section splits both per entry mode and exit policy
   with the cost split (swap, tx, tax, composition, bin array; position rent is refunded and is not a cost).
   Old sessions show ~96% of the cost as swap cost.
Caveat when reading the size table: large positions relative to TVL sit in a few pools (a pump in one
pool made "2-5%" look great in one replay): it is a pool effect, not proof that size helps.
Tests: `test/costsStage3.test.ts` (13).

## Stage 4: event entries and the sequential account (2026-09-29, cloud) ✅
**Event entries for the signal modes** (`grid.signal_entry`, default `cohort` = unchanged):
- `event`: signal modes enter when a pool's signal **turns admitted** (a rising edge to MASUK for
  signal_enter, PANTAU for signal_watch), right at the scoring round, instead of at the next cohort.
  `both`: cohorts and events. Positions carry `entry_trigger`; the report has the table *entry trigger
  (signal modes)* and the event counts (rising edges, entries, what stopped the rest).
- Limits: `min_gap_minutes` per pool and mode between entries (cohort entries count, so the first
  round after a cohort does not double-enter), `max_per_pool` events per session; optional
  `require_flow_confirm` (Friday's one-minute flow confirmation must pass, waiting `flow_wait_minutes`
  while the signal stays admitted). A pool with stale price data is skipped and the edge is seen again
  on the next round. Replay sessions now keep the grid stats in their notes.
- First replay (45 min, 8 pools, one session, pool effects dominate, proves nothing): cohort 700
  positions +2.27% vs event 1,050 positions +2.06% (tracker 2.76% vs 2.63%).
**Sequential account** (`dlmm portfolio`, `src/analysis/portfolio.ts`): a manual trader holds ONE
position at a time; the grid opens hundreds at once. The journal of a chosen mode (and grid
filters `key=value` / `key~prefix`, e.g. `exit_policy~scalp bins_per_side=34`) is replayed as an account:
- takes the next opportunity after it is free (positions opening while busy are skipped; positions
  opening within 60 s of each other are one opportunity, picked by `first` | `random` (seed) | `score`);
- compounding (`--fraction`), trade size cap (`--max-trade`, a bigger swap moves the price and the
  stored % is NOT re-priced), daily stop (`--daily-stop`: no new trades after a realized loss of X% of
  the day's start equity), day boundary WIB or UTC by close time, several sessions chained (`--last N`);
- output: final equity, return, win rate, profit factor, max drawdown (trades and days), longest
  losing streak, best / worst day, positive days, daily Sharpe, the calendar; markdown + trade CSV in
  `reports/portfolio/`. The session report shows it for `portfolio.report_modes` (friday_scalp,
  meridian_preset) once they have 5 sequential trades.
Tests: `test/eventEntry.test.ts` (7), `test/portfolio.test.ts` (9). 282 tests total.

## Playbook revisions: Yunus / EvilPanda (2026-09-29, cloud) ✅
Source: a summary of the public playbooks (tweets, unverified) analysed in the conversation; the
implementation tests the claims, it does not assume them. Seven points, all done:
1. **Range width in price %** (`grid.range_pct`, `wide_range.range_pct`): `binsForRangePct(pct, step)`
   = ln(1-pct)/ln(1/(1+step)) — -50% is 70 bins at step 100 but 693 at step 10. Resolved per pool at the
   open; a level that needs more than `max_bins_per_position` (1400) in a pool is skipped and counted
   (`widthSkips`), never clipped. Defaults 30/50/70/90 (wide_range 50/70/90).
2. **Coin-selection dimensions**: every position journals `range_down_pct`, `range_up_pct`, `pool_age_h`,
   `token_age_h`, `mcap_usd` (Jupiter audit at the entry) and `ath_drawdown_pct`; the session report slices by all
   of them (null = "unknown", never zero).
3. **`yunus_flip` entry mode** (`presets/yunus.yaml`, `src/sim/yunus.ts`): bid-ask quote-only below the price
   (widths 50/70 %, anchored to the price or to the ATH), held WITHOUT a stop loss until fully converted to the
   token, then flipped base-only above the new price (`+up_pct`, up to `max_flips`) as a plain bid-ask or as a
   **70:30 bid-ask : spot mix** (`RangeSpec.blend`, two SDK distributions summed per bin); closes as
   `cycle_complete` when fully back in quote. Screen: pool category, risk token = base X, TVL, mint / freeze
   authority, optional mcap / token age / ATH drawdown thresholds (off by default: the report slices by them).
   One cycle at a time per pool and combination, re-entry after a cooldown (`reentry`). The exit policies of the
   preset are grid levels too (break-even exit vs a plain time-cap hold as the control).
4. **`breakeven_exit` policy**: after the net PnL has been <= -`min_underwater_pct` at some evaluation, close
   as soon as it is back at `target_pct` (0 = break-even after costs); optional `tp_pct` / `sl_pct`; the
   `time_cap_minutes` closes what is left (`time_cap`). Works in any grid, not only Yunus.
5. **ATH** (`src/features/ath.ts`): daily candles back to the pool's start (`collectors.ohlcv.daily_lookback_days`
   365; one pull per pool, the newest days again every 6 h) + 1h + 5m; `AthLookup` is look-ahead safe (closed
   candles only) and cached per pool and 5 min. Checked on stored data: OHLCV close = on-chain price (ratio 1.000).
   ATH is the highest high we can see (a lower bound for pools older than the lookback). The anchor: bottom of the
   range = ATH x (1 - pct); skipped when the price is already below it or less than `min_downside_pct` is left.
6. **Real LP outcomes without survivorship** (`dlmm lp outcomes`, `src/analysis/lpOutcomes.ts`, report section):
   the cohort is every position that OPENED WHILE WE WATCHED (`new_in_scan = 1`), followed to closure. Time to
   close is a Kaplan-Meier estimate on the sightings alone (right-censored at the last scan that saw the position,
   independent of which wallets we queried); PnL is shown for closed positions and for all (open ones at their
   mark) by sides / shape / width / hold time, with the open share next to every number. The wallet fetch queue
   puts the cohort first and the budget went from 40 to 100 per scan. First look at real data (1,550 positions,
   10 h): 44% still open after 1 h, median close 0.5 h, PnL known for only 38% (coverage is the limit); nothing
   about long holds can be said before sessions run for days.
7. **Long-session profile** (`config/session-3d.yaml`): 72 h (or `-d 1440`), reduced sampling, gap thresholds
   scaled to the cadence. Credits MEASURED on a real 20 min run of this profile
   (fresh DB, 12 pools, swap budget scaled to the 72 h pacing): 389 credits in 22 minutes, 617 virtual positions,
   0 gap-tainted. Steady state ~10 credits/min (of which ~4 swap stream, capped by its budget), startup ~61, one real LP
   scan = 140 (14 pools x 10; every 30 min = ~280/h). Extrapolation: ~360/h core + ~280/h scans + ~280/h swap
   budget (20,000 / 72 h) = ~920/h, about 66,000 for 72 h (`session_credit_budget` 90,000). For comparison the default
   profile used 6,337 credits in 62 min (live session, 14 pools). The extrapolation assumes the 20 min steady state
   holds for days; the real check is the first 72 h run. Do not edit config / schema files while a session runs:
   the end-of-session report reloads config from disk and a strict schema of the old code rejects new keys (happened once).
Tests: `test/rangePct.test.ts` (7), `test/yunus.test.ts` (19), `test/ohlcvDaily.test.ts` (5),
`test/lpOutcomes.test.ts` (10), `test/profiles.test.ts` (5). 328 tests total.
Replay check (`dlmm sim replay` on a copy of the DB, 45 min): 44 yunus_flip cycles on 3 memecoin pools; the first
version also opened them in bluechip pairs and where the risk token is the quote side (found by this replay, now
screened out). 45 minutes cannot finish a cycle: every position closed at the session end (censored).
**What this does not prove**: whether the playbook works. It builds the instrument: one sequence of sessions of
24-72 h will show cycles that complete, flips, and break-even exits; compare `yunus_flip` with the baseline on the
same pools and cohorts (report: "group comparison", "pool-selection effect"), and use `dlmm portfolio -m yunus_flip`
for the one-at-a-time account.

## Second laptop 2 h session and the "Fomo / Moby / GMGN" screening playbook (2026-09-30) ✅

Session `16aea039` (2 h, config `session-2h.yaml`): 6161 positions, 0 gap-tainted, 3 fresh pools added mid-session ("fresh pool added" seen live for the first time), `lp realism` fee difference median -2.7 % / PnL difference -0.12 pp before and -0.41 pp after costs. Baseline average -5.0 % (memecoin -5.7 %, bluechip -0.4 %), `yunus_flip` +2.8 pp vs baseline (190 positions, 2 cohorts), `friday_scalp` 7 positions, -3.1 pp (too few).

**Why only three entry modes showed up.**
- `signal_enter` / `signal_watch`: 0 positions. A MASUK signal lasts about a minute (26 MASUK of about 3000 signals) and with `signal_entry.trigger: cohort` the modes look only at the 3 cohort instants; at all three, every pool was LEWATI. `config/session-2h.yaml` now sets `trigger: both` (event entries exist since stage 4).
- `meridian_preset`: evaluated 75, passed 0. The screen (TVL 10-150k, bin step 80-125, fee/TVL, mcap >= 150k, organic >= 60, holders >= 500, top-10 <= 60 %, bot <= 30 %) is strict; the stats now count **why** pools fail (`grid.preset.failed`, in the report notes) so the filter can be judged from data.
- Fresh-lane pools are already in the grid's pool set, so they are evaluated by Meridian, Friday and Yunus without changes.

**Screening playbook of a manual trader (tweet: trending on Fomo, market cap 500k-2M, GMGN / Rugcheck / Bubblemaps, "if all safe, buy").** Analysed for what is testable; nothing was adopted as a rule.
- Every position now journals its token context at entry next to market cap: top-10 holders, holders, organic score, bot holder %, bundler %, and the number of smart LP wallets with an open position in the pool (`smart_lp_open`, null = no real-LP data for the pool) plus all open real positions there (`lp_positions_open`) (`grid_combo`; smart status is look-ahead safe, `SmartLpLookup`). Run `dlmm lp collect` before a session so the pools have real-LP data; the report slices by these. The session report and `analyze` slice by finer market cap buckets (< $500k, $500k-1M, $1-2M, $2-5M, $5-20M, >= $20M) and by top-10 / organic / holders / bundler buckets.
- `dlmm rugs [--lead MIN]`: rug post-mortem. For every token our detector flagged (`blocklist_tokens`, source `auto_rug`) it reads the audit / security / flow rows at least `lead` minutes before the rug and shows which screens (Friday market cap band, Meridian token filters, authorities, token age, bundlers) would have kept a position out, next to the share of the other audited tokens the same screen would also have thrown away.
- First numbers (n = 2 rugs, not significant): SI-SOL (the pool with the highest volume) rugged 1.1 h after token creation with market cap $938k (inside the 500k-2M band), top-10 23 %, 5531 holders, organic 76, bundlers 0.6 %, no authorities: every "looks safe" check passed; only bot holders (31 %) and token age would have caught it. The other rug (ARTHUR-SOL) had no audit row yet (the pool was added 10 min before). Market cap $500k-1M had -22 % on baseline positions and $1-2M -2.4 %, but the first bucket is one pool (192 positions).
- Not done, on purpose: scraping Fomo / Moby / GMGN / Bubblemaps (no official API), trending lists as a signal (no history, hype chasing), an LLM or social sentiment choosing entries, a binary "all safe = enter" rule.
- Data needed: about 5 two-hour sessions on different days / hours for the market cap and top-10 buckets (the unit is the pool, not the position: one pool can be 190 positions), about 20 detected rugs for the screens in `dlmm rugs`. Smart-LP presence is journaled from now on, so sessions before this change cannot be used for it.
- Next (needs more sessions first): smart-LP presence as an entry filter, cluster / funding analysis of holders (only with a stable public source), combined entry mode.

## Cross-checked against 5 external DLMM/LP-agent projects (2026-09-30) ✅

Studied `fciaf420/meridian` (fork of `yunus-0x/meridian`, live LLM-driven agent), `irfndi/prism-liquidity-agent`
(rule-based live agent, LLM optional as a confidence-lowering overlay only), `DeltaLogicLabs/Mantis` (near-sibling
of Prism, but Claude decides every cycle), and `hummingbot/hummingbot` (general market-making framework, has a
Meteora CLMM connector). None run an LLM as anything more than an optional veto/overlay in the non-Meridian/Mantis
projects; Meridian and Mantis let an LLM decide entries/exits live, which we do not adopt (our own rule: LLM never
decides entry/exit/size). Six concrete, data-ready ideas implemented:

- **Volume authenticity score** (`src/features/poolQuality.ts:volumeAuthenticity`, prism-liquidity-agent /
  Mantis): 0–1 score from volume/TVL ratio, pool fee-rate band, and volume on thin TVL. Journaled per position
  (`grid_combo.volume_auth_score`, config `simulation.volume_authenticity`), not yet a hard filter.
- **Gas-aware rebalance gate** extended from `exit_engine` to `rebalance_out_of_range` (prism-liquidity-agent's
  gas-aware rebalance): skip the rebalance (close instead) when its cost >= the pool's expected fee income.
  New close reason `rebalance_out_of_range:rebalance_not_worth`, flag `simulation.gas_aware_rebalance` (default
  on). Directly relevant to the $40 capital question: this is exactly the kind of fixed-cost-vs-income check
  that protects a small position from repeated rebalance churn.
- **`min_token_fees_sol`** added to the Meridian preset (config.js `minTokenFeesSol`: all-time gas a token's
  traders have paid; low -> bundled/spam suspicion). Reproducible from `token_audit.fees_sol`, which we already
  collect; wired through `AuditRow` -> `presetInputsOf` -> `evaluateMeridian`. Off (null) by default.
- **Bin-utilization filter** (`min_bin_utilization`, Mantis `MIN_BIN_UTILIZATION`): share of bins in
  `[lower, upper]` with non-zero supply at the latest snapshot; low means liquidity clumped into a narrow band,
  which breaks the uniform-distribution assumption a Spot/wide-range IL model relies on. Journaled on every
  position too (`grid_combo.bin_utilization`). Off by default.
- **`max_volatility` / `max_price_change_pct`** added to the Meridian preset (config.js has both; ours was
  missing them). Ours is our own proxy (stddev of log returns over the fee window, %), not a byte-for-byte port
  of Meridian's internal volatility feature (units undocumented). Off by default.
- **IL formula cross-checked against Mantis's closed-form CPMM approximation**
  (`r=(1+binStep/10000)^binsDrifted; IL=2√r/(1+r)-1`): no change needed. Ours is computed directly as
  `valueUsd - hodlUsd` from the actual simulated bin composition and price path, which is exact for our shapes
  (spot/curve/bidask) rather than an approximation assuming a single global CPMM curve; the closed form is only
  a fast real-time estimate for a project that doesn't simulate bin composition.

Also corrected, not changed: `presets/meridian.yaml`'s `max_top10_pct` (60) / `max_bot_holders_pct` (30) do not
match the fork's current base (Meteora) screening path, which has no top10/bot-holder check at all — only its
optional GMGN path does, at 50% / 40%. Left as is (documented in the preset's comments): these are our own
screening levels to test, not a claim of matching upstream exactly, and changing them is a judgement call, not
a bug fix.

New report dimensions (session report + `analyze`): volume authenticity score, bin utilization, realized
volatility, all bucketed like the other entry-context fields. 346/346 tests pass (`test/poolQuality.test.ts` new,
`test/phase5.test.ts` and `test/phase9.test.ts` extended).

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
