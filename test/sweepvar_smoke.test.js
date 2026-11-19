'use strict';
/* Smoke tests for sweepvar.js and study_sweep_variants.js (bt30) on SYNTHETIC data only: nothing here proves anything about real results.
   Run: node test/sweepvar_smoke.test.js */
const assert = require('assert');
const SV = require('../sweepvar.js');
const study = require('../study_sweep_variants.js');
const H = study.helpers;
const Engine = require('../engine.js');

let ok = 0;
const pending = [];
function t(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') { pending.push(r.then(() => { ok++; console.log('ok   ' + name); }, e => { console.log('FAIL ' + name + '\n' + (e && e.stack)); process.exitCode = 1; })); return; }
    ok++; console.log('ok   ' + name);
  } catch (e) { console.log('FAIL ' + name + '\n' + (e && e.stack)); process.exitCode = 1; }
}
const near = (a, b, eps) => assert.ok(Math.abs(a - b) <= (eps || 1e-9), a + ' vs ' + b);

// ---- tiny bar builder for walk tests: minute m of day D, t = m * 60000 (any monotone base works for walk)
const bar = (m, o, h, l, c, day) => ({ t: m * 60000, min: m, o, h, l, c, v: 100, day: day || 'D', vwap: 100, atr: 0.5 });

t('walk run (long): stop hit exits at the end of that bar', () => {
  const b = [bar(600, 100, 100.2, 99.9, 100), bar(601, 100, 100.2, 99.9, 100), bar(602, 100, 100.1, 99.4, 99.5)];
  assert.strictEqual(SV.walk(b, 0, 1, 0.5, 'run'), b[2].t + 60000);
});
t('walk run (long): trail moves up, then a pullback to the trailed stop exits', () => {
  const b = [bar(600, 100, 100.2, 99.9, 100), bar(601, 100, 101, 100.6, 100.9), bar(602, 100.9, 101, 100.4, 100.6)];
  // after bar 601: hi=101, trailed stop = 100.5; bar 602 low 100.4 <= 100.5 -> exit at 602 end. (bar 601: low 100.6 > 100.5 no exit)
  assert.strictEqual(SV.walk(b, 0, 1, 0.5, 'run'), b[2].t + 60000);
});
t('walk run (long): a close below the trailed stop exits even when the low did not touch it', () => {
  const b = [bar(600, 100, 100.2, 99.9, 100), bar(601, 100, 101, 100.6, 100.9), bar(602, 100.9, 101, 100.51, 100.49)];
  assert.strictEqual(SV.walk(b, 0, 1, 0.5, 'run'), b[2].t + 60000);
});
t('walk run (short) mirrors the long', () => {
  const b = [bar(600, 100, 100.1, 99.9, 100), bar(601, 100, 99.4, 99, 99.1), bar(602, 99.1, 99.6, 99, 99.4)];
  // short: entry 100, stop 100.5; bar 601 lo 99 -> trailed stop 99.5; bar 602 high 99.6 >= 99.5 -> exit
  assert.strictEqual(SV.walk(b, 0, -1, 0.5, 'run'), b[2].t + 60000);
});
t('walk: flat at the 15:30 bar returns that bar time; data running out falls back like bt8', () => {
  const b = [bar(600, 100, 100.1, 99.9, 100), bar(601, 100, 100.1, 99.9, 100), bar(930, 100, 100.1, 99.9, 100)];
  assert.strictEqual(SV.walk(b, 0, 1, 0.5, 'run'), b[2].t);
  const c = [bar(600, 100, 100.1, 99.9, 100), bar(601, 100, 100.1, 99.9, 100)];
  assert.strictEqual(SV.walk(c, 0, 1, 0.5, 'run'), c[1].t + 60000);
});
t('walk t10ns: no stop at all; exits 10 bars after the signal bar, even through a crash', () => {
  const b = []; for (let q = 0; q < 14; q++) b.push(bar(600 + q, 100, 100.1, q === 3 ? 50 : 99.9, 100));
  assert.strictEqual(SV.walk(b, 0, 1, 0.5, 't10ns'), b[10].t + 60000);
});
t('walk stays inside the signal day', () => {
  const b = [bar(600, 100, 100.1, 99.9, 100, 'D'), bar(601, 100, 100.1, 99.9, 100, 'D'), bar(570, 100, 100.1, 40, 40, 'E')];
  assert.strictEqual(SV.walk(b, 0, 1, 0.5, 'run'), b[1].t + 60000);
});

t('signalFacts: R, rPct, trend sign, VWAP agreement; bt8 tiny-stop guard; last bar of day', () => {
  const bars = [bar(600, 100, 100.1, 99, 100.05), bar(601, 100, 100.2, 99.9, 100.1)]; bars[0].vwap = 100.0;
  const f = SV.signalFacts(bars, { k: 0, sig: { dir: 1, stopPx: 98.9 } }, 100);
  near(f.R, 1.1, 1e-9); near(f.rPct, 1.1, 1e-6); // R = |100 - 98.9|, 1.1% of the 100 entry price assert.strictEqual(f.trendSign, 1); assert.strictEqual(f.trendAgree, true); assert.strictEqual(f.vwapAgree, true);
  const g = SV.signalFacts(bars, { k: 0, sig: { dir: -1, stopPx: 101.1 } }, 100);
  assert.strictEqual(g.trendAgree, false); assert.strictEqual(g.vwapAgree, false);
  assert.strictEqual(SV.signalFacts(bars, { k: 0, sig: { dir: 1, stopPx: 99.9999 } }, 100), null); // |100 - 99.9999| is not > 0.0001 x price
  assert.strictEqual(SV.signalFacts(bars, { k: 1, sig: { dir: 1, stopPx: 99 } }, 100), null);     // no next bar
  assert.strictEqual(SV.signalFacts(bars, { k: 0, sig: { dir: 1, stopPx: 98.9 } }, 100.05).trendAgree, null); // exactly flat vs the day's open
});

t('variant filters: W caps, T1/T2/T3 selection, fades take everything', () => {
  const f = (o) => Object.assign({ dir: 1, rPct: 0.05, trendAgree: true, vwapAgree: true }, o), V = id => SV.VARIANTS.find(v => v.id === id);
  assert.ok(V('W1').take(f({ rPct: 0.08 })) && !V('W1').take(f({ rPct: 0.081 })));
  assert.ok(V('W2').take(f({ rPct: 0.12 })) && !V('W2').take(f({ rPct: 0.121 })));
  assert.ok(V('T1').take(f()) && !V('T1').take(f({ trendAgree: false })) && !V('T1').take(f({ trendAgree: null })));
  assert.ok(V('T3').take(f({ trendAgree: false })) && !V('T3').take(f()) && !V('T3').take(f({ trendAgree: null })));
  assert.ok(V('T2').take(f()) && !V('T2').take(f({ vwapAgree: false })));
  assert.ok(V('F1').take(f({ rPct: 5 })) && V('F2').take(f({ trendAgree: null })));
  assert.deepStrictEqual(SV.VARIANTS.map(v => v.id), ['S0', 'F1', 'F2', 'W1', 'W2', 'T1', 'T2', 'T3']);
  assert.strictEqual(SV.dirOf('S0', { dir: 1 }), 1); assert.strictEqual(SV.dirOf('F1', { dir: 1 }), -1); assert.strictEqual(SV.modeOf('F2'), 't10ns'); assert.strictEqual(SV.modeOf('F1'), 'run');
});

t('coin: deterministic and about 50/50', () => {
  let h = 0; for (let i = 0; i < 4000; i++) { if (SV.coin(29, i)) h++; assert.strictEqual(SV.coin(29, i), SV.coin(29, i)); }
  assert.ok(h > 1800 && h < 2200, 'heads ' + h);
});

t('metrics, dropBest, bootCI', () => {
  const m = SV.metrics([10, -5, -5, 20], 8);
  assert.strictEqual(m.n, 4); near(m.avg, 5); near(m.total, 20); near(m.avgAllDays, 2.5); near(m.pf, 3); assert.strictEqual(m.win, 50); near(m.worst, -5); near(m.best, 20);
  near(SV.dropBest([10, -5, -5, 20, 1, 1, 1], 5), -5);
  assert.strictEqual(SV.dropBest([1, 2, 3], 5), null);
  assert.deepStrictEqual(SV.metrics([], 5), { n: 0 });
  const rows = []; for (let d = 0; d < 60; d++) rows.push({ day: 'd' + d, pnl: d % 2 ? 10 : -4 });
  const ci1 = SV.bootCI(rows, 500, 7), ci2 = SV.bootCI(rows, 500, 7);
  assert.deepStrictEqual(ci1, ci2); assert.ok(ci1[0] < 3 && ci1[1] > 3 && ci1[0] < ci1[1]); // true mean = 3
  assert.strictEqual(SV.bootCI(rows.slice(0, 3), 100, 1), null);
});

// ---- analyze / evaluate on a hand-built table (one symbol 'X'; fade wins +30, original loses -30 gross)
function addDays(base, n, step) { const d = new Date(Date.parse(base + 'T12:00:00Z') + n * step * 864e5); return d.toISOString().slice(0, 10); }
function buildTbl(rPct) {
  const S = [], days = []; let i = 0;
  for (let k = 0; k < 130; k++) { const day = addDays('2025-01-01', k, 4); days.push(day); S.push({ i: i++, day, f: { dir: k % 2 ? 1 : -1, R: 0.3, rPct: rPct, trendAgree: k % 2 === 0, vwapAgree: k % 3 === 0 }, g: { S0: -30, F1: 30, F2: 30 } }); }
  for (let k = 0; k < 130; k++) { const day = addDays('2026-07-14', k, 1); days.push(day); S.push({ i: i++, day, f: { dir: k % 2 ? 1 : -1, R: 0.3, rPct: rPct, trendAgree: k % 2 === 0, vwapAgree: k % 3 === 0 }, g: { S0: -30, F1: 30, F2: 30 } }); }
  return { tbl: { X: S }, sessions: { X: days.slice().sort() } };
}
t('analyze: costs applied as 2 fills x per-share x 100; fade and control numbers; noise near zero', () => {
  const { tbl, sessions } = buildTbl(0.05), an = H.analyze(tbl, sessions, { boot: 300 }), X = an.res.X;
  near(X.S0.c03.all.avg, -36); near(X.S0.c01.all.avg, -32); near(X.F1.c03.all.avg, 24); near(X.F1.c01.all.avg, 28);
  assert.strictEqual(X.S0.c03.dev.n, 130); assert.strictEqual(X.S0.c03.holdout.n, 130);
  near(X.F1.c03.dev.avgAllDays, 24); // one trade per session here
  near(X.W1.c03.all.avg, -36); assert.strictEqual(X.W1.c03.all.n, 260); // rPct 0.05 <= 0.08 so W1 = S0
  assert.strictEqual(X.T1.c03.all.n, 130); assert.strictEqual(X.T3.c03.all.n, 130); assert.strictEqual(X.T1.c03.all.n + X.T3.c03.all.n, 260);
  assert.ok(Math.abs(X.NOISE.c03.all.avg - (-6)) < 6, 'noise avg ' + X.NOISE.c03.all.avg); // about (-30 + 30)/2 - 6
  assert.ok(X.F1.c03.all.quarters.length >= 6);
  assert.strictEqual(X.F1.c03.all.callsPuts.call.n + X.F1.c03.all.callsPuts.put.n, 260);
  assert.ok(an.extra.X.stopDist.dev.R$.med === 0.3);
});
t('evaluate: fade that wins everywhere passes every criterion; S0-like filter fails; control flag carried', () => {
  const { tbl, sessions } = buildTbl(0.05), an = H.analyze(tbl, sessions, { boot: 300 }), ev = H.evaluate(an, { ok: true });
  assert.strictEqual(ev.variants.F1.passStage0, true, JSON.stringify(ev.variants.F1));
  assert.strictEqual(ev.variants.W1.passStage0, false); assert.strictEqual(ev.variants.W1.perSymbol.X.c1_devAndHoldoutPositive, false);
  assert.strictEqual(ev.controlOk, true);
  assert.strictEqual(H.evaluate(an, { ok: false }).controlOk, false);
  assert.ok(!('S0' in ev.variants) && !('T3' in ev.variants)); // control and diagnostic are not judged
});
t('evaluate: holdout n below 100 cannot pass; drop-best-5 criterion bites', () => {
  const { tbl, sessions } = buildTbl(0.05); tbl.X = tbl.X.filter(r => !(r.day >= H.HOLD) || r.i % 3 === 0); // thin the holdout to ~44
  const ev = H.evaluate(H.analyze(tbl, sessions, { boot: 200 }), { ok: true });
  assert.strictEqual(ev.variants.F1.perSymbol.X.c2_holdoutN100, false); assert.strictEqual(ev.variants.F1.passStage0, false);
  const b2 = buildTbl(0.05); b2.tbl.X.forEach((r, ix) => { r.g.F1 = ix < 5 ? 5000 : -10; });
  const ev2 = H.evaluate(H.analyze(b2.tbl, b2.sessions, { boot: 200 }), { ok: true });
  assert.strictEqual(ev2.variants.F1.perSymbol.X.c3_positiveDropBest5, false); // five huge winners carry the average; without them it loses
});

t('reproCheck: matches bt8 within tolerance; flags a mismatch; unreadable bt8 is not verified', () => {
  const S = [{ i: 0, day: '2026-03-02', f: {}, g: { S0: 100 } }, { i: 1, day: '2026-08-03', f: {}, g: { S0: -100 } }];
  const bt8 = (n, avg) => ({ started: '2026-11-10T00:00:00Z', days: 1000, res: { 'X|run|ALL': { n, avg } } });
  assert.strictEqual(H.reproCheck({ X: S }, bt8(2, -2)).ok, true); // mine: (98 + -102)/2 = -2
  assert.strictEqual(H.reproCheck({ X: S }, bt8(2, 9)).ok, false);
  assert.strictEqual(H.reproCheck({ X: S }, bt8(40, -2)).ok, false);
  assert.strictEqual(H.reproCheck({ X: S }, null).ok, null); assert.strictEqual(H.reproCheck({ X: S }, { error: 'x' }).ok, null);
  assert.strictEqual(H.reproCheck({ X: S }, { started: '2026-11-10T00:00:00Z', days: 1000, res: {} }).ok, false);
});

t('price helpers: entry fill window, sell lookups, contract symbol', () => {
  const arr = [{ t: 1000 * 60000, o: 2, c: 2.1 }, { t: 1002 * 60000, o: 2.2, c: 2.3 }, { t: 1010 * 60000, o: 3, c: 3.1 }];
  assert.deepStrictEqual(H.entryFill(arr, 1001 * 60000), { pin: 2.2, tFill: 1002 * 60000 });
  assert.strictEqual(H.entryFill(arr, 1003 * 60000), null); // next bar is more than 3 minutes later
  near(H.sellAt(arr, 1002 * 60000), 2.3); near(H.sellAt(arr, 1004 * 60000), 2.3); assert.strictEqual(H.sellAt(arr, 990 * 60000), null); near(H.sellAt(arr, 999 * 60000), 2.1); // bt8 looks forward up to 5 minutes for a bar
  assert.strictEqual(H.contract('SPY', '2026-03-02', 1, 100.4), 'SPY260302C00100000'); assert.strictEqual(H.contract('QQQ', '2026-08-03', -1, 655.6), 'QQQ260803P00656000');
});

// ---- end to end with a stub client: two synthetic sessions, each with ONE low-sweep signal at 9:50 ET
function utcOf(day, min) { const dst = day >= '2026-03-08' && day < '2026-11-01' ? 4 : 5; return new Date(Date.parse(day + 'T00:00:00Z') + (min + dst * 60) * 60000).toISOString(); }
function stockDay(day) {
  const out = [];
  for (let j = 0; j < 390; j++) {
    let p = 100; if (j >= 21) p = 100 + 0.05 * Math.min(j - 21, 39);
    let o = p, h = p + 0.25, l = p - 0.25, c = p;
    if (j >= 21 && j < 61) c = p + 0.05;
    if (j === 20) { o = 100; h = 100.1; l = 99; c = 100.05; }
    out.push({ t: utcOf(day, 570 + j), o, h, l, c, v: 100 });
  }
  return out;
}
function optDay(day, callEnd, putMid) { // call: 2.0 until 10:00 then callEnd; put: 2.0 until 10:01, putMid until 10:09 (when the F1 stop is hit), then 1.0
  const call = [], put = [];
  for (let j = 0; j < 390; j++) {
    const m = 570 + j, t = utcOf(day, m);
    call.push({ t, o: m <= 600 ? 2.0 : callEnd, c: m <= 600 ? 2.0 : callEnd });
    put.push({ t, o: m <= 601 ? 2.0 : m <= 609 ? putMid : 1.0, c: m <= 601 ? 2.0 : m <= 609 ? putMid : 1.0 });
  }
  return { call, put };
}
t('engine sanity: the synthetic session produces exactly one sweep signal', () => {
  const raw = stockDay('2026-03-02').map(b => ({ begins_at: b.t, open_price: b.o, high_price: b.h, low_price: b.l, close_price: b.c, volume: b.v }));
  const bars = Engine.prepare(raw); Engine.simulate(bars, {}, true);
  const sg = Engine.signals(bars, { vwap: false, orb: false, ema: false }).filter(g => g.sig.trig === 'sweep');
  assert.strictEqual(sg.length, 1, JSON.stringify(sg.map(g => [g.k, g.sig.dir])));
  assert.strictEqual(sg[0].k, 20); assert.strictEqual(sg[0].sig.dir, 1);
});
t('end to end (stub client): control, fade and F2 values, rows, criteria and control flag', async () => {
  const dev = '2026-03-02', hold = '2026-08-03', saved = {};
  const o1 = optDay(dev, 3.0, 1.5), o2 = optDay(hold, 1.0, 2.5); // F1 exits 10:09 (put 1.5 dev -> -50, 2.5 holdout -> +50); F2 exits 10:01 (put 2.0 -> 0)
  const ap = async (path, qs) => {
    if (path === '/v2/stocks/SPY/bars') return { bars: stockDay(dev).concat(stockDay(hold)) };
    if (path === '/v1beta1/options/bars') {
      const bars = {}, o = Date.parse(qs.start) < Date.parse(hold + 'T00:00:00Z') ? o1 : o2; // start time identifies the session
      qs.symbols.split(',').forEach(s => { bars[s] = s.includes('C0') ? o.call : o.put; });
      return { bars };
    }
    throw new Error('unexpected ' + path);
  };
  const kset = async (k, v) => { saved[k] = v; };
  const bt8 = { started: '2026-11-10T00:00:00Z', days: 1000, res: { 'SPY|run|ALL': { n: 2, avg: -2 } } };
  const out = await study(ap, Engine, kset, { gap: 0, minBars: 300, syms: ['SPY'], from: '2026-01-01', to: '2026-11-01T00:00:00Z', now: Date.parse('2026-11-19T00:00:00Z'), boot: 200, chunkDays: 1, kget: async k => k === 'bt8' ? bt8 : null });
  assert.strictEqual(out.progress, 'done'); assert.strictEqual(out.errs, 0, out.lastErr);
  assert.strictEqual(out.n.SPY.sessions, 2); assert.strictEqual(out.rows.length, 2, JSON.stringify(out.skipped));
  const r = out.rows; // [sym, day, dir, R, R%, trendAgree, vwapAgree, S0, F1, F2]
  assert.strictEqual(r[0][1], dev); assert.strictEqual(r[0][2], 1); near(r[0][7], 100); near(r[0][8], -50); near(r[0][9], 0);
  assert.strictEqual(r[1][1], hold); near(r[1][7], -100); near(r[1][8], 50); near(r[1][9], 0);
  assert.strictEqual(r[0][5], 1); assert.strictEqual(r[0][6], 1);
  assert.strictEqual(out.control.ok, true, JSON.stringify(out.control));
  near(out.res.SPY.S0.c03.dev.avg, 94); near(out.res.SPY.S0.c03.holdout.avg, -106); near(out.res.SPY.F1.c03.dev.avg, -56); near(out.res.SPY.F1.c03.holdout.avg, 44);
  assert.strictEqual(out.res.SPY.T1.c03.all.n, 2); assert.strictEqual(out.res.SPY.T3.c03.all.n, 0); assert.strictEqual(out.res.SPY.W1.c03.all.n, 0); // stop is ~1% of price here, far above the caps
  assert.strictEqual(out.criteria.variants.F1.passStage0, false); assert.strictEqual(out.criteria.variants.F1.perSymbol.SPY.c2_holdoutN100, false);
  assert.ok(saved.bt30p && saved.bt30p.progress, 'progress row written');
  assert.ok(!/CONTROL NOT VERIFIED/.test(out.verdictNote));
});
t('end to end: an unreadable bt8 is labelled; a lost day is counted in errs and does not stop the run', async () => {
  const dev = '2026-03-02', o1 = optDay(dev, 3.0, 1.0); let calls = 0;
  const ap = async (path, qs) => {
    if (path === '/v2/stocks/SPY/bars') return { bars: stockDay(dev) };
    calls++; if (calls <= 2) throw new Error('boom'); // the call and its one retry both fail -> the day is lost, counted
    return { bars: { [qs.symbols.split(',')[0]]: o1.call } };
  };
  const out = await study(ap, Engine, async () => {}, { gap: 0, minBars: 300, syms: ['SPY'], from: '2026-01-01', to: '2026-11-01T00:00:00Z', now: Date.parse('2026-11-19T00:00:00Z'), boot: 100, chunkDays: 5, kget: async () => null });
  assert.strictEqual(out.progress, 'done'); assert.strictEqual(out.errs, 1); assert.strictEqual(out.control.ok, null); assert.ok(/CONTROL NOT VERIFIED/.test(out.verdictNote));
});

Promise.all(pending).then(() => { console.log(ok + ' passed'); if (process.exitCode) console.log('SOME FAILED'); else console.log('\nAll sweepvar smoke checks passed (synthetic data only -- real results require the server-side run against Alpaca).'); });
