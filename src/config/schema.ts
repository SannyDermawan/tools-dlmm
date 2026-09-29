import { z } from "zod";

const retry = z
  .object({
    max_attempts: z.number().int().min(1),
    base_delay_ms: z.number().int().min(0),
    max_delay_ms: z.number().int().min(0),
  })
  .strict();

const pos = z.number().positive();
const nonneg = z.number().min(0);
const pct = z.number().min(0).max(100);
const frac = z.number().min(0).max(1);
const collector = <T extends z.ZodRawShape>(shape: T) =>
  z.object({ enabled: z.boolean(), ...shape }).strict();

export const STRATEGIES = ["spot", "curve", "bidask"] as const;
export const SIDES = ["two_sided", "base_only", "quote_only"] as const;
export const CATEGORIES = ["memecoin", "bluechip"] as const;
export const ENTRY_MODES = ["all_pools_baseline", "meridian_preset", "friday_scalp", "signal_enter", "signal_watch"] as const;
export const OHLCV_TIMEFRAMES = ["5m", "30m", "1h", "2h", "4h", "12h", "24h"] as const;

const numOrList = z.union([z.number().positive(), z.array(z.number().positive()).min(1)]);
const nonnegOrList = z.union([z.number().min(0), z.array(z.number().min(0)).min(1)]);
export const VARIANTS = ["none", "partial_harvest", "fee_compounding", "single_sided_reseed", "wide_range"] as const;

// Friday playbook, stage 2: one-minute flow triggers (defaults = Friday's numbers)
const FLOW_TRIGGER_NAMES = ["bundler", "net_buy", "net_buy_rel", "holders", "volume", "volume_avg3"] as const;
const flowThresholds = {
  bundler_drop_pp: nonneg.default(2),
  net_buy_usd: nonneg.default(5000),
  net_buy_tvl_pct: nonneg.default(5),
  holders_drop_pct: nonneg.default(10),
  volume_drop_pct: nonneg.default(20),
  min_prev_volume_usd: nonneg.default(0),
  confirm_seconds: nonneg.default(0),
};

const exitPolicy = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hold_to_session_end") }).strict(),
  // minutes 0 = exit on the first update out of range (Friday playbook); a list gives several levels
  z.object({ type: z.literal("exit_out_of_range"), minutes: nonnegOrList }).strict(),
  z
    .object({
      type: z.literal("rebalance_out_of_range"),
      minutes: pos,
      max_rebalances: z.number().int().min(1),
    })
    .strict(),
  z.object({ type: z.literal("exit_engine"), minutes: pos, max_rebalances: z.number().int().min(0) }).strict(),
  // ---- addendum v1.1 (phase 9); list values expand into several grid policies
  z.object({ type: z.literal("take_profit"), pct: numOrList, basis: z.enum(["net", "fee"]).default("net") }).strict(),
  z.object({ type: z.literal("stop_loss"), pct: numOrList }).strict(),
  z
    .object({
      type: z.literal("trailing_tp"),
      trigger_pct: numOrList,
      drop_pct: numOrList,
      confirm_seconds: nonneg.default(15),
      tolerance_pct: nonneg.default(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("tp_sl_combo"),
      tp_pct: pos.optional(),
      tp_fee_pct: pos.optional(),
      sl_pct: pos,
      trigger_pct: pos.optional(),
      drop_pct: pos.optional(),
      confirm_seconds: nonneg.default(15),
      tolerance_pct: nonneg.default(1),
      oor_minutes: pos.optional(),
    })
    .strict(),
  z.object({ type: z.literal("low_yield_exit"), min_fee_pct_per_hour: nonneg, window_minutes: pos, min_age_minutes: nonneg }).strict(),
  // ---- Friday playbook (stage 1): time stop, and the scalp combination (time stop + out-of-range)
  z.object({ type: z.literal("time_stop"), minutes: numOrList }).strict(),
  z
    .object({
      type: z.literal("scalp"),
      time_stop_minutes: pos,
      oor_minutes: nonneg,
      sl_pct: pos.optional(),
      flow: z.object({ triggers: z.array(z.enum(FLOW_TRIGGER_NAMES)).min(1), ...flowThresholds }).strict().optional(),
    })
    .strict(),
  // each entry of `sets` is one grid level: a single trigger, or `all` = Friday's four (any of)
  z
    .object({
      type: z.literal("flow_trigger"),
      sets: z.array(z.enum([...FLOW_TRIGGER_NAMES, "all"])).min(1),
      ...flowThresholds,
      time_stop_minutes: pos.optional(),
    })
    .strict(),
]);

const opCounts = z
  .object({ open: nonneg, close: nonneg, rebalance: nonneg, claim: nonneg, add: nonneg, swap: nonneg })
  .strict();

const MODULES = ["edge", "regime", "flow", "attention", "competition", "safety"] as const;
const moduleWeights = z.object(Object.fromEntries(MODULES.map((m) => [m, nonneg])) as Record<(typeof MODULES)[number], typeof nonneg>).strict();
const REGIMES = ["sideways", "volatile_no_direction", "trending_up", "trending_down", "chaos"] as const;
const stratChoice = z.object({ strategy: z.enum(STRATEGIES), sides: z.enum(SIDES) }).strict();

const ScoringSchema = z
  .object({
    enabled: z.boolean(),
    interval_seconds: pos,
    window_minutes: pos,
    depth_bins: z.number().int().min(0),
    max_age_seconds: z.record(z.string(), pos),
    normalization: z
      .object({
        cross_weight: frac,
        min_history_points: z.number().int().min(1),
        history_points: z.number().int().min(10),
        winsor_pct: z.tuple([pct, pct]),
      })
      .strict(),
    features: z
      .object({
        min_swap_coverage: frac, min_flow_samples: z.number().int().min(1), min_price_minutes: pos, er_minutes: pos, markout_seconds: pos, whale_swap_usd: pos,
        smart_lp: z.boolean().default(true), // phase 11: smart LP presence feature (competition module)
      })
      .strict(),
    edge: z
      .object({
        horizon_minutes: pos,
        paths: z.number().int().min(10),
        drift_per_hour: z.number(),
        fee_offsets: z.number().int().min(0),
        max_score_if_nonpositive: pct,
        seed: z.number().int(),
        capital_usd: pos,
      })
      .strict(),
    regime: z
      .object({
        er_low: frac,
        er_trend: frac,
        z_trend: pos,
        vol_high_per_hour: pos,
        vol_extreme_per_hour: pos,
        scores: z.object(Object.fromEntries(REGIMES.map((r) => [r, pct])) as Record<(typeof REGIMES)[number], typeof pct>).strict(),
        sol_trend_penalty: nonneg,
        btc_trend_penalty: nonneg,
        strategy_map: z.object(Object.fromEntries(REGIMES.map((r) => [r, stratChoice])) as Record<(typeof REGIMES)[number], typeof stratChoice>).strict(),
      })
      .strict(),
    safety_gate: z
      .object({
        fail_on_mint_authority: z.boolean(),
        fail_on_freeze_authority: z.boolean(),
        max_top10_pct: pct,
        max_cluster_pct: pct,
        max_dev_rugs: z.number().int().min(1),
        min_tvl_usd: nonneg,
        max_transfer_fee_pct: pct,
        dead_token_market_cap_usd: nonneg,
        // ---- addendum v1.1 phase 10 (Jupiter audit, launchpad, token age, PVP, blocklist)
        max_bot_holders_pct: pct,
        fail_on_sus: z.boolean(),
        organic: z.object({ min_score: pct, penalty: pct }).strict(),
        launchpad: z.object({ allow: z.array(z.string()), block: z.array(z.string()) }).strict(),
        token_age_hours: z.object({ min: nonneg.nullable(), max: nonneg.nullable() }).strict(),
        pvp: z.object({ mode: z.enum(["penalty", "fail", "ignore"]), penalty: pct }).strict(),
        blocklist: z.boolean(),
        missing_data: z.object({ memecoin: z.enum(["fail", "lower_confidence"]), bluechip: z.enum(["fail", "lower_confidence"]) }).strict(),
      })
      .strict(),
    context: z
      .object({
        macro_window_minutes: nonneg,
        macro_multiplier: frac,
        priority_fee_p75_threshold: nonneg,
        congestion_multiplier: frac,
        low_volume_hour_multiplier: frac,
        low_volume_hour_min_days: pos,
        low_volume_hour_ratio: frac,
        blocking_gap_sources: z.array(z.string()),
        floor: frac,
      })
      .strict(),
    modules: z.object(Object.fromEntries(MODULES.map((m) => [m, z.boolean()])) as Record<(typeof MODULES)[number], z.ZodBoolean>).strict(),
    weights: z.record(z.string(), z.object({ memecoin: moduleWeights, bluechip: moduleWeights }).strict()),
    thresholds: z.object({ enter: pct, watch: pct }).strict(),
    confidence: z.object({ min_for_enter: frac }).strict(),
  })
  .strict();

export const ConfigSchema = z
  .object({
    config_label: z.string().min(1),
    app: z
      .object({
        db_path: z.string().min(1),
        log_dir: z.string().min(1),
        log_level: z.enum(["trace", "debug", "info", "warn", "error"]),
        log_rotate: z
          .object({
            frequency: z.enum(["daily", "hourly"]),
            size: z.string().regex(/^\d+[kmg]$/),
            keep_files: z.number().int().min(1),
          })
          .strict(),
        status_interval_seconds: pos,
      })
      .strict(),
    rpc: z
      .object({
        http_url_env: z.string().min(1),
        ws_url_env: z.string().min(1),
        commitment: z.enum(["processed", "confirmed", "finalized"]),
        max_rps: pos,
        max_concurrency: z.number().int().min(1),
        request_timeout_ms: z.number().int().min(1000),
        retry,
        quota: z
          .object({
            credit_limit: pos,
            credits_used_before_session: nonneg,
            warn_at_pct: pct,
            session_credit_budget: pos,
            method_credits: z.record(z.string(), nonneg),
          })
          .strict(),
        ws: z
          .object({
            heartbeat_seconds: pos,
            reconnect_base_delay_ms: z.number().int().min(0),
            reconnect_max_delay_ms: z.number().int().min(0),
          })
          .strict(),
      })
      .strict(),
    api: z
      .object({
        meteora_base_url: z.url(),
        max_rps: pos,
        request_timeout_ms: z.number().int().min(1000),
        retry,
        rugcheck_base_url: z.url(),
        rugcheck_max_rps: pos,
        dexscreener_base_url: z.url(),
        coingecko_base_url: z.url(),
        fear_greed_url: z.url(),
        fx_url: z.url(),
        defillama_base_url: z.url(),
        defillama_stables_url: z.url(),
        public_max_rps: pos,
        jupiter: z
          .object({
            tokens_base_url: z.url(),
            keyed_tokens_base_url: z.url(),
            swap_base_url: z.url(),
            keyed_swap_base_url: z.url(),
            datapi_base_url: z.url(),
            use_datapi: z.boolean(),
            max_rps: pos,
            batch_size: z.number().int().min(1).max(100),
          })
          .strict(),
      })
      .strict(),
    discovery: z
      .object({
        max_pools: z.number().int().min(1),
        min_tvl_usd: nonneg,
        min_volume_1h_usd: nonneg,
        min_pool_age_minutes: nonneg,
        exclude_blacklisted: z.boolean(),
        sort_by: z.string().min(1),
        candidate_page_size: z.number().int().min(1).max(1000),
        include_categories: z.array(z.enum(CATEGORIES)).min(1),
        pool_allowlist: z.array(z.string()),
        pool_denylist: z.array(z.string()),
        recheck_params_minutes: pos,
        // Friday playbook: a second lane for freshly created memecoin pools (on top of max_pools)
        fresh_lane: z
          .object({
            enabled: z.boolean(),
            max_pools: z.number().int().min(0),
            max_added_per_session: z.number().int().min(0),
            refresh_minutes: pos,
            min_age_minutes: nonneg,
            max_age_minutes: pos,
            bin_steps: z.array(z.number().int().min(1)).min(1),
            min_base_fee_pct: nonneg,
            max_base_fee_pct: pos,
            min_tvl_usd: nonneg,
            min_volume_1h_usd: nonneg,
          })
          .strict(),
      })
      .strict(),
    categories: z
      .object({
        bluechip_tokens: z.array(z.string()),
        usd_stable_tokens: z.array(z.string()),
      })
      .strict(),
    collectors: z
      .object({
        pool_state: collector({ interval_seconds: pos }),
        bin_snapshot: collector({
          interval_seconds: pos,
          bins_each_side: z.number().int().min(1).max(700),
          keyframe_every: z.number().int().min(1),
        }),
        pool_metrics: collector({ interval_seconds: pos }),
        swap_stream: collector({
          mode: z.enum(["sample", "full"]),
          sample_per_minute: pos,
          max_rps: pos,
          max_concurrency: z.number().int().min(1),
          include_categories: z.array(z.enum(CATEGORIES)),
          include_pools: z.array(z.string()),
          exclude_pools: z.array(z.string()),
          credit_budget: pos,
          pacing: z.boolean(),
          pacing_burst_pct: pct,
          backfill_interval_seconds: pos,
          backfill_page_limit: z.number().int().min(1).max(1000),
          max_queue: z.number().int().min(1),
          tx_concurrency: z.number().int().min(1),
          dedupe_cache_size: z.number().int().min(1000),
        }),
        ohlcv: collector({
          timeframes: z.array(z.enum(OHLCV_TIMEFRAMES)).min(1),
          interval_seconds: pos,
          warmup_hours: nonneg,
          refresh_lookback_minutes: pos,
        }),
        token_security: collector({
          interval_minutes: pos,
          skip_bluechip_holders: z.boolean(),
          use_rugcheck: z.boolean(),
        }),
        token_flow: collector({ interval_seconds: pos, max_age_seconds: pos }),
        token_audit: collector({
          interval_minutes: pos,
          pvp: z.object({ enabled: z.boolean(), min_rival_volume_24h_usd: nonneg }).strict(),
        }),
        ecosystem: collector({ interval_seconds: pos, sol_price_pool: z.string().min(32) }),
        venues: collector({ interval_seconds: pos }),
        attention: collector({ interval_seconds: pos }),
        macro: collector({ interval_seconds: pos }),
      })
      .strict(),
    gaps: z
      .object({
        watchdog_interval_seconds: pos,
        stale_after_seconds: z.record(z.string(), pos),
      })
      .strict(),
    simulation: z
      .object({
        virtual_capital_usd: pos,
        entry_delay_seconds: nonneg,
        fee_attribution: z.enum(["accumulator", "swap_events"]),
        starting_asset: z.enum(["quote", "as_needed"]),
        two_sided_x_value_fraction: z.union([z.literal("auto"), frac]),
        exit_to: z.enum(["none", "quote"]),
        fee_event_interval_seconds: pos,
        pnl_eval_seconds: pos,
        gap_taint: z
          .object({
            mode: z.enum(["proportional", "any_overlap"]),
            max_fraction: frac,
            max_single_gap_minutes: pos,
            action_sources: z.array(z.string()).min(1),
            defer_actions: z.boolean(),
          })
          .strict(),
        avoid_bin_array_init: z.boolean(),
        max_bins_per_position: z.number().int().min(1),
        costs: z
          .object({
            base_fee_lamports_per_signature: nonneg,
            signatures: opCounts,
            compute_units: opCounts,
            priority_fee_percentile: pct,
            priority_fee_floor_micro_lamports: nonneg,
            tx_failure_rate: frac,
            slippage_margin_pct: nonneg,
            swap_model: z.enum(["aggregator", "pool"]),
            aggregator: z
              .object({ quote_notional_usd: pos, quote_interval_minutes: pos, fallback_cost_pct: nonneg, max_quote_age_minutes: pos })
              .strict(),
            position_base_rent_sol: nonneg,
            position_default_bins: z.number().int().min(1),
            bins_per_tx: z.number().int().min(1),
            position_extra_bin_bytes: nonneg,
            rent_lamports_per_byte: nonneg,
            position_rent_refundable: z.boolean(),
            bin_array_init_sol: nonneg,
            bin_array_rent_refundable: z.boolean(),
          })
          .strict(),
      })
      .strict(),
    reconcile: z.object({ api_lag_minutes: nonneg, tolerance_pct: pos }).strict(),
    session: z
      .object({
        duration_minutes: pos,
        warmup_minutes: nonneg,
        stop_new_positions_before_end_minutes: nonneg,
        label: z.string(),
      })
      .strict(),
    grid: z
      .object({
        strategies: z.array(z.enum(STRATEGIES)).min(1),
        bins_per_side: z.array(z.number().int().min(0)).min(1),
        sides: z.array(z.enum(SIDES)).min(1),
        exit_policies: z.array(exitPolicy).min(1),
        entry_modes: z.array(z.enum(ENTRY_MODES)).min(1),
        variants: z.array(z.enum(VARIANTS)).min(1).default(["none"]),
        variant_params: z
          .object({
            partial_harvest: z.object({ trigger_return_pct: pos, fraction: frac }).strict(),
            fee_compounding: z.object({ min_fee_usd: pos, every_minutes: pos }).strict(),
            single_sided_reseed: z.object({ max_reseeds: z.number().int().min(1) }).strict(),
            wide_range: z.object({ bins_per_side: z.array(z.number().int().min(1)).min(1), strategy: z.enum(STRATEGIES) }).strict(),
          })
          .strict(),
        sampling: z
          .object({
            mode: z.enum(["full", "balanced"]),
            max_combos: z.number().int().min(1),
            baseline_max_combos: z.number().int().min(1).nullable().default(null),
            seed: z.number().int(),
          })
          .strict(),
        cooldown_enabled: z.array(z.boolean()).min(1).default([false]),
        cooldown_min_session_minutes: nonneg.default(0),
        entry_filter: z.array(z.enum(["none", "supertrend_break", "rsi_reversal", "bollinger_reversion", "flow_confirm"])).min(1).default(["none"]),
        cohort_interval_minutes: nonneg,
        max_positions: z.number().int().min(1),
      })
      .strict(),
    weights_profile: z.string(),
    presets: z.object({ meridian: z.string(), friday: z.string() }).strict(),
    memory: z
      .object({
        cooldown: z
          .object({
            low_yield_hours: nonneg,
            oor_consecutive: z.number().int().min(1),
            oor_hours: nonneg,
            modes: z.array(z.string()).min(1),
          })
          .strict(),
        min_positions_for_features: z.number().int().min(1),
      })
      .strict(),
    indicators: z
      .object({
        enabled: z.boolean(),
        timeframes: z.array(z.enum(["5m", "15m", "30m", "1h"])).min(1),
        rsi_period: z.number().int().min(2),
        rsi_low: pct,
        rsi_high: pct,
        bb_period: z.number().int().min(2),
        bb_k: pos,
        st_period: z.number().int().min(2),
        st_mult: pos,
        fib_lookback: z.number().int().min(5),
        filter_timeframe: z.enum(["5m", "15m", "30m", "1h"]),
        filter_lookback_bars: z.number().int().min(1),
      })
      .strict(),
    llm: z
      .object({
        enabled: z.boolean(),
        provider: z.enum(["anthropic", "openai_compatible", "local"]),
        model: z.string().min(1),
        base_url: z.string().nullable(),
        api_key_env: z.string().min(1),
        effort: z.enum(["low", "medium", "high", "xhigh", "max"]),
        temperature: z.number().min(0).max(2),
        max_tokens: z.number().int().min(256),
        timeout_ms: pos,
        price_per_mtok: z.object({ input: nonneg, output: nonneg }).strict(),
        daily_budget_usd: nonneg,
        max_calls_per_hour: z.number().int().min(0),
        prompt_version: z.string().min(1),
        cache_hours: nonneg,
        max_input_chars: z.number().int().min(200),
        activation: z.object({ min_clean_sessions: z.number().int().min(0), since: z.string(), max_gap_minutes: nonneg }).strict(),
        roles: z
          .object({ token_social: z.boolean(), explainer: z.boolean() })
          .strict(),
        use_in_scoring: z.boolean(),
        interval_minutes: pos,
        max_tokens_per_round: z.number().int().min(1),
      })
      .strict(),
    telegram: z
      .object({
        enabled: z.boolean(),
        in_session: z.boolean(),
        min_signal_score: pct,
        min_confidence: frac,
        signal_actions: z.array(z.string()).min(1),
        daily_briefing_time_wib: z.string().regex(/^\d{2}:\d{2}$/),
        poll_seconds: pos,
        batch_seconds: pos,
        min_interval_seconds: nonneg,
        max_messages_per_hour: z.number().int().min(1),
        alerts: z
          .object({
            gap_minutes: pos,
            quota_pct: pct,
            ws_down_minutes: pos,
            heartbeat_stale_minutes: pos,
            repeat_minutes: pos,
          })
          .strict(),
      })
      .strict(),
    real_lp: z
      .object({
        enabled: z.boolean(),
        scan_minutes: pos,
        max_wallet_queries_per_scan: z.number().int().min(0),
        max_pages_per_wallet: z.number().int().min(1),
        refetch_hours: nonneg,
        fetch_events: z.boolean(),
        max_event_fetches_per_scan: z.number().int().min(0),
        shape_for_new_positions: z.boolean(),
        smart: z
          .object({ min_closed_positions: z.number().int().min(1), min_win_rate: frac, min_avg_pnl_pct: z.number() })
          .strict(),
        realism: z
          .object({ max_single_add_gap_seconds: nonneg, min_duration_minutes: nonneg, max_checks: z.number().int().min(1) })
          .strict(),
      })
      .strict(),
    rug_detection: z
      .object({
        enabled: z.boolean(),
        price_drop_pct: pct,
        window_minutes: pos,
        lp_withdrawal_pct: pct,
        dev_dump_pct: pct,
      })
      .strict(),
    scoring: ScoringSchema,
    signals: z
      .object({
        enter_action: z.enum(["MASUK", "PANTAU", "LEWATI"]),
        watch_action: z.enum(["MASUK", "PANTAU", "LEWATI"]),
        max_signal_age_seconds: pos,
        size: z.object({ base_fraction: frac, max_fraction: frac, watch_fraction: frac }).strict(),
      })
      .strict(),
    calibration: z
      .object({
        entry_modes: z.array(z.enum(ENTRY_MODES)).min(1),
        min_sessions: z.number().int().min(1),
        min_observations: z.number().int().min(1),
        holdout_sessions: z.number().int().min(0),
        min_train_sessions: z.number().int().min(1),
        ridge_lambda: nonneg,
        selection_top_pct: pct,
        min_spearman_gain: z.number(),
        missing_score: pct,
      })
      .strict(),
    exit_engine: z
      .object({
        min_age_minutes: nonneg,
        whale_sell_pct_supply: pos,
        whale_window_minutes: pos,
        lp_withdrawal_pct: pct,
        lp_window_minutes: pos,
        lp_withdrawal_action: z.enum(["partial", "exit"]),
        partial_fraction: frac,
        min_fee_pct_per_hour: nonneg,
        fee_window_minutes: pos,
        il_fee_ratio: pos,
        il_min_usd: nonneg,
        regime_against: z.boolean(),
        regime_min_x_share: frac,
        rebalance_cost_check: z.boolean(),
      })
      .strict(),
  })
  .strict()
  .superRefine((c, ctx) => {
    const widest = Math.max(...c.grid.bins_per_side);
    if (c.collectors.bin_snapshot.bins_each_side < widest) {
      ctx.addIssue({
        code: "custom",
        path: ["collectors", "bin_snapshot", "bins_each_side"],
        message: `must be >= widest grid range (${widest}) so every virtual bin is observed`,
      });
    }
    const wideMax = c.grid.variants.includes("wide_range") ? Math.max(...c.grid.variant_params.wide_range.bins_per_side) : 0;
    if (2 * wideMax + 1 > c.simulation.max_bins_per_position) {
      ctx.addIssue({
        code: "custom",
        path: ["grid", "variant_params", "wide_range", "bins_per_side"],
        message: `2*${wideMax}+1 bins exceeds max_bins_per_position`,
      });
    }
    if (2 * widest + 1 > c.simulation.max_bins_per_position) {
      ctx.addIssue({
        code: "custom",
        path: ["grid", "bins_per_side"],
        message: `2*${widest}+1 bins exceeds max_bins_per_position`,
      });
    }
    if (!c.scoring.weights[c.weights_profile]) {
      ctx.addIssue({ code: "custom", path: ["weights_profile"], message: `no scoring.weights.${c.weights_profile}` });
    }
    if (c.scoring.regime.er_low > c.scoring.regime.er_trend) {
      ctx.addIssue({ code: "custom", path: ["scoring", "regime"], message: "er_low must be <= er_trend" });
    }
    if (c.session.warmup_minutes + c.session.stop_new_positions_before_end_minutes >= c.session.duration_minutes) {
      ctx.addIssue({ code: "custom", path: ["session"], message: "warm-up + stop window leaves no active phase" });
    }
  });

export type Config = z.infer<typeof ConfigSchema>;
export type Strategy = (typeof STRATEGIES)[number];
export type Sides = (typeof SIDES)[number];
export type PoolCategory = (typeof CATEGORIES)[number];
export type ExitPolicy = z.infer<typeof exitPolicy>;
export type ScoringConfig = Config["scoring"];
export type ModuleName = (typeof MODULES)[number];
export type RegimeLabel = (typeof REGIMES)[number];
export { MODULES, REGIMES };
