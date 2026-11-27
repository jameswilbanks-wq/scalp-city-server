/* bt38 signal confluence study. RESEARCH ONLY: pure functions, no network, no env, no orders, no kv. Spec: docs/signal-confluence-spec.md (frozen before any data was fetched).
   Question: does the forward SPY/QQQ move improve, in the signal's direction, as more of the five signal-board signals agree? It runs the PRODUCTION engine (signals.js computeSignals) on historical 1-minute bars.
   Input per symbol: raw columns {t:[ms bar start], o:[], h:[], l:[], c:[], v:[]} (Alpaca SIP, adjustment=all). Outcome = underlying move in basis points; option P&L is NOT modelled (spec section 5). */
'use strict';
const { computeSignals } = require('./signals.js');

const SPLIT = '2023-12-31', OPEN = 570, CLOSE = 960, WARM_DAYS = 5, WIN_DAYS = 3, SLOT_FROM = 600, SLOT_STEP = 5, TAIL = 30, MIN_N = 300;
const HZ = ['15', '30', '60', 'close'], HMIN = { '15': 15, '30': 30, '60': 60 }, NAMES = ['vwap', 'orb', 'rsi', 'ema', 'ihh'];
const COST_UND = 0.3, COST_OPT = 1.0, COST_OPT_STRESS = 2.0; // bp of price, round trip; stated assumptions (spec section 5)

/* ---------- time: US Eastern from the DST rule ---------- */
function nthSunday(y, m, n) { const f = new Date(Date.UTC(y, m, 1)).getUTCDay(); return 1 + (7 - f) % 7 + 7 * (n - 1); }
function etOffsetMin(ms) { const y = new Date(ms).getUTCFullYear(), s = Date.UTC(y, 2, nthSunday(y, 2, 2), 7), e = Date.UTC(y, 10, nthSunday(y, 10, 1), 6); return ms >= s && ms < e ? -240 : -300; }
function etParts(ms) { const d = new Date(ms + etOffsetMin(ms) * 60000); return { day: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes() }; }

/* ---------- prep: regular session only, calendar applied, hard cutoff first ---------- */
function prep(raw, opts) {
  opts = opts || {}; const dq = { rawBars: raw.t.length, sessionBars: 0, offSession: 0, afterEarlyClose: 0, notInCalendar: 0, afterCutoff: 0, duplicate: 0, outOfOrder: 0, badPrice: 0, shortDays: 0, days: 0 };
  const bars = [], closeMin = {}, sess = opts.calendar ? new Set(opts.calendar.map(x => x.date)) : null;
  if (opts.calendar) opts.calendar.forEach(x => { const m = /^(\d\d):(\d\d)$/.exec(x.close || ''); if (m && +m[1] * 60 + +m[2] < CLOSE) closeMin[x.date] = +m[1] * 60 + +m[2]; });
  let prevT = -Infinity;
  for (let i = 0; i < raw.t.length; i++) {
    const t = raw.t[i], p = etParts(t);
    if (opts.cutoffDay && p.day > opts.cutoffDay) { dq.afterCutoff++; continue; } // hard cutoff before any computation
    if (p.min < OPEN || p.min >= CLOSE) { dq.offSession++; continue; }
    if (sess && !sess.has(p.day)) { dq.notInCalendar++; continue; }
    if (closeMin[p.day] && p.min >= closeMin[p.day]) { dq.afterEarlyClose++; continue; }
    if (t === prevT) { dq.duplicate++; continue; } if (t < prevT) { dq.outOfOrder++; continue; }
    const o = +raw.o[i], h = +raw.h[i], l = +raw.l[i], c = +raw.c[i]; if (!(o > 0 && h > 0 && l > 0 && c > 0)) { dq.badPrice++; continue; }
    prevT = t; bars.push({ t, o, h, l, c, v: +raw.v[i] || 0, day: p.day, min: p.min });
  }
  const perDay = {}; bars.forEach((b, i) => { const q = perDay[b.day] || (perDay[b.day] = { day: b.day, start: i, end: i, n: 0 }); q.end = i; q.n++; });
  const days = Object.keys(perDay).sort().map(d => perDay[d]).filter(d => { const need = closeMin[d.day] ? 150 : 300; if (d.n < need) { dq.shortDays++; return false; } return true; });
  dq.sessionBars = bars.length; dq.days = days.length; dq.firstDay = days.length ? days[0].day : null; dq.lastDay = days.length ? days[days.length - 1].day : null;
  return { bars, days, closeMin, dq };
}

/* ---------- collect: one record per decision point ---------- */
function collect(P) {
  const { bars, days, closeMin } = P, recs = [];
  for (let di = Math.max(WARM_DAYS, WIN_DAYS); di < days.length; di++) {
    const D = days[di], from = days[di - WIN_DAYS].start, byMin = {}; for (let i = D.start; i <= D.end; i++) byMin[bars[i].min] = i;
    const lastSlot = (closeMin[D.day] || CLOSE) - TAIL;
    for (let m = SLOT_FROM; m <= lastSlot; m += SLOT_STEP) {
      const j = byMin[m]; if (j === undefined || j + 1 > D.end) continue;
      const s = computeSignals(bars.slice(from, j + 1), { index: true, now: bars[j].t + 90000 }), entry = bars[j + 1].o, r = {};
      HZ.forEach(h => { const x = h === 'close' ? D.end : Math.min(j + HMIN[h], D.end); r[h] = (bars[x].c / entry - 1) * 1e4; });
      recs.push({ di, day: D.day, m, v: NAMES.map(n => s.sigs[n].v), nb: s.nBuy, ns: s.nSell, st: s.state, r });
    }
  }
  return recs;
}

/* ---------- statistics ---------- */
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const pct = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)))] : NaN;
/* excess stats for a set of (record, direction) picks: direction-adjusted return minus the same-period unconditional mean, with a day-clustered bootstrap interval */
function excess(picks, h, base, draws, seed) {
  const byDay = {}; let n = 0, sx = 0, sraw = 0, hits = 0;
  picks.forEach(([rec, d]) => { const x = d * (rec.r[h] - base), q = byDay[rec.day] || (byDay[rec.day] = { s: 0, n: 0 }); q.s += x; q.n++; n++; sx += x; sraw += d * rec.r[h]; if (d * rec.r[h] > 0) hits++; });
  if (!n) return { n: 0 };
  const out = { n, days: Object.keys(byDay).length, mean: sx / n, rawMean: sraw / n, hit: hits / n * 100 };
  out.netUnd = out.mean - COST_UND; out.netOpt = out.mean - COST_OPT; out.netOptStress = out.mean - COST_OPT_STRESS;
  if (draws && n >= 30) {
    const dd = Object.keys(byDay).map(k => byDay[k]), R = rng(seed), means = [];
    for (let b = 0; b < draws; b++) { let s = 0, c = 0; for (let k = 0; k < dd.length; k++) { const q = dd[(R() * dd.length) | 0]; s += q.s; c += q.n; } means.push(s / c); }
    means.sort((x, y) => x - y); out.lo = pct(means, 0.025); out.hi = pct(means, 0.975);
  }
  return out;
}
function spearman(xs, ys) {
  if (xs.length < 3) return null; const rk = a => { const o = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]), r = Array(a.length); o.forEach((p, k) => { r[p[1]] = k + 1; }); return r; };
  const a = rk(xs), b = rk(ys), ma = mean(a), mb = mean(b); let nu = 0, da = 0, db = 0; for (let i = 0; i < a.length; i++) { nu += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; } return da && db ? nu / Math.sqrt(da * db) : null;
}
function corrMatrix(recs) {
  const M = NAMES.map(() => NAMES.map(() => null)); let sum = 0, cnt = 0;
  for (let a = 0; a < 5; a++) for (let b = a + 1; b < 5; b++) {
    const xs = [], ys = []; recs.forEach(r => { if (r.v[a] !== null && r.v[b] !== null) { xs.push(r.v[a]); ys.push(r.v[b]); } });
    const ma = mean(xs), mb = mean(ys); let nu = 0, da = 0, db = 0; for (let i = 0; i < xs.length; i++) { nu += (xs[i] - ma) * (ys[i] - mb); da += (xs[i] - ma) ** 2; db += (ys[i] - mb) ** 2; }
    const c = da && db ? nu / Math.sqrt(da * db) : null; M[a][b] = M[b][a] = c; if (c !== null) { sum += c; cnt++; }
  }
  const mc = cnt ? sum / cnt : null; return { names: NAMES, m: M, mean: mc, neff: mc === null ? null : 5 / (1 + 4 * Math.max(0, mc)) };
}
/* C1: circularly shift whole sessions of the signal vectors against the outcomes; the null for the pooled "light" excess */
function shiftNull(recs, h, base, draws, seed) {
  const days = [], idx = {}; recs.forEach(r => { if (idx[r.day] === undefined) { idx[r.day] = days.length; days.push({}); } days[idx[r.day]][r.m] = r; });
  const D = days.length; if (D < 10) return null; const R = rng(seed), dist = [];
  for (let b = 0; b < draws; b++) {
    const s = 1 + ((R() * (D - 1)) | 0); let sum = 0, n = 0;
    for (let d = 0; d < D; d++) { const src = days[(d + s) % D], dst = days[d]; for (const m in dst) { const q = src[m]; if (!q || q.st === 'none') continue; sum += (q.st === 'buy' ? 1 : -1) * (dst[m].r[h] - base); n++; } }
    dist.push(n ? sum / n : 0);
  }
  dist.sort((x, y) => x - y); return { draws, p975: pct(dist, 0.975), p50: pct(dist, 0.5), p025: pct(dist, 0.025) };
}

function analyse(recs, draws, seed) {
  const out = { nSlots: recs.length, base: {}, ladder: { buy: {}, sell: {} }, light: {}, weak: {}, five: {}, single: {}, corr: corrMatrix(recs), gradient: {}, null: {} };
  HZ.forEach(h => { out.base[h] = mean(recs.map(r => r.r[h])); });
  const sub = f => recs.filter(f);
  HZ.forEach(h => {
    const b = out.base[h], lightP = [], weakP = [];
    recs.forEach(r => { if (r.st === 'buy') lightP.push([r, 1]); else if (r.st === 'sell') lightP.push([r, -1]); if (r.nb === 1 || r.nb === 2) weakP.push([r, 1]); if (r.ns === 1 || r.ns === 2) weakP.push([r, -1]); });
    out.light[h] = excess(lightP, h, b, draws, seed + 1); out.weak[h] = excess(weakP, h, b, draws, seed + 2);
    out.five[h] = { buy: excess(sub(r => r.nb === 5).map(r => [r, 1]), h, b, draws, seed + 3), sell: excess(sub(r => r.ns === 5).map(r => [r, -1]), h, b, draws, seed + 4) };
    for (let k = 0; k <= 5; k++) { (out.ladder.buy[k] = out.ladder.buy[k] || {})[h] = excess(sub(r => r.nb === k).map(r => [r, 1]), h, b, draws, seed + 10 + k); (out.ladder.sell[k] = out.ladder.sell[k] || {})[h] = excess(sub(r => r.ns === k).map(r => [r, -1]), h, b, draws, seed + 20 + k); }
    NAMES.forEach((nm, i) => { (out.single[nm] = out.single[nm] || {})[h] = { buy: excess(sub(r => r.v[i] === 1).map(r => [r, 1]), h, b, 0, 0), sell: excess(sub(r => r.v[i] === -1).map(r => [r, -1]), h, b, 0, 0) }; });
    ['buy', 'sell'].forEach(side => { const ks = [], ms = []; for (let k = 1; k <= 5; k++) { const e = out.ladder[side][k][h]; if (e && e.n >= 30) { ks.push(k); ms.push(e.mean); } } (out.gradient[side] = out.gradient[side] || {})[h] = { rho: spearman(ks, ms), ks }; });
  });
  return out;
}

/* ---------- verdict (spec section 6; SPY, 30 minutes, light state, dev + holdout) ---------- */
function verdict(spy) {
  const L = p => spy[p].light['30'], W = p => spy[p].weak['30'], dev = L('dev'), hold = L('hold'), nul = spy.dev.null['30'], c = [], fails = [];
  const c1 = dev.n >= MIN_N && hold.n >= MIN_N; c.push({ id: 1, text: 'light decision points >= ' + MIN_N + ' in dev and holdout', ok: c1, dev: dev.n, hold: hold.n });
  if (!c1) return { label: 'Inconclusive', criteria: c, failed: ['1'] };
  c.push({ id: 2, text: 'mean excess > 0 in dev and holdout', ok: dev.mean > 0 && hold.mean > 0, dev: dev.mean, hold: hold.mean });
  c.push({ id: 3, text: 'dev bootstrap 95% lower bound > 0', ok: dev.lo > 0, lo: dev.lo, hi: dev.hi });
  c.push({ id: 4, text: 'mean excess minus ' + COST_OPT + ' bp option-equivalent cost > 0 in dev and holdout', ok: dev.netOpt > 0 && hold.netOpt > 0, dev: dev.netOpt, hold: hold.netOpt });
  c.push({ id: 5, text: 'dev excess above the C1 shifted-signal 97.5th percentile', ok: !!nul && dev.mean > nul.p975, dev: dev.mean, p975: nul ? nul.p975 : null });
  c.push({ id: 6, text: 'light (k>=3) excess greater than weak (k=1 or 2) excess in dev and holdout', ok: W('dev').n > 0 && W('hold').n > 0 && dev.mean > W('dev').mean && hold.mean > W('hold').mean, devLight: dev.mean, devWeak: W('dev').mean, holdLight: hold.mean, holdWeak: W('hold').mean });
  c.forEach(x => { if (!x.ok) fails.push(String(x.id)); });
  return { label: fails.length ? 'Not supported' : 'Supported (underlying move only)', criteria: c, failed: fails };
}

/* run: recsBySym = { SPY: [recs], QQQ: [recs] } (already collected); periods split by decision day; stage 'dev' touches no holdout record */
function run(recsBySym, o) {
  o = o || {}; const draws = o.draws === undefined ? 2000 : o.draws, nullDraws = o.nullDraws === undefined ? 1000 : o.nullDraws, dev = o.stage === 'dev';
  const res = { study: 'bt38', stage: o.stage || 'final', split: SPLIT, costs: { und: COST_UND, opt: COST_OPT, optStress: COST_OPT_STRESS }, draws, nullDraws, syms: {} };
  Object.keys(recsBySym).forEach(sym => {
    const all = recsBySym[sym], d = all.filter(r => r.day <= SPLIT), h = all.filter(r => r.day > SPLIT), S = res.syms[sym] = { dev: analyse(d, draws, 1000), hold: dev ? null : analyse(h, draws, 2000), full: dev ? null : analyse(all, draws, 3000) };
    S.dev.null['30'] = shiftNull(d, '30', S.dev.base['30'], nullDraws, 1099); if (S.hold) S.hold.null['30'] = shiftNull(h, '30', S.hold.base['30'], nullDraws, 2099);
  });
  if (!dev && res.syms.SPY) res.verdict = verdict(res.syms.SPY);
  return res;
}
module.exports = { prep, collect, analyse, excess, shiftNull, verdict, run, etParts, corrMatrix, spearman, rng, SPLIT, NAMES, HZ, COST_UND, COST_OPT, COST_OPT_STRESS, MIN_N };
