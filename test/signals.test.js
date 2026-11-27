/* Signal board engine (signals.js) test. Behaviour under test: five display-only signals per ticker (VWAP, 30-minute ORB, RSI(14) on 5-minute closes, EMA 9/21, first-half-hour momentum for index ETFs), each +1 / -1 / 0 / null; the row lights buy or sell only when 3 or more signals agree; null signals never count; a stale last bar never lights; and the module can never touch a network, an order or the journal. Synthetic bars, no network. Run: node test/signals.test.js */
'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path');
const { computeSignals, grouped, rsiWilder, ema, macdCross, bollinger, NEED, N_SIG } = require('../signals.js');
let pass = 0; const tests = []; const t = (n, f) => tests.push([n, f]);
const T0 = Date.parse('2026-11-27T14:30:00Z'); // 9:30 ET
/* n one-minute bars from 9:30 ET on `day`; px(i) gives the close of bar i; high/low = close +/- 0.05 */
function mk(day, n, px, o) { o = o || {}; const base = o.base || T0, out = []; for (let i = 0; i < n; i++) { const c = px(i); out.push({ t: base + i * 60000, o: c, h: c + 0.05, l: c - 0.05, c, v: o.v || 1000, day, min: 570 + i }); } return out; }
const sig = (bars, o) => computeSignals(bars, Object.assign({ now: bars[bars.length - 1].t + 90000 }, o)); // 30 s after the last bar closes
const D = '2026-11-27';

t('rsiWilder: a straight rise is 100, a straight fall is 0, a flat series is 50, too few closes is null', () => {
  assert.strictEqual(rsiWilder(Array.from({ length: 30 }, (_, i) => 100 + i), 14), 100); assert.strictEqual(rsiWilder(Array.from({ length: 30 }, (_, i) => 100 - i), 14), 0); assert.strictEqual(rsiWilder(Array(30).fill(100), 14), 50); assert.strictEqual(rsiWilder([1, 2, 3], 14), null);
});
t('ema: a constant series stays constant; recent values weigh more', () => { assert.strictEqual(ema([5, 5, 5, 5], 9), 5); assert.ok(ema([1, 1, 1, 10], 3) > ema([10, 1, 1, 1], 3)); });
t('VWAP: close above the session VWAP = +1, below = -1', () => {
  assert.strictEqual(sig(mk(D, 40, i => 100 + i * 0.1)).sigs.vwap.v, 1); assert.strictEqual(sig(mk(D, 40, i => 100 - i * 0.1)).sigs.vwap.v, -1);
});
t('ORB: null before 10:00 (range forming); after 10:00 a close above the 9:30-10:00 high = +1, below the low = -1, inside = 0', () => {
  assert.strictEqual(sig(mk(D, 20, () => 100)).sigs.orb.v, null);
  assert.strictEqual(sig(mk(D, 35, i => (i < 30 ? 100 : 101))).sigs.orb.v, 1); assert.strictEqual(sig(mk(D, 35, i => (i < 30 ? 100 : 99))).sigs.orb.v, -1); assert.strictEqual(sig(mk(D, 35, () => 100)).sigs.orb.v, 0);
});
t('RSI: null on a short day (needs 15 completed five-minute closes); a long straight rise = overbought -1, a long straight fall = oversold +1', () => {
  assert.strictEqual(sig(mk(D, 40, i => 100 + i)).sigs.rsi.v, null, '40 minutes = 8 five-minute closes');
  assert.strictEqual(sig(mk(D, 120, i => 100 + i * 0.2)).sigs.rsi.v, -1); assert.strictEqual(sig(mk(D, 120, i => 100 - i * 0.2)).sigs.rsi.v, 1);
});
t('EMA 9/21: rising = +1, falling = -1, fewer than 25 bars = null', () => {
  assert.strictEqual(sig(mk(D, 60, i => 100 + i * 0.1)).sigs.ema.v, 1); assert.strictEqual(sig(mk(D, 60, i => 100 - i * 0.1)).sigs.ema.v, -1); assert.strictEqual(sig(mk(D, 20, i => 100 + i)).sigs.ema.v, null);
});
t('first half hour (index ETFs only): prior close to the 10:00 price; null for a non-index symbol, before 10:00, and with no prior day', () => {
  const prev = mk('2026-11-26', 390, () => 100, { base: T0 - 86400000 }), td = mk(D, 40, () => 101), all = prev.concat(td);
  assert.strictEqual(sig(all, { index: true }).sigs.ihh.v, 1); assert.strictEqual(sig(all, { index: false }).sigs.ihh.v, null); assert.ok(/index ETFs only/.test(sig(all, { index: false }).sigs.ihh.why));
  assert.strictEqual(sig(prev.concat(mk(D, 40, () => 99)), { index: true }).sigs.ihh.v, -1);
  assert.strictEqual(sig(prev.concat(mk(D, 20, () => 101)), { index: true }).sigs.ihh.v, null, 'before 10:00'); assert.strictEqual(sig(td, { index: true }).sigs.ihh.v, null, 'no prior day');
});
t('MACD 12/26/9: rising = +1, falling = -1, null with fewer than 35 closes; a flat series has MACD equal to its signal = 0', () => {
  assert.strictEqual(macdCross(Array.from({ length: 60 }, (_, i) => 100 + i * 0.1)).v, 1); assert.strictEqual(macdCross(Array.from({ length: 60 }, (_, i) => 100 - i * 0.1)).v, -1); assert.strictEqual(macdCross(Array(60).fill(100)).v, 0); assert.strictEqual(macdCross(Array(34).fill(100)), null);
  assert.strictEqual(sig(mk(D, 34, i => 100 + i * 0.1)).sigs.macd.v, null); assert.strictEqual(sig(mk(D, 36, i => 100 + i * 0.1)).sigs.macd.v, 1);
});
t('Bollinger (20, 2 sd) on completed 5-minute closes: below the lower band = +1 (oversold), above the upper band = -1, inside = 0, null before 20 closes', () => {
  const flat = Array(19).fill(100), a = bollinger(flat.concat([90])), b = bollinger(flat.concat([110])), c = bollinger(flat.concat([100.0])); assert.deepStrictEqual([a.v, b.v, c.v], [1, -1, 0]); assert.strictEqual(bollinger(Array(19).fill(100)), null);
  assert.strictEqual(sig(mk(D, 60, () => 100)).sigs.bb.v, null, '12 five-minute closes'); assert.strictEqual(sig(mk(D, 130, i => 100 + (i % 10) * 0.01)).sigs.bb.v, 0, 'inside the bands'); assert.ok(/bands/.test(sig(mk(D, 130, i => 100 + (i % 10) * 0.01)).sigs.bb.why));
  const crash = n => sig(mk(D, n, i => (i < 125 ? 100 + (i % 10) * 0.01 : 90))).sigs.bb.v; assert.strictEqual(crash(128), 0, 'the five-minute bucket still forming is not used: the crash is not in the bands yet'); assert.strictEqual(crash(130), 1, 'once that bucket completes the close is below the lower band');
});
t('light rule (7 signals): buy needs 4 or more at +1, sell needs 4 or more at -1; 3 of 7 stays dark; null signals never count', () => {
  assert.deepStrictEqual([NEED, N_SIG], [4, 7]);
  const prev = mk('2026-11-26', 390, () => 100, { base: T0 - 86400000 }), K = ['vwap', 'orb', 'rsi', 'ema', 'ihh', 'macd', 'bb'], vs = x => K.map(k => x.sigs[k].v);
  const r = sig(prev.concat(mk(D, 120, i => 100 + i * 0.1)), { index: true }); assert.deepStrictEqual(vs(r), [1, 1, -1, 1, 1, 1, 0]); assert.deepStrictEqual([r.nBuy, r.nSell, r.nUse, r.state], [5, 1, 7, 'buy']);
  const d = sig(prev.concat(mk(D, 120, i => 100 - i * 0.1)), { index: true }); assert.deepStrictEqual(vs(d), [-1, -1, 1, -1, -1, -1, 0]); assert.deepStrictEqual([d.nBuy, d.nSell, d.state], [1, 5, 'sell']);
  const three = sig(mk(D, 34, i => 100 + i * 0.1)); assert.deepStrictEqual([three.sigs.vwap.v, three.sigs.orb.v, three.sigs.ema.v, three.sigs.macd.v, three.nBuy, three.state], [1, 1, 1, null, 3, 'none'], 'exactly 3 of 7: dark');
  const four = sig(mk(D, 36, i => 100 + i * 0.1)); assert.deepStrictEqual([four.sigs.macd.v, four.nBuy, four.state], [1, 4, 'buy'], 'the 4th signal arrives: lights');
  const early = sig(mk(D, 28, i => 100 + i * 0.1)); assert.deepStrictEqual([early.sigs.vwap.v, early.sigs.ema.v, early.nBuy, early.state], [1, 1, 2, 'none'], 'only 2 signals are up and the rest are null: dark');
  assert.strictEqual(sig(mk(D, 120, () => 100)).state, 'none', 'flat day');
});
t('grouped read: TREND (vwap, orb, ema, macd; 3 of 4) qualified by STRETCH (rsi, bb): buy/sell clean, late when stretched the same way, watch when trend is split but stretched, none otherwise; stale is none', () => {
  const sg = (vwap, orb, ema, macd, rsi, bb) => ({ vwap: { v: vwap }, orb: { v: orb }, ema: { v: ema }, macd: { v: macd }, rsi: { v: rsi }, bb: { v: bb } }), g = (a, stale) => grouped(sg(...a), stale);
  assert.deepStrictEqual([g([1, 1, 1, 1, 0, 0]).status, g([1, 1, 1, 0, 0, 0]).status, g([1, 1, 1, 0, 0, 0]).n, g([1, 1, 0, 0, 0, 0]).status], ['buy', 'buy', 3, 'none'], '3 of 4 sets the trend, 2 of 4 does not');
  assert.deepStrictEqual([g([-1, -1, -1, 0, 0, 0]).status, g([1, 1, 1, 1, -1, 0]).status, g([1, 1, 1, 1, 0, -1]).status, g([-1, -1, -1, -1, 1, 0]).status], ['sell', 'late', 'late', 'late'], 'stretched the same way as the trend = late');
  assert.deepStrictEqual([g([1, 1, 1, 1, 1, 0]).status, g([-1, -1, -1, -1, -1, 0]).status], ['buy', 'sell'], 'stretched AGAINST the trend (oversold in an uptrend) is not late');
  assert.deepStrictEqual([g([1, 0, -1, 0, -1, 0]).status, g([0, 0, 0, 0, 1, 0]).status, g([0, 0, 0, 0, 0, 0]).status, g([1, -1, 1, -1, 0, 0]).dir], ['watch', 'watch', 'none', 0], 'split trend + stretched = watch');
  assert.strictEqual(g([1, 1, 1, 1, 0, 0], true).status, 'none', 'stale never lights'); assert.deepStrictEqual([g([1, 1, 1, 1, -1, 1]).ext, g([0, 0, 0, 0, -1, 0]).ext, g([0, 0, 0, 0, 1, 0]).ext, g([0, 0, 0, 0, 0, 0]).ext], ['both', 'up', 'down', 'none']);
  assert.strictEqual(g([1, 1, null, 1, null, null]).status, 'buy', 'a null signal never counts against the trend, and a null stretch is not stretched');
  const r = sig(mk(D, 36, i => 100 + i * 0.1)); assert.deepStrictEqual([r.grp.status, r.grp.dir, r.grp.n, r.grp.ext], ['buy', 1, 4, 'none'], 'wired into computeSignals: at 36 rising bars vwap, orb, ema and macd are all up; rsi and bb are not available yet');
  assert.strictEqual(computeSignals([], {}).grp.status, 'none');
});
t('stale last bar (older than 5 minutes) never lights and is flagged; no bars or one bar is a dark flagged row', () => {
  const b = mk(D, 120, i => 100 + i * 0.1), s = computeSignals(b, { now: b[b.length - 1].t + 60000 + 6 * 60000 }); assert.deepStrictEqual([s.state, s.stale], ['none', true]);
  assert.strictEqual(computeSignals([], {}).state, 'none'); assert.strictEqual(computeSignals(null, {}).stale, true); assert.strictEqual(computeSignals(mk(D, 1, () => 100), {}).state, 'none');
});
t('source guard: display only, no require, no network or order call, no file or journal write, no env', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'signals.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''); assert.ok(!/require\(/.test(SRC), 'no requires'); assert.ok(!/fetch\(|https?:|place_|alpaca|\brh\(|saveRec|kset|writeFile|process\.env/i.test(SRC));
});

(async () => { for (const [n, f] of tests) { try { await f(); pass++; console.log('ok   ' + n); } catch (e) { console.log('FAIL ' + n + '\n' + (e && e.stack || e)); } } console.log(pass + '/' + tests.length + ' passed'); process.exit(pass === tests.length ? 0 : 1); })();
