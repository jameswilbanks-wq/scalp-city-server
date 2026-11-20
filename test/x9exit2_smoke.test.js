/* bt31 X9 exit study v2 (study_x9_exits2.js) test: premium-exit walk and decision criteria on synthetic data only. No network, no orders. Run: node test/x9exit2_smoke.test.js */
'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path');
const S = require('../study_x9_exits2.js');
let pass = 0; const tests = []; const t = (n, f) => tests.push([n, f]);
const T0 = Date.parse('2026-03-02T15:00:00Z'), M = 60000, PIN = 2.0;
const mk = pcts => pcts.map((p, i) => ({ t: T0 + i * M, o: PIN * (1 + p / 100), c: PIN * (1 + p / 100) })); // % path vs entry premium, one bar per minute (bar 0 = the fill bar)
const W = (pcts, rule, xtMin) => S.walk(mk(pcts), PIN, T0, T0 + (xtMin || pcts.length) * M, 'level', rule);
const ruleOf = id => S.VARS.find(v => v.id === id).rule;

t('variant table matches the spec: 12 ids, controls are the live rules', () => {
  assert.deepStrictEqual(S.VARS.map(v => v.id), ['C0', 'C1', 'C2', 'T1', 'T2', 'T3', 'T4', 'H1', 'H2', 'H3', 'B1', 'B2']);
  assert.deepStrictEqual(ruleOf('C1'), { tp: 70 }); assert.deepStrictEqual(ruleOf('C2'), { trail: { arm: 25, give: 0.5 } });
});
t('C0 never takes profit: a +50% run that fades is only closed at the rule exit time with the base reason', () => {
  const r = W([0, 20, 50, 30, 10, 5, 5, 5], ruleOf('C0')); assert.strictEqual(r.why, 'level'); assert.ok(Math.abs(r.pk - 50) < 1e-9);
});
t('QQQ complaint: +40% run then fade -> C1 (flat +70%) never sells; trail arm +15% (T2) sells on the way down; C2 (arm 25) sells too', () => {
  const path = [0, 15, 30, 40, 35, 25, 18, 10, 5, 5];
  assert.strictEqual(W(path, ruleOf('C1')).why, 'level', 'flat target never reached');
  const a = W(path, ruleOf('T2')); assert.strictEqual(a.why, 'trail'); assert.ok(Math.abs((a.pout / PIN - 1) * 100 - 18) < 1e-9, 'peak 40 -> exits when gain <= 20: first close at 18');
  assert.strictEqual(W(path, ruleOf('C2')).why, 'trail');
});
t('flat target: exits at the first close at or above +70%, price = that close', () => { const r = W([0, 30, 71, 90, 10], ruleOf('C1')); assert.strictEqual(r.why, 'target'); assert.ok(Math.abs(r.pout - PIN * 1.71) < 1e-9); });
t('trail keep fraction: T3 (keep 67%) exits earlier than T4 (keep 35%) on the same path', () => {
  const path = [0, 30, 60, 50, 38, 30, 20, 12, 5, 0];
  const t3 = W(path, ruleOf('T3')), t4 = W(path, ruleOf('T4')); assert.strictEqual(t3.why, 'trail'); assert.strictEqual(t4.why, 'trail'); assert.ok(t3.t < t4.t, 'tighter trail sells sooner');
  assert.ok(t3.pout > t4.pout, 'and at a higher price');
});
t('premium stop first: -30% closes before any target/trail logic; arming only happens on the way up', () => {
  const r = W([0, -10, -31, 80], ruleOf('H1')); assert.strictEqual(r.why, 'premium stop'); assert.ok(Math.abs(r.pout - PIN * 0.69) < 1e-9);
});
t('breakeven lock B1: arms at +30%, then sells when the premium returns to entry; without arming the -30% stop still rules', () => {
  const a = W([0, 20, 35, 20, 5, -1, -5], ruleOf('B1')); assert.strictEqual(a.why, 'lock'); assert.ok(a.pout <= PIN * 1.05 + 1e-9);
  const b = W([0, 20, 29, 10, -5, -20, 4], ruleOf('B1')); assert.strictEqual(b.why, 'level', 'never armed (peak +29%): only the -30% stop applies');
  const c = W([0, 35, 80], ruleOf('B2')); assert.strictEqual(c.why, 'target');
});
t('walk: missing option minutes are skipped and a rule exit never happens at or after the exit time', () => {
  const sparse = mk([0, 10, 20, 80]); sparse.splice(2, 1); assert.strictEqual(S.walk(sparse, PIN, T0, T0 + 3 * M, 'level', ruleOf('C1')).why, 'level');
});
t('controls C0/C1/C2 are identical to bt22\'s inline walk (copied verbatim from study_x9_exits.js) on 500 random paths', () => {
  const bt22 = (arr, pin, tFill, xt, tpPct, trail, why0) => { let peakPct = -Infinity; for (let t = tFill + 60000; t < xt; t += 60000) { let lo = 0, hi = arr.length - 1, a = -1; while (lo <= hi) { const mid = (lo + hi) >> 1; if (arr[mid].t <= t) { a = mid; lo = mid + 1; } else hi = mid - 1; } const v = a >= 0 && t - arr[a].t <= 2 * 60000 ? arr[a].c : null; if (v === null) continue; const pct = (v / pin - 1) * 100; if (pct <= -30) return { pout: v, why: 'premium stop' }; if (tpPct !== null && pct >= tpPct) return { pout: v, why: 'target' }; if (trail) { if (pct > peakPct) peakPct = pct; if (peakPct >= trail.arm && pct <= peakPct * (1 - trail.give)) return { pout: v, why: 'trail' }; } } return { pout: 'END', why: why0 }; };
  let seed = 7; const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  for (let k = 0; k < 500; k++) { let p = 0; const path = [0]; for (let i = 1; i < 40; i++) { p += (rnd() - 0.47) * 18; path.push(p); } const arr = mk(path), xt = T0 + 40 * M;
    [[{}, null, null], [{ tp: 70 }, 70, null], [{ trail: { arm: 25, give: 0.5 } }, null, { arm: 25, give: 0.5 }]].forEach(([rule, tp, tr]) => { const a = S.walk(arr, PIN, T0, xt, 'level', rule), b = bt22(arr, PIN, T0, xt, tp, tr, 'level'); assert.strictEqual(a.why, b.why); if (b.pout !== 'END') assert.strictEqual(a.pout, b.pout); }); }
});
// rows: [sym, day, split, pin, baseWhy, pkPct, g x12]
function rows(n, sym, f) { const R = []; for (let i = 0; i < n; i++) { const g = S.VARS.map(v => f(v.id, i)); R.push([sym, 'd' + sym + i, i < n * 2 / 3 ? 'train' : 'lock', 2, 'level', i % 4 === 0 ? 50 : 10].concat(g)); } return R; }
t('analyze: an identical variant never passes; +$20 better everywhere and profitable at $0.03 passes all five', () => {
  const a = S.analyze(rows(300, 'QQQ', id => id === 'T1' ? 40 : 20), { reps: 300 }), q = a.QQQ.variants;
  assert.strictEqual(a.QQQ.reference, 'C1'); assert.strictEqual(q.C1.crit.pass, false); assert.strictEqual(q.T2.crit.pass, false, 'identical to the reference: delta 0');
  assert.strictEqual(q.T1.delta.all, 20); assert.strictEqual(q.T1.crit.pass, true, JSON.stringify(q.T1.crit)); assert.deepStrictEqual(a.QQQ.candidates, ['T1']);
});
t('analyze: better-but-still-losing fails criterion 4; better only in train fails criterion 1; fewer than 100 per split fails criterion 5', () => {
  const lose = S.analyze(rows(300, 'SPY', id => id === 'T1' ? -30 : -50), { reps: 200 }).SPY.variants.T1; assert.strictEqual(lose.crit.c1_delta_ge3_train_and_lock, true); assert.strictEqual(lose.crit.c4_abs_avg_at_0_03_positive, false); assert.strictEqual(lose.crit.pass, false);
  const half = S.analyze(rows(300, 'QQQ', (id, i) => id === 'T1' ? (i < 200 ? 40 : 20) : 20), { reps: 200 }).QQQ.variants.T1; assert.strictEqual(half.crit.c1_delta_ge3_train_and_lock, false);
  assert.strictEqual(S.analyze(rows(120, 'QQQ', id => id === 'T1' ? 40 : 20), { reps: 100 }).QQQ.variants.T1.crit.c5_n_ge100_train_and_lock, false);
});
t('analyze: the peaked subset counts trades that reached +40%; the SPY reference is the trail C2; bootstrap is deterministic; null exits are excluded pairwise', () => {
  const R = rows(300, 'SPY', (id, i) => id === 'T1' ? (i === 3 ? null : 30) : 10), a = S.analyze(R, { reps: 200 }), b = S.analyze(R, { reps: 200 });
  assert.strictEqual(a.SPY.reference, 'C2'); assert.strictEqual(a.SPY.variants.T1.peaked.n, 75); assert.strictEqual(a.SPY.variants.T1.all.n, 299);
  assert.deepStrictEqual(a.SPY.variants.T1.ci995, b.SPY.variants.T1.ci995); assert.ok(S.verdict(a).length >= 12);
});
t('source guard: no order endpoint, no require(), kv writes only bt31/bt31p', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'study_x9_exits2.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/\/v2\/orders|alpacaBuy|alpacaSell|apTrade|require\(/.test(src)); assert.ok(/kset\(KEY \+ 'p'/.test(src) && !/kset\('(?!bt31)/.test(src));
});
(async () => { for (const [n, f] of tests) { try { await f(); pass++; console.log('ok   ' + n); } catch (e) { console.error('FAIL ' + n + '\n' + (e && e.stack || e)); process.exitCode = 1; } } console.log(pass + '/' + tests.length + ' passed'); })();
