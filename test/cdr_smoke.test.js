'use strict';
/* Synthetic smoke test for study_cdr.js. Builds one day with a deliberately choppy opening range (passes the
   chop gate) and a clean mid-range signal bar, with synthetic option prices for the condor, and checks the
   study finds exactly one condor trade and prices it sensibly. Also checks a trending day (no chop) is
   correctly gate-blocked and produces zero trades. Run: node test/cdr_smoke.test.js */
const assert = require('assert');
const studyCdr = require('../study_cdr.js');

function barTimeMs(y, m, d, min) { const h = Math.floor(min / 60), mm = min % 60; return Date.UTC(y, m, d, h + 5, mm, 0); } // ET->UTC, EST offset

// --- Day 1 (chop day): SPY, IB window 570-625 oscillates across a midpoint of 500, width ~1.05 (0.2% of 500 -- inside 0.15%-1% band).
// fetchStockBars reads 1-MINUTE bars and aggregates to 5-min internally (fiveMin requires >=5 one-minute bars per bucket),
// so every 5-min bucket below is expanded into 5 synthetic 1-minute bars carrying that bucket's intended open/high/low/close.
const D1 = '2026-03-02';
const stockBars1 = [];
function push1(min, o, h, l, c) { stockBars1.push({ t: new Date(barTimeMs(2026, 2, 2, min)).toISOString(), o, h, l, c, v: 1000 }); }
function expand5(min0, o, h, l, c) {
  push1(min0, o, o, o, o);         // sets the bucket's open
  push1(min0 + 1, o, h, o, o);     // touches the bucket's high
  push1(min0 + 2, o, o, l, o);     // touches the bucket's low
  push1(min0 + 3, o, o, o, o);
  push1(min0 + 4, c, c, c, c);     // sets the bucket's close
}
// 12 buckets, 570..625, oscillate above/below mid=500.075 at least 3 times, with a rejection wick near the top (500.6) and bottom (499.55).
const ibBuckets = [
  [500.0, 500.6, 499.9, 500.6], [500.6, 500.65, 499.6, 499.6], [499.6, 500.55, 499.55, 500.55], [500.55, 500.55, 499.55, 499.55],
  [499.55, 500.5, 499.55, 500.5], [500.5, 500.5, 499.6, 499.6], [499.6, 500.2, 499.6, 500.2], [500.2, 500.2, 499.8, 499.8],
  [499.8, 500.1, 499.8, 500.1], [500.1, 500.1, 499.9, 499.9], [499.9, 500.05, 499.9, 500.05], [500.05, 500.05, 499.95, 499.95],
];
let m1 = 570;
ibBuckets.forEach(([o, h, l, c]) => { expand5(m1, o, h, l, c); m1 += 5; });
// min now 630. Post-open buckets stay flat inside [low,high] (low=499.55, high=500.65, mid=500.1, width=1.1) and settle in the
// middle half (500.1 +/- 0.275 = 499.825..500.375) by the first eligible window bucket (min>=640).
for (let min = 630; min < 640; min += 5) expand5(min, 500.0, 500.1, 499.9, 500.0);
expand5(640, 500.0, 500.05, 499.95, 500.0); // signal bucket: closes at 500.0, inside [499.825,500.375] -- this is the signal
for (let min = 645; min < 960; min += 5) expand5(min, 500.0, 500.05, 499.95, 500.0); // flat rest of day, never breaches

// Synthetic option bars for every strike the study might request near 500 on day D1 (SPY260302...), 5-min bars from entry to close.
// Condor target: short put ~498, long put ~497, short call ~502, long call ~503 (just beyond low/high + padding).
// Keep prices stable (no move) so the trade settles near its entry credit at the close (small positive decay assumed via spread, not modeled -- flat is fine for a smoke check).
function occ(sym, ymd, type, k) { return sym + ymd + type + String(Math.round(k) * 1000).padStart(8, '0'); }
const optStub = {};
function setOpt(sym, price) {
  const bars = [];
  for (let min = 640; min < 960; min += 5) bars.push({ t: new Date(barTimeMs(2026, 2, 2, min)).toISOString(), c: price });
  optStub[sym] = bars;
}
// Strikes 493..497 (puts, candidates below low-padding) and 503..507 (calls, candidates above high-padding).
// padding = max(0.5, width*0.1) = max(0.5, 0.105) = 0.5, so low-padding=499.05, high+padding=501.1 -- candidates start just below/above that.
for (let k = 499; k >= 495; k--) setOpt(occ('SPY', '260302', 'P', k), Math.max(0.05, (k - 495) * 0.3 + 0.3)); // nearest-to-money (499) priciest, furthest OTM (495) cheapest -- correct put skew direction
for (let k = 502; k <= 506; k++) setOpt(occ('SPY', '260302', 'C', k), Math.max(0.05, (506 - k) * 0.3 + 0.3));

async function stubAp1(path, qs) {
  if (path.indexOf('/stocks/') >= 0) return { bars: stockBars1 };
  if (path.indexOf('/options/bars') >= 0) {
    const syms = (qs.symbols || '').split(',');
    const bars = {};
    syms.forEach(s => { if (optStub[s]) bars[s] = optStub[s]; });
    return { bars };
  }
  throw new Error('unexpected path ' + path);
}

// --- Day 2 (trending day): monotonic uptrend through the IB window -- should be gate-blocked (width or cross-count fails).
const D2 = '2026-03-03';
const stockBars2 = [];
function push2(min, o, h, l, c) { stockBars2.push({ t: new Date(barTimeMs(2026, 2, 3, min)).toISOString(), o, h, l, c, v: 1000 }); }
function expand5b(min0, o, h, l, c) { push2(min0, o, o, o, o); push2(min0 + 1, o, h, o, o); push2(min0 + 2, o, o, l, o); push2(min0 + 3, o, o, o, o); push2(min0 + 4, c, c, c, c); }
let m2 = 570;
for (let i = 0; i < 12; i++) { const c = 500 + i * 0.5; expand5b(m2, c - 0.1, c + 0.1, c - 0.15, c); m2 += 5; } // monotonic climb, width~6 -> well over the 1% band, fails the chop gate
for (let min = 630; min < 960; min += 5) expand5b(min, 506, 506.1, 505.9, 506);
async function stubAp2(path, qs) {
  if (path.indexOf('/stocks/') >= 0) return { bars: stockBars2 };
  if (path.indexOf('/options/bars') >= 0) return { bars: {} };
  throw new Error('unexpected path ' + path);
}

(async () => {
  const r1 = await studyCdr(stubAp1, async () => {}, { key: 'bt16-test', syms: ['SPY'], from: '2026-03-02', to: '2026-03-03T00:00:00Z' });
  assert.ok(r1.gate.SPY && r1.gate.SPY['gate-passed (chop confirmed)'] === 1, 'expected the chop day to pass the gate, got ' + JSON.stringify(r1.gate.SPY));
  assert.ok(r1.gate.SPY['condor opened'] === 1, 'expected exactly one condor opened, got ' + JSON.stringify(r1.gate.SPY));
  assert.ok(r1.res['SPY|lock'] && r1.res['SPY|lock'].n === 1, 'expected exactly 1 trade recorded, got ' + JSON.stringify(r1.res));
  console.log('ok - chop day passes the gate and opens exactly one condor, pnl=' + r1.res['SPY|lock'].avg);

  const r2 = await studyCdr(stubAp2, async () => {}, { key: 'bt16-test2', syms: ['SPY'], from: '2026-03-03', to: '2026-03-04T00:00:00Z' });
  assert.ok(!r2.res['SPY|lock'], 'expected the trending day to be gate-blocked with zero trades, got ' + JSON.stringify(r2.res));
  const blocked = Object.keys(r2.gate.SPY || {}).some(k => k.indexOf('gate-blocked') === 0);
  assert.ok(blocked, 'expected a gate-blocked reason logged for the trending day, got ' + JSON.stringify(r2.gate.SPY));
  console.log('ok - trending (non-choppy) day is correctly gate-blocked, reason: ' + Object.keys(r2.gate.SPY)[0]);

  console.log('\nAll study_cdr.js smoke checks passed (synthetic data only -- real results require the server-side run against Alpaca).');
})().catch(e => { console.error('SMOKE TEST FAILED:', e); process.exit(1); });
