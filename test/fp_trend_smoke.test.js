'use strict';
/* Synthetic smoke test for study_fp_trend.js. Builds 7 synthetic trading days for one symbol: the first 6 are a
   clean, monotonic DOWNTREND (so by day 7 both trend3 and trend5 read confirmed-down), and day 7 itself contains
   one deliberate reversion-UP signal (dir=+1, betting price snaps back up to the day's open) -- the exact losing
   pattern found live (betting up while the market has been grinding down). Checks:
   - base variant takes the trade (no filter).
   - trend3 and trend5 variants correctly SKIP it (gate blocks an opposing bet).
   - contOnly3/contOnly5 also skip it (any reversion on a trend day is blocked).
   A second synthetic set (day 8, an UPTREND into an UP-reversion bet, i.e. dir agrees with trend) checks that an
   AGREEING reversion is NOT filtered by trend3/trend5 (only contOnly blocks it, since contOnly ignores direction).
   Run: node test/fp_trend_smoke.test.js */
const assert = require('assert');
const studyFpTrend = require('../study_fp_trend.js');

// ET->UTC assuming EST (+5h) -- only valid outside the US DST window (roughly mid-March to early November).
// All synthetic days below use JANUARY dates specifically to stay clear of the 2026-03-08 spring-forward
// boundary (an earlier version of this test used March dates and silently shifted bar minutes/days across
// that boundary, which made the signal day vanish from the study's own day filter entirely).
function barTimeMs(y, m, d, min) { const h = Math.floor(min / 60), mm = min % 60; return Date.UTC(y, m, d, h + 5, mm, 0); }

// Build one flat trading day of 1-minute bars (570..959) at a given overall level, with NO reversion/continuation
// signal shape -- used for the filler days that only establish the trend history.
function flatDay(dayIdx, open, close) {
  const bars = [];
  const n = 390; // 9:30..15:59 inclusive-ish, 390 minutes
  for (let i = 0; i < n; i++) {
    const min = 570 + i;
    const frac = i / (n - 1);
    const c = open + (close - open) * frac;
    bars.push({ t: new Date(barTimeMs(2026, 0, dayIdx, min)).toISOString(), o: c, h: c + 0.02, l: c - 0.02, c, v: 500 });
  }
  return bars;
}

// Day with a deliberate reversion signal. fair = day's open (first bar's open). Builds a displacement candle at
// minute index `k` (0-based from day open) whose close sits `dispPct` away from fair in direction `-sigDir`
// (if sigDir=+1 we want price ABOVE fair with a down-closing candle per study_fp.js's dir=+1 rule: "b.c < fair &&
// b.c > b.o" -- re-derive exactly from study logic below) -- simplified by directly re-using the study's own
// trigger shape: for dir=+1 (call/betting-up) we need bar k: c < fair, c > o (green-ish but still below fair),
// body>prev body, c > prev high, fair-c >= 1.5*stop-distance. For dir=-1 (put/betting-down): c > fair, c < o,
// body>prev body, c < prev low, c-fair >= 1.5*stop-distance.
function buildSignalDay(dayIdx, fair, sigDir) {
  const bars = [];
  const push = (min, o, h, l, c) => bars.push({ t: new Date(barTimeMs(2026, 0, dayIdx, min)).toISOString(), o, h, l, c, v: 500 });
  const F = fair;
  // study_fp_trend.js's reversion trigger (mirrored from study_fp.js/live fpLook) is a two-bar "dip-then-bounce"
  // (or "spike-then-reject") pattern, not a single displacement candle:
  //   dir=+1 (call/betting price bounces UP to fair): prior bar (p=B[0]) is a down bar fully below fair; signal
  //     bar (b=B[1]) is a green reversal candle that closes ABOVE p's high, with a bigger body than p, while
  //     still closing below fair by >=1.5x the stop distance.
  //   dir=-1 (put/betting price falls back DOWN to fair): mirror image, both bars above fair.
  // NOTE: `fair` in the study is first.o -- B[0]'s OPEN -- so B[0] must open exactly at F while still playing the
  // role of the "prior bar" (p) the signal bar reverses against. B[0] is made a FLAT doji (o===c===F) deliberately:
  // the live/study continuation-trade check also keys off B[0] (first.c vs first.o) and, if B[0] had a real body,
  // the first version of this test found its own displacement-sized target getting hit on the very same B[1] bar
  // used for the reversion signal, marking that minute "busy" and silently preventing the reversion loop from
  // ever evaluating k=1. Flat o===c sidesteps that: dirF=0, so no continuation trade is placed at all, and B[0]'s
  // h/l are free to be set purely to satisfy the reversion trigger's p.h/p.l comparisons below.
  if (sigDir > 0) {
    push(570, F, F - 0.010 * F, F - 0.020 * F, F);                         // p: flat doji at fair, low high (F-0.010F) so b can close above it while staying below fair
    push(571, F - 0.012 * F, F - 0.004 * F, F - 0.013 * F, F - 0.005 * F); // b: green (c>o), closes above p.h, still below fair by >=1.5x stop
  } else {
    push(570, F, F + 0.020 * F, F + 0.010 * F, F);                         // p: flat doji at fair, high low (F+0.010F) so b can close below it while staying above fair
    push(571, F + 0.012 * F, F + 0.013 * F, F + 0.004 * F, F + 0.005 * F); // b: red (c<o), closes below p.l, still above fair by >=1.5x stop
  }
  // rest of the day: flat at fair, never hits stop or target, so it exits by time (we don't care about pnl here,
  // only whether the trade is RECORDED/gated -- a 'no option price'/'no exit price' skip is fine, since the stub
  // ap() returns no option bars; we assert against out.skipped's trend-gate keys, not against out.res).
  for (let min = 572; min < 960; min++) push(min, F, F + 0.01, F - 0.01, F);
  return bars;
}

async function run(label, dayBarsList, expectDay7Dir, dayLabel) {
  const days = {};
  dayBarsList.forEach(({ idx, ymd, bars }) => { days[ymd] = bars; });
  const allBars = Object.values(days).flat();
  async function stubAp(path) {
    if (path.indexOf('/stocks/') >= 0) return { bars: allBars };
    if (path.indexOf('/options/bars') >= 0) return { bars: {} }; // no option prices -- trades will be 'skip'ped at pricing, that's fine for this test
    throw new Error('unexpected path ' + path);
  }
  const r = await studyFpTrend(stubAp, async () => {}, { key: 'bt26-test-' + label, syms: ['SPY'], from: dayBarsList[0].ymd, to: '2026-02-01T00:00:00Z', trendThreshPct: 1.0 });
  return r;
}

(async () => {
  // --- Set A: 6 days of clean downtrend (each day ~1.5% lower than the last), then day 7 has a dir=+1 (betting UP) signal.
  // Dates: 2026-01-05 (a Monday) through 2026-01-13, solidly inside EST, nowhere near the 2026-03-08 DST boundary.
  const days = [];
  let level = 500;
  for (let i = 0; i < 6; i++) {
    const nextLevel = level * 0.985; // -1.5%/day
    const dIdx = 5 + i;
    days.push({ idx: dIdx, ymd: '2026-01-' + String(dIdx).padStart(2, '0'), bars: flatDay(dIdx, level, nextLevel) });
    level = nextLevel;
  }
  const day7fair = level;
  days.push({ idx: 12, ymd: '2026-01-12', bars: buildSignalDay(12, day7fair, +1) }); // dir=+1 betting UP during a confirmed downtrend -- the bad pattern
  const rA = await run('A', days);
  assert.ok(rA.skipped['trend3: reversion blocked, opposes confirmed trend'] >= 1, 'expected trend3 to block the up-bet during the downtrend, got skipped=' + JSON.stringify(rA.skipped));
  assert.ok(rA.skipped['trend5: reversion blocked, opposes confirmed trend'] >= 1, 'expected trend5 to block the up-bet during the downtrend, got skipped=' + JSON.stringify(rA.skipped));
  assert.ok(rA.skipped['contOnly3: reversion blocked, confirmed trend day'] >= 1, 'expected contOnly3 to block all reversion on the trend day');
  assert.ok(rA.skipped['contOnly5: reversion blocked, confirmed trend day'] >= 1, 'expected contOnly5 to block all reversion on the trend day');
  // base variant must NOT have this skip reason logged at all (no gating applied) -- it should have attempted the trade
  // (even though option pricing then skips it with 'no option price'/'no exit price', that's a different skip key).
  const baseBlocked = Object.keys(rA.skipped).some(k => k.indexOf('base:') === 0);
  assert.ok(!baseBlocked, 'expected base variant to have no trend-gate skips at all, got ' + JSON.stringify(rA.skipped));
  console.log('ok - set A: a reversion bet opposing a confirmed downtrend is correctly blocked by trend3/trend5/contOnly3/contOnly5, and NOT blocked by base');

  // --- Set B: 6 days of clean uptrend, then day 7 has a dir=+1 (betting UP) signal -- this AGREES with the trend,
  // so trend3/trend5 must NOT block it (only contOnly, which is direction-blind, still blocks it).
  // Dates: 2026-01-19 through 2026-01-27 -- a separate window from Set A so the two runs' histories don't overlap.
  const daysB = [];
  let levelB = 480;
  for (let i = 0; i < 6; i++) {
    const nextLevel = levelB * 1.015; // +1.5%/day
    const dIdx = 19 + i;
    daysB.push({ idx: dIdx, ymd: '2026-01-' + String(dIdx).padStart(2, '0'), bars: flatDay(dIdx, levelB, nextLevel) });
    levelB = nextLevel;
  }
  const day7fairB = levelB;
  daysB.push({ idx: 26, ymd: '2026-01-26', bars: buildSignalDay(26, day7fairB, +1) }); // dir=+1 betting UP during a confirmed UPtrend -- agrees, should not be filtered by trend3/trend5
  const rB = await run('B', daysB);
  const trend3BlockedB = (rB.skipped['trend3: reversion blocked, opposes confirmed trend'] || 0);
  const trend5BlockedB = (rB.skipped['trend5: reversion blocked, opposes confirmed trend'] || 0);
  assert.strictEqual(trend3BlockedB, 0, 'expected trend3 to NOT block an up-bet that agrees with a confirmed uptrend, got ' + trend3BlockedB);
  assert.strictEqual(trend5BlockedB, 0, 'expected trend5 to NOT block an up-bet that agrees with a confirmed uptrend, got ' + trend5BlockedB);
  assert.ok(rB.skipped['contOnly3: reversion blocked, confirmed trend day'] >= 1, 'expected contOnly3 to still block (direction-blind) on the trend day');
  console.log('ok - set B: a reversion bet AGREEING with a confirmed uptrend is correctly left alone by trend3/trend5 (only contOnly blocks it)');

  console.log('\nAll study_fp_trend.js smoke checks passed (synthetic data only -- real results require the server-side run against Alpaca).');
})().catch((e) => { console.error('SMOKE TEST FAILED:', e); process.exit(1); });
