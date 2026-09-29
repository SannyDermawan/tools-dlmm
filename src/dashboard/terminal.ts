import type { DashboardSession } from "./data.ts";

const pad = (s: unknown, n: number) => String(s ?? "-").slice(0, n).padEnd(n);
const num = (v: number | null | undefined, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? "-" : v.toFixed(d));
const hhmm = (t: number | null | undefined) => (t ? new Date(t).toLocaleTimeString("id-ID", { hour12: false }) : "-");
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const color = (s: string, c: number) => `\x1b[${c}m${s}\x1b[0m`;
const actionColor = (a: string) => (a === "MASUK" ? color(a, 32) : a === "PANTAU" ? color(a, 33) : color(a, 90));

/** Plain-text dashboard (blueprint 19): status, data health, latest signals, running PnL. */
export function renderTerminal(v: DashboardSession, now = Date.now()): string {
  const out: string[] = [];
  const hb = v.heartbeat?.state;
  const live = v.status === "running" && v.heartbeat && v.heartbeat.ageS < 180;
  out.push(bold(`DLMM ${v.kind} ${v.label ?? ""}  ${v.session_id.slice(0, 8)}  [${v.status}${live ? ", live" : ""}]`));
  if (hb) {
    const left = hb.phase === "ended" ? "-" : `${num(hb.leftMin, 0)} min`;
    out.push(`phase ${bold(hb.phase)}  left ${left}  started ${hhmm(hb.start)}  warm-up→${hhmm(hb.warmupEnd)}  new positions until ${hhmm(hb.stopNewAt)}  end ${hhmm(hb.end)}`);
    const p = hb.positions;
    out.push(`positions: active ${p.active}  pending ${p.pending}  closed ${p.closed}  failed ${p.failed}  cohorts ${hb.grid.cohorts}  rebalances ${hb.grid.rebalances}  signals ${hb.signalsTotal}`);
    if (hb.exitEngine) out.push(`exit engine: exits ${hb.exitEngine.exits}  partial ${hb.exitEngine.partials}  ${JSON.stringify(hb.exitEngine.byReason)}`);
  } else {
    out.push(`started ${new Date(v.start_at).toISOString()}  ${v.end_at ? `ended ${new Date(v.end_at).toISOString()}` : ""}  (no heartbeat: session predates the dashboard or is not live)`);
    out.push(`positions: ${v.db.positions.map((x) => `${x.status} ${x.n}`).join("  ") || "none"}`);
  }

  out.push("");
  out.push(bold("data health"));
  const h = hb?.health;
  const age = v.db.lastData ? (now - v.db.lastData) / 1000 : null;
  out.push(`last market data ${age === null ? "-" : `${num(age, 0)} s ago`}  swaps stored ${v.db.swaps}` +
    (h ? `  ws ${h.wsConnected ? color("up", 32) : color("down", 31)} (reconnects ${h.wsReconnects})  rpc ${num(h.rpcRps, 1)} rps  swap ${num(h.swapRps, 1)} rps  queue ${h.txQueue}` : ""));
  if (h) out.push(`credits this session ${h.credits} (swap ${h.swapCredits}, budget ${h.budget})  plan quota used ~${num(h.quotaPct, 2)}%  http ${h.httpCalls} calls / ${h.httpErrors} errors`);
  else for (const r of v.db.http) out.push(`${pad(r.endpoint, 8)} calls ${r.calls}  errors ${r.errors}  credits ${r.credits}`);
  const open = v.db.gapsOpen;
  out.push(`data gaps: ${open.length ? color(`${open.length} open`, 31) : "none open"}  total ${v.db.gapsTotal.map((g) => `${g.source} ${g.n} (${num(g.minutes, 1)} min)`).join(", ") || "0"}`);
  for (const g of open.slice(0, 5)) out.push(`  ${color("open", 31)} ${g.source} ${g.pool?.slice(0, 8) ?? "-"} since ${hhmm(g.start_at)} ${g.cause}`);

  out.push("");
  out.push(bold("running PnL (mark-to-market, $1 000 per position)"));
  if (hb?.pnl) {
    out.push(`${pad("entry mode", 22)} ${pad("n", 6)} ${pad("active", 7)} ${pad("win%", 5)} ${pad("avg net $", 10)} ${pad("avg fee $", 10)} ${pad("avg IL $", 9)}`);
    for (const [k, a] of Object.entries(hb.pnl.byMode) as [string, any][]) {
      out.push(`${pad(k, 22)} ${pad(a.n, 6)} ${pad(a.active, 7)} ${pad(num((a.win / a.n) * 100, 0), 5)} ${pad(num(a.netUsd / a.n), 10)} ${pad(num(a.feeUsd / a.n), 10)} ${pad(num(a.ilUsd / a.n), 9)}`);
    }
    out.push(`by strategy: ${Object.entries(hb.pnl.byStrategy).map(([k, a]: [string, any]) => `${k} ${num(a.netUsd / a.n)}$`).join("  ")}`);
    out.push(`by exit policy: ${Object.entries(hb.pnl.byExit).map(([k, a]: [string, any]) => `${k} ${num(a.netUsd / a.n)}$`).join("  ")}`);
  } else {
    for (const r of v.db.byMode) out.push(`${pad(r.k, 22)} n ${r.n}  closed ${r.closed}  win ${num((r.win ?? 0) * 100, 0)}%  avg net ${num(r.net, 3)}%`);
  }

  out.push("");
  out.push(bold(`latest signals${v.db.signals[0] ? ` (${hhmm(v.db.signals[0].ts)})` : ""}  ${v.db.signalCounts.map((c) => `${c.action} ${c.n}`).join("  ")}`));
  for (const s of v.db.signals.slice(0, 12)) {
    out.push(`${pad(s.name, 16)} ${actionColor(pad(s.action, 7))} score ${pad(num(s.final, 1), 6)} conf ${pad(num(s.confidence, 2), 5)} ${pad(s.regime, 22)} ${s.reasons.slice(0, 2).join("; ").slice(0, 90)}`);
  }
  out.push("");
  out.push(color(`updated ${new Date(now).toLocaleTimeString("id-ID", { hour12: false })} — Ctrl+C to leave (the session keeps running)`, 90));
  return out.join("\n");
}
