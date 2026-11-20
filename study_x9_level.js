/* bt32 (read-only; James approved 2026-11-20: "1. 5 is good. 2. yes 3. yes"): X9 LEVEL-EXIT study -- does changing how X9 decides a trade is wrong improve it? Spec and decision criteria fixed in advance: docs/x9-level-exit-study-spec.md.
   NOT TRADING: nothing here places an order or touches a live book. Saved to kv bt32 (resumable rows in bt32p), once.
   Setup is study_x9_exits2.js (bt31): Robinhood 1-minute bars -> 5-minute candles, Engine.x9Signals entries, real Alpaca 1-minute option prices, -30% premium stop, reverse exit, flat at 15:35, and the LIVE profit rule per symbol
   (QQQ flat +70% target, SPY trail arm 25% / keep 50%). Only the level exit varies: E0 current (first close through EMA9), E1 two closes, E2 close beyond EMA9 by 0.25 ATR, E3 ignore the level exit for the first two candles,
   E4 close through VWAP(OHLC/4) instead, E5 no level exit. E0L = E0 with bt31's old occupancy rule (position blocks new signals until its underlying exit time) -- a control that must reproduce bt31.
   Each variant runs its own trade list (one position per symbol at a time, occupied until its real exit) and is compared per trading day. */
'use strict';
const X = require('./study_x9_exits2.js'); // walk(): the bt31 premium walk (stop, target, trail), already tested against bt22
const VIDS = ['E0', 'E1', 'E2', 'E3', 'E4', 'E5', 'E0L'], TESTED = ['E1', 'E2', 'E3', 'E4', 'E5'], STEP = 300000, SPLITS = ['train', 'lock'];
const LIVE = { QQQ: { tp: 70 }, SPY: { trail: { arm: 25, give: 0.5 } } };

// Does completed candle q (signal candle k, entry candle k+1) trigger the level exit under variant vid? x9Exit(bar, dir) = close through EMA9 against the trade.
function levelHit(vid, bars, k, q, dir, x9Exit) {
  const x = bars[q];
  if (vid === 'E5') return false;
  if (vid === 'E1') return q >= k + 2 && x9Exit(x, dir) && x9Exit(bars[q - 1], dir);
  if (vid === 'E2') return dir > 0 ? x.c < x.e9 - 0.25 * x.atr : x.c > x.e9 + 0.25 * x.atr;
  if (vid === 'E3') return q >= k + 3 && x9Exit(x, dir);
  if (vid === 'E4') return dir > 0 ? x.c < x.vwap4 : x.c > x.vwap4;
  return x9Exit(x, dir); // E0, E0L
}
// Underlying-side exit time and reason for a trade signalled on candle k (same loop as bt22/bt31 with the variant's level rule).
function underlyingExit(vid, bars, k, dir, hooks) {
  let xt = null, why = 'time';
  for (let q = k + 1; q < bars.length && bars[q].day === bars[k].day; q++) {
    const x = bars[q]; if (x.min >= 930) { xt = x.t; break; }
    if (levelHit(vid, bars, k, q, dir, hooks.x9Exit)) { xt = x.t + STEP; why = 'level'; break; }
    const o = hooks.x9At(bars, q); if (o && o.dir === -dir) { xt = x.t + STEP; why = 'reverse'; break; }
  }
  if (xt === null) xt = bars[bars.length - 1].t;
  return { xt, why };
}
// Run one variant over a symbol's signals for ONE day (sigs in time order: {k, dir, s}); ob = option bars by option symbol. Returns the trades taken and a skip count.
function runVariant(vid, sym, sigs, bars, ob, hooks, busyIn) {
  const trades = [], skipped = {}; let busy = busyIn === undefined ? -1 : busyIn;
  sigs.forEach(g => {
    const k = g.k, b = bars[k], e = bars[k + 1]; if (!e || e.day !== b.day || b.t < busy) return;
    const u = underlyingExit(vid, bars, k, g.dir, hooks), arr = ob[g.s]; if (!arr) { skipped.noOption = (skipped.noOption || 0) + 1; return; }
    let pin = null, tFill = null; for (const z of arr) { if (z.t >= e.t && z.t <= e.t + 3 * 60000) { pin = z.o; tFill = z.t; break; } if (z.t > e.t + 3 * 60000) break; }
    if (pin === null || !(pin >= 0.05)) { skipped.noEntry = (skipped.noEntry || 0) + 1; return; }
    const w = X.walk(arr, pin, tFill, u.xt, u.why, LIVE[sym]); if (w.pout === null) { skipped.noExit = (skipped.noExit || 0) + 1; return; }
    trades.push({ day: b.day, pin, why: w.why, g: Math.round((w.pout - pin) * 100 * 100) / 100, pk: w.pk });
    busy = vid === 'E0L' ? u.xt : (w.why === u.why ? u.xt : w.t + 60000); // E0L = bt31's rule (occupied until the underlying exit); others: occupied until the position actually closes
  });
  return { trades, skipped };
}

// ---- statistics ----
const r2 = x => x === null || x === undefined || !isFinite(x) ? null : Math.round(x * 100) / 100, mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null, net = (g, c) => g - 200 * c;
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
// rows: [sym, day, split, vid, pin, why, g, pk]; days: { SYM: [[day, split], ...] } = every session in the window (no-trade days count as zero)
function analyze(rows, days, opts) {
  opts = opts || {}; const reps = opts.reps || 4000, res = {};
  Object.keys(days).sort().forEach((sym, si) => {
    const D = days[sym], idx = {}; D.forEach(([d], i) => { idx[d] = i; }); const dayArr = (T, c) => { const a = new Array(D.length).fill(0); T.forEach(r => { if (idx[r[1]] !== undefined) a[idx[r[1]]] += net(r[6], c); }); return a; };
    const per = {};
    VIDS.forEach(vid => {
      const T = rows.filter(r => r[0] === sym && r[3] === vid), v = { n: T.length }, a01 = dayArr(T, 0.01), a03 = dayArr(T, 0.03);
      SPLITS.concat(['all']).forEach(sp => { const Q = sp === 'all' ? T : T.filter(r => r[2] === sp), ix = D.map(([, s2], i) => (sp === 'all' || s2 === sp) ? i : -1).filter(i => i >= 0), o = { n: Q.length };
        if (Q.length) { const p1 = Q.map(r => net(r[6], 0.01)), p3 = Q.map(r => net(r[6], 0.03)); o.avgTrade01 = r2(mean(p1)); o.avgTrade03 = r2(mean(p3)); o.win01 = Math.round(100 * p1.filter(x => x > 0).length / p1.length); }
        o.avgDay01 = r2(mean(ix.map(i => a01[i]))); o.avgDay03 = r2(mean(ix.map(i => a03[i]))); v[sp] = o; });
      const own = T.map(r => net(r[6], 0.01)).sort((a, b) => b - a).slice(5); v.dropBest5 = own.length ? r2(mean(own)) : null;
      const byWhy = {}; T.forEach(r => { byWhy[r[5]] = byWhy[r[5]] || []; byWhy[r[5]].push(net(r[6], 0.01)); }); v.exitMix = {}; Object.keys(byWhy).forEach(k => { v.exitMix[k] = { n: byWhy[k].length, avg01: r2(mean(byWhy[k])) }; });
      v._a01 = a01; per[vid] = v;
    });
    const E0 = per.E0; res[sym] = { variants: {}, candidates: [] };
    VIDS.forEach((vid, vi) => {
      const v = per[vid], out = { n: v.n, train: v.train, lock: v.lock, all: v.all, dropBest5: v.dropBest5, exitMix: v.exitMix };
      if (vid !== 'E0' && vid !== 'E0L') {
        const diff = v._a01.map((x, i) => x - E0._a01[i]), rnd = rng(32 + si * 100 + vi), ms = [];
        for (let b = 0; b < reps; b++) { let s = 0; for (let i = 0; i < diff.length; i++) s += diff[(rnd() * diff.length) | 0]; ms.push(s / diff.length); }
        ms.sort((a, b) => a - b); out.ci99dayDelta = [r2(ms[Math.floor(reps * 0.005)]), r2(ms[Math.ceil(reps * 0.995) - 1])];
        out.delta = { tradeTrain: r2(v.train.avgTrade01 - E0.train.avgTrade01), tradeLock: r2(v.lock.avgTrade01 - E0.lock.avgTrade01), dayTrain: r2(v.train.avgDay01 - E0.train.avgDay01), dayLock: r2(v.lock.avgDay01 - E0.lock.avgDay01), dayAll: r2(v.all.avgDay01 - E0.all.avgDay01) };
        const c = { c1_trade_delta_ge3_train_and_lock: out.delta.tradeTrain >= 3 && out.delta.tradeLock >= 3, c2_day_delta_positive_train_and_lock: out.delta.dayTrain > 0 && out.delta.dayLock > 0, c3_ci99_day_delta_excludes_zero: out.ci99dayDelta[0] > 0,
          c4_dropBest5_beats_control: v.dropBest5 !== null && E0.dropBest5 !== null && v.dropBest5 > E0.dropBest5, c5_abs_at_0_03_positive_trade_and_day: v.all.avgTrade03 > 0 && v.all.avgDay03 > 0,
          c6_n_ge100_each_split_and_ge60pct_of_control: v.train.n >= 100 && v.lock.n >= 100 && v.n >= 0.6 * E0.n };
        c.pass = Object.keys(c).every(k => c[k] === true); out.crit = c; if (c.pass && TESTED.includes(vid)) res[sym].candidates.push(vid);
      }
      res[sym].variants[vid] = out;
    });
  });
  return res;
}
function verdict(res) {
  const L = []; Object.keys(res).forEach(sym => { const R = res[sym], e0 = R.variants.E0, e0l = R.variants.E0L;
    L.push(sym + ' E0 (current level exit, real occupancy): n=' + e0.n + ', $' + e0.all.avgTrade01 + '/trade and $' + e0.all.avgDay01 + '/day at $0.01; $' + e0.all.avgTrade03 + '/trade and $' + e0.all.avgDay03 + '/day at $0.03; E0L (bt31 occupancy): n=' + e0l.n + ', $' + e0l.all.avgTrade01 + '/trade');
    TESTED.forEach(id => { const v = R.variants[id]; L.push(sym + ' ' + id + ': ' + (v.crit.pass ? 'PASSES all six criteria' : 'fails ' + Object.keys(v.crit).filter(k => k !== 'pass' && !v.crit[k]).join(', ')) + '; n=' + v.n + '; delta vs E0 per trade train/lock $' + v.delta.tradeTrain + '/$' + v.delta.tradeLock + ', per day all $' + v.delta.dayAll + ' (99% ' + JSON.stringify(v.ci99dayDelta) + '); abs $' + v.all.avgTrade01 + '/trade, $' + v.all.avgTrade03 + '/trade and $' + v.all.avgDay03 + '/day at $0.03'); });
    L.push(sym + ' replacement candidates: ' + (R.candidates.length ? R.candidates.join(', ') : 'none (current rule stays)')); });
  return L;
}

module.exports = async function studyX9Level(ap, rh, Engine, kset, opts) {
  opts = opts || {}; const kget = opts.kget;
  const sleep = ms => new Promise(r => setTimeout(r, ms)), gap = opts.gap === undefined ? 400 : opts.gap, iso = t => new Date(t).toISOString();
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
  const todayET = (() => { const p = {}; fmt.formatToParts(new Date()).forEach(x => { p[x.type] = x.value; }); return p.year + '-' + p.month + '-' + p.day; })();
  const KEY = opts.key || 'bt32', out = { started: iso(Date.now()), progress: 'starting', errs: 0, skipped: {}, n: {}, rows: [], days: {} }, last = {}; const days = opts.days || 365; let now = opts.now || null;
  const skip = (k, n) => { out.skipped[k] = (out.skipped[k] || 0) + (n || 1); };
  try { if (kget) { const pp = await kget(KEY + 'p'); if (pp && Array.isArray(pp.rows)) { out.rows = pp.rows; out.skipped = pp.skipped || {}; Object.assign(last, pp.last || {}); if (pp.now) now = pp.now; out.resumed = true; } } } catch (e) {}
  let b31 = null; try { b31 = kget ? await kget('bt31') : null; } catch (e) {}
  if (!now) now = (b31 && b31.now) || Date.now(); out.now = now; out.windowEndBeforeSession = todayET;
  const progressSave = async () => { try { await kset(KEY + 'p', { progress: out.progress, errs: out.errs, skipped: out.skipped, last, now, rows: out.rows, at: iso(Date.now()) }); } catch (e) {} };
  const optBars = async (syms, start, end) => { const m = {}; let pt; for (let i = 0; i < syms.length; i += 90) { do { const d = await ap('/v1beta1/options/bars', { symbols: syms.slice(i, i + 90).join(','), timeframe: '1Min', start: iso(start), end: iso(end), limit: 10000, page_token: pt }); Object.keys(d.bars || {}).forEach(s => { (m[s] = m[s] || []).push(...d.bars[s].map(b => ({ t: Date.parse(b.t), o: b.o, c: b.c }))); }); pt = d.next_page_token; await sleep(gap); } while (pt); } return m; };
  const ymdOf = d => d.slice(2, 4) + d.slice(5, 7) + d.slice(8, 10);
  const agg5 = raw => { const o = [], by = {}; raw.forEach(x => { const t = Date.parse(x.begins_at), k = Math.floor(t / 300000) * 300000; (by[k] = by[k] || []).push(x); }); Object.keys(by).sort((a, b) => a - b).forEach(k => { const g = by[k]; o.push({ begins_at: iso(+k), open_price: g[0].open_price, high_price: Math.max(...g.map(x => +x.high_price)), low_price: Math.min(...g.map(x => +x.low_price)), close_price: g[g.length - 1].close_price, volume: g.reduce((s, x) => s + (+x.volume || 0), 0) }); }); return o; };
  const hooks = { x9At: Engine.x9At, x9Exit: Engine.x9Exit };
  for (const SYM of (opts.syms || ['SPY', 'QQQ'])) {
    try {
      out.progress = SYM + ' loading 1-minute bars'; await progressSave();
      const st = {};
      for (let a = now - days * 864e5; a < now; a += 4 * 864e5) { const d = await rh('get_equity_historicals', { symbols: [SYM], start_time: iso(a), end_time: iso(Math.min(a + 4 * 864e5, now)), interval: 'minute', bounds: 'regular' }); (((d.results || [])[0] || {}).bars || []).forEach(x => { st[Date.parse(x.begins_at)] = x; }); }
      const raw = Object.keys(st).sort((a, b) => a - b).map(k => st[k]), bars = Engine.prepare(agg5(raw), { partial: true }); Engine.simulate(bars, {}, true);
      if (bars.length < 200) { out.n[SYM] = 'too few bars'; continue; }
      const dayList = []; bars.forEach(b => { if (dayList[dayList.length - 1] !== b.day && b.day < todayET) dayList.push(b.day); });
      const split = {}; dayList.forEach((d, ix) => { split[d] = ix < dayList.length * 2 / 3 ? 'train' : 'lock'; }); out.days[SYM] = dayList.map(d => [d, split[d]]);
      const sigsByDay = {}; Engine.x9Signals(bars, 585, 930).forEach(g => { const b = bars[g.k], e = bars[g.k + 1]; if (!e || e.day !== b.day || !(b.day < todayET)) return; (sigsByDay[b.day] = sigsByDay[b.day] || []).push({ k: g.k, dir: g.sig.dir, s: SYM + ymdOf(b.day) + (g.sig.dir > 0 ? 'C' : 'P') + String(Math.round(e.o) * 1000).padStart(8, '0') }); });
      out.n[SYM] = { sessions: dayList.length, signalDays: Object.keys(sigsByDay).length, first: dayList[0], last: dayList[dayList.length - 1] };
      const D0 = Object.keys(sigsByDay).sort(); let done = 0;
      for (const D of D0) {
        if (last[SYM] && D <= last[SYM]) continue;
        try {
          const sigs = sigsByDay[D], first = Math.min(...sigs.map(g => bars[g.k + 1].t)), ob = await optBars([...new Set(sigs.map(g => g.s))], first - 60000, Date.parse(D + 'T21:05:00Z'));
          VIDS.forEach(vid => { const r = runVariant(vid, SYM, sigs, bars, ob, hooks); Object.keys(r.skipped).forEach(k => skip(SYM + ' ' + vid + ' ' + k, r.skipped[k])); r.trades.forEach(t => out.rows.push([SYM, D, split[D], vid, Math.round(t.pin * 100) / 100, t.why, t.g, Math.round(t.pk * 10) / 10])); });
        } catch (e) { out.errs++; out.lastErr = SYM + ' ' + D + ' ' + String(e && e.message || e).slice(0, 160); await sleep(3000); continue; }
        last[SYM] = D; done++; if (done % 30 === 0) { out.progress = SYM + ' ' + done + ' of ' + D0.length + ' signal days'; await progressSave(); }
      }
    } catch (e) { out.errs++; out.lastErr = SYM + ' ' + String(e && e.message || e).slice(0, 160); }
  }
  out.progress = 'analysing'; await progressSave();
  out.variants = { E0: 'first completed candle closing through EMA9', E1: 'two consecutive closes through EMA9', E2: 'close through EMA9 by 0.25 ATR', E3: 'ignore level exit on first two candles', E4: 'close through VWAP(OHLC/4)', E5: 'no level exit', E0L: 'control: E0 with bt31 occupancy rule' };
  out.analysis = analyze(out.rows, out.days); out.verdict = verdict(out.analysis);
  try { // control: E0L (bt31 occupancy, live profit rule) must reproduce the bt31 live-rule cells: trade count within 2%, average within $1.00
    const ctl = { ok: null, cells: {} };
    if (b31 && b31.analysis) { ctl.ok = true; Object.keys(out.analysis).forEach(sym => { const id = sym === 'QQQ' ? 'C1' : 'C2', ref = b31.analysis[sym] && b31.analysis[sym].variants[id] && b31.analysis[sym].variants[id].all, mine = out.analysis[sym].variants.E0L.all; const ok = !!ref && Math.abs(ref.n - mine.n) <= 0.02 * ref.n && Math.abs(ref.avg01 - mine.avgTrade01) <= 1; ctl.cells[sym + '|' + id] = { bt31: ref ? { n: ref.n, avg: ref.avg01 } : null, bt32_E0L: { n: mine.n, avg: mine.avgTrade01 }, ok }; if (!ok) ctl.ok = false; }); }
    out.control = ctl;
  } catch (e) { out.control = { ok: null, error: String(e && e.message || e) }; }
  out.verdictNote = out.control && out.control.ok === true ? 'Control E0L reproduced bt31 live-rule cells within tolerance: results usable. Judged at $0.01 per fill with $0.03 stress, per trade and per trading day.' : 'CONTROL NOT VERIFIED against bt31: per the spec, report this plainly and treat every result as unverified.';
  out.progress = 'done'; out.done = iso(Date.now());
  return out;
};
module.exports.levelHit = levelHit; module.exports.underlyingExit = underlyingExit; module.exports.runVariant = runVariant; module.exports.analyze = analyze; module.exports.verdict = verdict; module.exports.VIDS = VIDS;
