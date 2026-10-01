#!/usr/bin/env node
import { Command } from "commander";
import { createApp } from "./app.ts";
import { DEFAULT_CONFIG_PATH, loadConfig } from "./config/load.ts";
import { migrate, openDb } from "./db/index.ts";
import { flushLogger } from "./util/logger.ts";

const program = new Command();
program
  .name("dlmm")
  .description("Meteora DLMM signal engine + demo simulator (READ-ONLY, no keys, no transactions)")
  .option("-c, --config <path>", "config file", DEFAULT_CONFIG_PATH);

const cfgPath = () => program.opts().config as string;

program
  .command("config")
  .description("config utilities")
  .command("validate")
  .description("validate the config file and print its config_version")
  .action(() => {
    const lc = loadConfig(cfgPath());
    console.log(`OK  ${lc.path}\nconfig_version: ${lc.configVersion}`);
  });

const dbCmd = program.command("db").description("database utilities");
dbCmd
  .command("migrate")
  .description("create/upgrade the database schema")
  .action(() => {
    const lc = loadConfig(cfgPath());
    const db = openDb(lc.config.app.db_path);
    const r = migrate(db);
    console.log(`DB ${lc.config.app.db_path}: schema at ${r.current.at(-1)} (${r.current.length} migrations)`);
    db.close();
  });
dbCmd
  .command("recover")
  .description("mark sessions left 'running' by a killed process as aborted (idle > 5 min)")
  .action(async () => {
    const app = createApp(cfgPath());
    const { recoverUncleanSessions } = await import("./db/repo.ts");
    console.log(`recovered ${recoverUncleanSessions(app.db, app.log)} session(s)`);
    app.db.close();
  });
dbCmd
  .command("info")
  .description("row counts per table")
  .action(() => {
    const app = createApp(cfgPath());
    const tables = app.db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    for (const t of tables) {
      const n = app.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t.name}`)!.n;
      console.log(`${t.name.padEnd(22)} ${n}`);
    }
    app.db.close();
  });

program
  .command("discover")
  .description("run pool discovery once and print the pools that would be monitored")
  .option("--max-pools <n>", "override discovery.max_pools", (v) => parseInt(v, 10))
  .action(async (opts) => {
    const app = createApp(cfgPath());
    const { discoverPools } = await import("./collectors/discovery.ts");
    const { MeteoraApi } = await import("./api/meteora.ts");
    const { RpcClient } = await import("./chain/rpc.ts");
    const { endpoints } = await import("./app.ts");
    const c = app.lc.config;
    if (opts.maxPools) c.discovery.max_pools = opts.maxPools;
    const rpc = new RpcClient({ url: endpoints(app.lc).httpUrl, maxRps: c.rpc.max_rps, maxConcurrency: c.rpc.max_concurrency, timeoutMs: c.rpc.request_timeout_ms, retry: c.rpc.retry, commitment: c.rpc.commitment, log: app.log });
    const api = new MeteoraApi({ baseUrl: c.api.meteora_base_url, maxRps: c.api.max_rps, timeoutMs: c.api.request_timeout_ms, retry: c.api.retry, log: app.log });
    const pools = await discoverPools({ api, rpc, db: app.db, log: app.log, config: c }, null);
    for (const p of pools) console.log(`${p.pool}  ${p.name.padEnd(22)} step=${String(p.binStep).padEnd(4)} ${p.category}`);
    console.log(`${pools.length} pools`);
    app.db.close();
  });

program
  .command("collect")
  .description("collect mainnet data (read-only) into the database")
  .option("-d, --duration <minutes>", "stop after N minutes (default: until Ctrl+C)", parseFloat)
  .option("--max-pools <n>", "override discovery.max_pools", (v) => parseInt(v, 10))
  .option("-l, --label <label>", "session label")
  .option("-q, --quiet", "no periodic status lines on the console")
  .action(async (opts) => {
    const app = createApp(cfgPath());
    const { runCollection } = await import("./collectors/runner.ts");
    const r = await runCollection(app, { durationMinutes: opts.duration, maxPools: opts.maxPools, label: opts.label, quiet: opts.quiet });
    const { printSessionSummary } = await import("./report/summary.ts");
    printSessionSummary(app.db, r.sessionId);
    app.db.close();
    if (r.status === "failed") process.exitCode = 1;
  });

program
  .command("status")
  .description("summary of a collection session (default: latest)")
  .option("-s, --session <id>", "session id")
  .action(async (opts) => {
    const app = createApp(cfgPath());
    const { latestSession } = await import("./db/repo.ts");
    const id = opts.session ?? latestSession(app.db, "collect")?.session_id;
    if (!id) throw new Error("no collection session found");
    const { printSessionSummary } = await import("./report/summary.ts");
    printSessionSummary(app.db, id);
    app.db.close();
  });

program
  .command("audit-swaps")
  .description("independently re-fetch all transactions of a pool in a window and compare with stored swaps")
  .requiredOption("-p, --pool <address>", "pool address")
  .option("-s, --session <id>", "collection session (window defaults to its span)")
  .option("--from <iso>", "window start (ISO)")
  .option("--to <iso>", "window end (ISO)")
  .option("--max-tx <n>", "cap on transactions fetched", (v) => parseInt(v, 10), 2000)
  .option("--rps <n>", "request rate for the audit", parseFloat)
  .action(async (opts) => {
    const app = createApp(cfgPath());
    const { endpoints } = await import("./app.ts");
    const { RpcClient } = await import("./chain/rpc.ts");
    const { auditSwaps } = await import("./analysis/swapAudit.ts");
    const { getSession, latestSession } = await import("./db/repo.ts");
    const c = app.lc.config;
    const s = opts.session ? getSession(app.db, opts.session) : latestSession(app.db, "collect");
    // Skip the first 90 s of a session: the backfill marker is set then, earlier swaps are out of scope.
    const from = opts.from ? Date.parse(opts.from) : s!.start_at + 90_000;
    const to = opts.to ? Date.parse(opts.to) : (s!.end_at ?? Date.now()) - 30_000;
    const rpc = new RpcClient({ url: endpoints(app.lc).httpUrl, maxRps: opts.rps ?? c.rpc.max_rps, maxConcurrency: c.rpc.max_concurrency, timeoutMs: c.rpc.request_timeout_ms, retry: { ...c.rpc.retry, max_attempts: 8 }, commitment: c.rpc.commitment, log: app.log });
    const r = await auditSwaps(app.db, rpc, opts.pool, from, to, opts.maxTx);
    console.log(JSON.stringify({ ...r, from: new Date(r.from).toISOString(), to: new Date(r.to).toISOString(), missingInDb: r.missingInDb.slice(0, 20), extraInDb: r.extraInDb.slice(0, 20), missingCount: r.missingInDb.length, extraCount: r.extraInDb.length }, null, 2));
    app.db.close();
  });

program
  .command("reconcile")
  .description("fee reconciliation: simulator fee sums (100% share) vs Meteora API fees, per pool")
  .option("-s, --session <id>", "collection session (default: latest)")
  .option("-p, --pool <address...>", "pools (default: all pools of the session)")
  .option("--from <iso>", "window start")
  .option("--to <iso>", "window end")
  .option("--json", "print JSON")
  .option("--census", "also fetch every transaction in the window as on-chain ground truth (slow)")
  .option("--rps <n>", "request rate for the census", parseFloat)
  .action(async (opts) => {
    const app = createApp(cfgPath());
    const { MeteoraApi } = await import("./api/meteora.ts");
    const { RpcClient } = await import("./chain/rpc.ts");
    const { endpoints } = await import("./app.ts");
    const { reconcilePool, saveReconcile } = await import("./analysis/reconcile.ts");
    const { getSession, latestSession } = await import("./db/repo.ts");
    const c = app.lc.config;
    const s = opts.session ? getSession(app.db, opts.session) : latestSession(app.db, "collect");
    if (!s) throw new Error("session not found");
    const api = new MeteoraApi({ baseUrl: c.api.meteora_base_url, maxRps: c.api.max_rps, timeoutMs: c.api.request_timeout_ms, retry: c.api.retry, log: app.log });
    const pools: string[] = opts.pool ?? app.db.all<{ pool: string }>("SELECT pool FROM session_pools WHERE session_id=? ORDER BY rank", s.session_id).map((r) => r.pool);
    const from = opts.from ? Date.parse(opts.from) : s.start_at + 60_000;
    const lagCut = Date.now() - c.reconcile.api_lag_minutes * 60_000;
    const to = Math.min(opts.to ? Date.parse(opts.to) : (s.end_at ?? Date.now()), lagCut);
    const results = [];
    for (const p of pools) {
      try {
        const censusRpc = opts.census
          ? new RpcClient({ url: endpoints(app.lc).httpUrl, maxRps: opts.rps ?? c.rpc.max_rps, maxConcurrency: c.rpc.max_concurrency, timeoutMs: c.rpc.request_timeout_ms, retry: { ...c.rpc.retry, max_attempts: 10 }, commitment: c.rpc.commitment, log: app.log })
          : undefined;
        const rr = await reconcilePool(app.db, api, p, from, to, c.reconcile.tolerance_pct, s.session_id, censusRpc);
        saveReconcile(app.db, s.session_id, rr);
        results.push(rr);
      } catch (e) {
        console.error(`${p}: ${(e as Error).message}`);
      }
    }
    if (opts.json) console.log(JSON.stringify(results, null, 2));
    else {
      const f = (v: number | null) => (v === null ? "   n/a" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`.padStart(8));
      console.log(`\nwindow ${results[0]?.from} -> ${results[0]?.to}   tolerance ±${c.reconcile.tolerance_pct}%`);
      console.log("pool          name                  API fee $   accum $  vs API  stream $  vs API  vol diff  swaps   chain $  accum vs chain  API vs chain  ref     result");
      for (const r of results) {
        console.log(
          `${r.pool.slice(0, 12)}  ${r.name.slice(0, 18).padEnd(18)} ${r.api.feesUsd.toFixed(2).padStart(10)} ${r.accumulator.lpFeeUsd.toFixed(2).padStart(9)} ${f(r.accumulator.diffPct)} ${r.swaps.lpFeeUsd.toFixed(2).padStart(9)} ${f(r.swaps.lpDiffPct)} ${f(r.swaps.volumeDiffPct)} ${String(r.swaps.count).padStart(6)} ${r.census ? r.census.lpFeeUsd.toFixed(2).padStart(9) : "        -"} ${r.census ? f(r.census.accumDiffPct).padStart(14) : "             -"} ${r.census ? f(r.census.apiDiffPct).padStart(12) : "           -"}  ${r.reference.padEnd(6)}  ${r.passed === null ? "n/a" : r.passed ? "PASS" : "FAIL"}${r.notes.length ? "  (" + r.notes.join("; ") + ")" : ""}`,
        );
      }
      const valid = results.filter((r) => r.passed !== null);
      console.log(`\n${valid.filter((r) => r.passed).length}/${valid.length} pools within tolerance (accumulator method vs reference)`);
    }
    app.db.close();
  });

const sim = program.command("sim").description("simulator");
sim
  .command("replay")
  .description("run the grid of virtual positions over a collected session (hold to end)")
  .option("-s, --session <id>", "collection session (default: latest)")
  .option("-p, --pool <address...>", "restrict to pools")
  .option("--duration <minutes>", "session duration (default: config, scaled to the collected span)", parseFloat)
  .option("--warmup <minutes>", "warm-up minutes", parseFloat)
  .option("--stop-before <minutes>", "no new positions in the last N minutes", parseFloat)
  .option("--cohort-interval <minutes>", "minutes between grid cohorts (0 = one cohort)", parseFloat)
  .option("--fee-attribution <mode>", "accumulator | swap_events")
  .option("--no-signals", "baseline grid only (skip scoring, signals and the exit engine)")
  .action(async (opts) => {
    const app = createApp(cfgPath());
    const { runReplay } = await import("./sim/replayRunner.ts");
    const { printSimSummary } = await import("./report/simSummary.ts");
    const { latestSession } = await import("./db/repo.ts");
    const src = opts.session ?? latestSession(app.db, "collect")?.session_id;
    if (!src) throw new Error("no collection session");
    const t0 = Date.now();
    const timing: Record<string, number> = {};
    if (opts.duration !== undefined) timing.durationMinutes = opts.duration;
    if (opts.warmup !== undefined) timing.warmupMinutes = opts.warmup;
    if (opts.stopBefore !== undefined) timing.stopNewBeforeEndMinutes = opts.stopBefore;
    if (opts.cohortInterval !== undefined) timing.cohortIntervalMinutes = opts.cohortInterval;
    const r = runReplay(app, { sourceSessionId: src, pools: opts.pool, feeAttribution: opts.feeAttribution, timing, signals: opts.signals });
    console.log(`replayed in ${((Date.now() - t0) / 1000).toFixed(1)} s  timing=${JSON.stringify(r.timing)}`);
    console.log(`grid=${JSON.stringify(r.grid)}  signals=${r.signals}  exitEngine=${JSON.stringify(r.exitEngine)}`);
    printSimSummary(app.db, r.sessionId);
    const { writeSessionReport } = await import("./report/sessionReport.ts");
    const rp = writeSessionReport(app.db, r.sessionId);
    console.log(`
report: ${rp.markdown}`);
    app.db.close();
  });

sim
  .command("retaint")
  .description("re-evaluate the gap taint of a simulation session with the current rule (simulation.gap_taint)")
  .requiredOption("-s, --session <id>", "simulation session")
  .option("--dry-run", "only print what would change")
  .option("--mode <mode>", "proportional | any_overlap (default: config)")
  .action(async (opts) => {
    const app = createApp(cfgPath());
    const { retaintSession } = await import("./sim/retaint.ts");
    const taint = opts.mode ? { ...app.lc.config.simulation.gap_taint, mode: opts.mode } : undefined;
    const r = retaintSession(app.db, app.lc.config, opts.session, { dryRun: opts.dryRun, taint });
    const pct = (n: number) => `${((n / Math.max(1, r.positions)) * 100).toFixed(0)}%`;
    console.log(`positions ${r.positions}: tainted before ${r.before} (${pct(r.before)}), now ${r.after} (${pct(r.after)})${opts.dryRun ? " [dry run]" : ""}`);
    console.log(`reasons: ${JSON.stringify(r.reasons)}`);
    for (const x of r.sensitivity) console.log(`  max_fraction ${x.max_fraction}, max single gap ${x.max_single_gap_minutes} min -> clean ${x.clean} (${pct(x.clean)})`);
    if (!opts.dryRun) console.log("run `dlmm report -s <session>` to rewrite the report");
    app.db.close();
  });

program
  .command("report")
  .description("write the session report (Markdown + CSV) for a simulation session")
  .option("-s, --session <id>", "simulation session (default: latest session / sim_replay)")
  .option("-o, --out <dir>", "output directory", "reports")
  .action(async (opts) => {
    const app = createApp(cfgPath());
    const { writeSessionReport } = await import("./report/sessionReport.ts");
    const id =
      opts.session ??
      app.db.get<{ session_id: string }>("SELECT session_id FROM sessions WHERE kind IN ('session','sim_replay') ORDER BY start_at DESC LIMIT 1")?.session_id;
    if (!id) throw new Error("no simulation session found");
    const rp = writeSessionReport(app.db, id, opts.out);
    console.log(`report: ${rp.markdown}
        ${rp.positionsCsv}
        ${rp.dimensionsCsv}`);
    app.db.close();
  });

const sessionCmd = program.command("session").description("demo sessions (collection + simulator)");
sessionCmd
  .command("start")
  .description("run a full session: warm-up, grid cohorts, closing phase, forced close, report (Ctrl+C stops cleanly)")
  .option("-d, --duration <minutes>", "override session.duration_minutes", parseFloat)
  .option("--warmup <minutes>", "override session.warmup_minutes", parseFloat)
  .option("--stop-before <minutes>", "override session.stop_new_positions_before_end_minutes", parseFloat)
  .option("--cohort-interval <minutes>", "override grid.cohort_interval_minutes", parseFloat)
  .option("--max-pools <n>", "override discovery.max_pools", (v) => parseInt(v, 10))
  .option("-l, --label <label>", "session label (default: session.label)")
  .option("-q, --quiet", "no periodic status lines on the console (use the dashboard / logs)")
  .action(async (opts) => {
    const app = createApp(cfgPath());
    const { runLiveSession } = await import("./session/liveSession.ts");
    const timing: Record<string, number> = {};
    if (opts.duration !== undefined) timing.durationMinutes = opts.duration;
    if (opts.warmup !== undefined) timing.warmupMinutes = opts.warmup;
    if (opts.stopBefore !== undefined) timing.stopNewBeforeEndMinutes = opts.stopBefore;
    if (opts.cohortInterval !== undefined) timing.cohortIntervalMinutes = opts.cohortInterval;
    const r = await runLiveSession(app, { maxPools: opts.maxPools, label: opts.label, timing, quiet: opts.quiet });
    const { printSessionSummary } = await import("./report/summary.ts");
    printSessionSummary(app.db, r.sessionId);
    console.log(`
session ${r.sessionId} ${r.status}: ${r.positions} virtual positions  grid=${JSON.stringify(r.grid)}`);
    if (r.report) console.log(`report: ${r.report.markdown}`);
    app.db.close();
    if (r.status === "failed") process.exitCode = 1;
  });

program
  .command("score")
  .description("compute features + scores on the decision grid over a stored data session (no look-ahead)")
  .option("-s, --session <id>", "data session (collect or session; default: latest collect)")
  .option("-p, --pool <address...>", "restrict to pools")
  .action(async (opts) => {
    const app = createApp(cfgPath());
    const { runScoreReplay } = await import("./features/scoreReplay.ts");
    const { latestSession } = await import("./db/repo.ts");
    const src = opts.session ?? latestSession(app.db, "collect")?.session_id;
    if (!src) throw new Error("no data session");
    const r = runScoreReplay(app, src, { pools: opts.pool });
    console.log(`scored ${r.decisions} decision times, ${r.scores} pool scores in ${r.seconds.toFixed(1)} s -> session ${r.sessionId}`);
    const { printScoreSummary } = await import("./report/scoreSummary.ts");
    printScoreSummary(app.db, r.sessionId);
    app.db.close();
  });

sessionCmd
  .command("stop")
  .description("ask a running session / collection (in another terminal) to stop cleanly")
  .option("-s, --session <id>", "session id (default: every running session)")
  .action(async (opts) => {
    const app = createApp(cfgPath());
    const running = app.db.all<{ session_id: string; kind: string; label: string | null }>(
      "SELECT session_id, kind, label FROM sessions WHERE status = 'running'",
    );
    const target = opts.session ? running.find((r) => r.session_id.startsWith(opts.session))?.session_id : "*";
    if (!target) throw new Error("no such running session");
    app.db.insert("session_control", { session_id: target, action: "stop", requested_at: Date.now() });
    console.log(`stop requested for ${target === "*" ? `${running.length} running session(s)` : target}; they close positions, write the report and exit within ~5 s`);
    app.db.close();
  });

program
  .command("dashboard")
  .description("real-time status: terminal view (default) or a local web page (--web)")
  .option("-s, --session <id>", "session (default: the running one, else the latest)")
  .option("--web", "serve a web dashboard on 127.0.0.1")
  .option("--port <n>", "web port", (v) => parseInt(v, 10), 8787)
  .option("--interval <s>", "terminal refresh seconds", parseFloat, 5)
  .option("--once", "print once and exit")
  .action(async (opts) => {
    const app = createApp(cfgPath());
    const { listSessions, sessionView } = await import("./dashboard/data.ts");
    if (opts.web) {
      const { startWebDashboard } = await import("./dashboard/web.ts");
      startWebDashboard(app.db, opts.port);
      console.log(`dashboard: http://127.0.0.1:${opts.port}/  (Ctrl+C to stop the dashboard; sessions keep running)`);
      await new Promise(() => {});
    }
    const { renderTerminal } = await import("./dashboard/terminal.ts");
    const pick = () => (opts.session ? app.db.get<{ session_id: string }>("SELECT session_id FROM sessions WHERE session_id LIKE ?", `${opts.session}%`)?.session_id : listSessions(app.db, 1)[0]?.session_id);
    const draw = () => {
      const id = pick();
      const v = id ? sessionView(app.db, id) : null;
      const text = v ? renderTerminal(v) : "no session yet";
      if (!opts.once) process.stdout.write("\x1b[2J\x1b[H");
      process.stdout.write(`${text}\n`);
    };
    draw();
    if (opts.once) return app.db.close();
    setInterval(draw, opts.interval * 1000);
    await new Promise(() => {});
  });

program
  .command("export")
  .description("export a session's data for Python / DuckDB (CSV or JSONL)")
  .requiredOption("-s, --session <id>", "session id")
  .option("-t, --table <name...>", "tables (default: positions, position_events, signals, scores)")
  .option("--all", "every table")
  .option("-f, --format <fmt>", "csv | jsonl", "csv")
  .option("-o, --out <dir>", "output directory", "exports")
  .action(async (opts) => {
    const app = createApp(cfgPath());
    const { exportSession, EXPORTS } = await import("./report/export.ts");
    const id = app.db.get<{ session_id: string }>("SELECT session_id FROM sessions WHERE session_id LIKE ?", `${opts.session}%`)?.session_id;
    if (!id) throw new Error("session not found");
    const tables = opts.all ? Object.keys(EXPORTS) : (opts.table ?? ["positions", "position_events", "signals", "scores"]);
    for (const r of await exportSession(app.db, id, tables, opts.out, opts.format)) console.log(`${r.table.padEnd(18)} ${String(r.rows).padStart(8)} rows  ${r.path}`);
    app.db.close();
  });

program
  .command("analyze")
  .description("cross-session analytics: signal vs baseline, score calibration, consistency (holdout kept apart)")
  .option("-s, --session <id...>", "sessions (prefixes); default: all simulation sessions")
  .option("--last <n>", "only the last N sessions", (v) => parseInt(v, 10))
  .option("--label <text>", "only sessions whose label contains this")
  .option("--holdout <n>", "keep the last N sessions as holdout", (v) => parseInt(v, 10), 0)
  .option("--live", "live sessions only (no replays)")
  .action(async (opts) => {
    const app = createApp(cfgPath());
    const { analyzeSessions, pickSessions } = await import("./report/crossSession.ts");
    const sessions = pickSessions(app.db, { ids: opts.session, last: opts.last, label: opts.label, live: opts.live });
    if (!sessions.length) throw new Error("no simulation sessions with closed positions");
    const r = analyzeSessions(app.db, sessions, opts.holdout);
    console.log(r.text);
    console.log(`written: ${r.markdown}`);
    app.db.close();
  });

const macroCmd = program.command("macro").description("scheduled macro events (FOMC, CPI, ...) used as a time filter");
macroCmd
  .command("import")
  .description("load config/macro_events.yaml (or --file) into the macro_events table")
  .option("-f, --file <path>", "YAML file", "config/macro_events.yaml")
  .action(async (opts) => {
    const app = createApp(cfgPath());
    const { readFileSync } = await import("node:fs");
    const YAML = (await import("yaml")).default;
    const doc = YAML.parse(readFileSync(opts.file, "utf8")) as { events?: { ts: string; name: string; impact?: string }[] };
    let n = 0;
    for (const e of doc.events ?? []) {
      const ts = Date.parse(e.ts);
      if (!Number.isFinite(ts)) throw new Error(`bad timestamp: ${e.ts}`);
      app.db.insert("macro_events", { ts, name: e.name, impact: e.impact ?? null }, "OR REPLACE");
      n++;
    }
    console.log(`imported ${n} macro events`);
    for (const r of app.db.all<{ ts: number; name: string; impact: string }>("SELECT * FROM macro_events WHERE ts >= ? ORDER BY ts", Date.now()))
      console.log(`  ${new Date(r.ts).toISOString()}  ${r.name}  ${r.impact ?? ""}`);
    app.db.close();
  });

const capitalList = (v: string) => v.split(",").map((x) => parseFloat(x)).filter((x) => Number.isFinite(x) && x > 0);

program
  .command("scorecard")
  .description("strategy scorecard (roadmap PHASE 5-8): sample, performance, fixed vs variable cost, capital efficiency, rug exposure, regime, projection to other capitals")
  .option("-s, --session <id...>", "sessions (prefixes); default: all live sessions")
  .option("--last <n>", "only the last N sessions", (v) => parseInt(v, 10))
  .option("--label <text>", "only sessions whose label contains this")
  .option("--replays", "include replays (not independent evidence)")
  .option("-m, --mode <mode...>", "only these entry modes")
  .option("--capitals <list>", "capitals to project to, comma separated", capitalList, [40, 45, 50, 100, 1000])
  .option("--holdout <n>", "keep the last N sessions apart: a scorecard for the selection sessions and one for the holdout (roadmap PHASE 13)", (v) => parseInt(v, 10), 0)
  .action(async (opts) => {
    const app = createApp(cfgPath());
    const { pickSessions } = await import("./report/crossSession.ts");
    const { scorecard, scorecardMarkdown } = await import("./analysis/scorecard.ts");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const sessions = pickSessions(app.db, { ids: opts.session, last: opts.last, label: opts.label, live: !opts.replays && !opts.session });
    if (!sessions.length) throw new Error("no simulation sessions with closed positions");
    const card = (ids: string[]) => scorecard(app.db, ids, { modes: opts.mode, capitals: opts.capitals, regime: app.lc.config.regime });
    const ids = sessions.map((s) => s.session_id);
    const h = Math.max(0, Math.min(opts.holdout as number, ids.length - 1));
    const md = h > 0
      ? [
          `# Strategy scorecard: ${ids.length - h} selection session(s), ${h} holdout session(s)`,
          "",
          "Choose components and thresholds on the selection sessions only; the holdout is read once, at the end, to check the choice (roadmap PHASE 13 / 15).",
          "",
          `## Selection (${ids.length - h} sessions)`,
          "",
          scorecardMarkdown(card(ids.slice(0, -h)), { title: false }),
          `## Holdout (${h} sessions, the latest)`,
          "",
          scorecardMarkdown(card(ids.slice(-h)), { title: false }),
        ].join(String.fromCharCode(10))
      : scorecardMarkdown(card(ids));
    mkdirSync("reports", { recursive: true });
    const file = `reports/scorecard-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.md`;
    writeFileSync(file, md);
    console.log(md);
    console.log(`written: ${file}`);
    app.db.close();
  });

program
  .command("capital")
  .description("capital-aware simulation (roadmap PHASE 7): replay a session at several position sizes and compare net, break-even and fixed cost per entry mode")
  .requiredOption("-s, --session <id>", "live session to replay (prefix)")
  .option("--capitals <list>", "position sizes in USD, comma separated", capitalList, [40, 45, 50, 100, 1000])
  .option("--no-replay", "only the projection from the stored positions (no replays)")
  .action(async (opts) => {
    const app = createApp(cfgPath());
    const { pickSessions } = await import("./report/crossSession.ts");
    const { scorecard, capitalComparisonMarkdown } = await import("./analysis/scorecard.ts");
    const { runReplay } = await import("./sim/replayRunner.ts");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const src = pickSessions(app.db, { ids: [opts.session] }).find((s) => s.kind === "session");
    if (!src) throw new Error(`no live session ${opts.session} with closed positions`);
    const base = scorecard(app.db, [src.session_id], { capitals: opts.capitals, regime: app.lc.config.regime });
    const runs: { capital: number; sessionId: string }[] = [];
    if (opts.replay)
      for (const c of opts.capitals as number[]) {
        const t0 = Date.now();
        const r = runReplay(app, { sourceSessionId: src.session_id, capitalUsd: c });
        console.log(`$${c}: replay ${r.sessionId} (${r.closed} positions) in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
        runs.push({ capital: c, sessionId: r.sessionId });
      }
    const replays = runs.map((r) => ({ capital: r.capital, sc: scorecard(app.db, [r.sessionId], { capitals: [r.capital] }) }));
    const md = capitalComparisonMarkdown(src.session_id, base, replays);
    mkdirSync("reports", { recursive: true });
    const file = `reports/capital-${src.session_id.slice(0, 8)}-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.md`;
    writeFileSync(file, md);
    console.log(md);
    console.log(`written: ${file}`);
    app.db.close();
  });

program
  .command("registry")
  .description("strategy registry (roadmap PHASE 1-2): strategies, sources, fidelity, per-component decomposition")
  .option("--status <status>", "implemented | candidate | reference | excluded")
  .option("--id <id>", "show one strategy in full, with its component table")
  .option("--components", "strategy x component grid of deviations")
  .option("--component <name>", "one component across strategies: entry | filter | side | range | position_size | exit | reentry | rebalance | transaction_policy")
  .option("--check", "check the registry against grid.entry_modes; exit 1 on a problem")
  .action(async (opts) => {
    const { loadRegistry, checkRegistry, registryMarkdown, registryComponentGrid, registryComponentMarkdown, COMPONENTS } = await import("./registry/strategies.ts");
    const reg = loadRegistry();
    if (opts.check) {
      const cfg = loadConfig(cfgPath()).config;
      const problems = checkRegistry(reg, cfg.grid.entry_modes);
      console.log(problems.length ? problems.join(String.fromCharCode(10)) : `registry ok: ${reg.strategies.length} strategies`);
      if (problems.length) process.exitCode = 1;
      return;
    }
    if (opts.components) return void console.log(registryComponentGrid(reg));
    if (opts.component) {
      if (!(COMPONENTS as readonly string[]).includes(opts.component)) {
        console.error(`unknown component ${opts.component}; one of ${COMPONENTS.join(", ")}`);
        process.exitCode = 1;
        return;
      }
      return void console.log(registryComponentMarkdown(reg, opts.component, { status: opts.status }));
    }
    console.log(registryMarkdown(reg, { status: opts.status, id: opts.id }));
  });
program
  .command("rugs")
  .description("rug post-mortem: what the tokens flagged by the rug detector looked like before the rug, and which entry screens would have caught them")
  .option("--lead <minutes>", "read the features at least this long before the rug", parseFloat, 10)
  .action(async (opts) => {
    const app = createApp(cfgPath());
    const { rugReport, rugReportMarkdown } = await import("./analysis/rugs.ts");
    console.log(rugReportMarkdown(rugReport(app.db, opts.lead)));
    app.db.close();
  });
const lpCmd = program.command("lp").description("real LP positions of other wallets (phase 11): collection, smart LPs, simulator realism");
lpCmd
  .command("collect")
  .description("scan open positions on chain and fetch wallets' position PnL from the Meteora Data API")
  .option("-s, --session <id>", "use the pools of this session (default: latest session / collect)")
  .option("-p, --pool <address...>", "pools")
  .option("--scans <n>", "number of scans", (v) => parseInt(v, 10), 1)
  .option("--interval <minutes>", "minutes between scans", parseFloat)
  .option("--wallets <n>", "override real_lp.max_wallet_queries_per_scan", (v) => parseInt(v, 10))
  .action(async (opts) => {
    const app = createApp(cfgPath());
    const { MeteoraApi } = await import("./api/meteora.ts");
    const { RpcClient } = await import("./chain/rpc.ts");
    const { endpoints } = await import("./app.ts");
    const { loadPoolMeta } = await import("./collectors/discovery.ts");
    const { RealLpCollector } = await import("./collectors/realLp.ts");
    const { latestSession, getSession } = await import("./db/repo.ts");
    const c = structuredClone(app.lc.config);
    if (opts.wallets !== undefined) c.real_lp.max_wallet_queries_per_scan = opts.wallets;
    let pools: string[] = opts.pool ?? [];
    if (!pools.length) {
      const s = opts.session ? getSession(app.db, opts.session) : (latestSession(app.db, "session") ?? latestSession(app.db, "collect"));
      if (!s) throw new Error("no session found; pass --pool");
      pools = app.db.all<{ pool: string }>("SELECT pool FROM session_pools WHERE session_id=? ORDER BY rank", s.session_id).map((r) => r.pool);
    }
    const metas = new Map(pools.map((p) => [p, loadPoolMeta(app.db, p)]).filter((x): x is [string, NonNullable<ReturnType<typeof loadPoolMeta>>] => !!x[1]));
    const rpc = new RpcClient({ url: endpoints(app.lc).httpUrl, maxRps: Math.max(0.5, c.rpc.max_rps / 2), maxConcurrency: 1, timeoutMs: 60_000, retry: c.rpc.retry, commitment: c.rpc.commitment, log: app.log });
    const api = new MeteoraApi({ baseUrl: c.api.meteora_base_url, maxRps: Math.min(c.api.max_rps, 3), timeoutMs: c.api.request_timeout_ms, retry: c.api.retry, log: app.log });
    const col = new RealLpCollector({ db: app.db, rpc, api: api.http, config: c, log: app.log, pools: metas });
    for (let i = 0; i < opts.scans; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, (opts.interval ?? c.real_lp.scan_minutes) * 60_000));
      const st = await col.tick();
      console.log(`scan ${i + 1}/${opts.scans}: ${JSON.stringify(st)}`);
    }
    const tot = app.db.get<{ n: number; closed: number; wallets: number }>("SELECT COUNT(*) n, SUM(is_closed) closed, COUNT(DISTINCT wallet) wallets FROM real_lp_positions")!;
    console.log(`real_lp_positions: ${tot.n} (${tot.closed ?? 0} closed) from ${tot.wallets} wallets; RPC credits ~${rpc.creditsUsed}`);
    app.db.close();
  });
lpCmd
  .command("realism")
  .description("replay simple real positions inside our data in the simulator; compare fee and PnL")
  .option("-s, --session <id>", "only this data session")
  .option("--recheck", "re-run positions already checked")
  .action(async (opts) => {
    const app = createApp(cfgPath());
    const { runRealismChecks, realismMarkdown } = await import("./analysis/realism.ts");
    const r = runRealismChecks(app.db, app.lc.config, { dataSessionId: opts.session, recheck: opts.recheck });
    console.log(`checked ${r.checked}, skipped ${r.skipped} ${JSON.stringify(r.byReason)}`);
    console.log(realismMarkdown(app.db, opts.session));
    app.db.close();
  });
lpCmd
  .command("outcomes")
  .description("outcomes of real positions that opened while we watched, followed to closure (survival + PnL by width / shape / hold time, censoring-aware)")
  .option("-p, --pool <address...>", "only these pools")
  .option("--since-hours <h>", "only positions first seen within the last N hours", parseFloat)
  .option("--min-deposit <usd>", "ignore PnL of positions with a smaller deposit", parseFloat, 20)
  .action(async (opts) => {
    const app = createApp(cfgPath());
    const { lpOutcomes, lpOutcomesMarkdown } = await import("./analysis/lpOutcomes.ts");
    const r = lpOutcomes(app.db, {
      pools: opts.pool, minDepositUsd: opts.minDeposit,
      since: opts.sinceHours !== undefined ? Date.now() - opts.sinceHours * 3_600_000 : undefined,
    });
    console.log(lpOutcomesMarkdown(r));
    app.db.close();
  });
lpCmd
  .command("wallets")
  .description("recompute lp_wallets and list the best wallets")
  .option("-n, --top <n>", "rows", (v) => parseInt(v, 10), 20)
  .option("--smart", "smart wallets only")
  .action(async (opts) => {
    const app = createApp(cfgPath());
    const { recomputeWallets } = await import("./collectors/realLp.ts");
    const n = recomputeWallets(app.db, app.lc.config.real_lp.smart);
    const rows = app.db.all<{ wallet: string; positions: number; closed_positions: number; win_rate: number | null; avg_pnl_pct: number | null; total_pnl_usd: number | null; status_smart: number }>(
      `SELECT * FROM lp_wallets ${opts.smart ? "WHERE status_smart = 1" : ""} ORDER BY status_smart DESC, total_pnl_usd DESC LIMIT ?`, opts.top,
    );
    console.log(`${n} wallets; smart: ${app.db.get<{ n: number }>("SELECT COUNT(*) n FROM lp_wallets WHERE status_smart = 1")!.n}`);
    for (const r of rows)
      console.log(`${r.wallet.padEnd(44)} ${r.status_smart ? "SMART" : "     "} closed ${String(r.closed_positions).padStart(4)}/${String(r.positions).padEnd(4)} win ${r.win_rate === null ? "  -" : (r.win_rate * 100).toFixed(0).padStart(3) + "%"} avg ${(r.avg_pnl_pct ?? 0).toFixed(1).padStart(6)}%  total $${(r.total_pnl_usd ?? 0).toFixed(0)}`);
    app.db.close();
  });

program
  .command("portfolio")
  .description("sequential account over stored positions: one at a time, compounding, daily stop (Friday-style calendar and drawdown)")
  .option("-s, --session <id...>", "simulation session(s); several are chained by time")
  .option("--last <n>", "the last N finished live sessions", (v) => parseInt(v, 10))
  .requiredOption("-m, --mode <mode>", "entry mode: friday_scalp, yunus_flip, fork_panda, evil_panda, meridian_preset, signal_enter, signal_watch, all_pools_baseline")
  .option("-w, --where <filter...>", "grid_combo filters: key=value or key~prefix, e.g. exit_policy~scalp bins_per_side=34 strategy=spot")
  .option("--capital <usd>", "starting capital", parseFloat)
  .option("--fraction <f>", "share of the equity per trade (1 = all, compounding)", parseFloat)
  .option("--max-trade <usd>", "trade size cap in USD (0 = none)", parseFloat)
  .option("--daily-stop <pct>", "stop for the day after a realized loss of this % of the day's start equity (0 = off)", parseFloat)
  .option("--tz <tz>", "WIB | UTC (day boundary)")
  .option("--pick <rule>", "first | random | score when several positions open together")
  .option("--seed <n>", "seed for --pick random", (v) => parseInt(v, 10))
  .option("--all", "include positions with a data gap")
  .option("--days <n>", "show only the last N days of the calendar", (v) => parseInt(v, 10))
  .option("-o, --out <dir>", "write the markdown and the trade CSV here", "reports/portfolio")
  .action(async (opts) => {
    const app = createApp(cfgPath());
    const { runPortfolio, portfolioMarkdown, equityCsv } = await import("./analysis/portfolio.ts");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const c = app.lc.config.portfolio;
    let ids: string[] = opts.session ?? [];
    if (opts.last)
      ids = app.db
        .all<{ session_id: string }>("SELECT session_id FROM sessions WHERE kind = 'session' AND status != 'running' ORDER BY start_at DESC LIMIT ?", opts.last)
        .map((r) => r.session_id);
    if (!ids.length) throw new Error("pass --session <id> or --last <n>");
    ids = ids.map((id) => app.db.get<{ session_id: string }>("SELECT session_id FROM sessions WHERE session_id LIKE ? || '%' ORDER BY start_at DESC", id)?.session_id ?? id);
    const where = (opts.where ?? []).map((w: string) => {
      const m = /^([a-z_][a-z0-9_]*)([=~])(.*)$/.exec(w);
      if (!m) throw new Error(`bad filter "${w}" (use key=value or key~prefix)`);
      return { key: m[1], op: m[2] as "=" | "~", value: m[3] };
    });
    const r = runPortfolio(app.db, {
      sessionIds: ids, mode: opts.mode, where,
      startCapitalUsd: opts.capital ?? c.start_capital_usd, sizeFraction: opts.fraction ?? c.size_fraction,
      maxTradeUsd: opts.maxTrade === undefined ? c.max_trade_usd : opts.maxTrade > 0 ? opts.maxTrade : null,
      dailyStopPct: opts.dailyStop ?? c.daily_stop_pct, tz: opts.tz ?? c.tz, pick: opts.pick ?? c.pick, seed: opts.seed ?? 1,
      windowSeconds: c.window_seconds, cleanOnly: !opts.all,
    });
    const md = portfolioMarkdown(r, { calendarDays: opts.days });
    console.log(`sessions: ${ids.map((i) => i.slice(0, 8)).join(", ")}\n\n${md}`);
    mkdirSync(opts.out, { recursive: true });
    const stem = `${opts.mode}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`;
    writeFileSync(`${opts.out}/${stem}.md`, md + "\n");
    writeFileSync(`${opts.out}/${stem}.csv`, equityCsv(r));
    console.log(`\nwritten: ${opts.out}/${stem}.md, .csv`);
    app.db.close();
  });

const tgCmd = program.command("telegram").description("read-only Telegram notifications and commands (phase 12)");
const tgSetup = async () => {
  const app = createApp(cfgPath());
  const { TelegramApi } = await import("./notify/telegramApi.ts");
  const { TelegramService, accessFromEnv } = await import("./notify/service.ts");
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set in .env");
  const api = new TelegramApi(token);
  const access = accessFromEnv();
  const c = app.lc.config;
  let explain;
  if (c.llm.enabled) {
    const { LlmLayer, briefingExplainer } = await import("./llm/layer.ts");
    const { providerFromConfig } = await import("./llm/client.ts");
    explain = briefingExplainer(new LlmLayer(app.db, c.llm, providerFromConfig(c.llm), app.log));
  }
  return { app, api, access, svc: new TelegramService(app.db, c.telegram, api, access, app.log, c.rpc.quota.warn_at_pct, explain) };
};
tgCmd
  .command("run")
  .description("run the notifier + command handler until Ctrl+C (use when the session does not run it: telegram.in_session false)")
  .action(async () => {
    const { app, access, svc } = await tgSetup();
    if (!access.chatIds.length || !access.userIds.length) throw new Error("set TELEGRAM_CHAT_ID and TELEGRAM_ALLOWED_USER_IDS in .env");
    const ac = new AbortController();
    process.once("SIGINT", () => ac.abort());
    process.once("SIGTERM", () => ac.abort());
    console.log(`telegram: notifying ${access.chatIds.length} chat(s), commands from ${access.userIds.length} user(s); Ctrl+C to stop`);
    await svc.run(ac.signal);
    app.db.close();
  });
tgCmd
  .command("test")
  .description("send a test message to TELEGRAM_CHAT_ID")
  .action(async () => {
    const { app, access, svc } = await tgSetup();
    svc.enqueue("reply", "✅ dlmm test message: notifications work. /help lists the read-only commands.", true);
    await svc.flush();
    console.log(`sent to ${access.chatIds.join(", ") || "(no TELEGRAM_CHAT_ID set)"}; see notifications_log for the status`);
    app.db.close();
  });
tgCmd
  .command("whoami")
  .description("print chat and user ids of recent messages to the bot (to fill TELEGRAM_CHAT_ID / TELEGRAM_ALLOWED_USER_IDS)")
  .action(async () => {
    const { app, api } = await tgSetup();
    const ups = await api.getUpdates(undefined, 0);
    if (!ups.length) console.log("no recent messages: send /start to the bot, then run this again");
    for (const u of ups) if (u.message) console.log(`chat ${u.message.chat.id} (${u.message.chat.type})  user ${u.message.from?.id} @${u.message.from?.username ?? "-"}: ${u.message.text ?? ""}`);
    app.db.close();
  });

const llmCmd = program.command("llm").description("conditional LLM layer (phase 13.2): features and explanations only");
llmCmd
  .command("status")
  .description("activation condition, budget, recent calls")
  .action(async () => {
    const app = createApp(cfgPath());
    const { LlmLayer } = await import("./llm/layer.ts");
    const layer = new LlmLayer(app.db, app.lc.config.llm, null);
    const a = layer.activation();
    const b = layer.budget();
    console.log(`llm: ${app.lc.config.llm.enabled ? "enabled" : "disabled"} (${app.lc.config.llm.provider} ${app.lc.config.llm.model}, prompt ${app.lc.config.llm.prompt_version})`);
    console.log(`activation: ${a.active ? "ACTIVE" : "inactive"} — ${a.reason} (clean sessions ${a.cleanSessions}/${a.needed})`);
    console.log(`budget: $${b.spentTodayUsd.toFixed(4)} of $${app.lc.config.llm.daily_budget_usd} today, ${b.callsLastHour} calls in the last hour (${b.reason})`);
    for (const r of app.db.all<{ ts: number; role: string; subject: string | null; valid: number; error: string | null; cost_usd: number }>("SELECT ts, role, subject, valid, error, cost_usd FROM llm_calls ORDER BY id DESC LIMIT 10"))
      console.log(`  ${new Date(r.ts).toISOString()} ${r.role.padEnd(12)} ${(r.subject ?? "").slice(0, 12).padEnd(12)} ${r.valid ? "valid  " : "INVALID"} $${r.cost_usd.toFixed(4)} ${r.error ?? ""}`);
    app.db.close();
  });
llmCmd
  .command("test")
  .description("one manual call (skips only the activation condition; the switch, budget and validation still apply)")
  .option("--token <mint>", "token_social on this mint")
  .option("-s, --session <id>", "explainer on this session's result")
  .action(async (opts) => {
    const app = createApp(cfgPath());
    const { LlmLayer } = await import("./llm/layer.ts");
    const { providerFromConfig } = await import("./llm/client.ts");
    const c = app.lc.config;
    const layer = new LlmLayer(app.db, c.llm, providerFromConfig(c.llm), app.log);
    if (opts.token) {
      const { LlmFeatureCollector } = await import("./llm/collector.ts");
      const { publicHttp } = await import("./collectors/extraCollectors.ts");
      const col = new LlmFeatureCollector(app.db, c, layer, new Map(), publicHttp(c, c.api.dexscreener_base_url, "dexscreener", { log: app.log }), app.log);
      const data = await col.tokenData(opts.token);
      console.log("input:", JSON.stringify(data).slice(0, 600));
      console.log(JSON.stringify(await layer.tokenSocial(opts.token, data, { force: true }), null, 2));
    } else if (opts.session) {
      const { formatSessionResult } = await import("./notify/format.ts");
      console.log(JSON.stringify(await layer.explain(opts.session, { hasil_sesi: formatSessionResult(app.db, opts.session, "Sesi") }, { force: true }), null, 2));
    } else console.log("pass --token <mint> or --session <id>");
    app.db.close();
  });

const blockCmd = program.command("blocklist").description("token / dev blocklist (safety gate veto, phase 10)");
blockCmd
  .command("add")
  .description("block a token mint or a dev wallet")
  .argument("<kind>", "token | dev")
  .argument("<address>", "mint or wallet")
  .requiredOption("-r, --reason <text>", "why")
  .action(async (kind: string, address: string, opts) => {
    if (kind !== "token" && kind !== "dev") throw new Error("kind must be token or dev");
    const app = createApp(cfgPath());
    const { addBlock } = await import("./features/safetyData.ts");
    console.log(addBlock(app.db, kind, address, opts.reason, "manual") ? `blocked ${kind} ${address}` : `${kind} ${address} is already blocked`);
    app.db.close();
  });
blockCmd
  .command("remove")
  .description("unblock (soft delete: replays of older sessions keep the entry)")
  .argument("<kind>", "token | dev")
  .argument("<address>", "mint or wallet")
  .action(async (kind: string, address: string) => {
    if (kind !== "token" && kind !== "dev") throw new Error("kind must be token or dev");
    const app = createApp(cfgPath());
    const { removeBlock } = await import("./features/safetyData.ts");
    console.log(`${removeBlock(app.db, kind, address)} entr(ies) removed`);
    app.db.close();
  });
blockCmd
  .command("list")
  .description("active entries (--all: removed ones too)")
  .option("--all", "include removed entries")
  .action(async (opts) => {
    const app = createApp(cfgPath());
    const where = opts.all ? "" : "WHERE removed_at IS NULL";
    for (const [kind, table, col] of [["token", "blocklist_tokens", "mint"], ["dev", "blocklist_devs", "wallet"]] as const) {
      const rows = app.db.all<{ key: string; reason: string; source: string; added_at: number; removed_at: number | null }>(
        `SELECT ${col} key, reason, source, added_at, removed_at FROM ${table} ${where} ORDER BY added_at`,
      );
      console.log(`${kind}s: ${rows.length}`);
      for (const r of rows)
        console.log(`  ${r.key}  ${r.source.padEnd(8)} ${new Date(r.added_at).toISOString()}${r.removed_at ? ` removed ${new Date(r.removed_at).toISOString()}` : ""}  ${r.reason}`);
    }
    app.db.close();
  });

program
  .command("calibrate")
  .description("fit module weights from the journal, validate walk-forward + holdout, write a new config_version if it is better")
  .option("--write", "write config/calibrated/<profile>.yaml when accepted")
  .option("--force", "evaluate even with fewer sessions than calibration.min_sessions (never writes on its own)")
  .option("--source <source>", "sim (simulator baseline positions) or real_lp (real positions of other wallets, kept separate)", "sim")
  .action(async (opts) => {
    if (opts.source !== "sim" && opts.source !== "real_lp") throw new Error("--source must be sim or real_lp");
    const app = createApp(cfgPath());
    const { calibrate } = await import("./calibration/calibrate.ts");
    const r = calibrate(app.db, app.lc, { force: opts.force, write: opts.write, source: opts.source });
    console.log(`source: ${opts.source}`);
    console.log(`status: ${r.status}  data sessions: ${r.dataSessions}  observations: ${r.observations}`);
    for (const n of r.notes) console.log(`  note: ${n}`);
    for (const c of r.categories) {
      console.log(`\n[${c.category}] observations ${c.observations}  walk-forward folds ${c.walkForward.folds}  accepted: ${c.accepted}`);
      console.log(`  current   ${JSON.stringify(c.current)}`);
      console.log(`  candidate ${JSON.stringify(Object.fromEntries(Object.entries(c.candidate).map(([k, v]) => [k, Math.round((v ?? 0) * 10) / 10])))}`);
      if (c.holdout) console.log(`  holdout Spearman current ${c.holdout.current.spearman?.toFixed(3)} vs candidate ${c.holdout.candidate.spearman?.toFixed(3)}; uplift ${c.holdout.current.uplift?.toFixed(3)} vs ${c.holdout.candidate.uplift?.toFixed(3)} pp`);
      if (!c.accepted) console.log(`  not accepted: ${c.reasons.join("; ")}`);
    }
    if (r.newConfigPath) console.log(`\nnew config: ${r.newConfigPath}  (${r.newConfigVersion})`);
    console.log(`report: ${r.reportPath}`);
    app.db.close();
  });

async function main() {
  try {
    await program.parseAsync(process.argv);
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  } finally {
    await flushLogger();
  }
}

void main();
