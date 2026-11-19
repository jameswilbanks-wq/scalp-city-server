'use strict';
/* Smoke test for study_rb15.js (bt28). Synthetic bars only; no network, no kv. Run: node test/rb15_smoke.test.js */
const assert = require('assert');
const study = require('../study_rb15.js'), H = study.helpers;
let pass = 0; const T = (name, fn) => { try { fn(); pass++; console.log('ok   ' + name); } catch (e) { console.log('FAIL ' + name + ' -> ' + e.message); process.exitCode = 1; } };
const TA = []; const ta = (name, fn) => TA.push([name, fn]);
const r2 = x => Math.round(x * 100) / 100;

/* a 5-minute day (EST): bars 9:30..15:55; fields from spec(minute) */
const tOf = (D, min) => Date.parse(D + 'T14:30:00Z') + (min - 570) * 60000;
function day(D, spec) { const B = []; for (let m = 570; m <= 955; m += 5) { const s = Object.assign({ o: 100, h: 100.5, l: 99.5, c: 100 }, spec(m) || {}); B.push({ t: tOf(D, m), min: m, o: s.o, h: s.h, l: s.l, c: s.c }); } return B; }
// breakout day: the 9:45 candle (bars 585/590/595) closes at 101 > range high 100.5; entry at the 10:00 open 101.2; stop 99.5; R = 1.7
const breakout = (D, after) => day(D, m => m === 590 ? { c: 100.2 } : m === 595 ? { h: 101.1, l: 100, c: 101 } : m === 600 ? { o: 101.2, h: 101.4, l: 101.0, c: 101.2 } : m > 600 ? Object.assign({ o: 101.2, h: 101.4, l: 101.0, c: 101.2 }, after && after(m)) : null);

T('planDay: first 15-min close above the range -> long, entry = next 5-min open, stop = range low', () => {
  const r = H.planDay(breakout('2026-11-16')); assert(r.plan); const p = r.plan;
  assert.strictEqual(p.dir, 1); assert.strictEqual(p.e, 101.2); assert.strictEqual(p.stop0, 99.5); assert(Math.abs(p.R - 1.7) < 1e-9); assert.strictEqual(p.k1, 6);
});
T('planDay: no breakout and gap skips', () => {
  assert.strictEqual(H.planDay(day('2026-11-17', () => null)).skip, 'no breakout');
  const g = breakout('2026-11-16'); g.splice(4, 1); assert.strictEqual(H.planDay(g).skip, 'gap in 15-minute candle');
});
T('planDay: short breakout', () => {
  const B = day('2026-11-16', m => m === 595 ? { h: 100, l: 99, c: 99.2 } : m === 600 ? { o: 99.0, h: 99.1, l: 98.9, c: 99.0 } : null), r = H.planDay(B);
  assert.strictEqual(r.plan.dir, -1); assert.strictEqual(r.plan.stop0, 100.5);
});
T('exitSim: time exit, target, stop, break-even (stop checked before target)', () => {
  const p = H.planDay(breakout('2026-11-16')).plan;
  let x = H.exitSim(breakout('2026-11-16'), p, 1.25, 0.5); assert.strictEqual(x.why, 'time'); assert.strictEqual(x.xt, tOf('2026-11-16', 930)); assert.strictEqual(Math.round(x.xr * 1000), 0);
  x = H.exitSim(breakout('2026-11-16', m => m === 650 ? { h: 103.4 } : null), p, 1.25, 0.5); assert.strictEqual(x.why, 'target'); assert.strictEqual(x.xr, 1.25);
  x = H.exitSim(breakout('2026-11-16', m => m === 650 ? { l: 99.4 } : null), p, 1.25, 0.5); assert.strictEqual(x.why, 'stop'); assert(Math.abs(x.xr + 1) < 1e-9);
  x = H.exitSim(breakout('2026-11-16', m => m === 650 ? { h: 103.4, l: 99.4 } : null), p, 1.25, 0.5); assert.strictEqual(x.why, 'stop'); // both in one bar: stop first
  x = H.exitSim(breakout('2026-11-16', m => m === 650 ? { h: 102.2 } : m === 660 ? { l: 101.1 } : null), p, 1.25, 0.5); assert.strictEqual(x.why, 'breakeven'); assert.strictEqual(Math.round(x.xr * 1000), 0);
});
T('nextWeekday: Friday -> Monday, Thursday -> Friday, month end', () => {
  assert.strictEqual(H.nextWeekday('2026-11-20'), '2026-11-23'); assert.strictEqual(H.nextWeekday('2026-11-19'), '2026-11-20'); assert.strictEqual(H.nextWeekday('2026-11-30'), '2026-12-01');
});
T('legsFor: A same-day ATM; B buys ATM and sells $2 further out in the trade direction; C next expiry', () => {
  const up = { dir: 1, e: 101.2 }, dn = { dir: -1, e: 99.4 };
  assert.deepStrictEqual(H.legsFor('A', 'SPY', '2026-11-20', up), [{ s: 'SPY261120C00101000', q: 1 }]);
  assert.deepStrictEqual(H.legsFor('B', 'SPY', '2026-11-20', up), [{ s: 'SPY261120C00101000', q: 1 }, { s: 'SPY261120C00103000', q: -1 }]);
  assert.deepStrictEqual(H.legsFor('B', 'QQQ', '2026-11-20', dn), [{ s: 'QQQ261120P00099000', q: 1 }, { s: 'QQQ261120P00097000', q: -1 }]);
  assert.deepStrictEqual(H.legsFor('C', 'SPY', '2026-11-20', up), [{ s: 'SPY261123C00101000', q: 1 }]);
});
const ob1 = (v, t0) => { const a = []; for (let i = 0; i < 400; i++) a.push({ t: t0 + i * 60000, o: v, c: v }); return a; };
T('priceTrade: single leg, vertical debit, skips', () => {
  const t0 = tOf('2026-11-16', 600), p = { tIn: t0 }, xt = t0 + 120 * 60000, legsB = [{ s: 'L', q: 1 }, { s: 'S', q: -1 }];
  let r = H.priceTrade([{ s: 'L', q: 1 }], { L: ob1(1.5, t0) }, p, xt); assert(Math.abs(r.debit - 1.5) < 1e-9); assert.strictEqual(r.nf, 2); assert.strictEqual(r.ml, 150); assert.strictEqual(r.gross, 0);
  r = H.priceTrade(legsB, { L: ob1(1.0, t0), S: ob1(0.3, t0) }, p, xt); assert(Math.abs(r.debit - 0.7) < 1e-9); assert.strictEqual(r.nf, 4); assert.strictEqual(r.oob, false);
  assert.strictEqual(H.priceTrade(legsB, { L: ob1(1.0, t0) }, p, xt).skip, 'no option price');
  assert.strictEqual(H.priceTrade([{ s: 'L', q: 1 }], { L: ob1(0.04, t0) }, p, xt).skip, 'no usable entry price');
  assert.strictEqual(H.priceTrade(legsB, { L: ob1(0.5, t0), S: ob1(0.48, t0) }, p, xt).skip, 'no usable entry price'); // debit 0.02 < 0.05
  assert.strictEqual(H.priceTrade([{ s: 'L', q: 1 }], { L: ob1(1, t0 + 10 * 60000) }, p, xt).skip, 'no usable entry price'); // first bar more than 3 minutes late
  assert.strictEqual(H.priceTrade([{ s: 'L', q: 1 }], { L: ob1(1, t0).slice(0, 3) }, p, t0 + 40 * 60000).skip, 'no exit price'); // last bar older than the 30-minute fallback
  r = H.priceTrade(legsB, { L: ob1(1.0, t0), S: ob1(0.3, t0).map((b, i) => i > 100 ? Object.assign({}, b, { c: 1.4 }) : b) }, p, xt); assert.strictEqual(r.oob, true); // short leg marked above the long: out of bounds, flagged
});
T('metrics: per-fill cost applied ($0.03 x 100 x fills), all-days average, drop-best-5', () => {
  const rows = []; for (let i = 0; i < 8; i++) rows.push({ day: '2026-02-0' + (i + 1), gross: i === 0 ? 100 : -10, nf: 2, ml: 100, xr: 0 });
  const m = H.metrics(rows, 0.03, 16);
  assert.strictEqual(m.n, 8); assert.strictEqual(m.avg, r2((100 - 6 + 7 * (-10 - 6)) / 8)); assert.strictEqual(m.avgAllDays, r2((100 - 6 + 7 * (-10 - 6)) / 16));
  assert.strictEqual(m.shareDays, 50); assert.strictEqual(m.avgDropBest5, -16); assert.strictEqual(m.worst, -16); assert.strictEqual(m.best, 94);
  const m4 = H.metrics([{ day: 'x', gross: 0, nf: 4, ml: 1, xr: 0 }], 0.05, 1); assert.strictEqual(m4.avg, -20); // B pays 4 fills at $0.05 = $20
});
T('analyze: cap filter removes trades whose max loss exceeds $150, and paired diff vs A', () => {
  const mk = (v, day, gross, ml) => ({ sym: 'SPY', day, v, gross, nf: v === 'B' ? 4 : 2, ml, xr: 0 });
  const rows = [mk('A', '2026-02-01', 10, 200), mk('A', '2026-02-02', 10, 100), mk('B', '2026-02-01', 30, 90), mk('B', '2026-02-02', 30, 90)];
  const an = H.analyze(rows, { SPY: ['2026-02-01', '2026-02-02'] }, { boot: 50 });
  assert.strictEqual(an.res['SPY|A|lock|c0.03|all'].n, 2); assert.strictEqual(an.res['SPY|A|lock|c0.03|cap'].n, 1);
  assert.strictEqual(an.diffs['SPY|B|lock|c0.03|cap'].pairedDays, 1); assert.strictEqual(an.diffs['SPY|B|lock|c0.03|all'].pairedDays, 2);
});
T('reproCheck: matches only on same n and avg within $0.50; unreadable bt13 -> not verified', () => {
  const rows = [{ sym: 'SPY', day: '2025-05-01', v: 'A', gross: 12, nf: 2, ml: 90, xr: 0 }, { sym: 'SPY', day: '2026-02-02', v: 'A', gross: 8, nf: 2, ml: 90, xr: 0 }, { sym: 'SPY', day: '2026-11-18', v: 'A', gross: 500, nf: 2, ml: 90, xr: 0 }], ses = { SPY: [] };
  const bt = { res: { 'SPY|e15|t1.25|be0.5|train': { n: 1, avg: 10 }, 'SPY|e15|t1.25|be0.5|lock': { n: 1, avg: 6 } } }; // 12-2 = 10, 8-2 = 6; 2026-11-18 is after bt13's last day and ignored
  assert.strictEqual(H.reproCheck(rows, ses, bt).ok, true);
  bt.res['SPY|e15|t1.25|be0.5|lock'].avg = 6.6; assert.strictEqual(H.reproCheck(rows, ses, bt).ok, false);
  bt.res['SPY|e15|t1.25|be0.5|lock'] = { n: 2, avg: 6 }; assert.strictEqual(H.reproCheck(rows, ses, bt).ok, false);
  assert.strictEqual(H.reproCheck(rows, ses, null).ok, null);
});
T('evaluate: pass criteria, unproven label, lock n, control gate', () => {
  const an = { res: {} }; const put = (s, v, p, f, o) => { an.res[[s, v, p, 'c0.03', f].join('|')] = o; };
  for (const s of ['SPY', 'QQQ']) for (const p of ['train', 'lock']) { put(s, 'A', p, 'cap', { n: 120, avg: 1 }); put(s, 'B', p, 'cap', { n: 120, avg: 5, pf: 1.3, avgDropBest5: 2, ci: [1, 9] }); put(s, 'C', p, 'cap', { n: 120, avg: -1, pf: 0.9, avgDropBest5: -3 }); }
  let e = H.evaluate(an, { ok: true }, 'cap'); assert.strictEqual(e.B.advance, true); assert(/passes/.test(e.B.verdict)); assert.strictEqual(e.C.advance, false);
  e = H.evaluate(an, { ok: false }, 'cap'); assert.strictEqual(e.B.advance, false);
  put('SPY', 'B', 'lock', 'cap', { n: 120, avg: 5, pf: 1.3, avgDropBest5: 2, ci: [-1, 9] }); e = H.evaluate(an, { ok: true }, 'cap'); assert(/unproven/.test(e.B.verdict));
  put('SPY', 'B', 'lock', 'cap', { n: 99, avg: 5, pf: 1.3, avgDropBest5: 2, ci: [1, 9] }); e = H.evaluate(an, { ok: true }, 'cap'); assert.strictEqual(e.B.c4_lock_n100, false);
});

/* end to end with a fake Alpaca client, no sleeping */
ta('run: breakout day produces A/B/C rows, no-breakout day is counted, bt13 unreadable -> control not verified', async () => {
  const days = ['2026-11-16', '2026-11-17'], stock = [];
  days.forEach((D, i) => (i === 0 ? breakout(D) : day(D, () => null)).forEach(b => stock.push({ t: new Date(b.t).toISOString(), o: b.o, h: b.h, l: b.l, c: b.c })));
  const calls = []; const ap = async (path, qs) => {
    calls.push(path);
    if (path.startsWith('/v2/stocks/')) return { bars: stock };
    const t0 = Date.parse('2026-11-16T14:30:00Z'), bars = {}; String(qs.symbols).split(',').forEach(s => { bars[s] = ob1(s.endsWith('00103000') ? 0.3 : 1.0, t0).map(b => ({ t: new Date(b.t).toISOString(), o: b.o, c: b.c })); }); return { bars };
  };
  const kv = {}; const kset = async (k, v) => { kv[k] = JSON.parse(JSON.stringify(v)); };
  const out = await study(ap, kset, { syms: ['SPY'], gap: 0, boot: 40, kget: async () => null });
  assert.strictEqual(out.progress, 'done'); assert.strictEqual(out.n.SPY.sessions, 2);
  assert.strictEqual(out.rows.length, 3); assert.deepStrictEqual(out.rows.map(r => r[2]).sort(), ['A', 'B', 'C']);
  assert.strictEqual(out.skipped['A|no breakout'], 1); assert.strictEqual(out.control.ok, null); assert(/NOT verified|DID NOT/.test(out.verdictNote));
  const a = out.res['SPY|A|lock|c0.01|all'], b = out.res['SPY|B|lock|c0.01|all'];
  assert.strictEqual(a.n, 1); assert.strictEqual(a.avg, -2); assert.strictEqual(b.avg, -4); // flat prices: only costs; B pays 4 fills
  assert.strictEqual(out.res['SPY|A|lock|c0.05|all'].avg, -10); assert.strictEqual(out.res['SPY|B|lock|c0.05|all'].avg, -20);
  assert(calls.some(p => p.includes('/options/bars')));
  JSON.stringify(out); // must be storable
});
ta('run: a day that throws is counted in errs and does not stop the run', async () => {
  let n = 0; const stock = []; breakout('2026-11-16').forEach(b => stock.push({ t: new Date(b.t).toISOString(), o: b.o, h: b.h, l: b.l, c: b.c }));
  const ap = async path => { if (path.startsWith('/v2/stocks/')) return { bars: stock }; n++; throw new Error('boom'); };
  const out = await study(ap, async () => {}, { syms: ['QQQ'], gap: 0, boot: 20 });
  assert.strictEqual(out.progress, 'done'); assert.strictEqual(out.errs, 1); assert(/boom/.test(out.lastErr)); assert.strictEqual(n, 2); // one retry
});

(async () => {
  for (const [name, fn] of TA) { try { await fn(); pass++; console.log('ok   ' + name); } catch (e) { console.log('FAIL ' + name + ' -> ' + (e && e.message)); process.exitCode = 1; } }
  console.log(pass + ' passed' + (process.exitCode ? ', FAILURES above' : ''));
})();
