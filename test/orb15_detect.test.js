'use strict';
/* Unit test for orb15.js (ORB15 signal detection). Synthetic one-minute bars only, no network.
   Run: node test/orb15_detect.test.js */
const assert = require('assert');
const { find } = require('../orb15.js');

const T0 = Date.UTC(2026, 10, 18, 14, 30, 0); // 9:30 ET on 2026-11-18 (EST)
// Build one day of 1-minute bars from minute 570 through lastMin. price(min) gives the close; high/low are close +/- 0.05 unless overridden.
function day(lastMin, price, opts) {
  opts = opts || {};
  const out = [];
  for (let m = 570; m <= lastMin; m++) {
    if (opts.skip && opts.skip.includes(m)) continue;
    const c = price(m);
    const o = opts.over && opts.over[m] || {};
    out.push({ t: T0 + (m - 570) * 60000, min: m, h: o.h !== undefined ? o.h : c + 0.05, l: o.l !== undefined ? o.l : c - 0.05, c });
  }
  return out;
}
const INSIDE = () => 100; // range 99.95-100.05 when flat

// 1. nothing before the first candle closes (9:30-9:58): no signal, no warning
assert.strictEqual(find(day(598, INSIDE)), null);

// 2. flat day: no breakout
assert.strictEqual(find(day(914, INSIDE)), null);

// 3. first candle (closes min 599) breaks up
{
  const r = find(day(600, m => (m >= 585 ? 101 : 100)));
  assert(r && r.sig, 'signal expected');
  assert.strictEqual(r.sig.dir, 1);
  assert.strictEqual(r.bar.min, 599);
  assert.strictEqual(r.sig.stopPx, 99.95); // other side of the range
  assert.strictEqual(r.sig.oH, 100.05);
  assert.strictEqual(r.sig.trig, 'orb5');
}

// 4. third candle (closes min 629) breaks down; the earlier two close inside
{
  const r = find(day(630, m => (m >= 615 ? 99 : 100)));
  assert(r && r.sig);
  assert.strictEqual(r.sig.dir, -1);
  assert.strictEqual(r.bar.min, 629);
  assert.strictEqual(r.sig.stopPx, 100.05);
}

// 5. the FIRST breakout candle is returned even if later candles are also beyond the range, and even when the list is seen late
//    (this is the case the old code lost silently: a restart or slow tick at the candle-close minute)
{
  const bars = day(700, m => (m >= 585 ? 101 : 100)); // every candle from the first closes above the range
  const r = find(bars);
  assert(r && r.sig);
  assert.strictEqual(r.bar.min, 599, 'must be the first breakout candle, not the latest');
  assert.strictEqual(r.bar.t, T0 + 29 * 60000);
}

// 6. a candle that only wicks beyond the range but closes inside is not a breakout
assert.strictEqual(find(day(614, INSIDE, { over: { 600: { h: 105 }, 610: { l: 95 } } })), null);

// 7. opening range with a missing one-minute bar: reported as incomplete once a candle has closed, nothing before that
{
  const bars = day(600, m => (m >= 585 ? 101 : 100), { skip: [575] });
  const r = find(bars);
  assert(r && r.incomplete === true);
  assert.strictEqual(r.n, 14);
  assert.strictEqual(find(day(590, INSIDE, { skip: [575] })), null);
}

// 8. last allowed candle starts 15:00 (closes min 914); a breakout that only closes at min 929 is ignored
{
  assert(find(day(914, m => (m >= 900 ? 101 : 100))).sig, 'candle closing at min 914 is allowed');
  assert.strictEqual(find(day(930, m => (m >= 915 ? 101 : 100))), null);
}

// 9. degenerate stop distance (breakout close essentially equal to the stop): no signal
assert.strictEqual(find(day(600, m => (m >= 585 ? 100.0 : 100), { over: { 575: { l: 99.99999, h: 100.00001 }, 576: { l: 99.99999, h: 100.00001 } } })), null);

// 10. input order does not matter
{
  const bars = day(630, m => (m >= 615 ? 99 : 100)).reverse();
  const r = find(bars);
  assert(r && r.sig && r.bar.min === 629);
}

// 11. empty / missing input
assert.strictEqual(find([]), null);
assert.strictEqual(find(undefined), null);

console.log('orb15_detect: all checks passed');
