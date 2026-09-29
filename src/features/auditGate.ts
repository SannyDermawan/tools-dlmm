import type { Config, PoolCategory } from "../config/schema.ts";
import type { AuditRow, BlockHit } from "./safetyData.ts";

export interface AuditGateResult {
  /** GAGAL reasons (veto) */
  reasons: string[];
  /** filter tags that vetoed (for the report: pools removed per filter) */
  filters: string[];
  /** safety-score points subtracted (organic score, PVP) */
  penalty: number;
  /** non-veto risks worth logging (decision log) */
  warnings: string[];
  /** no Jupiter audit for a risk token */
  auditMissing: boolean;
}

/**
 * Phase 10 checks on top of the blueprint safety gate (addendum 3.1-3.3):
 *  - blocklisted token or dev -> GAGAL (checked first);
 *  - Jupiter audit: bot holders > max, audit.isSus, launchpad block/allow list, token age limits;
 *  - PVP rivals: penalty, GAGAL or ignored (config);
 *  - organic score below the minimum -> safety-score penalty.
 * Missing audit data never vetoes (the blueprint gate already handles missing security data).
 */
export function auditGate(
  category: PoolCategory,
  audits: (AuditRow | null)[],
  blocked: BlockHit[],
  t: number,
  g: Config["scoring"]["safety_gate"],
): AuditGateResult {
  const out: AuditGateResult = { reasons: [], filters: [], penalty: 0, warnings: [], auditMissing: false };
  const veto = (filter: string, reason: string) => {
    out.reasons.push(reason);
    if (!out.filters.includes(filter)) out.filters.push(filter);
  };
  if (g.blocklist) for (const b of blocked) veto("blocklist", `blocklisted ${b.kind} ${b.key.slice(0, 6)} (${b.reason})`);
  if (category === "bluechip") return out;
  for (const a of audits) {
    if (!a) {
      out.auditMissing = true;
      continue;
    }
    const tk = a.token.slice(0, 6);
    if (a.bot_holders_pct !== null && a.bot_holders_pct > g.max_bot_holders_pct) veto("bot_holders", `bot holders ${a.bot_holders_pct.toFixed(1)}% > ${g.max_bot_holders_pct}% (${tk})`);
    if (g.fail_on_sus && a.is_sus) veto("sus", `Jupiter flags token as suspicious (${tk})`);
    const lp = a.launchpad?.toLowerCase() ?? null;
    if (lp && g.launchpad.block.map((x) => x.toLowerCase()).includes(lp)) veto("launchpad", `launchpad ${a.launchpad} blocked`);
    if (g.launchpad.allow.length && !(lp && g.launchpad.allow.map((x) => x.toLowerCase()).includes(lp))) veto("launchpad", `launchpad ${a.launchpad ?? "none"} not allowed`);
    const born = a.first_pool_at ?? a.token_created_at;
    if (born !== null) {
      const hours = (t - born) / 3_600_000;
      if (g.token_age_hours.min !== null && hours < g.token_age_hours.min) veto("token_age", `token age ${hours.toFixed(1)} h < ${g.token_age_hours.min} h`);
      if (g.token_age_hours.max !== null && hours > g.token_age_hours.max) veto("token_age", `token age ${hours.toFixed(0)} h > ${g.token_age_hours.max} h`);
    }
    const riv = a.pvp_rival_count ?? 0;
    if (riv > 0 && g.pvp.mode !== "ignore") {
      if (g.pvp.mode === "fail") veto("pvp", `${riv} PVP rival token(s) with the same symbol (${a.symbol ?? tk})`);
      else {
        out.penalty += g.pvp.penalty;
        out.warnings.push(`${riv} PVP rival token(s) (${a.symbol ?? tk})`);
      }
    }
    if (a.organic_score !== null && a.organic_score < g.organic.min_score) {
      out.penalty += g.organic.penalty;
      out.warnings.push(`organic score ${a.organic_score.toFixed(0)} < ${g.organic.min_score}`);
    }
    if (a.bot_holders_pct === null) out.warnings.push(`bot holders unknown (${tk})`);
  }
  return out;
}
