'use strict';
/* Sweep variants (pure functions, no I/O; used only by the read-only study study_sweep_variants.js, kv bt30; spec docs/sweep-variants-study-spec.md).
   NOT a trading module: nothing in the server trading paths requires this file.

   Bars are Engine.prepare() bars: { t (ms), o, h, l, c, v, day 'YYYY-MM-DD', min (minutes since midnight ET), vwap, atr }.
   A signal is Engine.signals() output { k (bar index of the signal bar), sig { dir, stopPx } }. Entry is the NEXT bar's open (e = bars[k+1]).
   R = |e.o - sig.stopPx| (the wick-stop distance), exactly as study_sweep.js (bt8).

   Exits are decided on the underlying and copied from bt8 `walk`:
     run   = stop at entry -/+ R, then a chandelier trail one R behind the best price; exit at the end of the bar whose low/high hits the
             stop, or whose close is beyond the trailed stop; flat at the 15:30 bar (min >= 930).
     t10ns = no stop: out 10 bars after the signal bar (or 15:30).
   Returns the exit time in ms (the option is then sold at its last trade price at/after that time). */

const FLAT = 930;

function walk(bars, k, dir, R, mode) {
  const e = bars[k + 1], D = bars[k].day;
  if (!e) return null;
  let stop = e.o - dir * R, hi = e.o;
  for (let q = k + 1; q < bars.length && bars[q].day === D; q++) {
    const x = bars[q];
    if (x.min >= FLAT) return x.t;
    if (mode === 'run') {
      if (dir > 0 ? x.l <= stop : x.h >= stop) return x.t + 60000;
      hi = dir > 0 ? Math.max(hi, x.h) : Math.min(hi, x.l);
      const ns = hi - dir * R; if (dir * (ns - stop) > 0) stop = ns;
      if (dir * (x.c - stop) < 0) return x.t + 60000;
    } else if (mode === 't10ns') {
      if (q - k >= 10) return x.t + 60000;
    }
  }
  return e.t + 60000; // same fallback as bt8 when the day's bars run out
}

// Facts about a signal needed by the filters. dayOpen = open of the day's first regular-session bar.
function signalFacts(bars, g, dayOpen) {
  const b = bars[g.k], e = bars[g.k + 1], dir = g.sig.dir;
  if (!e || e.day !== b.day) return null;
  const R = Math.abs(e.o - g.sig.stopPx);
  if (!(R > 0.0001 * e.o)) return null; // same guard as bt8
  const trendSign = Math.sign(b.c - dayOpen);                  // 0 = exactly flat
  const vwapAgree = dir > 0 ? b.c >= b.vwap : b.c <= b.vwap;
  return { k: g.k, day: b.day, dir, R, entryO: e.o, entryT: e.t, rPct: 100 * R / e.o, trendSign, trendAgree: trendSign === 0 ? null : trendSign === dir, vwapAgree };
}

// Variant definitions (pre-registered, spec section 2). via = which simulated outcome supplies the P&L.
//   S0: original direction, run exit. F1: opposite direction, run exit (mirror). F2: opposite direction, t10ns exit.
const VARIANTS = [
  { id: 'S0', via: 'S0', take: () => true },
  { id: 'F1', via: 'F1', take: () => true },
  { id: 'F2', via: 'F2', take: () => true },
  { id: 'W1', via: 'S0', take: f => f.rPct <= 0.08 },
  { id: 'W2', via: 'S0', take: f => f.rPct <= 0.12 },
  { id: 'T1', via: 'S0', take: f => f.trendAgree === true },
  { id: 'T2', via: 'S0', take: f => f.vwapAgree === true },
  { id: 'T3', via: 'S0', take: f => f.trendAgree === false },
];
const OUTCOMES = ['S0', 'F1', 'F2'];
const dirOf = (name, f) => name === 'S0' ? f.dir : -f.dir;
const modeOf = name => name === 'F2' ? 't10ns' : 'run';

// Seeded coin flip per signal (noise reference): heads = the S0 outcome, tails = the F1 outcome (same exit, opposite direction).
function coin(seed, i) { let x = (seed * 2654435761 + i * 40503) >>> 0; x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return (x & 1) === 1; }

// Metrics for an array of per-trade net dollars (already net of costs). days = number of sessions in the period (all trading days).
function metrics(pnls, days) {
  const n = pnls.length;
  if (!n) return { n: 0 };
  let tot = 0, w = 0, gw = 0, gl = 0, worst = Infinity, best = -Infinity;
  for (const p of pnls) { tot += p; if (p > 0) { w++; gw += p; } else gl += -p; if (p < worst) worst = p; if (p > best) best = p; }
  const r2 = x => Math.round(x * 100) / 100;
  return { n, win: Math.round(1000 * w / n) / 10, avg: r2(tot / n), avgAllDays: days ? r2(tot / days) : null, pf: gl > 0.0001 ? r2(gw / gl) : null, worst: r2(worst), best: r2(best), total: r2(tot) };
}
function dropBest(pnls, k) { const s = pnls.slice().sort((a, b) => b - a).slice(k); return s.length ? Math.round(100 * s.reduce((a, b) => a + b, 0) / s.length) / 100 : null; }
// Day-level bootstrap of the mean: rows = [{ day, pnl }], resample DAYS with replacement; returns [lo, hi] of the average per trade.
function bootCI(rows, B, seed) {
  const byDay = {}; rows.forEach(r => { (byDay[r.day] = byDay[r.day] || []).push(r.pnl); });
  const days = Object.keys(byDay); if (days.length < 5) return null;
  let s = seed >>> 0 || 1; const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  const means = [];
  for (let b = 0; b < B; b++) { let sum = 0, cnt = 0; for (let i = 0; i < days.length; i++) { const arr = byDay[days[(rnd() * days.length) | 0]]; for (const p of arr) { sum += p; cnt++; } } if (cnt) means.push(sum / cnt); }
  means.sort((a, b) => a - b);
  return [Math.round(100 * means[Math.floor(0.025 * means.length)]) / 100, Math.round(100 * means[Math.floor(0.975 * means.length)]) / 100];
}

module.exports = { walk, signalFacts, VARIANTS, OUTCOMES, dirOf, modeOf, coin, metrics, dropBest, bootCI, FLAT };
