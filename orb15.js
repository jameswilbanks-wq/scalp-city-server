'use strict';
/* ORB15 signal detection (pure function, no I/O, so it can be unit-tested; see test/orb15_detect.test.js).

   Rule (unchanged from the live book and study bt13): opening range = 9:30-9:44 ET (minutes 570-584). The signal is the FIRST
   15-minute candle (9:45, 10:00, ...; the last one starts 15:00) whose close is beyond that range. A candle's close is the
   close of its last 1-minute bar (minutes 599, 614, ..., 914). Stop = the other side of the range.

   What changed (2026-11-18): the old code only saw a signal if the LAST bar in the list was exactly the candle-close minute,
   and returned null for every later candle once an earlier candle had broken out. A restart or a slow tick at that one minute
   therefore lost the symbol for the whole day with no log line (suspected on 2026-11-13, during an OOM crash loop). This
   version scans the whole day's completed bars for the first breakout candle, so the caller can act on it or, if it is stale,
   log a skip. Entry timing and staleness rules stay in server.js (orbLook).

   find(today): today = this ET day's COMPLETED 1-minute bars, each { t, min, h, l, c }, any order.
   Returns null (nothing to do), { incomplete: true, n } (a candle has closed but the opening range has fewer than 15 one-minute
   bars, so no range can be formed), or { sig: { dir, trig, stopPx, oH, oL }, bar } where bar is the candle's closing 1-minute bar. */
function find(today) {
  const bars = (today || []).slice().sort((a, b) => a.t - b.t);
  const rng = bars.filter(x => x.min >= 570 && x.min <= 584);
  const closes = bars.filter(x => x.min >= 599 && x.min <= 914 && (x.min - 584) % 15 === 0);
  if (!closes.length) return null; // no 15-minute candle has closed yet (before 10:00 ET), or none was seen
  if (rng.length < 15) return { incomplete: true, n: rng.length };
  const oH = Math.max(...rng.map(x => x.h)), oL = Math.min(...rng.map(x => x.l));
  for (const b of closes) {
    const dir = b.c > oH ? 1 : b.c < oL ? -1 : 0;
    if (!dir) continue;
    const stopPx = dir > 0 ? oL : oH;
    if (!(Math.abs(b.c - stopPx) > 0.0001 * b.c)) return null; // first breakout has no usable stop distance; the day has no signal
    return { sig: { dir, trig: 'orb5', stopPx, oH, oL }, bar: b };
  }
  return null;
}
module.exports = { find };
