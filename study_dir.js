/* bt34: daily-direction Stage 0 (docs/dir-signal-study-spec.md, frozen before any result). Underlying price only: do well-known indicators (gap, opening-range breakout, morning momentum, VWAP, 5-min EMA, 20-day trend, prior-day, daily RSI2, two composites) call the sign of the 10:30 ET -> 15:44 ET move well enough to pay for 0DTE calls/puts? Read-only: no orders, no options, nothing live. Pure functions are exported for test/dir_smoke.test.js; the runner is called once after boot from server.js and saves kv bt34 (progress bt34p). James's request 2026-11-20: "build a book strategy that recognizes the general daily direction of the market based on the best indicators out there and buys puts or calls to make as much profit as possible 0dte." */
'use strict';
const SPLIT = '2026-07-14', WARM = 22, ENTRY_MIN = 630, EXIT_MIN = 944, GAP_T = 0.001, MOM_T = 0.001, VWAP_T = 0.0002, REPS = 4000;
const VARIANTS = ['GAPF', 'GAPR', 'ORB30', 'MOM', 'VWAP', 'EMA', 'TREND', 'PDF', 'PDR', 'RSI2', 'C1', 'C2', 'B0', 'B1'], BASE = ['B0', 'B1'];
const r2 = x => Math.round(x * 100) / 100, r4 = x => Math.round(x * 10000) / 10000, sgn = x => (x > 0 ? 1 : x < 0 ? -1 : 0);
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function ema(vals, n) { if (!vals.length) return null; const k = 2 / (n + 1); let e = vals[0]; for (let i = 1; i < vals.length; i++) e = vals[i] * k + e * (1 - k); return e; }
function rsi2(closes) { if (closes.length < 3) return null; const a = closes[closes.length - 3], b = closes[closes.length - 2], c = closes[closes.length - 1], d1 = b - a, d2 = c - b, G = Math.max(d1, 0) + Math.max(d2, 0), L = Math.max(-d1, 0) + Math.max(-d2, 0); return G + L === 0 ? 50 : 100 * G / (G + L); }
function fiveMinCloses(bars) { const out = []; let cur = null, key = null; for (const b of bars) { const k = Math.floor(b.min / 5); if (k !== key) { if (cur !== null) out.push(cur); key = k; } cur = b.c; } if (cur !== null) out.push(cur); return out; }
// bars: [{min,o,h,l,c,v}] ascending, RTH only. hist: {closes:[daily closes, last is prior close], c5:[5-min closes of the last 3 sessions]}. Returns {skip} or {E, X, move, moveD, votes}
function voteDay(bars, hist, coin) {
  if (!bars.length || bars[0].min > 575) return { skip: 'late open' };
  if (hist.closes.length < WARM) return { skip: 'warm-up' };
  const pre = bars.filter(b => b.min < ENTRY_MIN); if (pre.length < 60) return { skip: 'thin morning (<60 one-minute bars before 10:30)' };
  const xs = bars.filter(b => b.min <= EXIT_MIN); if (!xs.length || xs[xs.length - 1].min < 935) return { skip: 'no bar between 15:35 and 15:44' };
  const E = pre[pre.length - 1].c, X = xs[xs.length - 1].c, open = bars[0].o, prev = hist.closes[hist.closes.length - 1], prev2 = hist.closes[hist.closes.length - 2];
  const gap = open / prev - 1, v = {};
  v.GAPF = Math.abs(gap) >= GAP_T ? sgn(gap) : 0; v.GAPR = v.GAPF ? -v.GAPF : 0;
  const orr = bars.filter(b => b.min < 600); if (orr.length < 10) return { skip: 'thin opening range' };
  const hi = Math.max(...orr.map(b => b.h)), lo = Math.min(...orr.map(b => b.l)); v.ORB30 = E > hi ? 1 : E < lo ? -1 : 0;
  const mom = E / open - 1; v.MOM = Math.abs(mom) >= MOM_T ? sgn(mom) : 0;
  let pv = 0, vol = 0; for (const b of pre) { pv += (b.h + b.l + b.c) / 3 * (b.v || 0); vol += b.v || 0; } const vw = vol > 0 ? pv / vol : null; v.VWAP = vw !== null && Math.abs(E - vw) / vw >= VWAP_T ? sgn(E - vw) : 0;
  const c5 = (hist.c5 || []).concat(fiveMinCloses(pre)); v.EMA = c5.length >= 20 ? sgn(ema(c5, 9) - ema(c5, 20)) : 0;
  const sma20 = hist.closes.slice(-20).reduce((a, b) => a + b, 0) / 20; v.TREND = sgn(prev - sma20);
  const pd = prev2 ? prev / prev2 - 1 : 0; v.PDF = sgn(pd); v.PDR = v.PDF ? -v.PDF : 0;
  const rs = rsi2(hist.closes); v.RSI2 = rs === null ? 0 : rs < 10 ? 1 : rs > 90 ? -1 : 0;
  v.C1 = sgn(v.ORB30 + v.MOM + v.VWAP + v.EMA + v.TREND); v.C2 = sgn(v.ORB30 + v.MOM + v.VWAP + v.EMA); v.B0 = 1; v.B1 = coin() < 0.5 ? 1 : -1;
  return { E, X, move: X / E - 1, moveD: X - E, votes: v };
}
function bootCI(xs, reps, seed) { if (!xs.length) return null; const rnd = mulberry32(seed), n = xs.length, ms = []; for (let r = 0; r < reps; r++) { let s = 0; for (let i = 0; i < n; i++) s += xs[Math.floor(rnd() * n)]; ms.push(s / n); } ms.sort((a, b) => a - b); return [ms[Math.floor(reps * 0.005)], ms[Math.min(reps - 1, Math.floor(reps * 0.995))]]; }
// days: [{day, move, moveD, votes}] for one symbol; name = variant; filt = test on the day string
function metrics(days, name, filt, nSessions, withCI, seed) {
  const tr = days.filter(d => filt(d.day) && d.votes[name] !== 0), n = tr.length; if (!n) return { n: 0, sessions: nSessions };
  const rets = tr.map(d => d.votes[name] * d.move * 1e4), mean = rets.reduce((a, b) => a + b, 0) / n, hit = tr.filter(d => d.votes[name] * d.move > 0).length / n;
  const pay = tr.reduce((a, d) => a + Math.max(0, d.votes[name] * d.moveD), 0) / n, half = tr.reduce((a, d) => a + Math.abs(d.moveD), 0) / n / 2;
  const o = { n, sessions: nSessions, hit: r4(hit), meanBps: r2(mean), perSessionBps: r2(rets.reduce((a, b) => a + b, 0) / Math.max(1, nSessions)), edgeVsFairPerContract: r2(100 * (pay - half)) };
  if (withCI) { const ci = bootCI(rets, REPS, seed); o.ci99Bps = ci ? [r2(ci[0]), r2(ci[1])] : null; } return o;
}
function analyze(rowsBySym, opts) {
  opts = opts || {}; const split = opts.split || SPLIT, res = {}, cand = { weak: [], robust: [] }, passBy = {};
  for (const sym of Object.keys(rowsBySym)) {
    const days = rowsBySym[sym], nDev = days.filter(d => d.day < split).length, nHold = days.length - nDev; res[sym] = {};
    VARIANTS.forEach((name, i) => { res[sym][name] = { dev: metrics(days, name, d => d < split, nDev, false), holdout: metrics(days, name, d => d >= split, nHold, false), all: metrics(days, name, () => true, days.length, true, 1000 + i) }; });
    for (const name of VARIANTS) {
      if (BASE.includes(name)) continue; const R = res[sym][name], a = R.all, d = R.dev, h = R.holdout;
      const crit = { c1_n_ge150: a.n >= 150, c2_ci99_lower_gt0: !!(a.ci99Bps && a.ci99Bps[0] > 0), c3_mean_pos_dev_and_holdout: d.n > 0 && h.n > 0 && d.meanBps > 0 && h.meanBps > 0, c4_hit_ge53_dev_and_holdout: d.n > 0 && h.n > 0 && d.hit >= 0.53 && h.hit >= 0.53, c5_edge_ge5_per_contract: a.n > 0 && a.edgeVsFairPerContract >= 5, c6_beats_B0_and_B1: a.n > 0 && a.meanBps > res[sym].B0.all.meanBps && a.meanBps > res[sym].B1.all.meanBps };
      crit.pass = Object.values(crit).every(Boolean); R.crit = crit; if (crit.pass) (passBy[name] = passBy[name] || []).push(sym);
    }
  }
  for (const name of Object.keys(passBy)) (passBy[name].length === Object.keys(rowsBySym).length ? cand.robust : cand.weak).push(name + ' (' + passBy[name].join('+') + ')');
  return { res, candidates: cand, comparisons: (VARIANTS.length - BASE.length) * Object.keys(rowsBySym).length, split };
}
function verdict(an) {
  const L = [], c = an.candidates; L.push('Stage 0 (underlying only, no options, not a profit): ' + (c.robust.length ? 'ROBUST candidates on both symbols: ' + c.robust.join(', ') : c.weak.length ? 'no robust candidate; one-symbol candidates only (weak): ' + c.weak.join(', ') : 'NO variant passed all six pre-registered criteria on either symbol'));
  for (const sym of Object.keys(an.res)) { const rows = VARIANTS.map(n => [n, an.res[sym][n].all]).filter(x => x[1].n > 0).sort((a, b) => b[1].meanBps - a[1].meanBps).slice(0, 4); rows.forEach(([n, m]) => L.push(sym + ' top by mean: ' + n + ' n=' + m.n + ' hit ' + (m.hit * 100).toFixed(1) + '% mean ' + m.meanBps + ' bps ci99 ' + JSON.stringify(m.ci99Bps || null) + ' edge$/contract ' + m.edgeVsFairPerContract + (BASE.includes(n) ? ' (baseline)' : an.res[sym][n].crit.pass ? ' PASSES' : ' fails ' + Object.keys(an.res[sym][n].crit).filter(k => k !== 'pass' && !an.res[sym][n].crit[k]).join(',')))); }
  return L;
}
module.exports = async function studyDir(ap, kset, opts) {
  opts = opts || {};
  const sleep = ms => new Promise(r => setTimeout(r, ms)), tick = () => new Promise(r => setImmediate(r)), gap = opts.gap === undefined ? 400 : opts.gap, iso = t => new Date(t).toISOString();
  const KEY = opts.key || 'bt34', PKEY = KEY + 'p', FROM = opts.from || '2024-03-01', TO = opts.to || '2026-11-14T00:00:00Z', SYMS = opts.syms || ['SPY', 'QQQ'];
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const et = ms => { const p = {}; fmt.formatToParts(new Date(ms)).forEach(x => { p[x.type] = x.value; }); return { day: p.year + '-' + p.month + '-' + p.day, min: (+p.hour % 24) * 60 + +p.minute }; };
  const out = { started: iso(Date.now()), progress: 'starting', errs: 0, skips: {}, n: {}, settings: { source: 'Alpaca 1-minute stock bars, IEX feed, split-adjusted (not consolidated tape; IEX volume is a small share, VWAP is a rough proxy)', symbols: SYMS, from: FROM, split: SPLIT, entryMin: ENTRY_MIN, exitMin: EXIT_MIN, variants: VARIANTS, thresholds: { gap: GAP_T, mom: MOM_T, vwap: VWAP_T }, reps: REPS }, notes: ['Stage 0: underlying only, no options, no costs. HISTORICAL, not forward, not live, not profit. Holdout window was seen by earlier studies (weak holdout).', 'Comparisons: ' + (VARIANTS.length - BASE.length) + ' variants x ' + SYMS.length + ' symbols, all logged; thresholds fixed in advance, not tuned.'] };
  const skip = (sym, why) => { const k = sym + '|' + why; out.skips[k] = (out.skips[k] || 0) + 1; };
  const apr = async (p, q) => { try { return await ap(p, q); } catch (e) { await sleep(1500); return await ap(p, q); } };
  const saveProg = async (msg) => { out.progress = msg; try { await kset(PKEY, { progress: msg, at: iso(Date.now()), errs: out.errs }); } catch (e) { } };
  async function fetchBars(sym) {
    const days = {}; let tok, pages = 0;
    do {
      const d = await apr('/v2/stocks/' + sym + '/bars', { timeframe: '1Min', start: FROM + 'T00:00:00Z', end: TO, feed: 'iex', limit: 10000, adjustment: 'split', page_token: tok });
      for (const b of (d.bars || [])) { const e = et(Date.parse(b.t)); if (e.min < 570 || e.min >= 960) continue; (days[e.day] = days[e.day] || []).push({ min: e.min, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0 }); }
      tok = d.next_page_token; pages++; if (pages % 5 === 0) await saveProg(sym + ' loading bars, page ' + pages); if (tok) await sleep(gap);
    } while (tok); return days;
  }
  const rowsBySym = {};
  for (const SYM of SYMS) {
    const days = await fetchBars(SYM), dayList = Object.keys(days).sort(), rows = [], closes = [], c5hist = []; let done = 0; const rnd = mulberry32(777 + SYM.charCodeAt(0));
    out.n[SYM] = { sessions: dayList.length, first: dayList[0], last: dayList[dayList.length - 1] };
    for (const D of dayList) {
      const bars = days[D].sort((a, b) => a.min - b.min); delete days[D];
      try {
        const r = voteDay(bars, { closes, c5: [].concat(...c5hist.slice(-3)) }, rnd);
        if (r.skip) skip(SYM, r.skip); else rows.push({ day: D, move: r.move, moveD: r.moveD, votes: r.votes });
        if (bars.length >= 150 && bars[bars.length - 1].min >= 900) { closes.push(bars[bars.length - 1].c); c5hist.push(fiveMinCloses(bars)); if (c5hist.length > 3) c5hist.shift(); }
      } catch (e) { out.errs++; out.lastErr = SYM + ' ' + D + ' ' + String(e && e.message || e).slice(0, 160); }
      done++; if (done % 100 === 0) await saveProg(SYM + ' ' + done + ' of ' + dayList.length); else if (done % 10 === 0) await tick();
    }
    rowsBySym[SYM] = rows; out.n[SYM].usable = rows.length; await saveProg(SYM + ' done');
  }
  const an = analyze(rowsBySym); out.res = an.res; out.candidates = an.candidates; out.comparisons = an.comparisons; out.verdict = verdict(an);
  out.progress = 'done'; out.done = iso(Date.now()); await kset(KEY, out); return out;
};
module.exports.helpers = { voteDay, metrics, analyze, verdict, bootCI, mulberry32, ema, rsi2, fiveMinCloses, VARIANTS, SPLIT };
