/* bt34 daily-direction Stage 0 (study_dir.js) test: indicator votes, no lookahead, skip rules, metrics, pass criteria, source guard. Synthetic data only. No network, no orders. No existing test for this module (orpb_smoke covers a different study). Run: node test/dir_smoke.test.js */
'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path');
const H = require('../study_dir.js').helpers;
let pass = 0; const tests = []; const t = (n, f) => tests.push([n, f]);
// one session of minute bars 570..959; px(min) gives the close, bars are flat-ish around it
const day = (px, o) => { o = o || {}; const a = []; for (let m = o.start || 570; m < 960; m++) { const c = px(m); a.push({ min: m, o: o.open !== undefined && m === 570 ? o.open : c, h: c + 0.05, l: c - 0.05, c, v: o.vol === undefined ? 100 : o.vol }); } return a; };
const flat = (c) => () => c, closes = (n, v) => Array.from({ length: n }, () => v);
const hist = (o) => Object.assign({ closes: closes(22, 100), c5: [] }, o || {});
const coin = () => 0.7;
const V = (bars, h) => H.voteDay(bars, h || hist(), coin);

t('gap: follow and fade vote opposite signs at >=0.10%; below the threshold is no vote', () => {
  const up = V(day(flat(101), { open: 101 })).votes; assert.strictEqual(up.GAPF, 1); assert.strictEqual(up.GAPR, -1);
  const dn = V(day(flat(99), { open: 99 })).votes; assert.strictEqual(dn.GAPF, -1); assert.strictEqual(dn.GAPR, 1);
  const small = V(day(flat(100.05), { open: 100.05 })).votes; assert.strictEqual(small.GAPF, 0); assert.strictEqual(small.GAPR, 0);
});
t('ORB30: close above the 9:30-10:00 high is +1, below the low is -1, inside is 0', () => {
  const up = V(day(m => (m < 600 ? 100 : 101))).votes.ORB30, dn = V(day(m => (m < 600 ? 100 : 99))).votes.ORB30, ins = V(day(flat(100))).votes.ORB30; assert.strictEqual(up, 1); assert.strictEqual(dn, -1); assert.strictEqual(ins, 0);
});
t('MOM: entry vs open at 0.10% threshold', () => { assert.strictEqual(V(day(flat(100.2), { open: 100 })).votes.MOM, 1); assert.strictEqual(V(day(flat(99.8), { open: 100 })).votes.MOM, -1); assert.strictEqual(V(day(flat(100.05), { open: 100 })).votes.MOM, 0); });
t('VWAP: above/below session VWAP at the 0.02% threshold; zero volume gives no vote', () => {
  const up = V(day(m => (m < 620 ? 100 : 100.5))).votes.VWAP; assert.strictEqual(up, 1); const dn = V(day(m => (m < 620 ? 100 : 99.5))).votes.VWAP; assert.strictEqual(dn, -1);
  assert.strictEqual(V(day(flat(100), {})).votes.VWAP, 0); assert.strictEqual(V(day(m => (m < 620 ? 100 : 100.5), { vol: 0 })).votes.VWAP, 0);
});
t('TREND: prior close above/below its 20-day average', () => {
  const rising = Array.from({ length: 22 }, (_, i) => 90 + i), falling = Array.from({ length: 22 }, (_, i) => 110 - i);
  assert.strictEqual(V(day(flat(100)), hist({ closes: rising })).votes.TREND, 1); assert.strictEqual(V(day(flat(100)), hist({ closes: falling })).votes.TREND, -1);
});
t('prior-day follow/fade and RSI2 extremes (daily)', () => {
  const up = closes(21, 100).concat([102]), v = V(day(flat(100)), hist({ closes: up })).votes; assert.strictEqual(v.PDF, 1); assert.strictEqual(v.PDR, -1);
  const os = closes(20, 100).concat([98, 96]); assert.strictEqual(V(day(flat(96)), hist({ closes: os })).votes.RSI2, 1); const ob = closes(20, 100).concat([102, 104]); assert.strictEqual(V(day(flat(104)), hist({ closes: ob })).votes.RSI2, -1); assert.strictEqual(V(day(flat(100)), hist()).votes.RSI2, 0);
  assert.strictEqual(H.rsi2([1, 2]), null); assert.strictEqual(H.rsi2([5, 5, 5]), 50);
});
t('EMA: 5-minute EMA9 over EMA20 with history; fewer than 20 5-minute closes gives no vote', () => {
  const rise = Array.from({ length: 30 }, (_, i) => 90 + i * 0.3), v = V(day(m => 99 + (m - 570) * 0.01), hist({ c5: rise })).votes.EMA; assert.strictEqual(v, 1);
  const fall = Array.from({ length: 30 }, (_, i) => 110 - i * 0.3); assert.strictEqual(V(day(m => 101 - (m - 570) * 0.01), hist({ c5: fall })).votes.EMA, -1); assert.strictEqual(V(day(flat(100)), hist({ c5: [] })).votes.EMA, 0);
});
t('composites: C1 sums five votes, C2 four; ties are no trade; baselines B0 always +1, B1 uses the coin', () => {
  const v = V(day(m => (m < 600 ? 100 : 101), { open: 100 }), hist({ closes: Array.from({ length: 22 }, (_, i) => 90 + i), c5: Array.from({ length: 30 }, (_, i) => 90 + i * 0.3) })).votes; assert.strictEqual(v.ORB30, 1); assert.strictEqual(v.MOM, 1); assert.strictEqual(v.TREND, 1); assert.strictEqual(v.C1, 1); assert.strictEqual(v.C2, 1); assert.strictEqual(v.B0, 1); assert.strictEqual(v.B1, -1);
  assert.strictEqual(H.voteDay(day(flat(100)), hist(), () => 0.1).votes.B1, 1);
});
t('entry and exit prices: entry = close before 10:30, exit = last close at or before 15:44; move and dollar move agree', () => {
  const r = V(day(m => (m < 630 ? 100 : m <= 944 ? 100 + (m - 629) * 0.01 : 500))); assert.strictEqual(r.E, 100); assert.ok(Math.abs(r.X - (100 + (944 - 629) * 0.01)) < 1e-9); assert.ok(Math.abs(r.moveD - (r.X - r.E)) < 1e-9); assert.ok(Math.abs(r.move - (r.X / r.E - 1)) < 1e-12);
});
t('no lookahead: changing any price after 10:30 (other than the exit bar) cannot change any vote', () => {
  const a = V(day(m => (m < 600 ? 100 : 101))), b = V(day(m => (m < 600 ? 100 : m < 630 ? 101 : m === 944 ? 101 : 50))); assert.deepStrictEqual(a.votes, b.votes);
});
t('skips: late open, warm-up, thin morning, no late bar; each is counted by reason, never silent', () => {
  assert.ok(/late open/.test(V(day(flat(100), { start: 580 })).skip)); assert.ok(/warm-up/.test(V(day(flat(100)), hist({ closes: closes(10, 100) })).skip));
  assert.ok(/thin morning/.test(V(day(flat(100)).filter(b => b.min < 570 + 30 || b.min >= 630)).skip)); assert.ok(/no bar/.test(V(day(flat(100)).filter(b => b.min < 930)).skip));
});
t('metrics: hit rate, mean bps, per-session average, edge vs fair premium per contract', () => {
  const days = [{ day: '2025-01-02', move: 0.01, moveD: 1, votes: { X: 1 } }, { day: '2025-01-03', move: -0.01, moveD: -1, votes: { X: 1 } }, { day: '2025-01-06', move: 0.02, moveD: 2, votes: { X: -1 } }, { day: '2025-01-07', move: 0.01, moveD: 1, votes: { X: 0 } }];
  const m = H.metrics(days, 'X', () => true, 4, false, 1); assert.strictEqual(m.n, 3); assert.strictEqual(m.hit, 0.3333); assert.strictEqual(m.meanBps, -66.67, 'mean of +100, -100, -200 bps'); assert.strictEqual(m.perSessionBps, -50);
  assert.strictEqual(m.edgeVsFairPerContract, Math.round(100 * ((1 + 0 + 0) / 3 - (1 + 1 + 2) / 3 / 2) * 100) / 100, 'payoff (1+0+0)/3 minus half the mean absolute move (4/3/2), per contract');
});
const rowsFor = (n, f) => Array.from({ length: n }, (_, i) => { const d = new Date(Date.UTC(2025, 0, 2) + i * 864e5 * 1.6).toISOString().slice(0, 10), mv = f(i), v = {}; H.VARIANTS.forEach(k => { v[k] = 0; }); v.B0 = 1; v.B1 = i % 3 ? 1 : -1; return { day: d, move: mv, moveD: mv * 500, votes: v }; });
t('criteria: a perfect predictor passes all six and is robust on both symbols; one symbol only is weak; a coin baseline is not judged', () => {
  const mk = (good) => rowsFor(400, i => (i % 2 ? 0.004 : -0.003)).map((r, i) => { r.votes.MOM = good ? (i % 2 ? 1 : -1) : 0; return r; });
  const both = H.analyze({ SPY: mk(true), QQQ: mk(true) }); assert.deepStrictEqual(both.candidates.robust, ['MOM (SPY+QQQ)']); assert.ok(both.res.SPY.MOM.crit.pass, JSON.stringify(both.res.SPY.MOM.crit)); assert.strictEqual(both.comparisons, 24);
  const one = H.analyze({ SPY: mk(true), QQQ: mk(false) }); assert.deepStrictEqual(one.candidates.weak, ['MOM (SPY)']); assert.deepStrictEqual(one.candidates.robust, []); assert.strictEqual(both.res.SPY.B0.crit, undefined);
});
t('criteria: wrong-way in the holdout fails c3/c4; n<150 fails c1; weak edge fails c5', () => {
  const rows = rowsFor(400, i => (i % 2 ? 0.004 : -0.003)).map((r, i) => { r.votes.MOM = r.day >= H.SPLIT ? (i % 2 ? -1 : 1) : (i % 2 ? 1 : -1); return r; }); const a = H.analyze({ SPY: rows }).res.SPY.MOM.crit; assert.strictEqual(a.pass, false); assert.strictEqual(a.c3_mean_pos_dev_and_holdout, false);
  const few = rowsFor(100, i => (i % 2 ? 0.004 : -0.003)).map((r, i) => { r.votes.MOM = i % 2 ? 1 : -1; return r; }); assert.strictEqual(H.analyze({ SPY: few }).res.SPY.MOM.crit.c1_n_ge150, false);
  const tiny = rowsFor(400, i => (i % 2 ? 0.0001 : -0.0001)).map((r, i) => { r.votes.MOM = i % 2 ? 1 : -1; return r; }); assert.strictEqual(H.analyze({ SPY: tiny }).res.SPY.MOM.crit.c5_edge_ge5_per_contract, false);
});
t('bootstrap deterministic and verdict leads with the Stage 0 line', () => {
  const x = [1, -2, 3, 4, -1, 2, 5, 0, 1, 2]; assert.deepStrictEqual(H.bootCI(x, 500, 5), H.bootCI(x, 500, 5)); const an = H.analyze({ SPY: rowsFor(300, i => (i % 2 ? 0.004 : -0.003)) }); assert.ok(/^Stage 0/.test(H.verdict(an)[0])); assert.ok(/NO variant passed/.test(H.verdict(an)[0]));
});
t('source guard: no order endpoint, no require(), only bt34/bt34p keys', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'study_dir.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''); assert.ok(!/\/v2\/orders|alpacaBuy|alpacaSell|apTrade|require\(|process\.env/.test(src)); assert.ok(/'bt34'/.test(src) && !/kset\('(?!bt34)/.test(src));
});
(async () => { for (const [n, f] of tests) { try { await f(); pass++; console.log('ok   ' + n); } catch (e) { console.error('FAIL ' + n + '\n' + (e && e.stack || e)); process.exitCode = 1; } } console.log(pass + '/' + tests.length + ' passed'); })();
