/* bt27 ORB15 exit study (study_orb_exit.js) test: trade simulator, premium-exit scan and statistics on synthetic data only. No network, no orders. Run: node test/orbexit_smoke.test.js */
'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path');
const S = require('../study_orb_exit.js');
let pass = 0; const tests = []; const t = (n, f) => tests.push([n, f]);
const T0 = Date.parse('2026-03-02T14:30:00Z'), M = 60000;
const mkB = over => { const B = []; for (let i = 0; i < 78; i++) B.push(Object.assign({ t: T0 + i * 5 * M, min: 570 + i * 5, o: 100, h: 100.2, l: 99.8, c: 100 }, over && over[i])); return B; };
const P = { dir: 1, k1: 6, e: 100, stop0: 99, R: 1 }; P.tIn = T0 + 6 * 5 * M;
const mkArr = (fn, from, to) => { const a = []; for (let m = from; m < to; m++) { const c = fn(m - from); a.push({ t: T0 + m * M, o: c, c }); } return a; };
const flat = v => () => v;

t('underlying exits mirror bt13: stop, target, breakeven after +0.5R, time at 15:30', () => {
  assert.strictEqual(S.underlying(P, mkB(), 0.5).why, 'time');
  assert.strictEqual(S.underlying(P, mkB({ 8: { l: 98.9 } }), 0.5).why, 'stop');
  assert.strictEqual(S.underlying(P, mkB({ 8: { h: 101.3 } }), 0.5).why, 'target');
  assert.strictEqual(S.underlying(P, mkB({ 8: { h: 100.6 }, 9: { l: 99.9 } }), 0.5).why, 'breakeven'); // +0.6R reached, stop moved to entry (100), next bar trades at 99.9
  assert.strictEqual(S.underlying(P, mkB({ 8: { h: 100.6 }, 9: { l: 99.9 } }), 0).why, 'time'); // without breakeven the same path just keeps going
});
t('scan: -50% premium exit on the first CLOSED bar at or below half the entry premium, price = that close; nothing after the exit time', () => {
  const arr = mkArr(i => i < 10 ? 2.0 : 0.9, 30, 60), ev = S.scan(arr, 0, T0 + 45 * M, 2.0, 'p50');
  assert.strictEqual(ev.why, 'premium'); assert.strictEqual(ev.p, 0.9); assert.strictEqual(ev.t, T0 + 41 * M);
  assert.strictEqual(S.scan(arr, 0, T0 + 40 * M, 2.0, 'p50'), null, 'exit time before the dip closes: no premium exit');
  assert.strictEqual(S.scan(mkArr(i => i < 10 ? 2.0 : 1.2, 30, 60), 0, T0 + 59 * M, 2.0, 'p35').why, 'premium'); // -40% trips the -35% stop but not -50%
  assert.strictEqual(S.scan(mkArr(i => i < 10 ? 2.0 : 1.2, 30, 60), 0, T0 + 59 * M, 2.0, 'p50'), null);
});
t('scan: premium lock arms at +30%/+50% and exits when a later close returns to the entry premium; the -50% stop stays on', () => {
  const up = mkArr(i => i < 5 ? 2.0 : i < 10 ? 2.7 : 1.9, 30, 60);
  const a = S.scan(up, 0, T0 + 59 * M, 2.0, 'l30'); assert.strictEqual(a.why, 'premium lock'); assert.strictEqual(a.p, 1.9);
  assert.strictEqual(S.scan(up, 0, T0 + 59 * M, 2.0, 'l50'), null, '+35% peak never arms the +50% lock, and 1.9 is nowhere near -50%');
  assert.strictEqual(S.scan(mkArr(i => i < 5 ? 2.0 : 0.9, 30, 60), 0, T0 + 59 * M, 2.0, 'l30').why, 'premium');
});
t('scan: X9 trail arms at +25% and exits when the close gives back half the peak gain', () => {
  const arr = mkArr(i => i < 3 ? 2.0 : i < 6 ? 3.0 : 2.4, 30, 60); // peak 3.0 -> give-back line 2.5; 2.4 is below it
  const ev = S.scan(arr, 0, T0 + 59 * M, 2.0, 'tr'); assert.strictEqual(ev.p, 2.4);
  assert.strictEqual(S.scan(mkArr(i => i < 3 ? 2.0 : 2.4, 30, 60), 0, T0 + 59 * M, 2.0, 'tr'), null, '+20% never arms the trail');
});
t('simTrade: flat underlying + option collapsing 50% -> L0 books the premium stop, V1 (no premium stop) books the time-exit price; all six columns present', () => {
  const arr = mkArr(i => i < 10 ? 2.0 : i < 200 ? 0.9 : 1.5, 30, 400); // entry bar (index 6) opens 30 minutes after T0; options trade until after the 15:30 exit (minute 360)
  const r = S.simTrade(P, mkB(), arr); assert.ok(!r.skip, JSON.stringify(r)); assert.strictEqual(r.pin, 2.0); assert.strictEqual(r.rsn, 'premium');
  assert.ok(Math.abs(r.g[0] - (-110)) < 1e-9, 'L0 exits at 0.90'); assert.ok(r.g[1] > r.g[0], 'V1 not stopped by the premium'); assert.strictEqual(r.g.length, 6);
});
t('simTrade: skips are labelled, never silent', () => {
  assert.strictEqual(S.simTrade(P, mkB(), null).skip, 'no option price');
  assert.strictEqual(S.simTrade(Object.assign({}, P, { stop0: 100.5 }), mkB(), mkArr(flat(2), 30, 360)).skip, 'entry already through the stop');
  assert.strictEqual(S.simTrade(P, mkB(), mkArr(flat(0.03), 30, 360)).skip, 'no usable entry price');
});
// rows: [sym, day, entryMin, pct, pin, rsn, gL0, gV1, gV2, gV3, gV4, gV5]
const mkRows = (n, f) => { const rows = []; for (const s of ['SPY', 'QQQ']) for (let i = 0; i < n; i++) { const d = i < n / 2 ? '2025-' + String(1 + i % 12).padStart(2, '0') + '-' + String(1 + i % 27).padStart(2, '0') : '2026-' + String(1 + i % 10).padStart(2, '0') + '-' + String(1 + i % 27).padStart(2, '0'); const r = [s, d, 600, 0.5, 2, 'stop', 0, 0, 0, 0, 0, 0]; const o = f(i, s); Object.keys(o).forEach(k => { r[+k] = o[k]; }); rows.push(r); } return rows; };
const CUTS = { SPY: { p90: 9 }, QQQ: { p90: 9 } };
t('analyze: costs are gross minus 200 x cost; an identical variant has delta 0 and cannot pass', () => {
  const rows = mkRows(240, () => ({ 6: -20, 7: -20, 8: -20, 9: -20, 10: -20, 11: -20 })); const a = S.analyze(rows, CUTS, { reps: 200 });
  assert.strictEqual(a.L0.pooled.avg01, -22); assert.strictEqual(a.L0.pooled.avg03, -26); assert.strictEqual(a.V3.pooled.delta01, 0); assert.strictEqual(a.V3.crit.pass, false); assert.strictEqual(a.V9.selected, null);
});
t('analyze: a variant +$10 better in every cell clears the delta tests but is not a pass while still losing after costs; <100 trades per cell fails criterion 5; V8 drops top-decile range days', () => {
  const rows = mkRows(240, i => ({ 6: -20 + (i % 7), 7: -20 + (i % 7), 8: -20 + (i % 7), 9: -10 + (i % 7), 10: -20 + (i % 7), 11: -20 + (i % 7) })); const a = S.analyze(rows, CUTS, { reps: 300 });
  assert.strictEqual(a.V3.pooled.delta01, 10); assert.ok(a.V3.crit.c1_delta_ge5_all4cells && a.V3.crit.c2_ci_excludes_zero && a.V3.crit.c4_delta_ge5_all4cells_at_03); assert.ok(!a.V3.crit.c3_positive_after_drop_best5); assert.strictEqual(a.V3.crit.pass, false); assert.strictEqual(a.V3.absAvg03Positive, false);
  const big = mkRows(240, () => ({ 6: -20, 9: 30 })); big.forEach((r, i) => { r[3] = i % 10 === 0 ? 5 : 0.4; }); const b = S.analyze(big, { SPY: { p90: 1 }, QQQ: { p90: 1 } }, { reps: 100 });
  assert.strictEqual(b.V8.n, big.length - big.filter(r => r[3] >= 1).length);
  const few = mkRows(60, () => ({ 6: -20, 9: 30 })); assert.strictEqual(S.analyze(few, CUTS, { reps: 50 }).V3.crit.c5_n_ge100_each_cell, false);
});
t('analyze: V9 needs V3 and a V6/V7 filter to pass alone; with them passing it is selected; the bootstrap is deterministic', () => {
  const rows = mkRows(480, i => ({ 6: i % 3 === 0 ? -15 : 140, 9: i % 3 === 0 ? -15 : 160, 7: -20, 8: -20, 10: -20, 11: -20 })); rows.forEach((r, i) => { r[2] = i % 3 === 0 ? 700 : 620; }); // late entries lose, early ones win big
  const a1 = S.analyze(rows, CUTS, { reps: 300 }), a2 = S.analyze(rows, CUTS, { reps: 300 });
  assert.deepStrictEqual(a1.V6.pooled.ci95delta01, a2.V6.pooled.ci95delta01); assert.ok(a1.V6.n < rows.length && a1.V7.n < rows.length);
  assert.strictEqual(a1.V6.crit.pass, true, JSON.stringify(a1.V6.crit)); assert.strictEqual(a1.V3.crit.pass, true, JSON.stringify(a1.V3.crit)); assert.strictEqual(a1.V9.selected !== null, true);
  const lines = S.verdict(a1); assert.strictEqual(lines.length, 12, 'one line per variant: L0, V1-V8, V9a, V9b, V9');
});
t('source guard: the study file has no order endpoint or require(), and writes only kv keys bt27/bt27p', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'study_orb_exit.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/\/v2\/orders|alpacaBuy|alpacaSell|apTrade|require\(/.test(src), 'no orders, no requires'); assert.ok(/kset\(KEY \+ 'p'/.test(src) && /kset\(KEY/.test(src) === true);
});
(async () => { for (const [n, f] of tests) { try { await f(); pass++; console.log('ok   ' + n); } catch (e) { console.error('FAIL ' + n + '\n' + (e && e.stack || e)); process.exitCode = 1; } } console.log(pass + '/' + tests.length + ' passed'); })();
