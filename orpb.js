'use strict';
/* ORPB signal mechanics (pure functions, no I/O; used only by the read-only study study_orpb.js, kv bt29; spec docs/orpb-signal-study-spec.md).
   NOT a trading module: nothing in server.js trading paths requires this file.

   Bars: one ET session of 1-minute bars, each { min, o, h, l, c }, min = minutes since midnight ET (570 = 9:30). Any order.
   Candles are aligned to 9:30: an n-minute candle starts at 570 + k*n and "closes" at start+n (e = start+n). A candle exists if it has
   at least one 1-minute bar; its close is the close of its LAST bar inside the bucket (IEX minute bars can be missing).

   Rules as pre-registered (inferred pieces are flagged in the spec, section 3):
   - range = high/low of 1-minute bars 570 .. 570+rangeMin-1; needs ceil(rangeMin*25/30) bars (25 of 30 for the primary 30-minute range)
   - trigger = first trigMin-minute candle starting at or after the range end (and no later than 14:30) whose close is above the range high
     (long) or below the range low (short)
   - entry = first 2-minute candle that closes after the trigger candle closes, ends by 15:00, touches the 20 EMA (long: low <= EMA,
     short: high >= EMA) and, in 'hold' mode, also closes on the trade side of it; 'touch' mode drops the close condition. Entry = that
     candle's close. EMA value used = the EMA including that candle's own close (what the chart shows once the candle is complete).
   - stop = the pullback candle's low (long) / high (short); a stop distance below the floor skips the day (counted)
   - exit: 1-minute bars after the entry candle closes; stop checked BEFORE target inside a bar; a bar that opens beyond the stop fills at
     the open (worse); flat at the open of the first bar at/after 15:30 (or the session's last close if the data ends earlier). */

const FLAT = 930, ENTRY_END = 900, LAST_TRIG_START = 870;

function agg(bars, n) {
  const list = (bars || []).filter(b => b.min >= 570 && b.min < 960).sort((a, b) => a.min - b.min);
  const out = []; let cur = null;
  for (const b of list) {
    const s = 570 + Math.floor((b.min - 570) / n) * n;
    if (!cur || cur.s !== s) { cur = { s, e: s + n, o: b.o, h: b.h, l: b.l, c: b.c, nb: 1 }; out.push(cur); }
    else { if (b.h > cur.h) cur.h = b.h; if (b.l < cur.l) cur.l = b.l; cur.c = b.c; cur.nb++; }
  }
  return out;
}

// Standard recursive EMA, alpha = 2/(len+1), seeded with the first value of the series.
function emaSeries(closes, len) {
  const a = 2 / (len + 1), out = new Array(closes.length); let e = 0;
  for (let i = 0; i < closes.length; i++) { e = i === 0 ? closes[0] : e + a * (closes[i] - e); out[i] = e; }
  return out;
}
// EMA values for today's candles, warmed up on warmCloses (previous sessions' 2-minute closes; [] = session-only seed).
function emaForDay(todayCloses, warmCloses, len) {
  const w = warmCloses || [];
  return emaSeries(w.concat(todayCloses), len).slice(w.length);
}

function rangeOf(bars, rangeMin) {
  const rb = (bars || []).filter(b => b.min >= 570 && b.min < 570 + rangeMin);
  const need = Math.ceil(rangeMin * 25 / 30);
  if (rb.length < need || !rb.length) return { ok: false, nb: rb.length, need };
  return { ok: true, nb: rb.length, need, hi: Math.max(...rb.map(b => b.h)), lo: Math.min(...rb.map(b => b.l)) };
}

function findTrigger(candles, hi, lo, firstStart, lastStart) {
  for (const c of candles) {
    if (c.s < firstStart) continue;
    if (c.s > lastStart) break;
    const dir = c.c > hi ? 1 : c.c < lo ? -1 : 0;
    if (dir) return { dir, c };
  }
  return null;
}

function findPullback(c2, ema, dir, afterMin, mode) {
  for (let i = 0; i < c2.length; i++) {
    const c = c2[i];
    if (c.s < afterMin) continue;
    if (c.e > ENTRY_END) break;
    const touch = dir > 0 ? c.l <= ema[i] : c.h >= ema[i];
    const hold = dir > 0 ? c.c > ema[i] : c.c < ema[i];
    if (touch && (mode === 'touch' || hold)) return { i, c, ema: ema[i] };
  }
  return null;
}

function exitSim(bars, fromMin, dir, stop, target) {
  const list = (bars || []).filter(b => b.min >= fromMin).sort((a, b) => a.min - b.min);
  for (const b of list) {
    if (b.min >= FLAT) return { px: b.o, why: 'time', min: b.min };
    const stopHit = dir > 0 ? b.l <= stop : b.h >= stop;
    const tgtHit = target != null && (dir > 0 ? b.h >= target : b.l <= target);
    if (stopHit) return { px: dir > 0 ? Math.min(stop, b.o) : Math.max(stop, b.o), why: tgtHit ? 'stop(tie)' : 'stop', min: b.min };
    if (tgtHit) return { px: target, why: 'target', min: b.min };
  }
  if (list.length) { const L = list[list.length - 1]; return { px: L.c, why: 'time(end)', min: L.min }; }
  return null;
}

// One session, lazily computing and caching the pieces different configs share.
function makeDay(bars, warmCloses) {
  const memo = {}, get = (k, f) => (k in memo ? memo[k] : (memo[k] = f()));
  const d = {
    bars, warm: warmCloses || null,
    cand: n => get('c' + n, () => agg(bars, n)),
    range: m => get('r' + m, () => rangeOf(bars, m)),
    ema: (len, useWarm) => get('e' + len + (useWarm ? 'w' : 's'), () => emaForDay(d.cand(2).map(c => c.c), useWarm ? d.warm : [], len)),
    closes2: () => d.cand(2).map(c => c.c),
  };
  return d;
}

/* cfg = { entry: 'hold'|'touch'|'naive', target: R multiple or 0 for none (flat 15:30), emaLen, trigMin, rangeMin, warm: bool, floor: $ per share }
   returns { skip: reason, signal?: bool } or { trade, signal: true }. Trade money is per share; R = |entry-stop|. */
function runConfig(d, cfg) {
  if (!d.warm) return { skip: 'warmup (fewer than 5 prior sessions)' };
  const R = d.range(cfg.rangeMin);
  if (!R.ok) return { skip: 'range bars missing' };
  const trig = findTrigger(d.cand(cfg.trigMin), R.hi, R.lo, 570 + cfg.rangeMin, LAST_TRIG_START);
  if (!trig) return { skip: 'no breakout' };
  const dir = trig.dir; let entry, stop, from;
  if (cfg.entry === 'naive') { entry = trig.c.c; stop = dir > 0 ? R.lo : R.hi; from = trig.c.e; }
  else {
    const pb = findPullback(d.cand(2), d.ema(cfg.emaLen, cfg.warm), dir, trig.c.e, cfg.entry);
    if (!pb) return { skip: 'no pullback' };
    entry = pb.c.c; stop = dir > 0 ? pb.c.l : pb.c.h; from = pb.c.e;
  }
  const risk = dir * (entry - stop);
  if (!(risk >= cfg.floor) || !(risk > 0)) return { skip: 'stop below floor', signal: true };
  const target = cfg.target > 0 ? entry + dir * risk * cfg.target : null;
  const ex = exitSim(d.bars, from, dir, stop, target);
  if (!ex) return { skip: 'no bars after entry', signal: true };
  return { signal: true, trade: { dir, entryMin: from, entry, stop, risk, exitPx: ex.px, why: ex.why, exitMin: ex.min, gross: dir * (ex.px - entry) } };
}

module.exports = { agg, emaSeries, emaForDay, rangeOf, findTrigger, findPullback, exitSim, makeDay, runConfig, FLAT, ENTRY_END, LAST_TRIG_START };
