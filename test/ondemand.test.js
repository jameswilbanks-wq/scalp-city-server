/* On-demand 0DTE paper order (server.js: MAN constants, manualEnter, manageMan, the /api/ondemand route, the MAN row/panel in public/city.html) test. Behaviour under test: James picks call or put, SPY or QQQ, and 1 to 3 contracts; the server journals a simulated buy at the ask in its own book r.mank, refuses bad input / closed market / outside 9:30-16:00 ET / more than 3 open / over the correlation cap / no fresh price, closes at the bid on a manual close or at 15:59 ET even on a stale quote, applies an automatic stop only when MAN_STOP is set, and can never call a broker order function. Mock quotes and clock, no network, no orders, no keys. Related tests: manual_close.test.js (the shared manual-close path), csk_priority.test.js (the cap). Run: node test/ondemand.test.js */
'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'), HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'city.html'), 'utf8');
let pass = 0; const tests = []; const t = (n, f) => tests.push([n, f]);
function fn(name) { let i = SRC.indexOf('async function ' + name + '('); if (i < 0) i = SRC.indexOf('function ' + name + '('); assert.ok(i >= 0, 'missing ' + name); let d = 0; for (let k = SRC.indexOf('{', i); k < SRC.length; k++) { if (SRC[k] === '{') d++; else if (SRC[k] === '}') { d--; if (d === 0) return SRC.slice(i, k + 1); } } throw new Error('unbalanced ' + name); }
const line = start => { const i = SRC.indexOf(start); assert.ok(i >= 0, 'missing ' + start); return SRC.slice(i, SRC.indexOf('\n', i)); };
const CODE = [line('const MAN_ON'), ...['corrGroupOpenRiskUSD', 'cskReservedUSD', 'manGuardOn', 'corrCapBlocks', 'manualEnter', 'manageMan', 'manualCloseBook'].map(fn), "const MANUAL_BOOKS = { man: ['mank', manageMan] };"].join('\n');
const NAMES = ['P', 'CFG', 'marketOpen', 'nowET', 'pickContract', 'logSignal', 'saveRec', 'rh', 'iso', 'CORR_GROUPS', 'CORR_CAP_USD', 'CSK_ON', 'CSK', 'CSK2', 'pBars'];
function build(o) {
  o = o || {}; const calls = { pick: [], sig: [] }, env = { open: true, min: 700, noQuote: false, stale: false, bid: 2.0, ask: 2.1, pk: null, delay: 0 };
  const P = { busy: false, info: { SPY: { bar: { c: 710, t: Date.now() - 30000 } }, QQQ: { bar: { c: 640, t: Date.now() - 30000 } } }, rec: { shut: '', csk: { done: {}, open: [] }, x9k: { open: o.x9 || [] }, orbk: { open: [] } } };
  const pickContract = async (sym, dir, px, maxPrem, dte) => { calls.pick.push({ sym, dir, px, maxPrem, dte }); if (env.delay) await new Promise(r => setTimeout(r, env.delay)); return env.pk || { qAge: 1000, inst: 'opt', strike: 710, exp: '2026-11-24', type: dir > 0 ? 'call' : 'put', ask: env.ask, bid: env.bid, iv: 0.2, delta: dir * 0.5 }; };
  const rh = async (n, a) => { if (env.noQuote) return { results: [] }; return { results: a.instrument_ids.map(i => ({ quote: { instrument_id: i, bid_price: String(env.bid), ask_price: String(env.ask), updated_at: new Date(Date.now() - (env.stale ? 600000 : 1000)).toISOString() } })) }; };
  const stubs = [P, { syms: ['SPY', 'QQQ'] }, () => env.open, () => ({ min: env.min, day: '2026-11-24' }), pickContract, (...a) => { calls.sig.push(a); }, () => {}, rh, d => new Date(d).toISOString(), ['SPY', 'QQQ'], o.cap === undefined ? 1200 : o.cap, false, { syms: ['SPY', 'QQQ'], width: 2, min: 660 }, { on: true, min: 750 }, async sym => { calls.bars = (calls.bars || []).concat(sym); return env.noBars ? [] : [{ t: Date.now() - 30000, c: 200 }]; }];
  const api = new Function(...NAMES, CODE + '\nreturn { manualEnter, manageMan, manualCloseBook, MAN };')(...stubs);
  return Object.assign({ P, env, calls }, api);
}

t('call: 2 contracts of SPY are bought at the ask from the same-day chain, journaled in r.mank with cost, qty and a signal log', async () => {
  const w = build(), r = await w.manualEnter('SPY', 'call', '2');
  assert.deepStrictEqual([r.ok, r.type, r.qty, r.ask, r.cost], [true, 'call', 2, 2.1, 420]); assert.deepStrictEqual(w.calls.pick[0], { sym: 'SPY', dir: 1, px: 710, maxPrem: 400, dte: 0 }, 'same-day (dte 0), call = dir 1');
  const p = w.P.rec.mank.open[0]; assert.deepStrictEqual([p.sym, p.qty, p.entryAsk, p.entryBid, p.book], ['SPY', 2, 2.1, 2.0, 'man']); assert.strictEqual(w.calls.sig[0][3], 'entered'); assert.strictEqual(w.P.manBusy, false);
});
t('put: QQQ put uses dir -1', async () => { const w = build(), r = await w.manualEnter('QQQ', 'put', 1); assert.deepStrictEqual([r.ok, r.type], [true, 'put']); assert.strictEqual(w.calls.pick[0].dir, -1); });
t('input checks: bad side, qty 0/4/1.5/abc, unknown symbol, market closed, outside 9:35-15:55 ET, journal missing, day stopped; nothing journaled and no option lookup', async () => {
  const w = build(); const bad = async (a, b, c, why) => { const r = await w.manualEnter(a, b, c); assert.strictEqual(r.ok, false, why); assert.ok(r.error, why); };
  await bad('SPY', 'buy', 1, 'side'); for (const q of [0, 4, 1.5, 'abc', undefined]) await bad('SPY', 'call', q, 'qty ' + q); await bad('ZZZ', 'call', 1, 'symbol');
  w.env.open = false; await bad('SPY', 'call', 1, 'closed'); w.env.open = true; w.env.min = 569; await bad('SPY', 'call', 1, 'too early'); w.env.min = 960; await bad('SPY', 'call', 1, 'too late'); w.env.min = 700;
  w.P.rec.shut = 'stopped by you'; await bad('SPY', 'call', 1, 'shut'); w.P.rec.shut = ''; assert.strictEqual(w.calls.pick.length, 0); assert.ok(!w.P.rec.mank || w.P.rec.mank.open.length === 0);
  const w2 = build(); w2.P.rec = null; assert.strictEqual((await w2.manualEnter('SPY', 'call', 1)).ok, false, 'no journal');
});
t('entry window is 9:30:00 to 15:59:59 ET (James 2026-11-27): minute 570 and minute 959 are accepted, 569 and 960 are not; the window equals the market hours check', async () => {
  for (const min of [570, 571, 955, 958, 959]) { const w = build(); w.env.min = min; const r = await w.manualEnter('SPY', 'call', 1); assert.strictEqual(r.ok, true, 'minute ' + min + ' accepted'); assert.strictEqual(w.P.rec.mank.open.length, 1); }
  for (const min of [0, 569, 960, 1000]) { const w = build(); w.env.min = min; const r = await w.manualEnter('SPY', 'call', 1); assert.strictEqual(r.ok, false, 'minute ' + min + ' refused'); assert.ok(/9:30 to 16:00/.test(r.error)); assert.strictEqual(w.calls.pick.length, 0); }
  const w = build(); assert.deepStrictEqual([w.MAN.from, w.MAN.to, w.MAN.flat], [570, 960, 959]);
});
t('a stale underlying price (older than 5 minutes) and a failed contract pick are refused and logged as skipped, not journaled', async () => {
  const w = build(); w.P.info.SPY.bar.t = Date.now() - 400000; assert.strictEqual((await w.manualEnter('SPY', 'call', 1)).ok, false); w.P.info.SPY.bar.t = Date.now() - 30000;
  w.env.pk = { why: 'option quotes are stale' }; const r = await w.manualEnter('SPY', 'put', 1); assert.deepStrictEqual([r.ok, r.error], [false, 'option quotes are stale']); assert.strictEqual(w.calls.sig[0][3], 'skipped'); assert.strictEqual(w.P.rec.mank.open.length, 0);
});
t('at most 3 open; and a second order while one is being placed is refused (double tap)', async () => {
  const w = build(); w.P.rec.mank = { open: [{ sym: 'SPY' }, { sym: 'SPY' }, { sym: 'QQQ' }], trades: [], pnl: 0 }; assert.ok(/already open/.test((await w.manualEnter('SPY', 'call', 1)).error));
  const w2 = build(); w2.env.delay = 80; const a = w2.manualEnter('SPY', 'call', 1), b = await w2.manualEnter('SPY', 'call', 1); assert.ok(/being placed/.test(b.error)); assert.strictEqual((await a).ok, true); assert.strictEqual(w2.P.rec.mank.open.length, 1);
});
t('correlation cap: an order that would push SPY/QQQ open risk over the cap is refused with the reason and not journaled; the same order passes under a bigger cap; open on-demand positions count toward the cap', async () => {
  const w = build({ cap: 400, x9: [{ sym: 'SPY', entryAsk: 2.43 }] }); const r = await w.manualEnter('SPY', 'call', 1); assert.strictEqual(r.ok, false); assert.ok(/correlation cap/.test(r.error)); assert.strictEqual(w.P.rec.mank.open.length, 0);
  const w2 = build({ cap: 1200, x9: [{ sym: 'SPY', entryAsk: 2.43 }] }); assert.strictEqual((await w2.manualEnter('SPY', 'call', 1)).ok, true); const w3 = build({ cap: 900 }); assert.strictEqual((await w3.manualEnter('SPY', 'call', 3)).ok, true, '630 fits'); assert.strictEqual((await w3.manualEnter('QQQ', 'call', 2)).ok, false, '630 + 420 over 900');
});
t('manual close: books at the bid, P&L = (bid - ask) x 100 x qty, reason manual, even when the quote is stale; the position leaves r.mank.open', async () => {
  const w = build(); await w.manualEnter('SPY', 'call', 3); w.env.bid = 2.6; w.env.stale = true; const t0 = w.P.rec.mank.open[0].t0, r = await w.manualCloseBook('man', 'SPY', t0);
  assert.deepStrictEqual([r.ok, r.closed, r.pnl, r.reason], [true, true, 150, 'manual'], '(2.60 - 2.10) x 100 x 3'); assert.strictEqual(w.P.rec.mank.open.length, 0); assert.strictEqual(w.P.rec.mank.pnl, 150); assert.strictEqual(w.P.rec.mank.trades[0].qty, 3); assert.strictEqual(w.P.busy, false);
});
t('guardrails ON (default, James 2026-11-27): sold at the bid when down 30% or more (reason guard stop); 28% down stays open; a stale quote does not trigger it; the defaults are loss 30, gain 100, trail 25', async () => {
  const w = build(); await w.manualEnter('SPY', 'call', 1); assert.strictEqual(w.P.manGuard, undefined, 'default is ON'); assert.deepStrictEqual([w.MAN.gLoss, w.MAN.gGain, w.MAN.gTrail], [30, 100, 25]); // entry ask 2.10
  w.env.bid = 1.60; await w.manageMan(); assert.strictEqual(w.P.rec.mank.open.length, 1, 'down 23.8% (the old 25% line was 1.575): stays'); w.env.bid = 1.50; await w.manageMan(); assert.strictEqual(w.P.rec.mank.open.length, 1, 'down 28.6%: stays');
  w.env.stale = true; w.env.bid = 1.0; await w.manageMan(); assert.strictEqual(w.P.rec.mank.open.length, 1, 'stale quote ignored'); w.env.stale = false;
  w.env.bid = 1.46; await w.manageMan(); assert.deepStrictEqual([w.P.rec.mank.open.length, w.P.rec.mank.trades[0].reason, w.P.rec.mank.trades[0].pnl], [0, 'guard stop', -64], 'down 30.5% sells');
});
t('+100% does NOT sell, it arms a 25% trailing stop: 97.6% up stays unarmed; exactly +100% arms and stays open; the stop follows the highest bid up and sells at the bid when it falls 25% off that high (reason trail stop, P&L x qty); a stale quote never triggers it; the -30% stop no longer applies once armed', async () => {
  const w = build(); await w.manualEnter('QQQ', 'put', 2); const p = w.P.rec.mank.open[0]; // entry ask 2.10, 2x = 4.20
  w.env.bid = 4.15; await w.manageMan(); assert.deepStrictEqual([w.P.rec.mank.open.length, !!p.trailAt], [1, false], '97.6% up: not armed');
  w.env.bid = 4.2; await w.manageMan(); assert.deepStrictEqual([w.P.rec.mank.open.length, !!p.trailAt, p.trailArmBid], [1, true, 4.2], 'exactly +100%: armed, NOT sold');
  w.env.bid = 6.0; await w.manageMan(); assert.strictEqual(p.peak, 6, 'trail line follows the high'); w.env.bid = 4.6; await w.manageMan(); assert.strictEqual(w.P.rec.mank.open.length, 1, '4.60 is above 6.00 x 0.75 = 4.50: stays');
  w.env.stale = true; w.env.bid = 3.0; await w.manageMan(); assert.strictEqual(w.P.rec.mank.open.length, 1, 'stale quote ignored'); w.env.stale = false;
  w.env.bid = 4.5; await w.manageMan(); const tr = w.P.rec.mank.trades[0]; assert.deepStrictEqual([w.P.rec.mank.open.length, tr.reason, tr.pnl, tr.peakBid, !!tr.trailArmT], [0, 'trail stop', 480, 6, true], '(4.50 - 2.10) x 100 x 2 = 480');
  const v = build(); await v.manualEnter('SPY', 'call', 1); v.env.bid = 4.2; await v.manageMan(); v.env.bid = 4.1; await v.manageMan(); assert.strictEqual(v.P.rec.mank.open.length, 1, '4.10 vs high 4.20 x 0.75 = 3.15: stays, and no guard stop or target while armed'); v.env.bid = 3.1; await v.manageMan(); assert.strictEqual(v.P.rec.mank.trades[0].reason, 'trail stop', '3.10 <= 3.15 sells, still +48% on the price paid');
  const x = build(); await x.manualEnter('SPY', 'call', 1); x.env.bid = 4.2; await x.manageMan(); x.env.min = 959; await x.manageMan(); assert.strictEqual(x.P.rec.mank.trades[0].reason, 'time', 'the 15:59 flat still wins over an armed trail');
  const y = build(); await y.manualEnter('SPY', 'call', 1); y.env.bid = 4.2; await y.manageMan(); const t0 = y.P.rec.mank.open[0].t0, r = await y.manualCloseBook('man', 'SPY', t0); assert.deepStrictEqual([r.closed, r.reason], [true, 'manual'], 'manual Close works on an armed position');
});
t('guardrails OFF: no loss or gain auto-sell at all (a 90% loss and a 300% gain both stay open); manual Close still works; the 15:59 ET market-close sell still happens (even on a stale quote)', async () => {
  const w = build(); await w.manualEnter('SPY', 'call', 1); w.P.manGuard = false; w.env.bid = 0.2; await w.manageMan(); assert.strictEqual(w.P.rec.mank.open.length, 1, '90% loss stays'); w.env.bid = 8.4; await w.manageMan(); assert.strictEqual(w.P.rec.mank.open.length, 1, '300% gain stays');
  w.env.stale = true; w.env.min = 958; await w.manageMan(); assert.strictEqual(w.P.rec.mank.open.length, 1, 'not yet 15:59'); w.env.min = 959; await w.manageMan(); assert.deepStrictEqual([w.P.rec.mank.open.length, w.P.rec.mank.trades[0].reason], [0, 'time']);
  const v = build(); await v.manualEnter('SPY', 'call', 1); v.P.manGuard = false; v.env.bid = 1.0; const r = await v.manualCloseBook('man', 'SPY', v.P.rec.mank.open[0].t0); assert.deepStrictEqual([r.closed, r.reason], [true, 'manual']);
  const g = build(); await g.manualEnter('SPY', 'call', 1); g.P.manGuard = false; g.P.manGuard = true; g.env.bid = 1.0; await g.manageMan(); assert.strictEqual(g.P.rec.mank.trades[0].reason, 'guard stop', 'switching back ON applies to the open position at once');
});
t('guardrails switch: POST /api/manguard (behind the key, on=1 or 0 only) saves kv man_guard, boot loads it, the page data carries mg, and the page has the toggle button', () => {
  const auth = SRC.indexOf('if (!authed(u, req))'), route = SRC.indexOf("u.pathname === '/api/manguard'"); assert.ok(auth > 0 && route > auth); assert.ok(/req\.method === 'POST' && u\.pathname === '\/api\/manguard'/.test(SRC)); const rt = SRC.slice(route, route + 700); assert.ok(/on !== '1' && on !== '0'/.test(rt) && /kset\('man_guard'/.test(rt));
  assert.ok(/kget\('man_guard'\)/.test(SRC) && /P\.manGuard = g\.on/.test(SRC), 'boot restores the saved switch'); assert.ok(/mg: \{ on: manGuardOn\(\), loss: MAN\.gLoss, gain: MAN\.gGain, trail: MAN\.gTrail \}/.test(SRC), 'page data');
  assert.ok(/id="odGuard"/.test(HTML) && /\/api\/manguard\?on=/.test(HTML) && /Web\.odGuardPaint\(\)/.test(HTML), 'button, call and repaint'); assert.ok(/MAN_GUARD_LOSS \|\| 30/.test(SRC) && /MAN_GUARD_GAIN \|\| 100/.test(SRC) && /MAN_GUARD_TRAIL \|\| 25/.test(SRC)); assert.ok(/trail: MAN\.gTrail/.test(SRC), 'page data carries the trail'); assert.ok(!/guard target/.test(SRC.slice(SRC.indexOf('async function manageMan('), SRC.indexOf('const MANUAL_BOOKS'))), 'no sell at +100%');
});
t('source guard: paper only (no broker order call in the MAN block), POST route after the key check, panel needs two taps and the server route is not reachable by GET', () => {
  const a = SRC.indexOf('const MAN_ON'), b = SRC.indexOf('const MANUAL_BOOKS'), block = SRC.slice(a, b).replace(/\/\*[\s\S]*?\*\//g, ''); assert.ok(!/apTrade|place_option_order|place_equity_order|fetch\(|\/v2\/orders|https?:\/\//.test(block), 'no order or network call');
  const auth = SRC.indexOf('if (!authed(u, req))'), route = SRC.indexOf("u.pathname === '/api/ondemand'"); assert.ok(auth > 0 && route > auth); assert.ok(/req\.method === 'POST' && u\.pathname === '\/api\/ondemand'/.test(SRC)); assert.ok(/\[A-Z\.\]\{1,6\}/.test(SRC.slice(route, route + 300)));
  assert.ok(/Tap again within 5 seconds/.test(HTML) && /\/api\/ondemand\?sym=/.test(HTML) && /id="odBox"[^>]*hidden/.test(HTML), 'two-tap panel, hidden until the web page starts'); assert.ok(/MAN:'man'/.test(HTML), 'Close button wired for the MAN row');
  assert.ok(/mank: n\('mank'\)/.test(SRC) && /rec\.mank && rec\.mank\.open/.test(SRC), 'counted as an open book and in the correlation cap');
});
t('Magnificent 7 and PLTR are choices: price comes from a one-off minute-bar load (not the tracked SPY/QQQ feed), stock premium cap is $800 per contract and index stays $400, same-day flag reflects the expiry returned', async () => {
  for (const sym of ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA', 'PLTR']) { const w = build(), r = await w.manualEnter(sym, 'call', 1); assert.strictEqual(r.ok, true, sym); assert.strictEqual(w.calls.pick[0].px, 200); assert.strictEqual(w.calls.pick[0].maxPrem, 800, sym + ' stock cap'); assert.deepStrictEqual(w.calls.bars, [sym]); }
  const w = build(); await w.manualEnter('SPY', 'call', 1); assert.strictEqual(w.calls.pick[0].maxPrem, 400); assert.strictEqual(w.calls.bars, undefined, 'SPY uses the tracked feed');
  const w2 = build(); w2.env.pk = { qAge: 1, inst: 'o', strike: 200, exp: '2026-11-27', type: 'call', ask: 2, bid: 1.9 }; const r2 = await w2.manualEnter('NVDA', 'call', 1); assert.strictEqual(r2.sameDay, false, 'nearest expiry is flagged'); const r3 = await build().manualEnter('SPY', 'call', 1); assert.strictEqual(r3.sameDay, true);
  const w4 = build(); w4.env.noBars = true; assert.strictEqual((await w4.manualEnter('TSLA', 'put', 1)).ok, false, 'no price, no order');
});
t('per-order cost limit $1,200: 3 x $5.00 stock contracts ($1,500) is refused with a clear reason and journals nothing; 2 x $5.00 ($1,000) goes through', async () => {
  const w = build(); w.env.ask = 5; w.env.bid = 4.8; const r = await w.manualEnter('NVDA', 'call', 3); assert.strictEqual(r.ok, false); assert.ok(/per-order limit/.test(r.error)); assert.ok(!w.P.rec.mank || w.P.rec.mank.open.length === 0); assert.strictEqual((await w.manualEnter('NVDA', 'call', 2)).ok, true);
});
t('panel lists the new symbols and is compact (single control row, small buttons)', () => {
  for (const s of ['SPY', 'QQQ', 'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA', 'PLTR']) assert.ok(HTML.includes('<option>' + s + '</option>'), s); assert.ok(/id="odBox"[\s\S]*class="odr"/.test(HTML) && /#odBox\{[^}]*max-width:250px/.test(HTML));
});
t('scoreboards: on-demand trades are counted by scoreOf (per symbol, per strategy "manual", in ALL), and the days list, summary line, closed rows and scorecard column include them', () => {
  const scoreOf = new Function(fn('scoreOf') + '\nreturn scoreOf;')(), mt = (sym, pnl) => ({ sym, pnl, trig: 'manual', exitT: '2026-11-24T20:45:19Z', exitBid: 1, qty: 1 });
  const out = scoreOf([{ key: 'rec:2026-11-24', value: { day: '2026-11-24', trades: [{ sym: 'SPY', pnl: 100, trig: 'sweep', exitT: 'x' }], mank: { trades: [mt('SPY', 21), mt('SPY', -45), mt('NVDA', 30)] } } }]);
  assert.deepStrictEqual([out['*|manual'].n, out['*|manual'].pnl, out['SPY|manual'].pnl, out['NVDA|manual'].pnl], [3, 6, -24, 30]); assert.strictEqual(out['*|*'].pnl, 106, 'ALL includes the sweep trade and the three manual ones'); assert.strictEqual(out['*|sweep'].pnl, 100, 'sweep column untouched');
  assert.ok(/x\.value\.mank && x\.value\.mank\.trades/.test(SRC) && /x\.value\.mank && x\.value\.mank\.trades/.test(SRC.slice(SRC.indexOf('async function cityData'))), 'days list');
  assert.ok(/ST=\['orb5','sweep','cspread','x9','fp','condor','manual'\]/.test(HTML) && /manual:'ON-DEMAND'/.test(HTML) && /manual:'On-demand'/.test(HTML), 'scorecard column and label'); assert.ok(/bookBit\('On-demand',r\.od\)/.test(HTML) && /manRows/.test(HTML) && /concat\(manRows\)/.test(HTML), 'summary and closed rows');
});
(async () => { for (const [n, f] of tests) { try { await f(); pass++; console.log('ok   ' + n); } catch (e) { console.error('FAIL ' + n + '\n' + (e && e.stack || e)); process.exitCode = 1; } } console.log(pass + '/' + tests.length + ' passed'); })();
