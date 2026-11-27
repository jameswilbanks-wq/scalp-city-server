/* Signal board engine (signals.js) test. Behaviour under test: five display-only signals per ticker (VWAP, 30-minute ORB, RSI(14) on 5-minute closes, EMA 9/21, first-half-hour momentum for index ETFs), each +1 / -1 / 0 / null; the row lights buy or sell only when 3 or more signals agree; null signals never count; a stale last bar never lights; and the module can never touch a network, an order or the journal. Synthetic bars, no network. Run: node test/signals.test.js */
'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path');
const { computeSignals, rsiWilder, ema, NEED } = require('../signals.js');
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
t('light rule: buy needs 3 or more signals at +1, sell needs 3 or more at -1; 2 of 5 stays dark; null signals never count', () => {
  assert.strictEqual(NEED, 3);
  const prev = mk('2026-11-26', 390, () => 100, { base: T0 - 86400000 });
  const r = sig(prev.concat(mk(D, 120, i => 100 + i * 0.1)), { index: true }); assert.deepStrictEqual([r.sigs.vwap.v, r.sigs.orb.v, r.sigs.rsi.v, r.sigs.ema.v, r.sigs.ihh.v], [1, 1, -1, 1, 1]); assert.deepStrictEqual([r.nBuy, r.nSell, r.state], [4, 1, 'buy']);
  const d = sig(prev.concat(mk(D, 120, i => 100 - i * 0.1)), { index: true }); assert.deepStrictEqual([d.sigs.vwap.v, d.sigs.orb.v, d.sigs.rsi.v, d.sigs.ema.v, d.sigs.ihh.v], [-1, -1, 1, -1, -1]); assert.deepStrictEqual([d.nBuy, d.nSell, d.state], [1, 4, 'sell']);
  const early = sig(mk(D, 28, i => 100 + i * 0.1)); assert.deepStrictEqual([early.sigs.vwap.v, early.sigs.ema.v, early.nBuy, early.state], [1, 1, 2, 'none'], 'only 2 signals are up and the rest are null: dark');
  assert.strictEqual(sig(mk(D, 120, () => 100)).state, 'none', 'flat day');
});
t('stale last bar (older than 5 minutes) never lights and is flagged; no bars or one bar is a dark flagged row', () => {
  const b = mk(D, 120, i => 100 + i * 0.1), s = computeSignals(b, { now: b[b.length - 1].t + 60000 + 6 * 60000 }); assert.deepStrictEqual([s.state, s.stale], ['none', true]);
  assert.strictEqual(computeSignals([], {}).state, 'none'); assert.strictEqual(computeSignals(null, {}).stale, true); assert.strictEqual(computeSignals(mk(D, 1, () => 100), {}).state, 'none');
});
t('source guard: display only, no require, no network or order call, no file or journal write, no env', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'signals.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''); assert.ok(!/require\(/.test(SRC), 'no requires'); assert.ok(!/fetch\(|https?:|place_|alpaca|\brh\(|saveRec|kset|writeFile|process\.env/i.test(SRC));
});

(async () => { for (const [n, f] of tests) { try { await f(); pass++; console.log('ok   ' + n); } catch (e) { console.log('FAIL ' + n + '\n' + (e && e.stack || e)); } } console.log(pass + '/' + tests.length + ' passed'); process.exit(pass === tests.length ? 0 : 1); })();
