import type { Db } from "../db/index.ts";

export function printScoreSummary(db: Db, sessionId: string) {
  const acts = db.all<{ action: string; n: number }>("SELECT action, COUNT(*) n FROM scores WHERE session_id=? GROUP BY action", sessionId);
  console.log(`actions: ${acts.map((a) => `${a.action}=${a.n}`).join("  ")}`);
  const rows = db.all<{ name: string; n: number; final: number | null; edge: number | null; regime: number | null; flow: number | null; comp: number | null; safety: number | null; conf: number; gate: number; masuk: number; pantau: number; label: string | null; reasons: string | null }>(
    `SELECT pl.name, COUNT(*) n, AVG(s.final_score) final, AVG(s.edge) edge, AVG(s.regime) regime, AVG(s.flow) flow, AVG(s.competition) comp,
            AVG(s.safety) safety, AVG(s.confidence) conf, AVG(s.gate_passed) gate, SUM(s.action='MASUK') masuk, SUM(s.action='PANTAU') pantau,
            (SELECT regime_label FROM scores s2 WHERE s2.session_id=s.session_id AND s2.pool=s.pool GROUP BY regime_label ORDER BY COUNT(*) DESC LIMIT 1) label,
            (SELECT gate_reasons FROM scores s3 WHERE s3.session_id=s.session_id AND s3.pool=s.pool AND gate_passed=0 LIMIT 1) reasons
     FROM scores s JOIN pools pl ON pl.pool=s.pool WHERE s.session_id=? GROUP BY s.pool ORDER BY final DESC`,
    sessionId,
  );
  const f = (v: number | null, d = 0) => (v === null ? "  -" : v.toFixed(d)).padStart(5);
  console.log("pool                   n   final  edge  regime flow  comp  safe  conf  gate%  MASUK PANTAU  regime(mode)   gate reasons");
  for (const r of rows) {
    console.log(`${r.name.slice(0, 18).padEnd(18)} ${String(r.n).padStart(5)} ${f(r.final, 1)} ${f(r.edge)} ${f(r.regime)}  ${f(r.flow)} ${f(r.comp)} ${f(r.safety)} ${f(r.conf, 2)} ${f(r.gate * 100)}% ${String(r.masuk).padStart(5)} ${String(r.pantau).padStart(6)}  ${(r.label ?? "-").padEnd(14)} ${r.reasons ?? ""}`);
  }
  const miss = db.all<{ name: string; avail: number }>(
    "SELECT name, AVG(raw_value IS NOT NULL) avail FROM features WHERE session_id=? GROUP BY name ORDER BY avail", sessionId,
  );
  console.log(`feature availability: ${miss.map((m) => `${m.name}=${Math.round(m.avail * 100)}%`).join(" ")}`);
}
