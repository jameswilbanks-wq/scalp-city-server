/* Signal board engine (James 2026-11-27: "a table ... that shows all our manual trade tickers and when a buy or sell signal is triggered it lights up either way ... lights up when 3 of 5 are triggered ... also shows the actual 5 signals and lights up each one along the way").
   DISPLAY ONLY. Pure functions: no network, no orders, no state. It never feeds an order path; the on-demand book stays a human decision.
   NOT A VALIDATED STRATEGY. The five signals are standard textbook rules; published evidence says such rules rarely survive costs out of sample (docs/DECISIONS.md 2026-11-27). Every signal change is journaled so a later read-only study can measure hit rate net of spread.
   Input: bars from Engine.prepare (regular hours, ascending): { t, o, h, l, c, v, day, min } where min = minutes since midnight ET (570 = 9:30).
   Each signal is +1 (buy lean), -1 (sell lean), 0 (neutral) or null (not available yet / not applicable).
   1 vwap  : last close above today's session VWAP (typical price x volume) = +1, below = -1.
   2 orb   : after 10:00 ET, close above the 9:30-10:00 range high = +1, below the range low = -1, inside = 0; null before 10:00.
   3 rsi   : Wilder RSI(14) on completed 5-minute closes; <= 30 = +1 (oversold), >= 70 = -1 (overbought), else 0. Mean-reversion by design.
   4 ema   : 1-minute EMA(9) above EMA(21) = +1, below = -1; null until 25 bars exist.
   5 ihh   : first-half-hour momentum (Gao, Han, Li, Zhou 2018, index ETFs only): sign of (10:00 price - prior close); null before 10:00 and for non-index symbols. The paper uses it to predict the LAST half hour; the board shows it all day as a lean.
   6 macd  : MACD(12,26,9) on 1-minute closes: MACD line above its signal line = +1, below = -1; null until 35 bars exist. (James 2026-11-27: "we could just add all 7")
   7 bb    : Bollinger Bands (20, 2 standard deviations) on completed 5-minute closes: close below the lower band = +1 (oversold lean), above the upper band = -1, inside = 0; null until 20 five-minute closes. Mean-reversion by design, like RSI.
   Light: buy when 4 or more of the 7 signals are +1, sell when 4 or more are -1, else none (a signal that is null never counts). 4 of 7 is a majority; it replaces "3 of 5" for the 7-signal board (scaled by Claude, not tuned: James can change it). */
'use strict';
const NEED = 4, N_SIG = 7, RSI_N = 14, EMA_F = 9, EMA_S = 21, ORB_END = 600, STALE_MS = 5 * 60000, BB_N = 20, BB_K = 2, MACD_F = 12, MACD_S = 26, MACD_G = 9;
function ema(vals, n) { const k = 2 / (n + 1); let e = null; for (let i = 0; i < vals.length; i++) e = e === null ? vals[i] : vals[i] * k + e * (1 - k); return e; }
function rsiWilder(closes, n) {
  if (closes.length < n + 1) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = closes[i] - closes[i - 1]; if (d >= 0) g += d; else l -= d; }
  g /= n; l /= n;
  for (let i = n + 1; i < closes.length; i++) { const d = closes[i] - closes[i - 1]; g = (g * (n - 1) + (d > 0 ? d : 0)) / n; l = (l * (n - 1) + (d < 0 ? -d : 0)) / n; }
  if (l === 0) return g === 0 ? 50 : 100;
  return 100 - 100 / (1 + g / l);
}
function macdCross(closes) { // +1 / -1 / 0 for MACD line vs signal line at the last close; null until 35 closes
  if (closes.length < MACD_S + MACD_G) return null;
  const kf = 2 / (MACD_F + 1), ks = 2 / (MACD_S + 1), kg = 2 / (MACD_G + 1); let ef = closes[0], es = closes[0], sg = null, m = 0;
  for (let i = 0; i < closes.length; i++) { ef = i ? closes[i] * kf + ef * (1 - kf) : closes[0]; es = i ? closes[i] * ks + es * (1 - ks) : closes[0]; m = ef - es; sg = sg === null ? m : m * kg + sg * (1 - kg); }
  return { m, sg, v: m > sg ? 1 : m < sg ? -1 : 0 };
}
function bollinger(closes) { // last close vs mean +/- K sd of the last N closes; null until N closes
  if (closes.length < BB_N) return null;
  const w = closes.slice(-BB_N), mu = w.reduce((a, b) => a + b, 0) / BB_N, sd = Math.sqrt(w.reduce((a, b) => a + (b - mu) * (b - mu), 0) / BB_N), c = closes[closes.length - 1], lo = mu - BB_K * sd, hi = mu + BB_K * sd;
  return { lo, hi, mu, c, v: c < lo ? 1 : c > hi ? -1 : 0 };
}
function fiveMin(bars, lastT) { // completed 5-minute closes (the bucket still forming is dropped)
  const out = [], seen = {};
  bars.forEach(b => { const k = Math.floor(b.t / 300000); (seen[k] = seen[k] || []).push(b); });
  Object.keys(seen).map(Number).sort((a, b) => a - b).forEach(k => { if ((k + 1) * 300000 <= lastT + 60000) out.push(seen[k][seen[k].length - 1].c); });
  return out;
}
function computeSignals(bars, opts) {
  opts = opts || {}; const now = opts.now || Date.now(), isIndex = !!opts.index;
  const blank = (why) => ({ state: 'none', nBuy: 0, nSell: 0, nUse: 0, sigs: { vwap: { v: null, why }, orb: { v: null, why }, rsi: { v: null, why }, ema: { v: null, why }, ihh: { v: null, why }, macd: { v: null, why }, bb: { v: null, why } }, px: null, asOf: null, stale: true, why });
  if (!bars || bars.length < 2) return blank('no bars yet');
  const last = bars[bars.length - 1], today = bars.filter(b => b.day === last.day);
  if (!today.length) return blank('no bars today');
  const stale = now - (last.t + 60000) > STALE_MS, sigs = {};
  // 1 VWAP
  { let pv = 0, vv = 0; today.forEach(b => { pv += (b.h + b.l + b.c) / 3 * b.v; vv += b.v; }); const vw = vv ? pv / vv : null;
    sigs.vwap = vw === null ? { v: null, why: 'no volume' } : { v: last.c > vw ? 1 : last.c < vw ? -1 : 0, why: 'price ' + last.c.toFixed(2) + ' vs VWAP ' + vw.toFixed(2) }; }
  // 2 ORB 30
  { const rng = today.filter(b => b.min >= 570 && b.min < ORB_END);
    if (last.min < ORB_END || rng.length < 20) sigs.orb = { v: null, why: last.min < ORB_END ? 'range forming until 10:00' : 'range incomplete (' + rng.length + ' bars)' };
    else { const hi = Math.max.apply(null, rng.map(b => b.h)), lo = Math.min.apply(null, rng.map(b => b.l)); sigs.orb = { v: last.c > hi ? 1 : last.c < lo ? -1 : 0, why: 'range ' + lo.toFixed(2) + ' to ' + hi.toFixed(2) }; } }
  // 3 RSI on 5-minute closes (and 7 Bollinger Bands on the same completed 5-minute closes)
  const fm = fiveMin(bars, last.t);
  { const r = rsiWilder(fm, RSI_N); sigs.rsi = r === null ? { v: null, why: 'needs ' + (RSI_N + 1) + ' five-minute bars' } : { v: r <= 30 ? 1 : r >= 70 ? -1 : 0, why: 'RSI ' + r.toFixed(0) }; }
  // 4 EMA 9 / 21 on 1-minute closes
  { if (bars.length < EMA_S + 4) sigs.ema = { v: null, why: 'needs ' + (EMA_S + 4) + ' bars' };
    else { const cl = bars.map(b => b.c), f = ema(cl, EMA_F), s = ema(cl, EMA_S); sigs.ema = { v: f > s ? 1 : f < s ? -1 : 0, why: 'EMA9 ' + f.toFixed(2) + ' vs EMA21 ' + s.toFixed(2) }; } }
  // 5 first half hour (index ETFs only)
  { if (!isIndex) sigs.ihh = { v: null, why: 'index ETFs only' };
    else { const prev = bars.filter(b => b.day < last.day), pc = prev.length ? prev[prev.length - 1].c : null, at10 = today.filter(b => b.min < ORB_END).pop();
      if (last.min < ORB_END || !at10) sigs.ihh = { v: null, why: 'known after 10:00' };
      else if (pc === null) sigs.ihh = { v: null, why: 'no prior close' };
      else { const ret = (at10.c - pc) / pc * 100; sigs.ihh = { v: ret > 0 ? 1 : ret < 0 ? -1 : 0, why: 'prior close to 10:00 ' + (ret >= 0 ? '+' : '') + ret.toFixed(2) + '%' }; } } }
  // 6 MACD 12/26/9 on 1-minute closes
  { const mc = macdCross(bars.map(b => b.c)); sigs.macd = mc === null ? { v: null, why: 'needs ' + (MACD_S + MACD_G) + ' bars' } : { v: mc.v, why: 'MACD ' + mc.m.toFixed(3) + ' vs signal ' + mc.sg.toFixed(3) }; }
  // 7 Bollinger Bands (20, 2) on completed 5-minute closes
  { const bb = bollinger(fm); sigs.bb = bb === null ? { v: null, why: 'needs ' + BB_N + ' five-minute bars' } : { v: bb.v, why: 'close ' + bb.c.toFixed(2) + ' vs bands ' + bb.lo.toFixed(2) + ' to ' + bb.hi.toFixed(2) }; }
  const vals = Object.keys(sigs).map(k => sigs[k].v), nBuy = vals.filter(v => v === 1).length, nSell = vals.filter(v => v === -1).length, nUse = vals.filter(v => v !== null).length;
  const state = stale ? 'none' : nBuy >= NEED ? 'buy' : nSell >= NEED ? 'sell' : 'none';
  return { state, nBuy, nSell, nUse, sigs, px: last.c, asOf: last.t, stale, why: stale ? 'quote older than 5 minutes' : '' };
}
module.exports = { computeSignals, rsiWilder, ema, macdCross, bollinger, NEED, N_SIG };
