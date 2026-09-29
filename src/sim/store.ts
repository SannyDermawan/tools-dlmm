import type { Db, Row } from "../db/index.ts";
import type { PositionResult, SimEvent, SimSink } from "./engine.ts";
import type { VirtualPosition } from "./position.ts";

/** Journals virtual positions to sim_positions / sim_position_events / sim_results. */
export class DbSimSink implements SimSink {
  private events: Row[] = [];

  constructor(private readonly db: Db, private readonly sessionId: string, private readonly configVersion: string, private readonly flushEvery = 2000) {}

  private row(p: VirtualPosition): Row {
    return {
      position_id: p.id,
      session_id: this.sessionId,
      signal_id: p.spec.signalId ?? null,
      pool: p.pool,
      grid_combo: JSON.stringify(p.spec.combo),
      entry_mode: p.spec.entryMode,
      strategy: p.spec.strategy,
      sides: p.spec.sides,
      bins_below: p.spec.binsBelow,
      bins_above: p.spec.binsAbove,
      lower_bin: p.status === "pending" ? null : p.lower,
      upper_bin: p.status === "pending" ? null : p.upper,
      capital_usd: p.spec.capitalUsd,
      requested_at: p.requestedAt,
      opened_at: p.openedAt,
      closed_at: p.closedAt,
      close_reason: p.closeReason,
      gap_tainted: p.gapTainted ? 1 : 0,
      config_version: this.configVersion,
      status: p.status,
      exit_policy_params: JSON.stringify(p.spec.exitPolicy ?? { type: "hold_to_session_end" }),
      strategy_params: JSON.stringify({ variant: p.spec.variant ?? "none", ...((p.spec.combo.variant_params as object | undefined) ?? {}) }),
      cooldown_enabled: null,
      entry_filter: (p.spec.combo.entry_filter as string | undefined) ?? "none",
    };
  }

  positionCreated(p: VirtualPosition) {
    this.db.insert("sim_positions", this.row(p));
  }

  positionUpdated(p: VirtualPosition) {
    this.db.insert("sim_positions", this.row(p), "OR REPLACE");
  }

  event(e: SimEvent) {
    this.events.push({ position_id: e.positionId, ts: e.ts, type: e.type, detail: JSON.stringify(e.detail) });
    if (this.events.length >= this.flushEvery) this.flush();
  }

  result(_p: VirtualPosition, r: PositionResult) {
    this.flush();
    this.db.insert(
      "sim_results",
      {
        position_id: r.positionId, fee_usd: r.feeUsd, fee_x_ui: r.feeXUi, fee_y_ui: r.feeYUi, il_usd: r.ilUsd,
        cost_usd: r.costUsd, rent_locked_usd: r.rentLockedUsd, net_pnl_usd: r.netPnlUsd, net_pnl_pct: r.netPnlPct,
        time_in_range_pct: r.timeInRangePct, duration_min: r.durationMin, max_drawdown_usd: r.maxDrawdownUsd,
        max_drawdown_pct: r.maxDrawdownPct, final_value_usd: r.finalValueUsd, hodl_value_usd: r.hodlValueUsd,
        entry_price: r.entryPrice, exit_price: r.exitPrice, detail: JSON.stringify(r.detail),
      },
      "OR REPLACE",
    );
  }

  flush() {
    const rows = this.events;
    this.events = [];
    this.db.insertMany("sim_position_events", rows);
  }
}
