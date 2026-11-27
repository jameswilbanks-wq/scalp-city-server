/* Local runner for the signal confluence study (docs/signal-confluence-spec.md, bt38). RESEARCH ONLY. Runs on this PC: never touches Render, the live server, Supabase or any broker.
   Usage (PowerShell; type the credentials into THIS window only, they vanish when it closes; a PAPER-account key is fine, market data works with any Alpaca account's keys):
     $env:ALPACA_KEY_ID = '...'
     $env:ALPACA_SECRET = '...'
     node run_sig_local.js fetch     # download and cache 1-minute SIP bars WITH VOLUME for SPY and QQQ, 2016-01-04 .. 2026-11-25 (resumable; no analysis). Only 'fetch' needs credentials.
     node run_sig_local.js dev       # dev stage: HARD CUTOFF 2023-12-31 before any computation; holdout is never read; prints the dev tables
     node run_sig_local.js final     # ONE full run after the code is committed and the tree is clean; writes harness_local/sig/out/bt38*.json
   Safety: Alpaca DATA host only, GET only, keys read from env and never printed or written; the only other process it starts is `git` (read-only, for the commit SHA). */
'use strict';
const fs = require('fs'), path = require('path'), cp = require('child_process');
const study = require('./study_sig.js');

const AK = process.env.ALPACA_KEY_ID, AS = process.env.ALPACA_SECRET, cmd = process.argv[2], flags = process.argv.slice(3);
const DIR = path.join(__dirname, 'harness_local', 'sig'), CACHE = path.join(DIR, 'cache'), OUT = path.join(DIR, 'out'), CAL = path.join(__dirname, 'harness_local', 'ger', 'calendar.json');
const SYMS = ['SPY', 'QQQ'], START_YEAR = 2016, END_MS = Date.parse('2026-11-26T00:00:00Z'), sleep = ms => new Promise(r => setTimeout(r, ms));
if (!['fetch', 'dev', 'final'].includes(cmd)) { console.error('usage: node run_sig_local.js fetch|dev|final [--draws=N] [--allow-dirty]'); process.exit(2); }
if (cmd === 'fetch' && (!AK || !AS)) { console.error('fetch needs $env:ALPACA_KEY_ID and $env:ALPACA_SECRET set in this PowerShell window (paper-account key).'); process.exit(2); }
fs.mkdirSync(CACHE, { recursive: true }); fs.mkdirSync(OUT, { recursive: true });

async function ap(qs) { // GET only, data host only
  const u = new URL('https://data.alpaca.markets/v2/stocks/bars'); Object.keys(qs).forEach(k => { if (qs[k] !== undefined && qs[k] !== '') u.searchParams.set(k, qs[k]); });
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(u, { method: 'GET', headers: { 'APCA-API-KEY-ID': AK, 'APCA-API-SECRET-KEY': AS, accept: 'application/json' } });
    if (r.ok) return r.json();
    if ((r.status === 429 || r.status >= 500) && attempt < 8) { await sleep(1500 * (attempt + 1)); continue; }
    let body = ''; try { body = (await r.text()).slice(0, 300); } catch (e) { /* none */ } // Alpaca error bodies carry no keys
    throw new Error('data request failed: HTTP ' + r.status + ' ' + body);
  }
}
async function fetchYear(sym, year) {
  const f = path.join(CACHE, sym + '_' + year + '.json'); if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8')).t.length;
  const start = new Date(Date.UTC(year, 0, 1)).toISOString(), end = new Date(Math.min(Date.UTC(year + 1, 0, 1), END_MS)).toISOString(), col = { t: [], o: [], h: [], l: [], c: [], v: [] }; let token;
  do {
    const d = await ap({ symbols: sym, timeframe: '1Min', start, end, limit: 10000, adjustment: 'all', feed: 'sip', sort: 'asc', page_token: token });
    for (const b of (d.bars && d.bars[sym]) || []) { col.t.push(Date.parse(b.t)); col.o.push(b.o); col.h.push(b.h); col.l.push(b.l); col.c.push(b.c); col.v.push(b.v); }
    token = d.next_page_token; await sleep(320);
  } while (token);
  fs.writeFileSync(f + '.tmp', JSON.stringify(col)); fs.renameSync(f + '.tmp', f); return col.t.length;
}
function load(sym) {
  const col = { t: [], o: [], h: [], l: [], c: [], v: [] };
  for (let y = START_YEAR; y <= 2026; y++) { const f = path.join(CACHE, sym + '_' + y + '.json'); if (!fs.existsSync(f)) continue; const d = JSON.parse(fs.readFileSync(f, 'utf8')); for (const k of Object.keys(col)) for (let i = 0; i < d[k].length; i++) col[k].push(d[k][i]); }
  return col;
}
const f2 = x => (x === undefined || x === null || Number.isNaN(x)) ? '   n/a' : (x >= 0 ? '+' : '') + x.toFixed(2);
const cell = e => !e || !e.n ? 'n=0' : 'n=' + e.n + ' mean ' + f2(e.mean) + 'bp hit ' + e.hit.toFixed(1) + '%' + (e.lo !== undefined ? ' CI[' + f2(e.lo) + ',' + f2(e.hi) + ']' : '') + ' net1.0 ' + f2(e.netOpt);
function show(res) {
  for (const sym of Object.keys(res.syms)) for (const sn of Object.keys(res.syms[sym])) for (const per of ['dev', 'hold', 'full']) {
    const a = res.syms[sym][sn][per]; if (!a) continue; const n = a.set.n; console.log('\n=== ' + sym + ' ' + sn.toUpperCase() + ' (' + n + ' signals, light at ' + a.set.need + ') ' + per + ' (' + a.nSlots + ' decision points; unconditional mean at 30 min ' + f2(a.base['30']) + ' bp) ===');
    for (const h of ['15', '30', '60', 'close']) console.log('H' + h.padEnd(5) + ' light: ' + cell(a.light[h]) + '\n       weak (1 to ' + (a.set.need - 1) + ' agree): ' + cell(a.weak[h]) + '\n       ' + n + ' of ' + n + ' buy: ' + cell(a.all[h].buy) + ' | sell: ' + cell(a.all[h].sell));
    console.log('Ladder at 30 min (exactly k signals agree):'); for (let k = 0; k <= n; k++) console.log('  k=' + k + '  buy ' + cell(a.ladder.buy[k]['30']) + '\n       sell ' + cell(a.ladder.sell[k]['30']));
    console.log('Single signals at 30 min:'); for (const nm of Object.keys(a.single)) console.log('  ' + nm.padEnd(5) + ' +1: ' + cell(a.single[nm]['30'].buy) + ' | -1: ' + cell(a.single[nm]['30'].sell));
    console.log('Gradient (Spearman k vs mean excess, 30 min): buy ' + f2(a.gradient.buy['30'].rho) + ' sell ' + f2(a.gradient.sell['30'].rho) + ' | mean pairwise correlation ' + f2(a.corr.mean) + ', effective independent signals ' + (a.corr.neff === null ? 'n/a' : a.corr.neff.toFixed(2)) + ' of ' + n);
    if (a.null && a.null['30']) console.log('C1 shifted null for the light, 30 min: 2.5% ' + f2(a.null['30'].p025) + ' median ' + f2(a.null['30'].p50) + ' 97.5% ' + f2(a.null['30'].p975));
  }
  for (const [k, title] of [['verdict', 'VERDICT (PRIMARY: SPY, all 7 signals, light at 4)'], ['verdict5', 'REPLICATION VERDICT (SPY, the original 5 signals, light at 3)']]) { const v = res[k]; if (!v) continue; console.log('\n' + title + ': ' + v.label + (v.failed.length ? ' (failed criteria: ' + v.failed.join(', ') + ')' : '')); v.criteria.forEach(c => console.log('  ' + (c.ok ? 'PASS' : 'FAIL') + ' ' + c.id + '. ' + c.text)); }
}

(async () => {
  if (cmd === 'fetch') { for (const sym of SYMS) { let tot = 0; for (let y = START_YEAR; y <= 2026; y++) { const n = await fetchYear(sym, y); tot += n; console.log(sym + ' ' + y + ': ' + n + ' bars'); } console.log(sym + ' total ' + tot); } console.log('fetch done. Next: node run_sig_local.js dev'); return; }
  let calendar = null; try { calendar = JSON.parse(fs.readFileSync(CAL, 'utf8')); } catch (e) { /* handled below */ } if (!calendar || !calendar.length) { console.error('missing ' + CAL + ' (exchange calendar saved by the GER study)'); process.exit(2); }
  const sf = flags.find(f => /^--draws=/.test(f)), draws = sf ? +sf.split('=')[1] : undefined;
  let sha = 'unknown', dirty = true; try { sha = cp.execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim(); dirty = cp.execSync('git status --porcelain', { cwd: __dirname }).toString().trim().length > 0; } catch (e) { /* no git */ }
  if (cmd === 'final' && dirty && !flags.includes('--allow-dirty')) { console.error('final needs a clean committed tree (git status --porcelain is not empty). Commit first.'); process.exit(2); }
  const recs = {}, dq = {};
  for (const sym of SYMS) {
    const raw = load(sym); if (!raw.t.length) { console.error('no cached data for ' + sym + '; run fetch first'); process.exit(2); }
    const P = study.prep(raw, { calendar, cutoffDay: cmd === 'dev' ? study.SPLIT : undefined }); dq[sym] = P.dq; console.log(sym + ' prepared: ' + P.dq.days + ' sessions ' + P.dq.firstDay + ' .. ' + P.dq.lastDay + ' (' + P.dq.sessionBars + ' bars; afterCutoff ' + P.dq.afterCutoff + ')');
    recs[sym] = study.collect(P); console.log(sym + ' decision points: ' + recs[sym].length);
  }
  const res = study.run(recs, { stage: cmd, draws }); res.sha = sha; res.dirty = dirty; res.ranAt = new Date().toISOString(); res.data = dq;
  show(res); const f = path.join(OUT, cmd === 'dev' ? 'bt38_dev.json' : 'bt38.json'); fs.writeFileSync(f, JSON.stringify(res)); console.log('\nsaved ' + f);
})().catch(e => { console.error(String(e && e.message || e)); process.exit(1); });
