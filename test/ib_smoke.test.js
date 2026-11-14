'use strict';
/* Synthetic smoke test for study_ib.js -- not a replacement for running it on real data (that happens server-side
   against Alpaca), but catches logic bugs in the IB/FA/TC mechanics before deploying. Builds one fake trading day
   with a deliberate Failed-Auction setup and a deliberate Trend-Continuation setup, feeds it through a stub ap()
   shaped like Alpaca's paginated bars response, and checks the study records exactly the trades we built in.
   Run: node test/ib_smoke.test.js */
const assert = require('assert');
const studyIB = require('../study_ib.js');

// Build one ET trading day, 2026-03-02 (a Monday, arbitrary), bars every 5 min from 570 (9:30) to 955 (15:55).
const DAY = '2026-03-02';
function barTimeMs(min) {
  // 2026-03-02 is EST (before spring-forward), UTC = ET + 5h
  const h = Math.floor(min / 60), m = min % 60;
  return Date.UTC(2026, 2, 2, h + 5, m, 0);
}
const bars = [];
function push(min, o, h, l, c, v) { bars.push({ t: new Date(barTimeMs(min)).toISOString(), o, h, l, c, v, vw: (o + c) / 2 }); }

// IB window 570..625 (12 bars): tight range (IBH=501, IBL=499 => IBW=2, 0.4% of price -- inside the 0.20-0.90% band),
// with a smooth, mildly-drifting close so price tracks close to its own AVWAP and the chop filter (4+ crosses) doesn't trip.
let min = 570;
push(min, 500.0, 501.0, 499.0, 500.1, 1000); min += 5; // first bar sets both IB extremes
for (let i = 1; i < 12; i++) {
  const c = 500.1 + i * 0.05; // monotonic drift, 500.15 .. 500.65, well inside [499,501]
  push(min, c - 0.05, c + 0.05, c - 0.1, c, 1000);
  min += 5;
}
// min is now 630 (10:30) -- first bar after IB.

// --- Failed Auction setup: a SHALLOW break above IBH=501 (keeps the stop close), then close back inside near IBH
// (keeps the entry far from IBM so the trade actually clears the R/R>=1.0 bar to IBM), short, target IBM=500.
push(630, 500.95, 501.05, 500.9, 501.02, 1000); // break bar: closes 501.02 > IBH(501) -- the break (shallow)
push(635, 501.0, 501.05, 500.85, 500.9, 1000); // closes back inside IB (500.9 is between 499 and 501) -- the failure; high doesn't exceed 501.05
push(640, 500.9, 500.95, 500.8, 500.9, 1000); // entry bar: entry = open 500.9 (short); doesn't hit stop (501.15ish) or target (500) yet
push(645, 500.9, 500.95, 499.9, 500.0, 1000); // low 499.9 <= target IBM(500) -- target hit
// Pad the rest of the day out to a realistic bar count (study requires >=70 bars/day) with flat, uneventful bars.
for (let m = 650; m < 960; m += 5) push(m, 500.0, 500.05, 499.95, 500.0, 500);

// --- Trend Continuation setup: IB trended up hard (close near top of range), pullback to IBM with AVWAP agreement, continuation.
// We'll reuse the same IB (trendUp requires ibClose-ibOpen >= 0.5*IBW = 1.0; our IB bars oscillate +-0.3 so ibClose-ibOpen is tiny --
// this IB as built will NOT trigger TC. That's fine for a single combined day; we verify TC in a SEPARATE synthetic day below.)

const daysPayload1 = { [DAY]: bars };

// --- Second day dedicated to Trend Continuation, with a clean uptrend IB.
const DAY2 = '2026-03-03';
function barTimeMs2(min) { const h = Math.floor(min / 60), m = min % 60; return Date.UTC(2026, 2, 3, h + 5, m, 0); }
const bars2 = [];
function push2(min, o, h, l, c, v) { bars2.push({ t: new Date(barTimeMs2(min)).toISOString(), o, h, l, c, v, vw: (o + c) / 2 }); }
let min2 = 570;
// IB trends from 500 up to 504 over 12 bars -> IBW=4, ibOpen=500, ibClose=504, diff=4 >= 0.5*4=2 -> trendUp. IBM=502.
for (let i = 0; i < 12; i++) {
  const o = 500 + i * (4 / 12), c = 500 + (i + 1) * (4 / 12);
  push2(min2, o, c + 0.1, o - 0.1, c, 1000);
  min2 += 5;
}
// min2 = 630. Price pulls back to IBM=502 zone (zone = 0.10*4 = 0.4, so zone is [501.6,502.4]), AVWAP should also be near there,
// then closes back up out of the zone (continuation), entry next bar open, target IBH=504.
push2(630, 503.0, 503.2, 501.8, 502.0, 1000); // touches zone (l=501.8 <= 502.4, h=503.2>=501.6), but closes INSIDE zone (502.0) -- not a trigger yet
push2(635, 502.0, 502.8, 501.9, 502.6, 1000); // touches zone again, closes 502.6 > 502.4 -- OUT of zone upward -- trigger (entry = next bar open)
push2(640, 502.6, 502.7, 502.5, 502.6, 1000); // entry bar, entry px = 502.6, stop = touch-bar low (501.9) minus tiny buffer
push2(645, 502.6, 504.2, 502.5, 504.0, 1000); // rallies to target IBH=504 -- high 504.2 >= 504 -> target hit
// Pad the rest of the day out to a realistic bar count (study requires >=70 bars/day) with flat, uneventful bars.
for (let m = 650; m < 960; m += 5) push2(m, 504.0, 504.05, 503.95, 504.0, 500);

const daysPayload2 = { [DAY2]: bars2 };

function stubAp(label, payloadByDay) {
  let called = 0;
  return async function ap(path, qs) {
    called++;
    if (called > 1) return { bars: [] }; // one page only
    const allBars = Object.values(payloadByDay).flat();
    return { bars: allBars };
  };
}

(async () => {
  // Run FA check on day 1 only.
  let r1 = await studyIB(stubAp('d1', daysPayload1), async () => {}, { key: 'bt24-test', syms: ['SPY'], from: '2026-03-02', to: '2026-03-03T00:00:00Z' });
  assert.ok(r1.res['SPY|FA|dev'], 'expected an FA|dev trade bucket');
  assert.strictEqual(r1.res['SPY|FA|dev'].n, 1, 'expected exactly 1 FA trade on the synthetic FA day');
  assert.ok(r1.res['SPY|FA|dev'].avgR > 0, 'the synthetic FA trade was built to hit its target, so avgR should be positive, got ' + r1.res['SPY|FA|dev'].avgR);
  console.log('ok - Failed Auction setup fires once and resolves profitably on synthetic data, avgR=' + r1.res['SPY|FA|dev'].avgR);

  // Run TC check on day 2 only.
  let r2 = await studyIB(stubAp('d2', daysPayload2), async () => {}, { key: 'bt24-test', syms: ['SPY'], from: '2026-03-03', to: '2026-03-04T00:00:00Z' });
  assert.ok(r2.res['SPY|TC|dev'], 'expected a TC|dev trade bucket');
  assert.strictEqual(r2.res['SPY|TC|dev'].n, 1, 'expected exactly 1 TC trade on the synthetic TC day');
  assert.ok(r2.res['SPY|TC|dev'].avgR > 0, 'the synthetic TC trade was built to hit its target, so avgR should be positive, got ' + r2.res['SPY|TC|dev'].avgR);
  console.log('ok - Trend Continuation setup fires once and resolves profitably on synthetic data, avgR=' + r2.res['SPY|TC|dev'].avgR);

  // Sanity: neither day should accidentally also fire the other setup given how we built them.
  assert.ok(!r1.res['SPY|TC|dev'], 'day 1 was not built with a TC setup, should not have fired one');
  assert.ok(!r2.res['SPY|FA|dev'], 'day 2 was not built with an FA setup, should not have fired one');
  console.log('ok - no cross-contamination between setups');

  console.log('\nAll study_ib.js smoke checks passed (synthetic data only -- real results require the server-side run against Alpaca).');
})().catch((e) => { console.error('SMOKE TEST FAILED:', e); process.exit(1); });
