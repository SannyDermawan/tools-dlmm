import { describe, expect, it } from "vitest";
import { Db, migrate } from "../src/db/index.ts";
import { pickSessions } from "../src/report/crossSession.ts";

const T0 = Date.parse("2026-10-01T00:00:00Z");

function seed() {
  const db = new Db(":memory:");
  migrate(db);
  db.run("INSERT INTO config_versions (config_version, config_json, config_hash, created_at) VALUES ('v', '{}', 'h', 0)");
  const session = (id: string, kind: string, status: string, start: number, label: string, notes: string | null = null) =>
    db.run("INSERT INTO sessions (session_id, kind, start_at, label, config_version, status, notes) VALUES (?, ?, ?, ?, 'v', ?, ?)", id, kind, start, label, status, notes);
  const pos = (id: string, sid: string, status: string) =>
    db.run(
      `INSERT INTO sim_positions (position_id, session_id, pool, grid_combo, entry_mode, strategy, sides, bins_below, bins_above, capital_usd, requested_at, status, gap_tainted, config_version)
       VALUES (?, ?, 'P', '{}', 'all_pools_baseline', 'spot', 'two_sided', 5, 5, 1000, 0, ?, 0, 'v')`,
      id, sid, status,
    );
  session("S1", "session", "completed", T0, "sesi-2jam");
  session("S2", "session", "aborted", T0 + 1000, "sesi-2jam"); // interrupted, nobody finalized it
  session("S3", "session", "aborted", T0 + 2000, "sesi-2jam"); // interrupted, finalized by R3
  session("R1", "sim_replay", "completed", T0 + 3000, "replay:sesi-2jam", JSON.stringify({ timing: {} }));
  session("R3", "sim_replay", "completed", T0 + 2000, "finalized:sesi-2jam", JSON.stringify({ finalizes: "S3" }));
  session("R4", "sim_replay", "completed", T0 + 4000, "replay:old", "free text, not json");
  for (const s of ["S1", "S2", "S3", "R1", "R3", "R4"]) {
    pos(`${s}-a`, s, "closed");
    pos(`${s}-b`, s, "active"); // never closed: only closed positions make a session count
  }
  return db;
}

describe("interrupted sessions and `dlmm sim finalize`", () => {
  it("analytics count a finalized session through its replay and leave the raw interrupted rows out", () => {
    const db = seed();
    expect(pickSessions(db, {}).map((s) => s.session_id)).toEqual(["S1", "R3", "R1", "R4"]);
    const r3 = pickSessions(db, {}).find((s) => s.session_id === "R3")!;
    expect(r3).toMatchObject({ kind: "sim_replay", finalizes: "S3", positions: 1 });
  });

  it("`live` keeps live sessions and finalized ones, not ordinary replays of the same data", () => {
    const db = seed();
    expect(pickSessions(db, { live: true }).map((s) => s.session_id)).toEqual(["S1", "R3"]);
  });

  it("an interrupted session nobody finalized only comes back on request, and never next to its own finalization", () => {
    const db = seed();
    expect(pickSessions(db, { includeAborted: true }).map((s) => s.session_id)).toEqual(["S1", "S2", "R3", "R1", "R4"]);
  });

  it("a finalization that is not completed (superseded, failed) counts for nothing", () => {
    const db = seed();
    db.run("UPDATE sessions SET status = 'failed' WHERE session_id = 'R3'");
    expect(pickSessions(db, {}).map((s) => s.session_id)).toEqual(["S1", "R1", "R4"]);
    expect(pickSessions(db, { live: true }).map((s) => s.session_id)).toEqual(["S1"]);
    expect(pickSessions(db, { includeAborted: true }).map((s) => s.session_id)).toContain("S3");
  });

  it("the finalized session keeps the original's place in time (holdout and `last` read the order)", () => {
    const db = seed();
    expect(pickSessions(db, { live: true, last: 1 }).map((s) => s.session_id)).toEqual(["R3"]);
    expect(pickSessions(db, { ids: ["R3"] })[0].start_at).toBe(T0 + 2000);
  });
});
