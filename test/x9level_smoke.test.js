/* bt32 X9 level-exit study (study_x9_level.js) test: level-exit variants, occupancy rule, per-day accounting and decision criteria on synthetic data only. No network, no orders. Run: node test/x9level_smoke.test.js */
'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path');
const L = require('../study_x9_level.js');
let pass = 0; const tests = []; const t = (n, f) => tests.push([n, f]);
const T0 = Date.parse('2026-03-02T14:30:00Z'), M = 60000, DAY = '2026-03-02';
const x9Exit = (b, dir) => dir > 0 ? b.c < b.e9 : b.c > b.e9, hooks = over => Object.assign({ x9At: () => null, x9Exit }, over);
const mkBars = over => { const B = []; for (let i = 0; i < 78; i++) B.push(Object.assign({ t: T0 + i * 5 * M, min: 570 + i * 5, day: DAY, o: 100, h: 100, l: 100, c: 100, e9: 99, vwap4: 99, atr: 1 }, over && over[i])); return B; };
const K = 6; // signal candle; entry candle 7

t('E0: first completed close through EMA9 (call: close below e9); put mirrored', () => {
  assert.strictEqual(L.levelHit('E0', mkBars({ 7: { c: 98.9 } }), K, 7, 1, x9Exit), true);
  assert.strictEqual(L.levelHit('E0', mkBars({ 7: { c: 99.1 } }), K, 7, 1, x9Exit), false);
  assert.strictEqual(L.levelHit('E0', mkBars({ 7: { c: 101 } }).map(b => Object.assign({}, b, { e9: 100.5 })), K, 7, -1, x9Exit), true);
});
t('E1: needs two consecutive closes through EMA9, both at or after the entry candle', () => {
  assert.strictEqual(L.levelHit('E1', mkBars({ 7: { c: 98 } }), K, 7, 1, x9Exit), false, 'one close is not enough');
  assert.strictEqual(L.levelHit('E1', mkBars({ 7: { c: 98 }, 8: { c: 98 } }), K, 8, 1, x9Exit), true);
  assert.strictEqual(L.levelHit('E1', mkBars({ 7: { c: 100 }, 8: { c: 98 } }), K, 8, 1, x9Exit), false, 'previous candle closed above the line');
});
t('E2: close beyond EMA9 by at least 0.25 ATR; a shallow poke does not count', () => {
  assert.strictEqual(L.levelHit('E2', mkBars({ 7: { c: 98.9, atr: 1 } }), K, 7, 1, x9Exit), false, '0.1 ATR below');
  assert.strictEqual(L.levelHit('E2', mkBars({ 7: { c: 98.7, atr: 1 } }), K, 7, 1, x9Exit), true, '0.3 ATR below');
  assert.strictEqual(L.levelHit('E2', mkBars({ 7: { c: 99.2, e9: 99.5, atr: 1 } }), K, 7, -1, x9Exit), false);
});
t('E3: level exit ignored on the first two candles after the signal candle, live from the third', () => {
  const B = mkBars({ 7: { c: 98 }, 8: { c: 98 }, 9: { c: 98 } });
  assert.strictEqual(L.levelHit('E3', B, K, 7, 1, x9Exit), false); assert.strictEqual(L.levelHit('E3', B, K, 8, 1, x9Exit), false);
  assert.strictEqual(L.levelHit('E3', B, K, 9, 1, x9Exit), true);
});
t('E4 uses the VWAP line, not EMA9; E5 never triggers', () => {
  const B = mkBars({ 7: { c: 98.5, e9: 98, vwap4: 99 } }); assert.strictEqual(L.levelHit('E0', B, K, 7, 1, x9Exit), false, 'above EMA9'); assert.strictEqual(L.levelHit('E4', B, K, 7, 1, x9Exit), true, 'below VWAP');
  assert.strictEqual(L.levelHit('E5', mkBars({ 7: { c: 50 } }), K, 7, 1, x9Exit), false);
});
t('underlyingExit: level exit time = candle start + 5 min; E5 falls through to the reverse cross or the 15:30 time exit', () => {
  const B = mkBars({ 8: { c: 98 } }), a = L.underlyingExit('E0', B, K, 1, hooks()); assert.strictEqual(a.why, 'level'); assert.strictEqual(a.xt, B[8].t + 300000);
  const e5 = L.underlyingExit('E5', B, K, 1, hooks()); assert.strictEqual(e5.why, 'time'); assert.strictEqual(e5.xt, B[72].t);
  const rev = L.underlyingExit('E5', B, K, 1, hooks({ x9At: (bars, q) => q === 20 ? { dir: -1 } : null })); assert.strictEqual(rev.why, 'reverse'); assert.strictEqual(rev.xt, B[20].t + 300000);
});
t('occupancy: after a profit exit a new signal is tradable for E0 (real occupancy) but blocked for E0L (bt31 rule: occupied until the underlying exit)', () => {
  const B = mkBars({ 40: { c: 98 } }), mkOpt = (from, f) => { const a = []; for (let i = 0; i < 400; i++) a.push({ t: B[from].t + i * M, o: f(i), c: f(i) }); return a; };
  const ob = { s1: mkOpt(7, i => i < 10 ? 2.0 : 4.0), s2: mkOpt(19, () => 2.0) }, sigs = [{ k: 6, dir: 1, s: 's1' }, { k: 18, dir: 1, s: 's2' }];
  const e0 = L.runVariant('E0', 'QQQ', sigs, B, ob, hooks()), e0l = L.runVariant('E0L', 'QQQ', sigs, B, ob, hooks());
  assert.strictEqual(e0.trades.length, 2); assert.strictEqual(e0.trades[0].why, 'target'); assert.strictEqual(e0l.trades.length, 1);
  assert.ok(e0.trades[0].g > 100 && e0.trades[0].pin === 2, 'first trade booked at the +70% target close (4.0 vs 2.0)');
  assert.strictEqual(L.runVariant('E0', 'QQQ', sigs, B, { s2: ob.s2 }, hooks()).skipped.noOption, 1, 'missing option prices are counted, never silent');
});
// rows: [sym, day, split, vid, pin, why, g, pk]
const DAYS = []; for (let i = 0; i < 300; i++) DAYS.push(['2026-d' + String(i).padStart(3, '0'), i < 200 ? 'train' : 'lock']);
const mkRows = f => { const R = []; DAYS.forEach(([d, sp], i) => L.VIDS.forEach(v => { const r = f(v, i, sp); if (r !== null) R.push(['QQQ', d, sp, v, 2, 'level', r, 40]); })); return R; };
t('analyze: +$20 on every day passes all six; <60% of control trades fails c6; identical fails c1; train-only gain fails c1', () => {
  const a = L.analyze(mkRows((v, i, sp) => v === 'E1' ? 40 : v === 'E2' ? (i % 3 === 0 ? 100 : null) : v === 'E4' ? (sp === 'train' ? 40 : 20) : v === 'E5' ? null : 20), { QQQ: DAYS }, { reps: 400 }).QQQ, q = a.variants;
  assert.strictEqual(q.E1.crit.pass, true, JSON.stringify(q.E1.crit)); assert.deepStrictEqual(a.candidates, ['E1']);
  assert.strictEqual(q.E2.crit.c6_n_ge100_each_split_and_ge60pct_of_control, false); assert.strictEqual(q.E2.n, 100);
  assert.strictEqual(q.E3.crit.c1_trade_delta_ge3_train_and_lock, false); assert.strictEqual(q.E4.crit.c1_trade_delta_ge3_train_and_lock, false); assert.strictEqual(q.E5.crit.pass, false);
});
t('analyze: no-trade days count as zero in the per-day average; better-but-negative fails c5', () => {
  const a = L.analyze(mkRows((v, i) => i % 2 === 0 ? (v === 'E1' ? 40 : 20) : null), { QQQ: DAYS }, { reps: 200 }).QQQ.variants;
  assert.strictEqual(a.E0.all.n, 150); assert.strictEqual(a.E0.all.avgTrade01, 18); assert.strictEqual(a.E0.all.avgDay01, 9, '150 trades of $18 over 300 days');
  const neg = L.analyze(mkRows(v => v === 'E1' ? -30 : -50), { QQQ: DAYS }, { reps: 200 }).QQQ.variants.E1; assert.strictEqual(neg.crit.c1_trade_delta_ge3_train_and_lock, true); assert.strictEqual(neg.crit.c5_abs_at_0_03_positive_trade_and_day, false); assert.strictEqual(neg.crit.pass, false);
});
t('analyze: bootstrap is deterministic; verdict has 7 lines per symbol', () => {
  const R = mkRows((v, i) => 10 + (i % 7) * (v === 'E1' ? 3 : 1)), a = L.analyze(R, { QQQ: DAYS }, { reps: 300 }), b = L.analyze(R, { QQQ: DAYS }, { reps: 300 });
  assert.deepStrictEqual(a.QQQ.variants.E1.ci99dayDelta, b.QQQ.variants.E1.ci99dayDelta); assert.strictEqual(L.verdict(a).length, 7);
});
t('source guard: no order endpoint; only require is the bt31 module; kv writes only bt32/bt32p', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'study_x9_level.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/\/v2\/orders|alpacaBuy|alpacaSell|apTrade/.test(src)); assert.deepStrictEqual(src.match(/require\([^)]*\)/g), ["require('./study_x9_exits2.js')"]); assert.ok(/kset\(KEY \+ 'p'/.test(src) && !/kset\('(?!bt32)/.test(src));
});
(async () => { for (const [n, f] of tests) { try { await f(); pass++; console.log('ok   ' + n); } catch (e) { console.error('FAIL ' + n + '\n' + (e && e.stack || e)); process.exitCode = 1; } } console.log(pass + '/' + tests.length + ' passed'); })();
