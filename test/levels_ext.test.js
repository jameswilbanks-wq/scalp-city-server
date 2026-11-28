/* Extended price levels (levels_ext.js) for the Trade Deck: previous day/week/month high-low, Fibonacci of the prior day, previous-day 4-hour blocks, prior-session volume profile, open-interest walls, estimated GEX, and the refresher that loads them. James 2026-11-27 asked for these as support/resistance reference lines (display only; nothing feeds an order). Fixtures are real SPY numbers read from Alpaca on 2026-11-27 (weekly bar week of 11/23 H 729.15 L 695.45; October H 781.62 L 750.36; Friday 11/27 early close 13:00 with 30-minute bars). Behaviour under test: previous period chosen by DATE (Monday pre-open, Monday mid-session, Tuesday 12/1 month flip, weekend); Fibonacci arithmetic for an up and a down day; the 4-hour blocks on a normal day and on the early-close day (after-hours print excluded, second block absent and marked partial); volume-profile POC and value area; OI walls respect the price side; Black-Scholes gamma agrees with the gamma Alpaca reported; GEX flip sits between the put and call clusters; the refresher survives each part failing on its own, falls back from SIP to IEX and records it, throttles retries, and the payload never carries strike arrays; signals.levels no longer reports prior-day levels from a partial session. Related: signals.test.js, deck_page.test.js. Run: node test/levels_ext.test.js */
'use strict';
const assert = require('assert'), L = require('../levels_ext.js'), Sig = require('../signals.js');
let pass = 0; const tests = []; const t = (n, f) => tests.push([n, f]);
const W = [{ t: '2026-11-02T05:00:00Z', o: 759.45, h: 775.64, l: 732.71, c: 735.29 }, { t: '2026-11-09T05:00:00Z', o: 741.95, h: 763.04, l: 741.025, c: 754.37 }, { t: '2026-11-16T05:00:00Z', o: 749.66, h: 749.82, l: 686.75, c: 689.81 }, { t: '2026-11-23T05:00:00Z', o: 724.33, h: 729.15, l: 695.45, c: 728.32 }];
const M = [{ t: '2026-09-01T04:00:00Z', o: 762.01, h: 775.14, l: 749.6, c: 762.63 }, { t: '2026-10-01T04:00:00Z', o: 764.36, h: 781.62, l: 750.36, c: 755.72 }, { t: '2026-11-01T04:00:00Z', o: 759.45, h: 775.64, l: 686.75, c: 728.32 }];
const D = [{ t: '2026-11-23T05:00:00Z', o: 724.33, h: 727.98, l: 713.53, c: 722.29 }, { t: '2026-11-24T05:00:00Z', o: 715.148, h: 720.93, l: 712.14, c: 718.78 }, { t: '2026-11-25T05:00:00Z', o: 703.2, h: 718.43, l: 695.45, c: 716.7 }, { t: '2026-11-27T05:00:00Z', o: 725.86, h: 729.15, l: 719.61, c: 728.32 }];
const at = s => Date.parse(s);
// real 30-minute SPY bars for 2026-11-27 (UTC stamps): pre-market, the early-close session 14:30Z-18:00Z, and the after-close prints
const B30 = [['09:00', 731.485, 727.98], ['13:30', 728.667, 727.7136], ['14:00', 727.77, 725.84], ['14:30', 726.09, 720], ['15:00', 723.69, 719.61], ['15:30', 726.62, 722.71], ['16:00', 725.7, 724.11], ['16:30', 728, 725.22], ['17:00', 727.32, 725.75], ['17:30', 729.15, 725.26], ['18:00', 729.2, 726.09], ['19:00', 729.09, 728.27], ['21:00', 731.2, 730.51]].map(x => ({ t: '2026-11-27T' + x[0] + ':00Z', o: x[1], h: x[1], l: x[2], c: x[2], v: 1000 }));

t('reference day and previous periods are chosen by date: Monday pre-open, Monday mid-session, Tuesday 12/1 month flip, weekend', () => {
  assert.strictEqual(L.refDay(at('2026-11-27T21:50:00Z')), '2026-11-27'); assert.strictEqual(L.refDay(at('2026-11-28T15:00:00Z')), '2026-11-30'); assert.strictEqual(L.refDay(at('2026-11-29T15:00:00Z')), '2026-11-30'); assert.strictEqual(L.refDay(at('2026-11-30T13:00:00Z')), '2026-11-30');
  const pre = L.htf(D, W, M, at('2026-11-30T13:00:00Z'));
  assert.deepStrictEqual([pre.pdDay, pre.pdh, pre.pdl, pre.pdc], ['2026-11-27', 729.15, 719.61, 728.32]); assert.deepStrictEqual([pre.pwStart, pre.pwh, pre.pwl], ['2026-11-23', 729.15, 695.45]); assert.deepStrictEqual([pre.pmStart, pre.pmh, pre.pml], ['2026-10-01', 781.62, 750.36]);
  const wk = L.htf(D, W, M, at('2026-11-28T15:00:00Z')); assert.deepStrictEqual([wk.pwh, wk.pml], [729.15, 750.36], 'weekend shows the same levels Monday will');
  const mid = L.htf(D.concat([{ t: '2026-11-30T05:00:00Z', o: 728, h: 735, l: 727, c: 734 }]), W.concat([{ t: '2026-11-30T05:00:00Z', o: 728, h: 735, l: 727, c: 734 }]), M, at('2026-11-30T17:00:00Z'));
  assert.deepStrictEqual([mid.pdDay, mid.pwh, mid.pmh], ['2026-11-27', 729.15, 781.62], 'today\'s partial bars are never "previous"');
  const dec = L.htf(D, W.concat([{ t: '2026-11-30T05:00:00Z', h: 735, l: 727 }]), M.concat([{ t: '2026-12-01T05:00:00Z', o: 734, h: 736, l: 730, c: 735 }]), at('2026-12-01T15:00:00Z'));
  assert.deepStrictEqual([dec.pmStart, dec.pmh, dec.pml, dec.pwStart], ['2026-11-01', 775.64, 686.75, '2026-11-23'], 'on 12/1 the previous month is November');
});
t('Fibonacci of the prior day: up day measures down from the high, down day measures up from the low', () => {
  const up = L.fib({ pdo: 725.86, pdh: 729.15, pdl: 719.61, pdc: 728.32 }); assert.deepStrictEqual(up, { dir: 'up', f382: 725.51, f500: 724.38, f618: 723.25 });
  const dn = L.fib({ pdo: 100, pdh: 101, pdl: 98, pdc: 99 }); assert.deepStrictEqual(dn, { dir: 'down', f382: 99.15, f500: 99.5, f618: 99.85 });
  assert.strictEqual(L.fib({ pdo: 1, pdh: 5, pdl: 5, pdc: 5 }), null); assert.strictEqual(L.fib({}), null);
});
t('previous-day 4-hour blocks: early-close day keeps only the first block (partial), excludes pre-market and after-close prints', () => {
  const r = L.fourHour(B30, '2026-11-27', 780); assert.deepStrictEqual(r, { amH: 729.15, amL: 719.61, pmH: null, pmL: null, amPartial: true }, 'matches the daily high 729.15 and low 719.61; the 729.2 and 731.2 prints after 13:00 are excluded');
  assert.strictEqual(L.fourHour([], '2026-11-27', 960), null);
  const mk = (h, m, hi, lo) => ({ t: new Date(Date.UTC(2026, 11, 1, h + 5, m)).toISOString(), h: hi, l: lo, c: lo, o: lo, v: 1 });
  const nm = L.fourHour([mk(9, 30, 10, 9), mk(13, 0, 12, 8), mk(13, 30, 15, 11), mk(15, 30, 14, 10)], '2026-12-01', 960); assert.deepStrictEqual([nm.amH, nm.amL, nm.pmH, nm.pmL, nm.amPartial], [12, 8, 15, 10, false], 'the 13:30 bar belongs to the second block');
});
t('volume profile: POC is the busiest price, the value area is grown toward the busier side until 70% of volume', () => {
  const mk = (i, px, v) => ({ t: new Date(Date.UTC(2026, 11, 1, 14, 30 + i)).toISOString(), h: px, l: px, c: px, o: px, v });
  let bars = [], i = 0; [[100.025, 30], [100.075, 25], [99.975, 20], [100.125, 15], [99.925, 10]].forEach(x => { for (let k = 0; k < x[1]; k++) bars.push(mk(i++, x[0], 10)); });
  bars.push(mk(i++, 100.025, 1)); const p = L.volProfile(bars, '2026-12-01', 960);
  assert.ok(Math.abs(p.poc - 100.025) < 0.011 && Math.abs(p.vah - 100.075) < 0.011 && Math.abs(p.val - 99.975) < 0.011, JSON.stringify(p));
  assert.strictEqual(L.volProfile(bars.slice(0, 10), '2026-12-01', 960), null, 'too few bars gives nothing');
});
t('open interest walls: call wall at or above the price, put wall at or below, max over everything; zero-OI ignored', () => {
  const c = [{ strike: 730, type: 'call', oi: 5000 }, { strike: 735, type: 'call', oi: 9000 }, { strike: 725, type: 'call', oi: 12000 }, { strike: 725, type: 'put', oi: 8000 }, { strike: 720, type: 'put', oi: 15000 }, { strike: 730, type: 'put', oi: 20000 }, { strike: 740, type: 'call', oi: 0 }];
  assert.deepStrictEqual(L.oiLevels(c, 728), { callWall: { strike: 735, oi: 9000 }, putWall: { strike: 720, oi: 15000 }, max: { strike: 730, oi: 25000 } }); assert.deepStrictEqual(L.oiLevels([], 728), { callWall: null, putWall: null, max: null });
});
t('Black-Scholes gamma agrees with the gamma Alpaca reported for SPY 726C (0.0373) within 8%', () => {
  const T = (at('2026-11-30T21:00:00Z') - at('2026-11-27T18:14:59Z')) / (365 * 864e5), g = L.bsGamma(728.32, 726, T, 0.1602);
  assert.ok(Math.abs(g - 0.0373) / 0.0373 < 0.08, 'got ' + g); assert.strictEqual(L.bsGamma(0, 726, T, 0.16), 0); assert.strictEqual(L.bsGamma(728, 726, 0, 0.16), 0);
});
t('GEX estimate: calls above and puts below give a flip between them, walls on the right sides, flip null when only one kind exists', () => {
  const now = at('2026-11-30T15:00:00Z'), row = (strike, type, oi) => ({ strike, type, oi, exp: '2026-12-04', iv: 0.2 });
  const rows = [row(104, 'call', 3000), row(102, 'call', 400), row(96, 'put', 3000), row(98, 'put', 400), row(100, 'call', 50), row(100, 'put', 50)];
  const g = L.gexLevels(rows, 100, now); assert.ok(g && g.netUSD > 0, JSON.stringify(g)); assert.strictEqual(g.callWall, 104); assert.strictEqual(g.putWall, 96); assert.ok(g.flip !== null && g.flip > 94 && g.flip < 100, 'flip ' + g.flip);
  const only = L.gexLevels([104, 105, 106, 107, 108, 109].map(s => row(s, 'call', 500)), 100, now); assert.strictEqual(only.flip, null); assert.strictEqual(only.putWall, null); assert.strictEqual(L.gexLevels(rows.slice(0, 3), 100, now), null, 'too few contracts gives nothing');
});
function mockApi(over) {
  const calls = []; const api = {
    calls, async bars(sym, tf, s, e, feed) { calls.push('bars:' + tf + ':' + feed); if (over && over.sipBlocked && feed === 'sip') throw new Error('403 subscription does not permit querying recent SIP data'); if (over && over.barsFail) throw new Error('bars down');
      return tf === '1Day' ? D : tf === '1Week' ? W : tf === '1Month' ? M : tf === '30Min' ? B30 : Array.from({ length: 210 }, (x, i) => ({ t: new Date(Date.UTC(2026, 10, 27, 14, 30 + i)).toISOString(), h: 728 + (i % 3) * 0.1, l: 727.9, c: 728, o: 728, v: 100 + i })); },
    async calendar(a) { calls.push('cal'); return [{ date: a, close: '13:00' }]; },
    async contracts() { calls.push('contracts'); if (over && over.oiFail) throw new Error('contracts down'); const o = []; for (let s = 700; s <= 760; s += 1) { o.push({ symbol: 'SPY261204C' + s, type: 'call', strike_price: String(s), open_interest: String(s >= 728 ? 1000 + s % 7 * 100 : 300), expiration_date: '2026-12-04', open_interest_date: '2026-11-27' }); o.push({ symbol: 'SPY261204P' + s, type: 'put', strike_price: String(s), open_interest: String(s <= 728 ? 1000 + s % 5 * 100 : 300), expiration_date: '2026-12-04', open_interest_date: '2026-11-27' }); } return { option_contracts: o }; },
    async snaps() { calls.push('snaps'); const s = {}; for (let k = 700; k <= 760; k++) { s['SPY261204C' + k] = { impliedVolatility: 0.18 }; s['SPY261204P' + k] = { impliedVolatility: 0.19 }; } return { snapshots: s }; }
  }; return api;
}
t('refresher: loads every part, records the feed, never puts strike arrays in the payload', async () => {
  const api = mockApi(), st = {}, o = { now: at('2026-11-30T15:00:00Z'), open: true, spot: () => 728.3 }; await L.refreshSym(api, 'SPY', st, o);
  const c = L.compact(st); assert.strictEqual(c.htf.pdh, 729.15); assert.strictEqual(c.fib.dir, 'up'); assert.strictEqual(c.h4.amH, 729.15); assert.ok(c.vp && c.vp.poc > 727 && c.vp.poc < 729); assert.ok(c.oi.callWall.strike >= 728 && c.oi.putWall.strike <= 728 && c.oi.oiDate === '2026-11-27'); assert.ok(c.gex && c.gex.n > 20); assert.strictEqual(c.feed, 'sip'); assert.strictEqual(c.err, null);
  const text = JSON.stringify(c); assert.ok(text.length < 1500, 'payload stays small: ' + text.length); assert.ok(!('oiRows' in c) && !('ivMap' in c));
});
t('refresher: SIP refused falls back to IEX and says so; market closed means no gamma call; a failing part leaves the others working and never throws', async () => {
  let api = mockApi({ sipBlocked: true }), st = {}; await L.refreshSym(api, 'SPY', st, { now: at('2026-11-28T15:00:00Z'), open: false, spot: () => 728.3 });
  assert.strictEqual(L.compact(st).feed, 'iex'); assert.ok(!api.calls.includes('snaps'), 'no gamma pull while the market is closed'); assert.strictEqual(L.compact(st).gex, null); assert.ok(L.compact(st).oi);
  api = mockApi({ oiFail: true }); st = {}; await L.refreshSym(api, 'QQQ', st, { now: at('2026-11-30T15:00:00Z'), open: true, spot: () => 650 }); const c = L.compact(st); assert.ok(c.htf && c.h4 && c.vp, 'bar levels survive'); assert.strictEqual(c.oi, null); assert.ok(/contracts down/.test(c.err));
  api = mockApi({ barsFail: true }); st = {}; await L.refreshSym(api, 'AAPL', st, { now: at('2026-11-30T15:00:00Z'), open: true, spot: () => 231 }); assert.ok(/bars down|no previous/.test(L.compact(st).err)); assert.strictEqual(L.compact(st).htf, null);
});
t('refresher: a failed load is not retried inside 10 minutes; a good load is not repeated the same day; gamma refreshes about every 10 minutes', async () => {
  let api = mockApi({ barsFail: true }), st = {}, now = at('2026-11-30T15:00:00Z'); await L.refreshSym(api, 'SPY', st, { now, open: true, spot: () => 728 }); const n1 = api.calls.length; await L.refreshSym(api, 'SPY', st, { now: now + 120000, open: true, spot: () => 728 }); assert.strictEqual(api.calls.length, n1, 'throttled');
  api = mockApi(); st = {}; await L.refreshSym(api, 'SPY', st, { now, open: true, spot: () => 728.3 }); const a = api.calls.filter(x => x.startsWith('bars')).length; await L.refreshSym(api, 'SPY', st, { now: now + 660000, open: true, spot: () => 728.9 });
  assert.strictEqual(api.calls.filter(x => x.startsWith('bars')).length, a, 'bar levels loaded once per day'); assert.strictEqual(api.calls.filter(x => x === 'snaps').length, 2, 'gamma pulled again after 10 minutes'); assert.strictEqual(api.calls.filter(x => x === 'contracts').length, 1, 'open interest pulled once per day');
});
t('signals.levels: prior-day levels are withheld when the bar window starts mid-session (a restart), kept when the prior session is whole', () => {
  const mk = (day, min, p) => ({ t: Date.parse('2026-11-30T14:30:00Z') + (min - 570) * 60000, day, min, o: p, h: p + 1, l: p - 1, c: p, v: 100 });
  const whole = [mk('2026-11-27', 570, 100), mk('2026-11-27', 700, 102), mk('2026-11-30', 570, 101), mk('2026-11-30', 575, 101)]; assert.strictEqual(Sig.levels(whole).pdh, 103);
  const partial = [mk('2026-11-27', 660, 100), mk('2026-11-27', 700, 102), mk('2026-11-30', 570, 101), mk('2026-11-30', 575, 101)]; const p = Sig.levels(partial); assert.deepStrictEqual([p.pdh, p.pdl, p.pdc], [null, null, null]); assert.ok(p.dh && p.dl, 'today\'s own levels still work');
});
(async () => { for (const [n, f] of tests) { try { await f(); pass++; console.log('ok   ' + n); } catch (e) { console.log('FAIL ' + n + '\n' + (e && e.stack || e)); } } console.log(pass + '/' + tests.length + ' passed'); process.exit(pass === tests.length ? 0 : 1); })();
