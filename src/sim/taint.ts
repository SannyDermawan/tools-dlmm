/**
 * Gap taint (blueprint 17 / data quality). A DLMM position's value is a function of the current
 * active bin only and fees come from the cumulative bin accumulators, so a short data gap in the
 * middle of a position changes neither its fee nor its final value. What a gap can spoil:
 *  - an action taken while the data was stale (open, rebalance, partial exit, compound, reseed,
 *    close — including a policy exit that fired late or at a stale price);
 *  - a long gap (exit rules could not react for minutes);
 *  - a position that spent a large share of its life without data.
 * Mode `any_overlap` keeps the original rule (any overlap taints) for comparison.
 */

/** Sources whose gaps matter for a position (swap_stream only when fees come from swap events). */
export const TAINT_SOURCES = ["pool_state", "bin_snapshot", "pool_metrics"];
export const taintSource = (source: string, feeAttribution: string) =>
  TAINT_SOURCES.includes(source) || (source === "swap_stream" && feeAttribution === "swap_events");

export interface GapInterval {
  source: string;
  start: number;
  end: number | null; // null: still open
}

export interface GapTaintConfig {
  mode: "proportional" | "any_overlap";
  /** gaps of these sources make an action stale (default: pool_state = price data) */
  action_sources?: string[];
  max_fraction: number; // share of the position's life without data
  max_single_gap_minutes: number;
}

export interface TaintVerdict {
  tainted: boolean;
  reason: string | null; // action_during_gap | long_gap | gap_fraction | overlap
  gapMs: number; // union of gap time inside the position's life
  maxGapMs: number; // longest single gap inside the life
  fraction: number;
}

export function gapTaint(
  gaps: Iterable<GapInterval>,
  actions: number[],
  from: number,
  to: number,
  c: GapTaintConfig,
): TaintVerdict {
  const clipped: [number, number][] = [];
  const full: [number, number][] = [];
  const gapsOpen: boolean[] = [];
  const priceGap: boolean[] = [];
  const actionSources = c.action_sources ?? ["pool_state"];
  for (const g of gaps) {
    const end = g.end ?? to;
    if (end < from || g.start > to) continue;
    full.push([g.start, end]);
    gapsOpen.push(g.end === null);
    priceGap.push(actionSources.includes(g.source));
    const a = Math.max(g.start, from);
    const b = Math.min(end, to);
    if (b >= a) clipped.push([a, b]);
  }
  const life = Math.max(1, to - from);
  if (!full.length) return { tainted: false, reason: null, gapMs: 0, maxGapMs: 0, fraction: 0 };
  // union of the clipped intervals
  clipped.sort((x, y) => x[0] - y[0]);
  let gapMs = 0;
  let cur: [number, number] | null = null;
  for (const [a, b] of clipped) {
    if (!cur || a > cur[1]) {
      if (cur) gapMs += cur[1] - cur[0];
      cur = [a, b];
    } else cur[1] = Math.max(cur[1], b);
  }
  if (cur) gapMs += cur[1] - cur[0];
  const maxGapMs = Math.max(0, ...clipped.map(([a, b]) => b - a));
  const fraction = gapMs / life;
  const v = (reason: string | null): TaintVerdict => ({ tainted: reason !== null, reason, gapMs, maxGapMs, fraction });
  if (c.mode === "any_overlap") return v("overlap");
  // half-open [start, end): at `end` fresh data has arrived again, so an action at that moment
  // (typically an exit the returning data triggered) used current data and stays usable; excluding
  // it would bias the clean set toward positions without moves during gaps. The delay itself is
  // bounded by max_single_gap_minutes. An open gap (end null) covers up to the position's end.
  if (actions.some((t) => full.some(([a, b], i) => priceGap[i] && t >= a && (t < b || (gapsOpen[i] && t <= b))))) return v("action_during_gap");
  if (maxGapMs > c.max_single_gap_minutes * 60_000) return v("long_gap");
  if (fraction > c.max_fraction) return v("gap_fraction");
  return v(null);
}
