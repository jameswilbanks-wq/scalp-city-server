'use strict';
/* Synthetic smoke test for orpb.js + study_orpb.js (bt29, read-only Stage 0). Hand-checkable bars; no network, no kv.
   Run: node test/orpb_smoke.test.js */
const assert = require('assert');
const O = require('../orpb.js');
const study = require('../study_orpb.js');
const H = study.helpers;
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= (tol || 1e-6), (msg || 'near') + ': got ' + a + ' expected ' + b);

// ---- synthetic 1-minute sessions (minutes 570..959) ----
function base() { const m = {}; for (let t = 570; t < 960; t++) m[t] = { min: t, o: 100, h: 100, l: 100, c: 100 }; return m; }
const setBar = (m, t, o, h, l, c) => { m[t] = { min: t, o, h, l, c }; };
const flat = (m, a, b, p) => { for (let t = a; t <= b; t++) m[t] = { min: t, o: p, h: p, l: p, c: p }; };
function opening(m) { // range 9:30-9:59 = [99.5, 100.5]; the 10:00 candle closes at 102 (long trigger); then price sits at 102 so the EMA stays below it
  setBar(m, 585, 100, 100.5, 100, 100); setBar(m, 590, 100, 100, 99.5, 100);
  setBar(m, 609, 100, 102, 100, 102);
  flat(m, 610, 959, 102);
}
// Day A: pullback candle at 11:00 (low 101.4, close 102.0) touches the EMA (~101.85) and closes above it; a second valid pullback at 12:00.
function dayA(tail) {
  const m = base(); opening(m);
  setBar(m, 660, 102, 102, 101.4, 101.6); setBar(m, 661, 101.6, 102.1, 101.5, 102.0);
  setBar(m, 720, 102, 102, 101.4, 101.6); setBar(m, 721, 101.6, 102, 101.5, 102.0);
  if (tail === 'target') setBar(m, 700, 102, 103.3, 102, 102.2);
  if (tail === 'tie') setBar(m, 663, 102, 103.3, 101.3, 102);
  if (tail === 'none') { flat(m, 720, 721, 102); setBar(m, 930, 102.5, 102.5, 102.5, 102.5); } // no stop touch all day, so the 15:30 flat exit is what ends it
  return Object.values(m);
}
// Day B: the first touch candle (11:00) closes BELOW the EMA (touch-only enters, touch-and-hold waits); the 11:02 candle touches and holds.
function dayB() {
  const m = base(); opening(m);
  setBar(m, 660, 102, 102, 101.0, 101.1); setBar(m, 661, 101.1, 101.3, 101.0, 101.2);
  setBar(m, 662, 101.2, 102, 101.1, 101.9); setBar(m, 663, 101.9, 102, 101.9, 102.0);
  return Object.values(m);
}
// Day C: a touch-and-hold candle whose stop distance is only $0.05 (below the $0.10 floor). Built from the EMA the study itself computes.
function dayC() {
  const m = base(); opening(m);
  const pre = Object.values(m).filter(b => b.min < 660);
  const E = O.emaForDay(O.agg(pre, 2).map(c => c.c), WARM, 20).pop(), c = E + 0.05;
  setBar(m, 660, 102, 102, E, c); setBar(m, 661, c, c, c, c);
  return Object.values(m);
}
const WARM = new Array(100).fill(100);
const mirror = bars => bars.map(b => ({ min: b.min, o: 200 - b.o, h: 200 - b.l, l: 200 - b.h, c: 200 - b.c }));
const PRIM = H.CONFIGS[H.PRIMARY];

// ---- 1. aggregation alignment ----
{
  const bars = dayA('target').filter(b => b.min !== 601); // one missing minute inside the 10:00 candle
  const c10 = O.agg(bars, 10), c2 = O.agg(bars, 2), k = c10.find(c => c.s === 600), k2 = c2.find(c => c.s === 600);
  assert.ok(k && k.e === 610 && k.o === 100 && k.c === 102 && k.nb === 9, '10-minute candle 600..609: 9 bars (601 missing), open of first bar, close of last bar');
  assert.deepStrictEqual(c10.slice(0, 4).map(c => c.s), [570, 580, 590, 600], '10-minute candles aligned to 9:30');
  assert.ok(k2 && k2.e === 602 && k2.nb === 1, '2-minute candle 600 exists with its only bar');
  assert.ok(!c2.find(c => c.s === 601) && !c2.find(c => c.s === 603) && c2.find(c => c.s === 602), '2-minute candles start on even offsets from 9:30');
  assert.strictEqual(O.agg(dayA('target'), 2).length, 195, '195 two-minute candles in a 390-minute session');
  assert.strictEqual(O.agg(dayA('target'), 10).length, 39, '39 ten-minute candles');
  console.log('ok - 10-minute and 2-minute aggregation alignment (9:30 anchored, missing minute tolerated)');
}
// ---- 2. EMA vs hand calculation ----
{
  assert.deepStrictEqual(O.emaSeries([10, 11, 12], 3), [10, 10.5, 11.25], 'alpha .5: 10, 10.5, 11.25');
  assert.deepStrictEqual(O.emaForDay([12], [10, 11], 3), [11.25], 'warm-up shapes today value; only today returned');
  assert.deepStrictEqual(O.emaForDay([12], [], 3), [12], 'session-only seed starts at the first close');
  near(O.emaSeries([100, 102], 20)[1], 100 + (2 / 21) * 2, 1e-12, 'EMA20 alpha = 2/21');
  console.log('ok - EMA matches hand calculation (10,11,12 -> 10, 10.5, 11.25; EMA20 alpha 2/21; warm and session-only seeds)');
}
// ---- 3. range and trigger candle ----
{
  const bars = dayA('target'), r = O.rangeOf(bars, 30);
  assert.ok(r.ok && r.hi === 100.5 && r.lo === 99.5 && r.nb === 30, 'range high/low from 9:30-9:59');
  assert.strictEqual(O.rangeOf(bars.filter(b => b.min >= 575), 30).ok, true, '25 of 30 bars is enough');
  assert.strictEqual(O.rangeOf(bars.filter(b => b.min >= 576), 30).ok, false, '24 of 30 bars skips the day');
  const t = O.findTrigger(O.agg(bars, 10), 100.5, 99.5, 600, 870);
  assert.ok(t && t.dir === 1 && t.c.s === 600 && t.c.c === 102, 'long trigger: 10:00 candle closes above the range high, known at 10:10');
  assert.strictEqual(O.findTrigger([{ s: 590, e: 600, c: 101 }, { s: 600, e: 610, c: 100.2 }], 100.5, 99.5, 600, 870), null, 'a candle inside the range window is not a trigger');
  assert.strictEqual(O.findTrigger([{ s: 880, e: 890, c: 101 }], 100.5, 99.5, 600, 870), null, 'no trigger candle starting after 14:30');
  assert.strictEqual(O.findTrigger([{ s: 600, e: 610, c: 99 }], 100.5, 99.5, 600, 870).dir, -1, 'short trigger mirrors the long');
  console.log('ok - range needs 25 of 30 bars; trigger candle starts at/after 10:00, not after 14:30; short mirrors long');
}
// ---- 4. touch-and-hold vs touch-only ----
{
  const dB = O.makeDay(dayB(), WARM);
  const hold = O.runConfig(dB, Object.assign({}, PRIM, { entry: 'hold' })), touch = O.runConfig(dB, Object.assign({}, PRIM, { entry: 'touch' }));
  assert.ok(hold.trade && touch.trade);
  assert.strictEqual(touch.trade.entryMin, 662, 'touch-only enters on the 11:00 candle (closes 11:02)');
  near(touch.trade.entry, 101.2, 1e-9); near(touch.trade.stop, 101.0, 1e-9); near(touch.trade.risk, 0.2, 1e-9);
  assert.strictEqual(hold.trade.entryMin, 664, 'touch-and-hold skips the candle that closed below the EMA and enters on the next');
  near(hold.trade.entry, 102.0, 1e-9); near(hold.trade.stop, 101.1, 1e-9);
  console.log('ok - touch-and-hold waits for a close above the EMA; touch-only enters on the first touch');
}
// ---- 5. stop floor skip ----
{
  const r = O.runConfig(O.makeDay(dayC(), WARM), PRIM);
  assert.strictEqual(r.trade, undefined); assert.strictEqual(r.skip, 'stop below floor'); assert.strictEqual(r.signal, true);
  const r2 = O.runConfig(O.makeDay(dayC(), WARM), Object.assign({}, PRIM, { floor: 0.04 }));
  assert.ok(r2.trade, 'same bars trade when the floor is lowered under the $0.05 stop distance');
  console.log('ok - $0.05 stop distance is skipped under the $0.10 floor (and counted as a signal)');
}
// ---- 6. exits: target, stop before target, time exit, one trade per day, costs in R ----
{
  const hit = O.runConfig(O.makeDay(dayA('target'), WARM), PRIM).trade;
  assert.ok(hit.dir === 1 && hit.entry === 102 && hit.entryMin === 662 && hit.why === 'target' && hit.exitMin === 700, 'first pullback only; target hit at 11:40 (second pullback at 12:00 gives no second trade)');
  near(hit.stop, 101.4, 1e-9); near(hit.risk, 0.6, 1e-9); near(hit.exitPx, 103.2, 1e-9); near(hit.gross, 1.2, 1e-9);
  const m02 = H.metrics([Object.assign({ day: '2026-01-02' }, hit)], 1, 0.02, false), m04 = H.metrics([Object.assign({ day: '2026-01-02' }, hit)], 1, 0.04, false);
  near(m02.avgR, (1.2 - 0.02) / 0.6, 0.001, '$0.02 cost converted to R by the stop distance'); near(m04.avgR, (1.2 - 0.04) / 0.6, 0.001);
  const tie = O.runConfig(O.makeDay(dayA('tie'), WARM), PRIM).trade;
  assert.ok(tie.why === 'stop(tie)' && Math.abs(tie.exitPx - 101.4) < 1e-9, 'a bar touching both stop and target counts as a stop');
  near(H.metrics([Object.assign({ day: 'x' }, tie)], 1, 0.02, false).avgR, (-0.6 - 0.02) / 0.6, 0.001, 'stop = about -1.03R net');
  const none = O.runConfig(O.makeDay(dayA('none'), WARM), Object.assign({}, PRIM, { target: 0 })).trade;
  assert.ok(none.why === 'time' && none.exitMin === 930 && none.exitPx === 102.5, 'no target: flat at the 15:30 open');
  const naive = O.runConfig(O.makeDay(dayA('target'), WARM), Object.assign({}, PRIM, { entry: 'naive' })).trade;
  assert.ok(naive.entry === 102 && naive.entryMin === 610 && naive.stop === 99.5 && naive.risk === 2.5, 'naive baseline: enter at the trigger-candle close, stop at the other side of the range');
  console.log('ok - target, stop-before-target, no-target time exit, naive baseline; costs converted to R (net R at $0.02 and $0.04)');
}
// ---- 7. short side mirrors the long ----
{
  const s = O.runConfig(O.makeDay(mirror(dayA('target')), WARM), PRIM).trade, l = O.runConfig(O.makeDay(dayA('target'), WARM), PRIM).trade;
  assert.ok(s.dir === -1 && Math.abs(s.entry - 98) < 1e-9 && Math.abs(s.stop - 98.6) < 1e-9 && s.why === 'target');
  near(s.gross, l.gross, 1e-9); near(s.risk, l.risk, 1e-9);
  console.log('ok - mirrored session gives the mirrored short trade with equal risk and gross');
}
// ---- 8. warm-up requirement ----
assert.deepStrictEqual(O.runConfig(O.makeDay(dayA('target'), null), PRIM), { skip: 'warmup (fewer than 5 prior sessions)' });
console.log('ok - no trade without 5 prior sessions of EMA warm-up');
// ---- 9. metrics ----
{
  const tr = [{ day: '2026-01-02', entry: 100, risk: 0.5, gross: 1.0, why: 'target' }, { day: '2026-01-05', entry: 100, risk: 0.5, gross: -0.5, why: 'stop' }];
  const m = H.metrics(tr, 4, 0.02, true);
  assert.ok(m.n === 2 && m.winPct === 50 && m.longestLosingStreak === 1);
  near(m.avgR, 0.46, 1e-6); near(m.totalR, 0.92, 1e-6); near(m.avgAllDays, 0.23, 1e-6, 'average over ALL days includes no-trade days'); near(m.pf, 1.96 / 1.04, 0.01);
  near(m.maxDDR, 1.04, 1e-6); near(m.tradesPerDay, 0.5, 1e-6); near(m.stopUsdMed, 0.5, 1e-6); near(m.netUsdPerShare, 0.25 - 0.02, 1e-6); assert.strictEqual(m.dropBest5, null);
  const six = H.metrics(tr.concat(tr, tr), 6, 0.02, true); assert.strictEqual(six.dropBest5.n, 1);
  assert.deepStrictEqual(H.bootCI([1, 1, 1, 1], 200, 29), [1, 1]); assert.deepStrictEqual(H.bootCI([0.5], 200, 29), null);
  assert.deepStrictEqual(H.bootCI([1, -1, 2, -2, 0.5], 500, 29), H.bootCI([1, -1, 2, -2, 0.5], 500, 29), 'seeded bootstrap is reproducible');
  console.log('ok - metrics: net R per trade and per trading day, PF, drawdown, streak, stop distance, drop-best-5, seeded bootstrap');
}
// ---- 10. pass/fail read-out ----
{
  const M = (n, avg, extra) => Object.assign({ n, avgR: avg, stopUsdMed: 0.5, dropBest5: { n: Math.max(n - 5, 0), avgR: avg > 0 ? 0.1 : -0.1 } }, extra);
  const cfg = (dn, da, hn, ha, extra) => ({ dev: { c02: M(dn, da, extra) }, holdout: { c02: M(hn, ha, extra) }, all: { c02: M(dn + hn, (da + ha) / 2, extra) } });
  const good = () => { const r = { SPY: {} }; r.SPY[H.PRIMARY] = cfg(300, 0.1, 50, 0.2); r.SPY.naive_t2 = cfg(300, 0, 50, 0.1); H.NEIGHBORS.forEach(k => { r.SPY[k] = cfg(300, 0.05, 50, 0.1); }); return r; };
  let e = H.evaluate(good()); assert.ok(e.passCriteria1to5BothSymbols && !e.costDominatedFlag && /all six/.test(e.verdict));
  let r = good(); r.SPY[H.PRIMARY] = cfg(300, 0.1, 30, 0.2); e = H.evaluate(r); assert.ok(!e.passCriteria1to5BothSymbols && !e.perSymbol.SPY.c2_holdoutPositiveAndN40, 'holdout n < 40 fails');
  r = good(); r.SPY.sens_ema25 = cfg(300, 0.05, 50, -0.1); e = H.evaluate(r); assert.ok(!e.perSymbol.SPY.c4_noSignFlipNeighbors && e.perSymbol.SPY.c4_flipped[0] === 'sens_ema25', 'sign flip in a neighbor fails');
  r = good(); r.SPY.naive_t2 = cfg(300, 0.2, 50, 0.1); e = H.evaluate(r); assert.ok(!e.perSymbol.SPY.c5_beatsNaiveBothPeriods && !e.passCriteria1to5BothSymbols, 'must beat the naive baseline in dev and holdout');
  r = good(); r.SPY[H.PRIMARY] = cfg(300, 0.1, 50, 0.2, { stopUsdMed: 0.1 }); e = H.evaluate(r); assert.ok(e.passCriteria1to5BothSymbols && e.costDominatedFlag && /cost-dominated/.test(e.verdict), 'median stop under $0.20 flags cost-dominated');
  console.log('ok - read-out: criteria 1-5 pass/fail per symbol, neighbor sign flips, naive baseline, cost-dominated flag');
}
// ---- 11. end-to-end with a stub Alpaca client ----
(async () => {
  const iso = (date, min) => { const [y, mo, d] = date.split('-').map(Number); return new Date(Date.UTC(y, mo - 1, d, Math.floor(min / 60) + 5, min % 60)).toISOString(); }; // February = EST, UTC = ET + 5h
  const sessions = [['2026-02-02', dayA('target')], ['2026-02-03', Object.values(base())], ['2026-02-04', Object.values(base())], ['2026-02-05', Object.values(base())], ['2026-02-06', Object.values(base())],
    ['2026-02-09', dayA('target')], ['2026-02-10', dayB()], ['2026-02-11', dayC()]];
  const all = []; sessions.forEach(([d, bars]) => bars.forEach(b => all.push({ t: iso(d, b.min), o: b.o, h: b.h, l: b.l, c: b.c, v: 100 })));
  let calls = 0; const ap = async () => (++calls === 1 ? { bars: all } : { bars: [] });
  const store = {}, kset = async (k, v) => { store[k] = v; };
  const out = await study(ap, kset, { syms: ['SPY'], gap: 0, split: '2026-02-10', from: '2026-02-01', to: '2026-02-12T00:00:00Z' });
  assert.strictEqual(out.errs, 0, 'no errors: ' + out.lastErr); assert.strictEqual(out.progress, 'done');
  assert.deepStrictEqual(Object.keys(out.res.SPY).length, 20, '20 configs per symbol');
  const R = out.res.SPY;
  assert.ok(out.n.SPY.sessions === 8 && out.n.SPY.devSessions === 6 && out.n.SPY.holdoutSessions === 2, 'sessions split 6 dev / 2 holdout');
  assert.strictEqual(R.hold_t2.skips['warmup (fewer than 5 prior sessions)'], 5, 'first 5 sessions are skipped for EMA warm-up (the breakout on 02-02 does not trade)');
  assert.ok(R.hold_t2.dev.c02.n === 1 && Math.abs(R.hold_t2.dev.c02.avgR - 1.967) < 0.001, 'dev: one trade on 02-09, net R (1.2-0.02)/0.6');
  near(R.hold_t2.dev.c02.avgAllDays, 1.9667 / 6, 0.001, 'dev average over all 6 trading days');
  assert.ok(R.hold_t2.holdout.c02.n === 1 && R.hold_t2.skips['stop below floor'] === 1 && R.hold_t2.signals === 3, 'holdout: 02-10 trades, 02-11 skipped by the stop floor and counted as a signal');
  near(R.hold_t2.holdout.c02.avgR, -0.02 / 0.9, 0.001, 'holdout touch-and-hold trade flat-exits at 15:30: only the cost');
  near(R.touch_t2.holdout.c02.avgR, 1.9, 0.001, 'touch-only enters earlier with a $0.20 stop and hits 2R');
  near(R.naive_t2.dev.c02.avgR, -0.008, 0.001, 'naive baseline: stop at the range other side, flat at 15:30, only cost');
  assert.strictEqual(out.primaryTrades.SPY.length, 2); assert.ok(store.bt29 && store.bt29.done && store.bt29p, 'final result and progress written');
  assert.ok(out.criteria && out.criteria.passCriteria1to5BothSymbols === false && out.criteria.verdict, 'thin synthetic sample cannot pass');
  // error path: the first call fails, the retry succeeds; two failures in a row reject (caller saves the error)
  let n2 = 0; const flaky = async () => { n2++; if (n2 === 1) throw new Error('boom'); return n2 === 2 ? { bars: all } : { bars: [] }; };
  const o2 = await study(flaky, async () => {}, { syms: ['SPY'], gap: 0, split: '2026-02-10', from: '2026-02-01', to: '2026-02-12T00:00:00Z' }); assert.strictEqual(o2.errs, 0);
  await assert.rejects(study(async () => { throw new Error('down'); }, async () => {}, { syms: ['SPY'], gap: 0 }), /down/);
  console.log('ok - end to end with stub client: dev/holdout split, warm-up skip, floor skip, touch vs hold, naive baseline, results saved; one retry then error');
  console.log('\nAll orpb smoke checks passed (synthetic data only; the real run is server-side against Alpaca).');
})().catch(e => { console.error('SMOKE TEST FAILED:', e); process.exit(1); });
