/* Manual close of open server paper positions (server.js: manualCloseBook + the 'manual' hooks in manageOrb, manageOrbN, x9Manage, fpManage, cskManage, cdrManage) test. Behaviour under test: a flagged position is booked through the book's own close path with reason manual, a stale quote does not block it, a missing quote queues it, a closed market / unknown book / unknown position is refused, the tick lock is respected so a position is never closed twice. Mock quotes, no network, no orders, no keys. Related existing tests: csk2.test.js, cskreal_wire.test.js (real mirror exit on a manual close is covered there). Run: node test/manual_close.test.js */
'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
let pass = 0; const tests = []; const t = (n, f) => tests.push([n, f]);
function fn(name) { // text of a top-level function by brace matching
  let i = SRC.indexOf('async function ' + name + '('); if (i < 0) i = SRC.indexOf('function ' + name + '('); assert.ok(i >= 0, 'missing ' + name);
  let d = 0, j = SRC.indexOf('{', i); for (let k = j; k < SRC.length; k++) { if (SRC[k] === '{') d++; else if (SRC[k] === '}') { d--; if (d === 0) return SRC.slice(i, k + 1); } } throw new Error('unbalanced ' + name);
}
const MB = SRC.slice(SRC.indexOf('const MANUAL_BOOKS'), SRC.indexOf('\n', SRC.indexOf('const MANUAL_BOOKS')));
const ln = s => { const i = SRC.indexOf(s); return SRC.slice(i, SRC.indexOf('\n', i)); };
const CODE = [ln('const MAN_ON'), ln('const MANCFG'), 'manGuardOn', 'cleanGuard', 'guardCfg', 'manageManB', 'manageSon', 'manageGf', 'manageOrb', 'manageMan', 'manageOrbN', 'x9Manage', 'fpManage', 'cskManage', 'cskClose', 'cdrManage', 'cdrClose', 'manualCloseBook'].map(x => x.startsWith('const ') ? x : fn(x)).join('\n');
const NAMES = ['P', 'rh', 'cskQuotes', 'exitReason', 'marketOpen', 'nowET', 'iso', 'saveRec', 'x9Bars', 'Engine', 'X9', 'CDR', 'CSK', 'AI_OVERLAY_ON', 'fiveMin', 'ensureBars', 'cskRealOnClose'];
function build() {
  const old = new Date(Date.now() - 600000).toISOString(), fresh = () => new Date().toISOString(), realCalls = [];
  const P = { busy: false, info: { SPY: { bar: { c: 710 } } }, bars: { SPY: [] }, rec: { orbk: { open: [], trades: [], pnl: 0 }, orbnk: { open: [], trades: [], pnl: 0 }, x9k: { open: [], trades: [], pnl: 0 }, fpk: { open: [], trades: [], pnl: 0, st: {} }, csk: { open: [], trades: [], pnl: 0, done: {} }, cdrk: { open: [], trades: [], pnl: 0 } } };
  const q = { opt: { instrument_id: 'opt', bid_price: '1.50', ask_price: '1.60', updated_at: fresh() }, S: { instrument_id: 'S', bid_price: '0.70', ask_price: '0.80', updated_at: fresh() }, L: { instrument_id: 'L', bid_price: '0.20', ask_price: '0.30', updated_at: fresh() } };
  const env = { open: true, noQuote: false, stale: false };
  const get = ids => { const by = {}; ids.forEach(i => { if (!env.noQuote && q[i]) by[i] = Object.assign({}, q[i], env.stale ? { updated_at: old } : {}); }); return by; };
  const stubs = [P, async (name, a) => ({ results: Object.values(get(a.instrument_ids)).map(x => ({ quote: x })) }), async ids => get(ids), () => '', () => env.open, () => ({ min: 600, day: '2026-11-24' }), d => new Date(d).toISOString(), () => {}, () => [], { x9Exit: () => false, x9At: () => null }, { tpSyms: [], tpPct: 70, trailArm: 25, trailGive: 0.5, stopPct: 30 }, { dailyStop: 1e9, timeExit: 9999, tradeStop: 1e9, fee: 0 }, { stop: 3 }, false, () => [], async () => {}, (p, c, r, e) => { realCalls.push({ c, r, e }); }];
  const f = new Function(...NAMES, MB + '\n' + CODE + '\nreturn { manualCloseBook, manageOrb, cskManage, cdrManage };'); const api = f(...stubs);
  return Object.assign({ P, q, env, realCalls, old }, api);
}
const opt = (sym, extra) => Object.assign({ sym, dir: 1, type: 'call', strike: 711, exp: '2026-11-24', inst: 'opt', t0: 1000, sigT: 0, entryAsk: 1.2, entryBid: 1.1, entryU: 710, stopU: 700, tgtU: 720, riskU: 5, peak: 1.2, flatMin: 930 }, extra || {});
const csk = () => ({ sym: 'SPY', ks: 711, kl: 713, exp: '2026-11-24', t0: 1000, instS: 'S', instL: 'L', creditNat: 0.55, creditMid: 0.6, width: 2, slot: 1, entryU: 705 });
const cdr = () => ({ sym: 'SPY', ksp: 700, klp: 698, ksc: 711, klc: 713, exp: '2026-11-24', t0: 1000, instSP: 'S', instLP: 'L', instSC: 'S', instLC: 'L', credit: 1.0, width: 2, high: 710, low: 705 });

for (const [book, key, label] of [['orb', 'orbk', 'ORB'], ['orbn', 'orbnk', 'ORBN'], ['x9', 'x9k', 'X9'], ['fp', 'fpk', 'FP']]) {
  t(label + ': manual close books the trade through the normal close path, reason manual, P&L = bid - entry ask', async () => {
    const w = build(), p = opt('SPY'); w.P.rec[key].open.push(p); const r = await w.manualCloseBook(book, 'SPY', 1000);
    assert.deepStrictEqual([r.ok, r.closed, r.pnl, r.reason], [true, true, 30, 'manual']); assert.strictEqual(w.P.rec[key].open.length, 0); assert.strictEqual(w.P.rec[key].trades.length, 1); assert.strictEqual(w.P.rec[key].trades[0].exitBid, 1.5); assert.strictEqual(w.P.rec[key].pnl, 30); assert.strictEqual(w.P.busy, false);
  });
}
t('a stale quote does not stop a manual close (it would stop an automatic one); no quote at all queues it and the flag stays', async () => {
  const w = build(), p = opt('SPY'); w.P.rec.orbk.open.push(p); w.env.stale = true; await w.manageOrb(); assert.strictEqual(w.P.rec.orbk.open.length, 1, 'automatic path ignores a stale quote');
  const r = await w.manualCloseBook('orb', 'SPY', 1000); assert.strictEqual(r.closed, true);
  const w2 = build(), p2 = opt('SPY'); w2.P.rec.orbk.open.push(p2); w2.env.noQuote = true; const r2 = await w2.manualCloseBook('orb', 'SPY', 1000); assert.deepStrictEqual([r2.ok, r2.closed, r2.pending], [true, false, true]); assert.strictEqual(p2.manual, true); assert.strictEqual(w2.P.busy, false);
  w2.env.noQuote = false; await w2.manageOrb(); assert.strictEqual(w2.P.rec.orbk.open.length, 0, 'the next tick closes the queued position');
});
t('CSK: manual close buys the spread back at the natural price (short ask - long bid), reason manual close, real mirror is told', async () => {
  const w = build(), p = csk(); w.P.rec.csk.open.push(p); const r = await w.manualCloseBook('csk', 'SPY', 1000);
  assert.deepStrictEqual([r.ok, r.closed, r.pnl, r.reason], [true, true, -5, 'manual close'], 'credit 0.55 - natural (0.80 - 0.20 = 0.60) = -0.05'); assert.strictEqual(w.P.rec.csk.pnl, -5); assert.strictEqual(w.P.rec.csk.open.length, 0);
  assert.deepStrictEqual(w.realCalls.map(x => [x.c, x.r, x.e]), [[0.6, 'manual close', false]]);
});
t('CDR: manual close pays the current debit; with no quote it uses the last known debit, and with neither it waits rather than booking the full wing width', async () => {
  const w = build(), p = cdr(); w.P.rec.cdrk.open.push(p); const r = await w.manualCloseBook('cdr', 'SPY', 1000); assert.strictEqual(r.closed, true); assert.strictEqual(r.reason, 'manual close'); assert.strictEqual(w.P.rec.cdrk.trades[0].closeDebit, 0.01, 'mock quotes make the condor nearly free to close: floor of one cent');
  const w2 = build(), p2 = cdr(); p2.live = { closeDebit: 0.4 }; w2.P.rec.cdrk.open.push(p2); w2.env.noQuote = true; const r2 = await w2.manualCloseBook('cdr', 'SPY', 1000); assert.strictEqual(r2.closed, true); assert.strictEqual(w2.P.rec.cdrk.trades[0].closeDebit, 0.4);
  const w3 = build(), p3 = cdr(); w3.P.rec.cdrk.open.push(p3); w3.env.noQuote = true; const r3 = await w3.manualCloseBook('cdr', 'SPY', 1000); assert.deepStrictEqual([r3.closed, r3.pending], [false, true]); assert.strictEqual(w3.P.rec.cdrk.trades.length, 0);
});
t('refusals: market closed, unknown book, unknown position; a second call after the close does not book a duplicate', async () => {
  const w = build(); w.P.rec.x9k.open.push(opt('SPY')); w.env.open = false; assert.strictEqual((await w.manualCloseBook('x9', 'SPY', 1000)).error, 'market is closed'); assert.strictEqual(w.P.rec.x9k.open[0].manual, undefined, 'refused before flagging'); w.env.open = true;
  assert.strictEqual((await w.manualCloseBook('nope', 'SPY', 1000)).error, 'unknown book'); assert.ok(/not open/.test((await w.manualCloseBook('x9', 'QQQ', 1000)).error)); assert.ok(/not open/.test((await w.manualCloseBook('x9', 'SPY', 999)).error));
  assert.strictEqual((await w.manualCloseBook('x9', 'SPY', 1000)).closed, true); assert.ok(/not open/.test((await w.manualCloseBook('x9', 'SPY', 1000)).error)); assert.strictEqual(w.P.rec.x9k.trades.length, 1);
});
t('tick lock: while the tick holds the lock the close is queued and flagged, not run concurrently', async () => {
  const w = build(), p = opt('SPY'); w.P.rec.orbk.open.push(p); w.P.busy = true; const t0 = Date.now(), r = await w.manualCloseBook('orb', 'SPY', 1000); assert.ok(Date.now() - t0 >= 4000, 'waited for the lock'); assert.deepStrictEqual([r.closed, r.pending], [false, true]); assert.strictEqual(p.manual, true); assert.strictEqual(w.P.rec.orbk.trades.length, 0); assert.strictEqual(w.P.busy, true, 'lock left to its owner');
});
t('source guard: the route validates the symbol, is POST only and sits behind the key check; the city page only shows the button on the web page', () => {
  const route = SRC.indexOf("u.pathname === '/api/closebook'"), auth = SRC.indexOf('if (!authed(u, req))'); assert.ok(route > auth && auth > 0, 'route is after the auth check');
  assert.ok(/req\.method === 'POST' && u\.pathname === '\/api\/closebook'/.test(SRC)); assert.ok(/\[A-Z\.\]\{1,6\}/.test(SRC.slice(route, route + 400)));
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'city.html'), 'utf8'); assert.ok(/if\(WEB&&bk&&!o\.man\)/.test(html)); assert.ok(/\/api\/closebook\?book=/.test(html)); assert.ok(/id="cskBtns"/.test(html) && /Web\.closeBook\('csk',o\)/.test(html), 'fixed CSK close buttons outside the server panel');
});
(async () => { for (const [n, f] of tests) { try { await f(); pass++; console.log('ok   ' + n); } catch (e) { console.error('FAIL ' + n + '\n' + (e && e.stack || e)); process.exitCode = 1; } } console.log(pass + '/' + tests.length + ' passed'); })();
