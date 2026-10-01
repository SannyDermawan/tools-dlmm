import { createServer, type Server } from "node:http";
import type { Db } from "../db/index.ts";
import { listSessions, sessionView } from "./data.ts";

const PAGE = `<!doctype html>
<html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DLMM Dashboard</title>
<style>
:root{--bg:#f7f7f5;--fg:#1d1d1b;--mut:#6b6b66;--card:#fff;--line:#e3e2dc;--good:#1f7a3a;--warn:#9a6700;--bad:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecebe6;--mut:#9c9b95;--card:#1f1f1d;--line:#34332f;--good:#6fcf8a;--warn:#e3b341;--bad:#f28b82}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,Segoe UI,Roboto,sans-serif}
main{max-width:1200px;margin:0 auto;padding:16px}
h1{font-size:18px;margin:0 0 4px}h2{font-size:14px;margin:0 0 8px;color:var(--mut);text-transform:uppercase;letter-spacing:.04em}
.row{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;margin:12px 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px;overflow-x:auto}
.kpi{font-size:22px;font-weight:600}.mut{color:var(--mut)}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}th,td{text-align:left;padding:4px 8px;border-bottom:1px solid var(--line);white-space:nowrap}
th{color:var(--mut);font-weight:500}td.n{text-align:right}
.MASUK{color:var(--good);font-weight:600}.PANTAU{color:var(--warn);font-weight:600}.LEWATI{color:var(--mut)}
.pos{color:var(--good)}.neg{color:var(--bad)}select{font:inherit;padding:4px;background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px}
</style></head><body><main>
<h1>DLMM Signal Engine — demo simulator <span class="mut" id="upd"></span></h1>
<div><select id="sess"></select> <span class="mut">read-only view of the local database; refreshes every 5 s</span></div>
<div id="app"></div></main>
<script>
const $=s=>document.querySelector(s);const f=(v,d=2)=>v==null||!isFinite(v)?'-':Number(v).toFixed(d);
const t=ts=>ts?new Date(ts).toLocaleTimeString('id-ID',{hour12:false}):'-';
const esc=s=>String(s??'-').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const sign=v=>v==null?'':v>=0?'pos':'neg';
let current=new URLSearchParams(location.search).get('session');
async function sessions(){const l=await (await fetch('api/sessions')).json();const sel=$('#sess');
 sel.innerHTML=l.map(s=>'<option value="'+s.session_id+'">'+esc(s.kind)+' · '+esc(s.label)+' · '+esc(s.status)+' · '+new Date(s.start_at).toLocaleString('id-ID')+'</option>').join('');
 if(!current&&l[0])current=l[0].session_id;sel.value=current;sel.onchange=()=>{current=sel.value;load()}}
function table(head,rows){return '<table><tr>'+head.map(h=>'<th>'+h+'</th>').join('')+'</tr>'+rows.map(r=>'<tr>'+r.join('')+'</tr>').join('')+'</table>'}
const td=(v,cls='')=>'<td class="'+cls+'">'+v+'</td>';
async function load(){if(!current)return;const v=await (await fetch('api/view?session='+current)).json();if(!v)return;
 const hb=v.heartbeat&&v.heartbeat.state;const h=hb&&hb.health;let html='<div class="row">';
 html+='<div class="card"><h2>status</h2><div class="kpi">'+esc(hb?hb.phase:v.status)+'</div><div class="mut">'+(hb&&hb.phase!=='ended'?f(hb.leftMin,0)+' min left · ':'')+'start '+t(v.start_at)+(hb?' · end '+t(hb.end):'')+'</div></div>';
 const P=hb?hb.positions:Object.fromEntries(v.db.positions.map(x=>[x.status,x.n]));
 html+='<div class="card"><h2>positions</h2><div class="kpi">'+(P.active||0)+' active</div><div class="mut">'+(P.closed||0)+' closed · '+(P.pending||0)+' pending · '+(P.failed||0)+' failed'+(hb?' · cohorts '+hb.grid.cohorts+' · rebalances '+hb.grid.rebalances:'')+'</div></div>';
 const age=v.db.lastData?(Date.now()-v.db.lastData)/1000:null;
 html+='<div class="card"><h2>data health</h2><div class="kpi '+(age!=null&&age<60?'pos':'neg')+'">'+(age==null?'-':f(age,0)+' s')+'</div><div class="mut">since last market data · open gaps '+v.db.gapsOpen.length+(h?' · ws '+(h.wsConnected?'up':'down')+' · credits '+h.credits+' ('+h.budget+')':'')+'</div></div>';
 html+='<div class="card"><h2>signals</h2><div class="kpi">'+v.db.signalCounts.map(c=>'<span class="'+c.action+'">'+c.action+' '+c.n+'</span>').join(' · ')+'</div><div class="mut">'+(hb?hb.signalsTotal+' total':'')+'</div></div></div>';
 const ext=e=>e?td(esc(e.pool)+' · '+(e.active?'open':'closed'))+td(f(e.usd)+' ('+f(e.pct,1)+'%)','n '+sign(e.usd)):td('-')+td('-','n');
 const extRows=hb&&hb.pnl?Object.entries(hb.pnl.byMode).map(([k,a])=>{const d=v.db.extremes.find(x=>x.k===k)||{};return [td(esc(k)),ext(a.best||d.best),ext(a.worst||d.worst)]}):v.db.extremes.map(x=>[td(esc(x.k)),ext(x.best),ext(x.worst)]);
 const extCard='<div class="card"><h2>biggest profit / loss of one position per entry mode'+(hb&&hb.pnl?' (open ones at their current mark)':' (closed positions)')+'</h2>'+table(['mode','biggest profit: pool','$ (%)','biggest loss: pool','$ (%)'],extRows)+'</div>';
 if(hb&&hb.pnl){const rows=Object.entries(hb.pnl.byMode).map(([k,a])=>[td(esc(k)),td(a.n,'n'),td(a.active,'n'),td(f(a.win/a.n*100,0)+'%','n'),td(f(a.netUsd/a.n),'n '+sign(a.netUsd)),td(f(a.feeUsd/a.n),'n'),td(f(a.ilUsd/a.n),'n')]);
  const rs=Object.entries(hb.pnl.byStrategy).concat(Object.entries(hb.pnl.byExit)).map(([k,a])=>[td(esc(k)),td(a.n,'n'),td(f(a.win/a.n*100,0)+'%','n'),td(f(a.netUsd/a.n),'n '+sign(a.netUsd))]);
  html+='<div class="row"><div class="card"><h2>running PnL by entry mode ($1 000 per position)</h2>'+table(['mode','n','active','win','avg net $','avg fee $','avg IL $'],rows)+'</div><div class="card"><h2>by strategy / exit policy</h2>'+table(['group','n','win','avg net $'],rs)+'</div></div>';}
 else{html+='<div class="card"><h2>results by entry mode</h2>'+table(['mode','n','closed','win','avg net %'],v.db.byMode.map(r=>[td(esc(r.k)),td(r.n,'n'),td(r.closed,'n'),td(f((r.win||0)*100,0)+'%','n'),td(f(r.net,3),'n '+sign(r.net))]))+'</div>';}
 html+='<div style="margin-top:12px">'+extCard+'</div>';
 html+='<div class="card" style="margin-top:12px"><h2>latest signals '+(v.db.signals[0]?t(v.db.signals[0].ts):'')+'</h2>'+table(['pool','action','score','conf','regime','reasons'],v.db.signals.map(s=>[td(esc(s.name)),td(s.action,s.action),td(f(s.final,1),'n'),td(f(s.confidence),'n'),td(esc(s.regime)),'<td style="white-space:normal">'+esc(s.reasons.join('; '))+'</td>']))+'</div>';
 html+='<div class="row"><div class="card"><h2>data gaps</h2>'+table(['source','gaps','minutes'],v.db.gapsTotal.map(g=>[td(esc(g.source)),td(g.n,'n'),td(f(g.minutes,1),'n')]))+'</div>';
 html+='<div class="card"><h2>http usage</h2>'+table(['endpoint','calls','errors','credits'],v.db.http.map(r=>[td(esc(r.endpoint)),td(r.calls,'n'),td(r.errors,'n'),td(r.credits,'n')]))+'</div></div>';
 $('#app').innerHTML=html;$('#upd').textContent='· '+new Date().toLocaleTimeString('id-ID',{hour12:false});}
sessions().then(load);setInterval(load,5000);setInterval(sessions,60000);
</script></body></html>`;

/** Local, read-only web dashboard (binds to 127.0.0.1 only). */
export function startWebDashboard(db: Db, port: number): Server {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/" || url.pathname === "/index.html") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(PAGE);
      }
      if (url.pathname === "/api/sessions") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(listSessions(db, 30)));
      }
      if (url.pathname === "/api/view") {
        const id = url.searchParams.get("session") ?? listSessions(db, 1)[0]?.session_id;
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(id ? sessionView(db, id) : null));
      }
      res.writeHead(404).end("not found");
    } catch (e) {
      res.writeHead(500, { "content-type": "text/plain" }).end((e as Error).message);
    }
  });
  server.listen(port, "127.0.0.1");
  return server;
}
