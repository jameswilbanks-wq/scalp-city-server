/* CSK downside-protection study (study_csk_downside.js, bt35) test. Behaviour under test: simulate() applies each variant's rule exactly as the spec (docs/csk-downside-study-spec.md) fixes it (hold; credit-multiple stops that need two consecutive bars; dollar-loss caps; underlying-price stops that fire on one bar; up-morning entry filters that skip the day); analyze() scores variants against the M3 control per trading day with zero on skipped days, splits train and lock, finds a clearly better stop and rejects a variant that never changes anything, and checks the H control against bt9; the file can only READ market data (no order call, no trading URL) and is launched once from server.js. Synthetic rows only, no network, no orders. No existing test covers study files. Run: node test/csk_downside.test.js */
'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path');
const S = require('../study_csk_downside.js'), SRC = fs.readFileSync(path.join(__dirname, '..', 'study_csk_downside.js'), 'utf8'), SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
let pass = 0; const tests = []; const t = (n, f) => tests.push([n, f]);
const row = (o) => Object.assign({ credit: 0.4, ks: 100, closeU: 98, openU: 100, entryU: 100, path: [] }, o);
const g6 = x => +x.toFixed(6);

t('hold: settles on the close capped at the $2 width (credit 0.40: close 98 keeps +$40; close 101.5 loses $110; close 105 loses $160)', () => {
  assert.strictEqual(S.simulate(row({}), 'H').g, 40); assert.strictEqual(g6(S.simulate(row({ closeU: 101.5 }), 'H').g), -110); assert.strictEqual(g6(S.simulate(row({ closeU: 105 }), 'H').g), -160); assert.strictEqual(S.simulate(row({}), 'H').fills, 2);
});
t('credit-multiple stops need TWO consecutive bars at or over the line: a one-bar spike does not fire; two bars fire at the second bar value with 4 fills', () => {
  const spike = row({ path: [[665, 0.5, 99], [670, 1.3, 99], [675, 0.2, 99]], closeU: 98 }); assert.strictEqual(S.simulate(spike, 'M3').fired, false); assert.strictEqual(S.simulate(spike, 'M3').g, 40);
  const two = row({ path: [[665, 0.5, 99], [670, 1.3, 99], [675, 1.25, 99], [680, 0.2, 99]], closeU: 98 }), s = S.simulate(two, 'M3'); assert.deepStrictEqual([s.fired, s.fills, g6(s.g), g6(s.holdG)], [true, 4, -85, 40]);
  const m2 = S.simulate(row({ path: [[665, 0.5, 99], [670, 0.85, 99], [675, 0.9, 99]] }), 'M2'); assert.deepStrictEqual([m2.fired, g6(m2.g)], [true, -50]); assert.strictEqual(S.simulate(row({ path: [[665, 0.85, 99], [670, 0.9, 99]] }), 'M3').fired, false);
  assert.strictEqual(S.simulate(row({ path: [[665, 1.0, 99], [670, 1.0, 99]] }), 'M25').fired, true, '2.5 x 0.40 = 1.00 is at the line'); assert.strictEqual(S.simulate(row({ path: [[665, 0.6, 99], [670, 0.6, 99]] }), 'M15').fired, true, '1.5 x 0.40 = 0.60');
});
t('dollar-loss caps: $75 cap fires at value >= credit + 0.75 (1.15) on two bars, $100 cap at 1.40; one bar is not enough', () => {
  assert.deepStrictEqual([S.simulate(row({ path: [[665, 1.2, 99], [670, 1.2, 99]] }), 'L75'), S.simulate(row({ path: [[665, 1.2, 99], [670, 1.2, 99]] }), 'L100')].map(x => x.fired), [true, false]);
  const a = S.simulate(row({ path: [[665, 1.15, 99], [670, 1.15, 99]] }), 'L75'); assert.deepStrictEqual([a.fired, g6(a.g)], [true, -75]); assert.strictEqual(S.simulate(row({ path: [[665, 1.5, 99], [670, 0.3, 99]] }), 'L75').fired, false);
  assert.strictEqual(S.simulate(row({ path: [[665, 1.4, 99], [670, 1.4, 99]] }), 'L100').fired, true);
});
t('underlying-price stops fire on ONE bar: U0 when the close is at or above the short strike, U1 within 0.10% below it (99.9), U2 within 0.20% below (99.8)', () => {
  const u0 = S.simulate(row({ path: [[665, 0.3, 99.5], [670, 0.9, 100.1], [675, 0.5, 99]] }), 'U0'); assert.deepStrictEqual([u0.fired, u0.fills, g6(u0.g)], [true, 4, -50]);
  assert.strictEqual(S.simulate(row({ path: [[665, 0.3, 99.9]] }), 'U0').fired, false); assert.strictEqual(S.simulate(row({ path: [[665, 0.3, 99.9]] }), 'U1').fired, true); assert.strictEqual(S.simulate(row({ path: [[665, 0.3, 99.85]] }), 'U1').fired, false); assert.strictEqual(S.simulate(row({ path: [[665, 0.3, 99.8]] }), 'U2').fired, true);
});
t('up-morning filters skip the entry when entry is up at least 0.50 / 0.75 / 1.00 percent from the open (skipped = null gross, 0 fills); below the line they hold; F3 = F75 skip then the M3 stop', () => {
  const up = row({ openU: 100, entryU: 100.8 }); assert.deepStrictEqual([S.simulate(up, 'F5').g, S.simulate(up, 'F75').g, S.simulate(up, 'F100').g, S.simulate(up, 'F3').g], [null, null, 40, null]); assert.strictEqual(S.simulate(up, 'F75').fills, 0);
  const calm = row({ openU: 100, entryU: 100.4, closeU: 101.5 }); assert.strictEqual(g6(S.simulate(calm, 'F5').g), -110, '0.4% is below the 0.5% line, so it trades and holds to a loss'); assert.ok(S.simulate(calm, 'F75').g !== null);
  const f3 = row({ openU: 100, entryU: 100.2, path: [[665, 1.3, 99], [670, 1.3, 99]] }); assert.deepStrictEqual([S.simulate(f3, 'F3').fired, g6(S.simulate(f3, 'F3').g)], [true, -90]);
});
t('analyze: a stop that cuts a recurring $160 loss to $60 is a candidate (with a plateau neighbour); a rule that never fires is not; skipped days count as zero; every variant is reported; M3 and H are controls, not judged', () => {
  const days = [], rows = [], base = Date.UTC(2025, 0, 1); for (let i = 0; i < 120; i++) days.push([new Date(base + i * 864e5).toISOString().slice(0, 10), 'T']); const b2 = Date.UTC(2026, 0, 1); for (let i = 0; i < 120; i++) days.push([new Date(b2 + i * 864e5).toISOString().slice(0, 10), 'L']);
  days.forEach(([d, sp], i) => { const bad = i % 10 === 5; rows.push(['SPY', d, sp, 0.4, 100, bad ? 105 : 98, 100, 100, bad ? [[665, 0.6, 100.5], [670, 1.0, 101], [675, 1.0, 102], [680, 1.0, 103]] : [[665, 0.3, 99], [670, 0.3, 99]]]); });
  const an = S.analyze(rows, { SPY: days }, { reps: 400 }), c = an.res.SPY.cells; assert.deepStrictEqual(Object.keys(c).sort(), S.VARS.slice().sort());
  assert.ok(an.res.SPY.candidates.includes('M2') && an.res.SPY.candidates.includes('M25'), 'candidates: ' + an.res.SPY.candidates.join(','));
  assert.ok(!an.res.SPY.candidates.includes('L75') && !an.res.SPY.candidates.includes('F5'), 'a rule that never changes the trade cannot be a candidate');
  assert.ok(c.M2.T.worst5 > c.M3.T.worst5 && c.M2.L.avgDay > c.M3.L.avgDay); assert.strictEqual(c.H.all.sessions, 240); assert.ok(c.M3.crit === undefined && c.H.crit === undefined);
  assert.ok(Math.abs(c.H.T.avgDay - (0.9 * 38 + 0.1 * -162)) < 0.2, 'H per-day: ' + c.H.T.avgDay);
  const withSkip = rows.map(r => r.slice()); withSkip.forEach((r, i) => { if (i % 10 === 5) { r[6] = 100; r[7] = 101; } }); const a2 = S.analyze(withSkip, { SPY: days }, { reps: 400 }).res.SPY.cells; assert.strictEqual(a2.F5.skipped, 24); assert.ok(a2.F5.T.avgDay > a2.H.T.avgDay, 'skipping the bad days improves the per-day average'); assert.strictEqual(a2.F5.T.sessions, 120, 'skipped days still count in the denominator');
});
t('analyze: the up-day / other-day split and the stop recovery stat are reported; control H vs bt9 passes when n and average agree and fails when they do not', () => {
  const days = [['2025-01-02', 'T'], ['2025-01-03', 'T']], rows = [['SPY', '2025-01-02', 'T', 0.4, 100, 98, 100, 100, [[665, 0.3, 99]]], ['SPY', '2025-01-03', 'T', 0.4, 100, 105, 100, 100, [[665, 1.3, 100.5], [670, 1.3, 101]]]];
  const c = S.analyze(rows, { SPY: days }, { reps: 50 }).res.SPY.cells; assert.strictEqual(c.H.all.upDays.sessions, 1); assert.strictEqual(c.H.all.otherDays.sessions, 1); assert.strictEqual(c.M3.fired, 1); assert.strictEqual(c.M3.recoveredPct, 0, 'the stopped trade would have lost anyway');
  const hold = rows.map(r => S.simulate({ credit: r[3], ks: r[4], closeU: r[5], openU: r[6], entryU: r[7], path: r[8] }, 'H').g - 2), avg = Math.round(100 * hold.reduce((a, b) => a + b, 0) / 2) / 100;
  const ok = S.analyze(rows, { SPY: days }, { reps: 50, b9: { res: { 'A|SPY|hold|train': { n: 2, avg } } } }); assert.strictEqual(ok.control.ok, false, 'lock side missing in bt9 = not reproduced'); assert.strictEqual(ok.control.cells['SPY|train'].ok, true);
  const bad = S.analyze(rows, { SPY: days }, { reps: 50, b9: { res: { 'A|SPY|hold|train': { n: 2, avg: avg + 5 } } } }); assert.strictEqual(bad.control.cells['SPY|train'].ok, false);
});
t('source guard: the study only reads market data (two GET paths via ap, no order, trade or broker call, no secrets), saves only kv bt35/bt35p, and is launched exactly once from server.js after bt33', () => {
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, ''); assert.ok(!/rh\(|apTrade|\/v2\/orders|place_|fetch\(|https?:\/\/|process\.env|api[_-]?key|secret/i.test(code), 'no order, network or secret access of its own');
  const paths = [...code.matchAll(/ap\('([^']+)'/g)].map(m => m[1]).sort(); assert.deepStrictEqual(paths, ['/v2/stocks/', '/v1beta1/options/bars'].sort());
  assert.ok(/opts\.key \|\| 'bt35'/.test(code)); assert.strictEqual((SERVER.match(/study_csk_downside\.js/g) || []).length, 1); const l = SERVER.split('\n').find(x => /study_csk_downside\.js/.test(x)); assert.ok(/kget\('bt35'\)/.test(l) && /kget\('bt33'\)/.test(l) && /kset\('bt35'/.test(l));
});
(async () => { for (const [n, f] of tests) { try { await f(); pass++; console.log('ok   ' + n); } catch (e) { console.error('FAIL ' + n + '\n' + (e && e.stack || e)); process.exitCode = 1; } } console.log(pass + '/' + tests.length + ' passed'); })();
