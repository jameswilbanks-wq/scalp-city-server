/* bt33 CSK multi-day study (study_csk_multiday.js) test: spread exit logic, costs, decision criteria, control gate. Synthetic data only. No network, no orders. Run: node test/cskmd_smoke.test.js */
'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path');
const S = require('../study_csk_multiday.js');
let pass = 0; const tests = []; const t = (n, f) => tests.push([n, f]);
const HALF = 30 * 60000, T0 = Date.parse('2026-03-02T16:00:00Z');
const vals = vs => vs.map((v, i) => ({ end: T0 + (i + 1) * HALF, v })); // one same-bar 30-minute read per half hour, values in $ of spread
const ev = (o) => S.evalSpread(Object.assign({ credit: 0.5, ks: 100, closeE: 99, vals: vals([]), tD: null, vD: null, dte: 0 }, o));

t('hold gross matches bt9: (credit - settle) x 100, settle capped at the $2 width, zero when out of the money', () => {
  assert.strictEqual(ev({ closeE: 99 }).holdG, 50); assert.strictEqual(ev({ closeE: 100 }).holdG, 50);
  assert.ok(Math.abs(ev({ closeE: 100.8 }).holdG - (0.5 - 0.8) * 100) < 1e-9); assert.ok(Math.abs(ev({ closeE: 105 }).holdG - (0.5 - 2) * 100) < 1e-9);
});
t('S: buy back only on TWO consecutive reads at or above 3x credit; fills at that read\'s value; a single spike is ignored', () => {
  const one = ev({ vals: vals([0.4, 1.6, 0.4, 0.4]), closeE: 99 }); assert.strictEqual(one.sF, 0); assert.strictEqual(one.sG, one.holdG);
  const two = ev({ vals: vals([0.4, 1.5, 1.7, 0.4]), closeE: 99 }); assert.strictEqual(two.sF, 1); assert.ok(Math.abs(two.sG - (0.5 - 1.7) * 100) < 1e-9, 'filled at the second read, value 1.7');
  assert.strictEqual(ev({ vals: vals([1.49, 1.49, 1.49]), credit: 0.5 }).sF, 0, 'just under 3x');
});
t('D: closes at the session-before-expiry value; missing value gives null (skipped, not guessed); not used for dte 0', () => {
  const a = ev({ dte: 2, vD: 0.2, tD: T0 + 5 * HALF }); assert.ok(Math.abs(a.dG - (0.5 - 0.2) * 100) < 1e-9);
  const b = ev({ dte: 2, vD: null, tD: T0 + 5 * HALF }); assert.strictEqual(b.dG, null); assert.strictEqual(b.sdG, null);
  const c = ev({ dte: 0, vD: 0.2 }); assert.strictEqual(c.dG, null); assert.strictEqual(c.sdG, null);
});
t('SD: a stop before the D time wins; a stop after the D time is ignored by SD (but S still fires)', () => {
  const before = ev({ dte: 2, vals: vals([1.6, 1.6, 0.1, 0.1]), vD: 0.1, tD: T0 + 4 * HALF }); assert.strictEqual(before.sdF, 1); assert.ok(Math.abs(before.sdG - (0.5 - 1.6) * 100) < 1e-9);
  const after = ev({ dte: 2, vals: vals([0.1, 0.1, 0.1, 1.6, 1.6]), vD: 0.1, tD: T0 + 3 * HALF }); assert.strictEqual(after.sdF, 0); assert.ok(Math.abs(after.sdG - (0.5 - 0.1) * 100) < 1e-9); assert.strictEqual(after.sF, 1);
});
// rows: [sym, day, split, dte, pctIdx, credit, holdG, sG, sF, dG, sdG, sdF]
const DAYS = []; const dd = i => new Date(Date.UTC(2025, 0, 1) + i * 864e5).toISOString().slice(0, 10); for (let i = 0; i < 250; i++) DAYS.push([dd(i), 'T']); for (let i = 0; i < 150; i++) DAYS.push([new Date(Date.UTC(2026, 0, 2) + i * 864e5).toISOString().slice(0, 10), 'L']);
const mk = (sym, dte, pi, g) => DAYS.map(([d, sp], i) => { const x = typeof g === 'function' ? g(i, sp) : g; return x === null ? null : [sym, d, sp, dte, pi, 0.5, x, x, 0, x, x, 0]; }).filter(Boolean);
const run = (rows, o) => S.analyze(rows, { SPY: DAYS }, Object.assign({ reps: 300 }, o));
t('costs: hold pays 2 fills (gross - 2 at $0.01, - 6 at $0.03); a fired stop pays 4 fills; an unfired stop pays 2', () => {
  const a = run(mk('SPY', 1, 1, 20)).res.SPY.cells['1|1|H'], one = (sF) => S.analyze([['SPY', DAYS[0][0], 'T', 1, 1, 0.5, 20, 10, sF, 5, 5, 0]], { SPY: DAYS }, { reps: 50 }).res.SPY.cells['1|1|S'];
  assert.strictEqual(a.avg01, 18); assert.strictEqual(a.avg03, 14); assert.strictEqual(one(1).avg01, 6, 'fired stop: 10 - 100 x 0.01 x 4'); assert.strictEqual(one(0).avg01, 8, 'not fired: 10 - 2');
});
t('criteria: all six pass with a positive neighbour; a lone cell fails the plateau; train-only gain fails c1; n<100 in a split fails c4; avg01>=3 but avg03<=0 fails c2', () => {
  const good = run(mk('SPY', 1, 1, 20).concat(mk('SPY', 1, 0, 10))).res.SPY; assert.ok(good.cells['1|1|H'].crit.pass, JSON.stringify(good.cells['1|1|H'].crit)); assert.ok(good.candidates.includes('1|1|H'));
  const lone = run(mk('SPY', 1, 1, 20)).res.SPY.cells['1|1|H']; assert.strictEqual(lone.crit.c6_plateau_neighbour_positive, false); assert.strictEqual(lone.crit.pass, false);
  const half = run(mk('SPY', 1, 1, (i, sp) => sp === 'T' ? 20 : 1).concat(mk('SPY', 1, 0, 10))).res.SPY.cells['1|1|H']; assert.strictEqual(half.crit.c1_avg01_ge3_train_and_lock, false);
  const few = run(mk('SPY', 1, 1, (i, sp) => (sp === 'L' && i % 3 ? null : 20)).concat(mk('SPY', 1, 0, 10))).res.SPY.cells['1|1|H']; assert.strictEqual(few.crit.c4_n_ge100_train_and_lock, false);
  const thin = run(mk('SPY', 1, 1, 5.5).concat(mk('SPY', 1, 0, 10))).res.SPY.cells['1|1|H']; assert.strictEqual(thin.crit.c1_avg01_ge3_train_and_lock, true); assert.strictEqual(thin.crit.c2_avg03_positive, false); assert.strictEqual(thin.crit.pass, false);
});
t('no-trade sessions count as zero in the lock per-session average (c5)', () => {
  const c = run(mk('SPY', 1, 1, (i) => (i % 2 ? null : 20)).concat(mk('SPY', 1, 0, 10))).res.SPY.cells['1|1|H']; assert.strictEqual(c.L.avg01, 18); assert.ok(c.L.avgDay01 > 8 && c.L.avgDay01 < 10, 'about half the lock sessions had a spread: ' + c.L.avgDay01);
});
t('control gate: dte0 0.45% H reproduces bt9 within 2% n and $0.50, else NOT reproduced; sessions after 2026-11-10 are excluded', () => {
  const rows = mk('SPY', 0, 0, 12), n = (sp) => rows.filter(r => r[2] === sp).length, b9 = ok => ({ res: { 'A|SPY|hold|train': { n: n('T'), avg: 10 }, 'A|SPY|hold|lock': { n: n('L') + (ok ? 1 : 30), avg: ok ? 10.3 : 10 } } });
  assert.strictEqual(run(rows, { b9: b9(true) }).control.ok, true); assert.strictEqual(run(rows, { b9: b9(false) }).control.ok, false);
  const late = rows.concat([['SPY', '2026-11-18', 'L', 0, 0, 0.5, 999, 999, 0, null, null, 0]]); assert.strictEqual(run(late, { b9: b9(true) }).control.cells['SPY|lock'].bt33.n, n('L'));
  assert.strictEqual(run(rows).control.ok, null);
});
t('bootstrap deterministic; verdict starts with the control line and lists candidates', () => {
  const R = mk('SPY', 1, 1, 20).concat(mk('SPY', 1, 0, 10)), a = run(R), b = run(R); assert.deepStrictEqual(a.res.SPY.cells['1|1|H'].ci99, b.res.SPY.cells['1|1|H'].ci99); assert.ok(a.res.SPY.cells['1|1|H'].ci99[0] > 0);
  const v = S.verdict(a); assert.ok(/^control vs bt9/.test(v[0])); assert.ok(v.some(l => /candidates/.test(l)));
});
t('source guard: no order endpoint, no require(), kv writes only bt33/bt33p', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'study_csk_multiday.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/\/v2\/orders|alpacaBuy|alpacaSell|apTrade|require\(/.test(src)); assert.ok(/kset\(KEY \+ 'p'/.test(src) && !/kset\('(?!bt33)/.test(src));
});
(async () => { for (const [n, f] of tests) { try { await f(); pass++; console.log('ok   ' + n); } catch (e) { console.error('FAIL ' + n + '\n' + (e && e.stack || e)); process.exitCode = 1; } } console.log(pass + '/' + tests.length + ' passed'); })();
