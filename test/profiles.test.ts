import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.ts";
import { gridCombos } from "../src/sim/gridRunner.ts";
import { loadYunusPreset, yunusCombos } from "../src/sim/yunus.ts";
import { exitPolicyLabel } from "../src/sim/policies.ts";

describe("session profiles", () => {
  for (const path of ["config/default.yaml", "config/session-2h.yaml", "config/session-3d.yaml"]) {
    it(`${path} is valid and its gap thresholds follow the collector cadence (stale after >= 3 intervals)`, () => {
      const c = loadConfig(path).config;
      const col = c.collectors;
      const stale = c.gaps.stale_after_seconds;
      // a source is stale after several missed intervals; less and healthy pools would open false gaps
      expect(stale.pool_state).toBeGreaterThanOrEqual(3 * col.pool_state.interval_seconds);
      expect(stale.bin_snapshot).toBeGreaterThanOrEqual(3 * col.bin_snapshot.interval_seconds);
      expect(stale.ohlcv).toBeGreaterThanOrEqual(2 * col.ohlcv.interval_seconds);
    });
  }

  it("the 3-day profile: 72 h, reduced sampling, no new cycles in the last 12 h, positions within the cap", () => {
    const d = loadConfig("config/default.yaml").config;
    const c = loadConfig("config/session-3d.yaml").config;
    expect(c.session.duration_minutes).toBe(72 * 60);
    expect(c.session.stop_new_positions_before_end_minutes).toBeGreaterThanOrEqual(12 * 60);
    expect(c.collectors.pool_state.interval_seconds).toBeGreaterThan(d.collectors.pool_state.interval_seconds);
    expect(c.collectors.bin_snapshot.interval_seconds).toBeGreaterThan(d.collectors.bin_snapshot.interval_seconds);
    expect(c.collectors.swap_stream.sample_per_minute).toBeLessThan(d.collectors.swap_stream.sample_per_minute);
    expect(c.real_lp.scan_minutes).toBeGreaterThan(d.real_lp.scan_minutes);
    expect(c.grid.entry_modes).toContain("yunus_flip");
    // worst-case positions: sampled grid x pools x cohorts, plus one yunus cycle set per pool and cohort
    const cohorts = Math.ceil((c.session.duration_minutes - c.session.warmup_minutes - c.session.stop_new_positions_before_end_minutes) / c.grid.cohort_interval_minutes);
    const perPoolCohort = gridCombos(c, { allowSignalModes: true, sessionMinutes: c.session.duration_minutes }).length;
    const yunus = yunusCombos(loadYunusPreset(c.presets.yunus), exitPolicyLabel).length;
    expect((perPoolCohort + yunus + 5) * c.discovery.max_pools * cohorts).toBeLessThanOrEqual(c.grid.max_positions * 2);
    expect(cohorts).toBeGreaterThanOrEqual(8);
  });

  it("the yunus time cap fits inside a 24 h session's tail, and every exit policy of the preset is a valid grid policy", () => {
    const p = loadYunusPreset("presets/yunus.yaml");
    const caps = yunusCombos(p, exitPolicyLabel).map((x) => (x.exit as { time_cap_minutes?: number; minutes?: number }).time_cap_minutes ?? (x.exit as { minutes?: number }).minutes ?? 0);
    expect(Math.max(...caps)).toBeLessThanOrEqual(1440);
  });
});
