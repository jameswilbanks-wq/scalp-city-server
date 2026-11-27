/* bt38 signal confluence study (study_sig.js, run_sig_local.js) test. Behaviour under test: session/calendar/cutoff prep; decision points every 5 minutes from 10:00 to 30 minutes before the close, entry at the NEXT bar's open, exit H minutes later capped at the session's last bar; no look-ahead (changing bars after a decision never changes that decision's signal vector); direction-adjusted excess return against the same-period unconditional mean; day-clustered bootstrap; shifted-signal null; the six pre-set verdict criteria; the dev stage never reads a holdout record; and the study and runner can never reach an order, a broker or the live server. Synthetic bars, no network. Run: node test/sig_study.test.js */
'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path');
const S = require('../study_sig.js');
let pass = 0; const tests = []; const t = (n, f) => tests.push([n, f]);
const SRC = fs.readFileSync(path.join(__dirname, '..', 'study_sig.js'), 'utf8'), RUN = fs.readFileSync(path.join(__dirname, '..', 'run_sig_local.js'), 'utf8');

const DAYS = ['2020-01-06', '2020-01-07', '2020-01-08', '2020-01-09', '2020-01-10', '2020-01-13', '2020-01-14', '2020-01-15', '2020-01-16', '2020-01-17', '2020-01-21', '2020-01-22', '2020-01-23', '2020-01-24']; // January: ET = UTC-5, no DST; 01-20 is a holiday (not a session)
const CAL = DAYS.map(d => ({ date: d, open: '09:30', close: d === '2020-01-24' ? '13:00' : '16:00' }));
/* bar k of a day (k = minutes after 9:30): o = 100 + 0.01k + 0.5 x day index, c = o + 0.005; afterHours adds 120 bars after the 16:00 close */
function mkRaw(days, o) {
  o = o || {}; const col = { t: [], o: [], h: [], l: [], c: [], v: [] };
  days.forEach((d, di) => {
    const base = Date.parse(d + 'T14:30:00Z'), n = o.afterHours ? 390 + 120 : 390; // 14:30 UTC = 9:30 ET
    for (let k = 0; k < n; k++) { const open = o.price ? o.price(di, k) : 100 + 0.01 * k + di * 0.5, close = open + 0.005; col.t.push(base + k * 60000); col.o.push(open); col.h.push(close + 0.01); col.l.push(open - 0.01); col.c.push(close); col.v.push(1000 + (k % 7)); }
  });
  return col;
}

t('etParts matches Intl for winter and summer dates around the DST changes', () => {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  for (const iso of ['2020-01-06T14:30:00Z', '2020-03-06T14:30:00Z', '2020-03-09T13:30:00Z', '2020-07-01T13:30:00Z', '2020-11-02T14:30:00Z', '2020-11-02T13:30:00Z', '2024-03-11T13:30:00Z', '2025-11-03T14:30:00Z']) {
    const o = {}; fmt.formatToParts(new Date(iso)).forEach(p => { o[p.type] = p.value; }); const p = S.etParts(Date.parse(iso)); assert.deepStrictEqual([p.day, p.min], [o.year + '-' + o.month + '-' + o.day, +o.hour * 60 + +o.minute], iso);
  }
});
t('prep: off-session, non-calendar days, after-early-close minutes and the hard cutoff are dropped before anything is computed; counts are recorded', () => {
  const raw = mkRaw(DAYS, { afterHours: true }), full = S.prep(raw, { calendar: CAL.filter(c => c.date !== '2020-01-09') });
  assert.strictEqual(full.dq.notInCalendar, 390, 'the removed 2020-01-09 session: its 390 in-session minutes (its after-hours minutes are counted as off-session first)');
  assert.ok(!full.days.some(d => d.day === '2020-01-09')); assert.strictEqual(full.dq.offSession, 14 * 120, '120 after-hours minutes on each of the 14 days'); assert.strictEqual(full.dq.afterEarlyClose, 180, '13:00 to 15:59 on the early-close day');
  const e = full.days.find(d => d.day === '2020-01-24'); assert.strictEqual(e.n, 210, '9:30 to 13:00 = 210 bars');
  const cut = S.prep(raw, { calendar: CAL, cutoffDay: '2020-01-10' }); assert.ok(cut.dq.afterCutoff > 0 && cut.dq.lastDay <= '2020-01-10', 'nothing after the cutoff survives'); assert.ok(cut.bars.every(b => b.day <= '2020-01-10'));
});
t('collect: decision minutes 10:00..15:30 every 5 (67 a day), entry = next bar open, exit = close H bars later, capped at the last bar; early close ends 30 minutes before 13:00', () => {
  const P = S.prep(mkRaw(DAYS), { calendar: CAL }), recs = S.collect(P), d7 = recs.filter(r => r.day === '2020-01-15'); // day index 7
  assert.deepStrictEqual([d7[0].m, d7[d7.length - 1].m, d7.length], [600, 930, 67]);
  const px = k => 100 + 0.01 * k + 7 * 0.5, ent = k => px(k), cl = k => px(k) + 0.005, r0 = d7[0], k = 600 - 570; // slot bar index 30
  assert.ok(Math.abs(r0.r['15'] - (cl(k + 15) / ent(k + 1) - 1) * 1e4) < 1e-9, 'H15'); assert.ok(Math.abs(r0.r['60'] - (cl(k + 60) / ent(k + 1) - 1) * 1e4) < 1e-9, 'H60'); assert.ok(Math.abs(r0.r.close - (cl(389) / ent(k + 1) - 1) * 1e4) < 1e-9, 'close = last bar');
  const last = d7[d7.length - 1], kl = 930 - 570; assert.ok(Math.abs(last.r['60'] - (cl(389) / ent(kl + 1) - 1) * 1e4) < 1e-9, 'H60 capped at the last bar of the session');
  const ec = recs.filter(r => r.day === '2020-01-24'); assert.deepStrictEqual([ec[0].m, ec[ec.length - 1].m], [600, 750], 'early close: last decision at 12:30');
  assert.ok(recs.every(r => r.di >= 5), 'first 5 sessions are warm-up'); assert.ok(!recs.some(r => r.day < '2020-01-13'), 'no decision before the 6th session');
});
t('no look-ahead: changing bars AFTER a decision never changes that decision\'s signal vector or light', () => {
  const f = (di, k) => 100 + Math.sin(k / 9) * 2 + di * 0.3, X = 11, a = mkRaw(DAYS, { price: f }), b = mkRaw(DAYS, { price: (di, k) => (di === X && k >= 130 ? 140 + k * 0.2 : f(di, k)) }); // from 11:40 ET on day X the future is rewritten
  const ra = S.collect(S.prep(a, { calendar: CAL })), rb = S.collect(S.prep(b, { calendar: CAL }));
  assert.strictEqual(ra.length, rb.length); let checked = 0, changed = 0; ra.forEach((r, i) => { const q = rb[i]; assert.strictEqual(r.day, q.day); const same = JSON.stringify([r.v, r.nb, r.ns, r.st]) === JSON.stringify([q.v, q.nb, q.ns, q.st]);
    if (r.day < DAYS[X] || (r.day === DAYS[X] && r.m <= 570 + 129)) { assert.ok(same, 'identical before the rewrite: ' + r.day + ' ' + r.m); checked++; } else if (r.day === DAYS[X] && !same) changed++; });
  assert.ok(checked > 300 && changed > 0, 'the rewrite does change later decisions, so this test can fail');
});
t('excess: direction-adjusted return minus the same-period unconditional mean; sells flip the sign; hit rate and cost nets', () => {
  const R = (day, r30) => ({ day, r: { '30': r30 } }), picks = [[R('a', 5), 1], [R('a', -1), 1], [R('b', 2), -1]], e = S.excess(picks, '30', 1, 0, 0);
  assert.deepStrictEqual([e.n, e.days], [3, 2]); assert.ok(Math.abs(e.mean - ((5 - 1) + (-1 - 1) + (-(2 - 1))) / 3) < 1e-12, 'mean of 4, -2, -1'); assert.ok(Math.abs(e.rawMean - (5 - 1 - 2) / 3) < 1e-12, 'raw direction-adjusted mean of 5, -1, -2'); assert.ok(Math.abs(e.hit - 100 / 3) < 1e-9, 'one of three trades made money');
  assert.ok(Math.abs(e.netOpt - (e.mean - 1)) < 1e-12 && Math.abs(e.netUnd - (e.mean - 0.3)) < 1e-12 && Math.abs(e.netOptStress - (e.mean - 2)) < 1e-12); assert.deepStrictEqual(S.excess([], '30', 0, 0, 0), { n: 0 });
});
t('bootstrap: deterministic for a seed, brackets the mean, and collapses when every day agrees', () => {
  const picks = []; for (let d = 0; d < 60; d++) for (let i = 0; i < 5; i++) picks.push([{ day: 'd' + d, r: { '30': (d % 2 ? 4 : -2) + i * 0.1 } }, 1]);
  const a = S.excess(picks, '30', 0, 500, 7), b = S.excess(picks, '30', 0, 500, 7), c = S.excess(picks, '30', 0, 500, 8); assert.deepStrictEqual([a.lo, a.hi], [b.lo, b.hi]); assert.ok(a.lo < a.mean && a.mean < a.hi); assert.notStrictEqual(a.lo, c.lo);
  const flat = S.excess(picks.map(p => [{ day: p[0].day, r: { '30': 3 } }, 1]), '30', 0, 500, 7); assert.ok(Math.abs(flat.lo - 3) < 1e-9 && Math.abs(flat.hi - 3) < 1e-9);
});
t('shifted-signal null: unlinked signals give a null centred near 0; a planted link beats its 97.5th percentile; too few sessions = null', () => {
  const R = S.rng(5), recs = []; for (let d = 0; d < 80; d++) for (let m = 600; m <= 930; m += 30) { const st = R() < 0.4 ? 'buy' : R() < 0.5 ? 'sell' : 'none'; recs.push({ day: 'd' + String(d).padStart(3, '0'), m, st, r: { '30': (R() - 0.5) * 10 } }); }
  const n = S.shiftNull(recs, '30', 0, 300, 1); assert.ok(n && Math.abs(n.p50) < 0.6 && n.p975 > n.p025 && n.p975 < 1.5, JSON.stringify(n));
  const linked = recs.map(r => Object.assign({}, r, { r: { '30': (r.st === 'buy' ? 3 : r.st === 'sell' ? -3 : 0) + (R() - 0.5) * 2 } })), real = S.excess(linked.filter(r => r.st !== 'none').map(r => [r, r.st === 'buy' ? 1 : -1]), '30', 0, 0, 0).mean, nl = S.shiftNull(linked, '30', 0, 300, 1);
  assert.ok(real > nl.p975 + 1, 'planted effect ' + real + ' vs null ' + nl.p975); assert.strictEqual(S.shiftNull(recs.slice(0, 20), '30', 0, 10, 1), null, 'too few sessions');
});
t('verdict: all six criteria pass = Supported; each single failure is named; too few points = Inconclusive', () => {
  const L = (n, mean, lo, hi) => ({ n, mean, lo, hi, netOpt: mean - 1 }), W = mean => ({ n: 500, mean });
  const mk = o => { o = o || {}; return { dev: { light: { '30': Object.assign(L(900, 2.5, 0.5, 4.5), o.devL) }, weak: { '30': Object.assign(W(0.5), o.devW) }, null: { '30': { p975: 1.5 } } }, hold: { light: { '30': Object.assign(L(400, 2.0, 0, 4), o.holdL) }, weak: { '30': Object.assign(W(0.4), o.holdW) } } }; };
  assert.deepStrictEqual([S.verdict(mk()).label, S.verdict(mk()).failed], ['Supported (underlying move only)', []]);
  assert.strictEqual(S.verdict(mk({ devL: { n: 100 } })).label, 'Inconclusive');
  const f = o => S.verdict(mk(o)).failed; assert.deepStrictEqual(f({ holdL: { mean: -0.1, netOpt: -1.1 } }), ['2', '4', '6']); assert.deepStrictEqual(f({ devL: { lo: -0.2 } }), ['3']); assert.deepStrictEqual(f({ devL: { mean: 1.2, netOpt: 0.2, lo: 0.1 } }), ['5'], 'only the null criterion fails');
  assert.deepStrictEqual(f({ devW: { mean: 3 } }), ['6']); assert.deepStrictEqual(f({ holdL: { mean: 1.5, netOpt: 0.5 } }), [], 'still passes'); assert.deepStrictEqual(f({ holdL: { mean: 0.8, netOpt: -0.2 } }), ['4'], 'beats weak but not the 1.0 bp cost');
});
t('stage dev never reads a holdout record: changing holdout records leaves the dev result identical; no holdout/full block or verdict in dev; final has all of them for both signal sets', () => {
  const R = S.rng(3), mkr = (day, m) => ({ day, di: 9, m, v: [1, 1, 0, 1, 1, 1, 0], r: { '15': R(), '30': R() - 0.5, '60': R(), close: R() } }), dev = [], hold1 = [], hold2 = [];
  for (let d = 0; d < 28; d++) for (let m = 600; m <= 900; m += 60) { dev.push(mkr('2022-02-' + String(d + 1).padStart(2, '0'), m)); hold1.push(mkr('2025-05-' + String(d + 1).padStart(2, '0'), m)); }
  hold1.forEach(r => hold2.push(Object.assign({}, r, { r: { '15': 99, '30': 99, '60': 99, close: 99 } })));
  const a = S.run({ SPY: dev.concat(hold1) }, { stage: 'dev', draws: 50, nullDraws: 30 }), b = S.run({ SPY: dev.concat(hold2) }, { stage: 'dev', draws: 50, nullDraws: 30 });
  for (const sn of ['s7', 's5']) { assert.deepStrictEqual(a.syms.SPY[sn].dev, b.syms.SPY[sn].dev, sn); assert.strictEqual(a.syms.SPY[sn].hold, null); assert.strictEqual(a.syms.SPY[sn].full, null); }
  assert.strictEqual(a.verdict, undefined); assert.strictEqual(a.verdict5, undefined);
  const f = S.run({ SPY: dev.concat(hold1) }, { stage: 'final', draws: 50, nullDraws: 30 }); for (const sn of ['s7', 's5']) assert.ok(f.syms.SPY[sn].hold && f.syms.SPY[sn].full, sn); assert.ok(f.verdict && f.verdict.label && f.verdict5 && f.verdict5.label);
});
t('set views: S7 lights at 4 of 7, S5 (the original board) at 3 of 5 using only the first five signals; null never counts', () => {
  const mk = v => ({ day: 'd', di: 9, m: 600, v, r: { '30': 0 } }), one = v => ({ s7: S.view([mk(v)], S.SETS.s7)[0], s5: S.view([mk(v)], S.SETS.s5)[0] });
  let x = one([1, 1, 1, 0, 0, 0, 0]); assert.deepStrictEqual([x.s7.nb, x.s7.st, x.s5.nb, x.s5.st], [3, 'none', 3, 'buy'], '3 agree: dark on the 7-board, lit on the 5-board');
  x = one([1, 1, 1, 1, 0, 0, 0]); assert.deepStrictEqual([x.s7.st, x.s5.st], ['buy', 'buy']); x = one([0, 0, 0, 0, 0, 1, 1]); assert.deepStrictEqual([x.s7.nb, x.s5.nb, x.s7.st], [2, 0, 'none'], 'MACD and Bollinger count only toward the 7-board');
  x = one([-1, -1, null, -1, null, -1, 0]); assert.deepStrictEqual([x.s7.ns, x.s7.st, x.s5.ns, x.s5.st], [4, 'sell', 3, 'sell'], 'nulls never count'); assert.deepStrictEqual(S.NAMES, ['vwap', 'orb', 'rsi', 'ema', 'ihh', 'macd', 'bb']);
});
t('ladder and light bookkeeping: buy k counts records with exactly k signals at +1; the light is the set state; independence stats are reported', () => {
  const mkr = (day, m, v, r) => ({ day, di: 9, m, v, r: { '15': r, '30': r, '60': r, close: r } }), S5 = S.SETS.s5;
  const recs = S.view([mkr('2022-01-03', 600, [1, 1, 1, 0, 0, 0, 0], 4), mkr('2022-01-03', 605, [1, 1, 1, -1, 0, 0, 0], 2), mkr('2022-01-04', 600, [1, -1, -1, -1, 0, 0, 0], -6), mkr('2022-01-04', 605, [0, 0, 0, 0, 0, 0, 0], 0), mkr('2022-01-05', 600, [1, 1, 1, 1, 1, 0, 0], 8)], S5);
  const a = S.analyse(recs, S5, 0, 1); assert.deepStrictEqual([a.ladder.buy[3]['30'].n, a.ladder.buy[5]['30'].n, a.ladder.sell[3]['30'].n, a.ladder.buy[1]['30'].n], [2, 1, 1, 1]); assert.strictEqual(a.light['30'].n, 4, 'buy, buy, sell, buy'); assert.ok(Math.abs(a.base['30'] - 1.6) < 1e-12);
  assert.strictEqual(a.all['30'].buy.n, 1); assert.ok('neff' in a.corr && 'mean' in a.corr && Array.isArray(a.corr.m) && a.corr.names.length === 5); assert.ok(Math.abs(S.spearman([1, 2, 3, 4], [1, 2, 3, 4]) - 1) < 1e-12 && S.spearman([1, 2], [1, 2]) === null);
});
t('source guard: the study is pure (only requires signals.js; no network, env, file, order or broker call); the runner talks to the Alpaca DATA host with GET only and never prints a key', () => {
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1'); assert.deepStrictEqual((code.match(/require\([^)]*\)/g) || []), ["require('./signals.js')"]);
  assert.ok(!/fetch\(|https?:|process\.|alpaca|place_|writeFile|readFile|rh\(|kset|kget|\.env/i.test(code), 'pure');
  const rc = RUN.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1'); assert.ok(/data\.alpaca\.markets/.test(rc) && !/paper-api|api\.alpaca\.markets|onrender|supabase|robinhood/i.test(rc), 'data host only'); assert.ok(/method: 'GET'/.test(rc) && !/method: 'POST'|method: 'DELETE'|method: 'PUT'|method: 'PATCH'/.test(rc), 'GET only');
  assert.ok(!/console\.(log|error)\([^)]*\b(AK|AS)\b/.test(rc), 'keys are never printed'); assert.ok(/status --porcelain/.test(rc) && /clean committed tree/.test(rc), 'final needs a clean tree'); assert.ok(/cutoffDay: cmd === 'dev' \? study\.SPLIT/.test(rc), 'dev has a hard cutoff');
});

(async () => { for (const [n, f] of tests) { try { await f(); pass++; console.log('ok   ' + n); } catch (e) { console.log('FAIL ' + n + '\n' + (e && e.stack || e)); } } console.log(pass + '/' + tests.length + ' passed'); process.exit(pass === tests.length ? 0 : 1); })();
