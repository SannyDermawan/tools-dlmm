const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function inline(s: string): string {
  return esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
}

const cells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

/**
 * Minimal Markdown -> standalone HTML for the session report (the subset the report uses:
 * headings, pipe tables with alignment, lists, block quotes, paragraphs, bold/italic/code).
 */
export function markdownToHtml(md: string, title: string): string {
  const lines = md.split(/\r?\n/);
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (/^\s*$/.test(l)) {
      i++;
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(l);
    if (h) {
      out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
      i++;
      continue;
    }
    if (l.trim().startsWith("|") && i + 1 < lines.length && /^\s*\|?\s*:?-{3}/.test(lines[i + 1])) {
      const head = cells(l);
      const align = cells(lines[i + 1]).map((a) => (a.endsWith(":") ? "right" : "left"));
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) rows.push(cells(lines[i++]));
      out.push(
        `<div class="t"><table><thead><tr>${head.map((c, j) => `<th style="text-align:${align[j] ?? "left"}">${inline(c)}</th>`).join("")}</tr></thead><tbody>` +
          rows.map((r) => `<tr>${r.map((c, j) => `<td style="text-align:${align[j] ?? "left"}">${inline(c)}</td>`).join("")}</tr>`).join("") +
          `</tbody></table></div>`,
      );
      continue;
    }
    if (l.startsWith(">")) {
      const q: string[] = [];
      while (i < lines.length && lines[i].startsWith(">")) q.push(lines[i++].replace(/^>\s?/, ""));
      out.push(`<blockquote>${inline(q.join(" "))}</blockquote>`);
      continue;
    }
    if (/^\s*[-*]\s+/.test(l)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*]\s+/, ""));
      out.push(`<ul>${items.map((x) => `<li>${inline(x)}</li>`).join("")}</ul>`);
      continue;
    }
    const p: string[] = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,4}\s|\||>|\s*[-*]\s)/.test(lines[i])) p.push(lines[i++]);
    if (p.length) out.push(`<p>${inline(p.join(" "))}</p>`);
    else i++;
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
:root{--bg:#fbfbf9;--fg:#1d1d1b;--mut:#6b6b66;--line:#e3e2dc;--card:#fff;--acc:#8a4b2a}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecebe6;--mut:#9c9b95;--line:#34332f;--card:#1c1c1a;--acc:#e0a07a}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,Segoe UI,Roboto,sans-serif}
main{max-width:1100px;margin:0 auto;padding:16px}
h1{font-size:22px}h2{font-size:17px;margin-top:28px;border-bottom:1px solid var(--line);padding-bottom:4px}h3{font-size:15px;margin-top:20px;color:var(--acc)}
.t{overflow-x:auto;margin:8px 0}table{border-collapse:collapse;font-variant-numeric:tabular-nums;background:var(--card)}
th,td{padding:4px 10px;border:1px solid var(--line);white-space:nowrap}th{color:var(--mut);font-weight:600}
blockquote{margin:12px 0;padding:8px 12px;border-left:3px solid var(--acc);background:var(--card)}code{font-size:12px}
</style></head><body><main>${out.join("\n")}</main></body></html>`;
}
