import type { Db } from "../db/index.ts";

/** Plain-text message formatting (no parse_mode: nothing to escape, nothing to inject). */

const usd = (v: number | null | undefined, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? "-" : `${v < 0 ? "-" : ""}$${Math.abs(v).toFixed(d)}`);
const pct = (v: number | null | undefined, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? "-" : `${v >= 0 ? "+" : ""}${v.toFixed(d)}%`);
export const wib = (ts: number) => new Date(ts + 7 * 3_600_000).toISOString().slice(0, 16).replace("T", " ") + " WIB";
const short = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`;

export interface SignalRow {
  signal_id: string;
  pool: string;
  ts: number;
  action: string;
  payload: string;
}

export function poolName(db: Db, pool: string): string {
  return db.get<{ name: string | null }>("SELECT name FROM pools WHERE pool = ?", pool)?.name ?? short(pool);
}

/** One message for a batch of signals: pool, strategy, range, expectations, main reasons. */
export function formatSignals(db: Db, rows: SignalRow[]): string {
  const out = [`📈 ${rows.length} signal${rows.length > 1 ? "s" : ""}`];
  for (const r of rows) {
    const s = JSON.parse(r.payload) as {
      final_score: number | null; confidence: number; regime_label: string | null;
      recommendation: { strategy: string; sides: string; bins_below: number; bins_above: number; price_min: number; price_max: number; size_fraction: number } | null;
      expectations: { net_return_per_hour_pct: number; fee_il_ratio: number | null; p_in_range: number; horizon_minutes: number } | null;
      top_reasons: string[]; risks?: string[];
    };
    out.push("");
    out.push(`${r.action} ${poolName(db, r.pool)} — score ${s.final_score?.toFixed(1) ?? "-"}, confidence ${(s.confidence * 100).toFixed(0)}%, regime ${s.regime_label ?? "-"}`);
    const rec = s.recommendation;
    if (rec) out.push(`  ${rec.strategy} ${rec.sides}, bins -${rec.bins_below}/+${rec.bins_above}, range ${rec.price_min.toPrecision(5)} – ${rec.price_max.toPrecision(5)}, size ${(rec.size_fraction * 100).toFixed(1)}%`);
    const e = s.expectations;
    if (e) out.push(`  expected ${pct(e.net_return_per_hour_pct, 3)}/h, fee/IL ${e.fee_il_ratio?.toFixed(2) ?? "-"}, P(in range) ${(e.p_in_range * 100).toFixed(0)}% over ${e.horizon_minutes} min`);
    if (s.top_reasons?.length) out.push(`  why: ${s.top_reasons.slice(0, 3).join("; ")}`);
    if (s.risks?.length) out.push(`  risks: ${s.risks.slice(0, 3).join("; ")}`);
    out.push(`  ${wib(r.ts)} · ${r.pool}`);
  }
  out.push("");
  out.push("Virtual demo only — not financial advice.");
  return out.join("\n");
}

export interface ModeRow {
  mode: string;
  n: number;
  win: number | null;
  net: number | null;
  total: number | null;
}

/** Closed clean positions of a simulation session by entry mode. */
export function modeTable(db: Db, simSessionId: string): ModeRow[] {
  return db.all<ModeRow>(
    `SELECT p.entry_mode mode, COUNT(*) n, AVG(r.net_pnl_usd > 0) win, AVG(r.net_pnl_pct) net, SUM(r.net_pnl_usd) total
     FROM sim_positions p JOIN sim_results r USING(position_id)
     WHERE p.session_id = ? AND p.status = 'closed' AND p.gap_tainted = 0 GROUP BY p.entry_mode
     ORDER BY CASE p.entry_mode WHEN 'all_pools_baseline' THEN 0 WHEN 'meridian_preset' THEN 1 WHEN 'friday_scalp' THEN 2 WHEN 'yunus_flip' THEN 3 WHEN 'evil_panda' THEN 4 ELSE 5 END, p.entry_mode`,
    simSessionId,
  );
}

/** Session result: totals, baseline vs signal, best / worst strategy and exit policy. */
export function formatSessionResult(db: Db, simSessionId: string, title: string): string {
  const s = db.get<{ label: string | null; start_at: number; end_at: number | null; status: string }>("SELECT label, start_at, end_at, status FROM sessions WHERE session_id = ?", simSessionId);
  if (!s) return `${title}: session ${simSessionId} not found`;
  const tot = db.get<{ n: number; closed: number; failed: number; net: number | null }>(
    `SELECT COUNT(*) n, SUM(p.status = 'closed') closed, SUM(p.status = 'failed') failed, SUM(r.net_pnl_usd) net
     FROM sim_positions p LEFT JOIN sim_results r USING(position_id) WHERE p.session_id = ?`,
    simSessionId,
  )!;
  const dur = ((s.end_at ?? Date.now()) - s.start_at) / 60_000;
  const out = [
    `${title}: ${s.label ?? short(simSessionId)} (${s.status})`,
    `${wib(s.start_at)} → ${s.end_at ? wib(s.end_at) : "now"} · ${dur.toFixed(0)} min`,
    `positions ${tot.n} (closed ${tot.closed ?? 0}, failed ${tot.failed ?? 0}), total net ${usd(tot.net)}`,
  ];
  const modes = modeTable(db, simSessionId);
  if (modes.length) {
    out.push("");
    out.push("entry mode — n · win · avg net · total");
    for (const m of modes) out.push(`${m.mode}: ${m.n} · ${m.win === null ? "-" : (m.win * 100).toFixed(0) + "%"} · ${pct(m.net)} · ${usd(m.total)}`);
    const base = modes.find((m) => m.mode === "all_pools_baseline")?.net ?? null;
    for (const m of modes.filter((x) => x.mode.startsWith("signal") || x.mode === "meridian_preset" || x.mode === "friday_scalp" || x.mode === "yunus_flip" || x.mode === "evil_panda"))
      if (base !== null && m.net !== null) out.push(`→ ${m.mode} vs baseline: ${pct(m.net - base)} pp`);
  }
  const best = (expr: string) =>
    db.all<{ k: string; n: number; net: number }>(
      `SELECT ${expr} k, COUNT(*) n, AVG(r.net_pnl_pct) net FROM sim_positions p JOIN sim_results r USING(position_id)
       WHERE p.session_id = ? AND p.status = 'closed' AND p.gap_tainted = 0 AND p.entry_mode = 'all_pools_baseline' GROUP BY k HAVING n >= 20 ORDER BY net DESC`,
      simSessionId,
    );
  for (const [label, expr] of [["strategy", "p.strategy"], ["exit policy", "json_extract(p.grid_combo,'$.exit_policy')"]] as const) {
    const r = best(expr);
    if (r.length >= 2) out.push(`${label}: best ${r[0].k} ${pct(r[0].net)}, worst ${r[r.length - 1].k} ${pct(r[r.length - 1].net)} (baseline, n>=20)`);
  }
  out.push("");
  out.push("One session is not significant; judge by consistency across sessions.");
  return out.join("\n");
}

/** /status from the heartbeat of a running session. */
export function formatStatus(db: Db, now = Date.now()): string {
  const hb = latestHeartbeat(db);
  if (!hb) return "No session has written a heartbeat yet.";
  const st = hb.state;
  const h = st.health ?? {};
  const age = (now - hb.ts) / 60_000;
  return [
    `Session ${hb.label ?? short(hb.session_id)} — ${hb.status}, phase ${st.phase}${hb.status === "running" ? `, ${Number(st.leftMin ?? 0).toFixed(0)} min left` : ""}`,
    `heartbeat ${age < 1 ? "just now" : `${age.toFixed(0)} min ago`}${age > 5 && hb.status === "running" ? " ⚠️" : ""}`,
    `positions: active ${st.positions?.active ?? 0}, pending ${st.positions?.pending ?? 0}, closed ${st.positions?.closed ?? 0}, failed ${st.positions?.failed ?? 0}`,
    `data: open gaps ${Array.isArray(h.openGaps) ? h.openGaps.length : (h.openGaps ?? "-")}, WS ${h.wsConnected === null || h.wsConnected === undefined ? "n/a" : h.wsConnected ? "up" : "DOWN"}, RPC credits ${h.credits ?? "-"} (${h.quotaPct !== undefined ? Number(h.quotaPct).toFixed(1) : "-"}% of plan), HTTP errors ${h.httpErrors ?? "-"}`,
  ].join("\n");
}

/** /positions: running mark-to-market PnL by entry mode. */
export function formatPositions(db: Db): string {
  const hb = latestHeartbeat(db);
  if (!hb) return "No session has written a heartbeat yet.";
  const by = (hb.state.pnl?.byMode ?? {}) as Record<string, { n: number; active: number; netUsd: number; feeUsd: number; win: number }>;
  const rows = Object.entries(by);
  if (!rows.length) return `Session ${hb.label ?? short(hb.session_id)}: no positions yet (phase ${hb.state.phase}).`;
  const out = [`Virtual positions — ${hb.label ?? short(hb.session_id)} (${hb.state.phase})`, "mode: n (active) · net · fee · win"];
  let total = 0;
  for (const [k, a] of rows) {
    total += a.netUsd;
    out.push(`${k}: ${a.n} (${a.active}) · ${usd(a.netUsd)} · ${usd(a.feeUsd)} · ${a.n ? ((a.win / a.n) * 100).toFixed(0) : 0}%`);
  }
  out.push(`total net ${usd(total)} (mark-to-market, $${db.get<{ c: number }>("SELECT AVG(capital_usd) c FROM sim_positions WHERE session_id = ?", hb.session_id)?.c?.toFixed(0) ?? "?"} per position)`);
  return out.join("\n");
}

/** /signals: the latest signal per pool of the newest session with signals. */
export function formatLatestSignals(db: Db, limit = 8): string {
  const sid = db.get<{ session_id: string }>("SELECT session_id FROM signals ORDER BY ts DESC LIMIT 1")?.session_id;
  if (!sid) return "No signals yet.";
  const rows = db.all<{ pool: string; ts: number; action: string; score: number | null; conf: number | null }>(
    `SELECT s.pool, s.ts, s.action, json_extract(s.payload, '$.final_score') score, json_extract(s.payload, '$.confidence') conf
     FROM signals s WHERE s.session_id = ? AND s.ts = (SELECT MAX(ts) FROM signals x WHERE x.session_id = s.session_id AND x.pool = s.pool)
     ORDER BY CASE s.action WHEN 'MASUK' THEN 0 WHEN 'PANTAU' THEN 1 ELSE 2 END, score DESC LIMIT ?`,
    sid, limit,
  );
  return [`Latest signals (${wib(rows[0]?.ts ?? Date.now())})`, ...rows.map((r) => `${r.action.padEnd(6)} ${poolName(db, r.pool)} — score ${r.score?.toFixed(1) ?? "-"}, conf ${r.conf === null ? "-" : (r.conf * 100).toFixed(0) + "%"}`)].join("\n");
}

export interface HeartbeatRow {
  session_id: string;
  ts: number;
  label: string | null;
  status: string;
  state: Record<string, any>;
}

export function latestHeartbeat(db: Db): HeartbeatRow | null {
  const r = db.get<{ session_id: string; ts: number; label: string | null; status: string; state: string }>(
    `SELECT h.session_id, h.ts, s.label, s.status, h.state FROM session_heartbeat h JOIN sessions s USING(session_id)
     ORDER BY (s.status = 'running') DESC, h.ts DESC LIMIT 1`,
  );
  return r ? { ...r, state: JSON.parse(r.state) } : null;
}

export const HELP = [
  "Read-only commands:",
  "/status — session state, time left, data health",
  "/positions — virtual positions and PnL by entry mode",
  "/signals — latest signal per pool",
  "/report — result of the last finished session",
  "/stop — stop the running session cleanly (positions closed, report written)",
  "Nothing here can change strategy, weights or touch funds.",
].join("\n");
