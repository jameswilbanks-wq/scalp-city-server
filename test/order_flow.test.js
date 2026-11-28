/* Order flow chart on the open trade cards (orderflow.js + the /flow routes). Display only; the point of most of these tests is that it can never crowd out the calls the stops depend on, and that guests get nothing while FLOW_GUESTS is off.
   Runs offline: fake trade pages, fake clock. */
'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path');
const OF = require('../orderflow.js');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'), HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'deck.html'), 'utf8');
const tests = []; const t = (n, f) => tests.push([n, f]);
const T0 = Date.parse('2026-11-30T15:30:20.000Z');
const trade = (ms, p, s, i) => ({ t: new Date(ms).toISOString(), p, s, i });
function rig(pages) { let clock = T0; const calls = []; const get = (p, qs) => { calls.push({ p, qs: Object.assign({}, qs) }); const r = pages(calls.length, qs, clock); return r instanceof Error ? Promise.reject(r) : Promise.resolve(r); }; return { f: OF.create(get, () => clock), calls, tick: ms => { clock += ms; } }; }

t('aggregate: volume by price adds up to every share in the window, the busiest price is marked, older trades are left out', () => {
  const list = [{ ms: T0 - 40 * 60000, p: 700, s: 999999, d: 0 }, { ms: T0 - 20 * 60000, p: 701.00, s: 100, d: 1 }, { ms: T0 - 20 * 60000 + 5, p: 701.00, s: 300, d: -1 }, { ms: T0 - 1000, p: 701.50, s: 50, d: 1 }];
  const a = OF.aggregate(list, T0);
  assert.strictEqual(a.n, 3); assert.strictEqual(a.profile.reduce((x, r) => x + r[1], 0), 450); assert.strictEqual(a.poc, 701); assert.deepStrictEqual([a.lo, a.hi, a.last.p], [701, 701.5, 701.5]);
  assert.strictEqual(a.bubbles.reduce((x, b) => x + b[2], 0), 450); assert.strictEqual(a.bubbles.length, 3, 'up and down in the same minute and price stay separate'); assert.strictEqual(a.bubbles[0][2], 300, 'largest first');
  assert.ok(a.line.every(r => r[0] >= 0 && r[0] <= 30)); assert.strictEqual(a.from % 60000, 0, 'columns sit on clock minutes');
  assert.strictEqual(OF.aggregate([], T0).n, 0);
});
t('aggregate stays small on a very busy, wide window', () => {
  const list = []; for (let i = 0; i < 20000; i++) list.push({ ms: T0 - 28 * 60000 + i * 80, p: 600 + (i % 997) / 100, s: 1 + (i % 300), d: i % 2 ? 1 : -1 });
  const a = OF.aggregate(list, T0); assert.ok(a.profile.length <= 25, 'rows ' + a.profile.length); assert.ok(a.bubbles.length <= OF.MAX_BUBBLES); assert.ok(JSON.stringify(a).length < 12000, 'payload ' + JSON.stringify(a).length);
});
t('one fetch is shared by every viewer, the next waits 15 s and asks only for newer trades, repeats are not counted twice, and the up/down tag follows the price', async () => {
  const r = rig(n => n === 1 ? { trades: { SPY: [trade(T0 - 5000, 701, 10, 1), trade(T0 - 4000, 701.1, 20, 2)] } } : { trades: { SPY: [trade(T0 - 4000, 701.1, 20, 2), trade(T0 + 1000, 701.05, 30, 3), trade(T0 + 2000, 701.05, 40, 4)] } });
  const [a, b] = await Promise.all([r.f.view('SPY'), r.f.view('SPY')]); assert.strictEqual(r.calls.length, 1, 'two viewers, one request'); assert.strictEqual(a.state, 'ok'); assert.strictEqual(b.n, 2);
  assert.strictEqual(r.calls[0].p, '/v2/stocks/trades'); assert.strictEqual(r.calls[0].qs.feed, 'iex'); assert.strictEqual(Date.parse(r.calls[0].qs.start), T0 - OF.WINDOW);
  r.tick(OF.TTL - 1); await r.f.view('SPY'); assert.strictEqual(r.calls.length, 1);
  r.tick(1); const c = await r.f.view('SPY'); assert.strictEqual(r.calls.length, 2); assert.strictEqual(r.calls[1].qs.start, new Date(T0 - 4000).toISOString()); assert.strictEqual(c.n, 4, 'the repeated trade is counted once');
  assert.deepStrictEqual(r.f.cache.SPY.trades.map(x => x.d), [0, 1, -1, -1], 'same price keeps the last direction');
});
t('a long catch-up is capped per refresh and is never drawn as if it were the whole window', async () => {
  let id = 0; const r = rig(n => n <= OF.MAX_PAGES ? { trades: { SPY: [trade(T0 - 60000 + n, 701, 10, ++id)] }, next_page_token: 'more' } : { trades: { SPY: [trade(T0 - 1000, 701, 10, ++id)] } });
  const a = await r.f.view('SPY'); assert.strictEqual(r.calls.length, OF.MAX_PAGES); assert.strictEqual(a.state, 'loading'); assert.strictEqual(a.profile, undefined);
  r.tick(OF.TTL); const b = await r.f.view('SPY'); assert.strictEqual(b.state, 'ok'); assert.strictEqual(b.n, OF.MAX_PAGES + 1);
});
t('the minute budget holds no matter how many symbols or how often the page asks', async () => {
  const r = rig(() => ({ trades: {}, next_page_token: 'more' }));
  for (let i = 0; i < 200; i++) { await r.f.view('S' + (i % 12)); r.tick(200); }
  assert.ok(r.calls.length <= OF.BUDGET, 'requests in 40 s: ' + r.calls.length); assert.ok(OF.BUDGET <= 40, 'well under the 200 a minute of the free plan');
});
t('a 429 pauses every symbol for 60 s; the last good picture stays, marked stale when old', async () => {
  let fail = false; const r = rig(() => fail ? new Error('alpaca 429 too many requests') : { trades: { SPY: [trade(T0 - 5000, 701, 10, 1)], QQQ: [trade(T0 - 5000, 600, 10, 2)] } });
  await r.f.view('SPY'); fail = true; r.tick(OF.TTL); const a = await r.f.view('SPY'); assert.strictEqual(a.state, 'ok'); const n = r.calls.length;
  r.tick(30000); const q = await r.f.view('QQQ'); assert.strictEqual(r.calls.length, n, 'no request for another symbol during the pause'); assert.strictEqual(q.state, 'unavailable');
  r.tick(29000); await r.f.view('SPY'); assert.strictEqual(r.calls.length, n); r.tick(20000); const b = await r.f.view('SPY'); assert.strictEqual(r.calls.length, n + 1, 'asks again after the pause'); assert.strictEqual(b.stale, true);
});
t('a failed first load says unavailable, an empty window says empty', async () => {
  const bad = rig(() => new Error('alpaca 500 boom')); assert.strictEqual((await bad.f.view('SPY')).state, 'unavailable');
  const none = rig(() => ({ trades: {} })); assert.strictEqual((await none.f.view('SPY')).state, 'empty');
});

function fn(name) { const i = SRC.indexOf('async function ' + name + '('); assert.ok(i >= 0, 'missing ' + name); let d = 0; for (let k = SRC.indexOf('{', SRC.indexOf(')', i)); k < SRC.length; k++) { if (SRC[k] === '{') d++; else if (SRC[k] === '}') { d--; if (d === 0) return SRC.slice(i, k + 1); } } throw new Error('unbalanced'); }
function route(guests, open, o) {
  o = o || {}; const asked = [];
  const f = new Function('FLOW_GUESTS', 'P', 'USE_ALPACA', 'marketOpen', 'FLOW', fn('flowOut') + '\nreturn flowOut;')(guests, { rec: { mank: { open: open.mank || [] }, sonk: { open: open.sonk || [] }, gfk: { open: open.gfk || [] } } }, true, () => o.market !== false, { view: async s => { asked.push(s); return { state: 'ok', n: 1, err: 'x' }; } });
  return { call: (cfg, sym) => f(cfg, new URL('http://x/api/flow?sym=' + sym)), asked };
}
const MAN = { key: 'mank', guest: false }, SON = { key: 'sonk', guest: true }, GF = { key: 'gfk', guest: true };
t('the route: only a symbol that book has open; nothing fetched when the market is closed; guests get nothing unless FLOW_GUESTS is on', async () => {
  const open = { mank: [{ sym: 'SPY' }], sonk: [{ sym: 'QQQ' }], gfk: [] };
  const off = route(false, open); assert.strictEqual((await off.call(MAN, 'spy')).state, 'ok'); assert.deepStrictEqual(await off.call(SON, 'QQQ'), { ok: true, state: 'off' }); assert.deepStrictEqual(await off.call(GF, 'SPY'), { ok: true, state: 'off' }); assert.deepStrictEqual(off.asked, ['SPY']);
  assert.strictEqual((await off.call(MAN, 'QQQ')).ok, false, 'a guest position does not open anything on James route');
  const on = route(true, open); assert.strictEqual((await on.call(SON, 'QQQ')).state, 'ok'); assert.strictEqual((await on.call(SON, 'SPY')).ok, false, 'the son cannot ask for James symbols'); assert.strictEqual((await on.call(GF, 'QQQ')).ok, false); assert.deepStrictEqual(on.asked, ['QQQ']);
  const shut = route(true, open, { market: false }); assert.strictEqual((await shut.call(MAN, 'SPY')).state, 'closed'); assert.deepStrictEqual(shut.asked, []);
  assert.strictEqual((await off.call(MAN, 'SPY')).err, undefined, 'no error text from the data service reaches the page');
});
t('guests are off by default, and nothing in the trading loop touches order flow', () => {
  assert.ok(SRC.includes("const FLOW_GUESTS = process.env.FLOW_GUESTS === '1'"));
  const uses = SRC.split('\n').filter(l => /\bFLOW\.|flowOut\(/.test(l)); assert.strictEqual(uses.length, 4, uses.join('\n')); // the function, the view call inside it, the two routes
});
t('the page: each deck calls only its own flow route, both languages are written, and the section stays hidden until the server turns it on', () => {
  for (const u of ["'/api/flow?'", "'/api/son/flow?'", "'/api/gf/flow?'"]) assert.strictEqual(HTML.split(u).length - 1, 1, u);
  assert.ok(HTML.includes('data-f="flow" hidden')); assert.ok(HTML.includes("r.state==='off'")); for (const w of ['Flujo de órdenes · acción', 'Solo una bolsa (IEX)', 'El precio subió (estimado)', 'No muestra las órdenes en espera']) assert.ok(HTML.includes(w), w);
});

(async () => { let ok = 0; for (const [n, f] of tests) { try { await f(); ok++; console.log('ok - ' + n); } catch (e) { console.log('FAIL - ' + n + '\n  ' + (e && e.stack || e)); process.exitCode = 1; } } console.log(ok + '/' + tests.length + ' passed'); })();
