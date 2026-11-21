/* CSK real order path (csk_orders.js) test, against a MOCK broker. No network, no orders, no keys. Behaviour under test: mleg payloads, D1 price ladders, order state machine (entry, ladder timeouts, fill/cancel race, idempotent adoption, rejects, exits, cutoff), risk checks, reconciliation, D2 pre-close rule, module source guard. No existing test for this module. Run: node test/cskreal.test.js */
'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path');
const C = require('../csk_orders.js');
let pass = 0; const tests = []; const t = (n, f) => tests.push([n, f]);
class Broker { constructor() { this.orders = {}; this.n = 0; this.placed = []; this.failPlace = null; }
  api() { return { place: async p => { if (this.failPlace) { const e = this.failPlace; this.failPlace = null; throw e; } const id = 'o' + (++this.n); this.orders[id] = { id, status: 'new', filled_qty: '0', client_order_id: p.client_order_id, payload: p }; this.placed.push(p); return { id }; },
    get: async id => { if (!this.orders[id]) throw Object.assign(new Error('nf'), { status: 404 }); return this.orders[id]; }, cancel: async id => { if (this.orders[id].status !== 'filled') this.orders[id].status = 'canceled'; },
    getByCid: async cid => { const o = Object.values(this.orders).find(x => x.client_order_id === cid); if (!o) throw Object.assign(new Error('nf'), { status: 404 }); return o; } }; }
  fill(id, px, qty) { Object.assign(this.orders[id], { status: 'filled', filled_qty: String(qty || 1), filled_avg_price: String(px) }); } }
const sim = (o) => Object.assign({ sym: 'SPY', slot: 1, exp: '2026-11-20', ks: 711, kl: 713, instS: 'rhS', instL: 'rhL', creditNat: 0.55, creditMid: 0.6 }, o);
const mk = (o) => C.newReal(sim(o), { qty: 1 }, 1000), ctxOf = (b, now, extra) => Object.assign({ now, api: b.api(), cfg: { creditSign: -1 } }, extra);

t('OCC symbol and client order ids', () => { assert.strictEqual(C.occ('SPY', '2026-11-20', 711), 'SPY261120C00711000'); assert.strictEqual(C.occ('QQQ', '2026-11-23', 600.5), 'QQQ261123C00600500'); const R = mk(); assert.strictEqual(C.cidOf(R, 'e', 0), 'csk-SPY-s1-2026-11-20-e0'); assert.strictEqual(R.short, 'SPY261120C00711000'); assert.strictEqual(R.long, 'SPY261120C00713000'); });
t('D1 entry ladder: mid -> natural in 3 steps, floored at max(0.03, simulated natural - 0.05)', () => {
  assert.deepStrictEqual(C.entryLadder(0.6, 0.55, 0.55), [0.6, 0.58, 0.57, 0.55]); assert.deepStrictEqual(C.entryLadder(0.6, 0.4, 0.55), [0.6, 0.53, 0.5, 0.5]); assert.deepStrictEqual(C.entryLadder(0.05, 0.03, 0.03), [0.05, 0.04, 0.04, 0.03]);
});
t('D1 exit ladder: natural debit then +0.02 per step', () => { assert.deepStrictEqual(C.exitLadder(0.3), [0.3, 0.32, 0.34, 0.36]); });
t('mleg payload: open = sell short/buy long as a net credit, close = buy short/sell long as a net debit; sign is configurable', () => {
  const o = C.mlegPayload({ kind: 'open', short: 'S', long: 'L', qty: 1, price: 0.6, cid: 'c1', creditSign: -1 });
  assert.strictEqual(o.order_class, 'mleg'); assert.strictEqual(o.type, 'limit'); assert.strictEqual(o.time_in_force, 'day'); assert.strictEqual(o.qty, '1'); assert.strictEqual(o.limit_price, '-0.60'); assert.strictEqual(o.client_order_id, 'c1');
  assert.deepStrictEqual(o.legs.map(l => [l.symbol, l.side, l.position_intent, l.ratio_qty]), [['S', 'sell', 'sell_to_open', '1'], ['L', 'buy', 'buy_to_open', '1']]);
  assert.strictEqual(C.mlegPayload({ kind: 'open', short: 'S', long: 'L', qty: 1, price: 0.6, cid: 'c', creditSign: 1 }).limit_price, '0.60');
  const x = C.mlegPayload({ kind: 'close', short: 'S', long: 'L', qty: 2, price: 0.3, cid: 'c2' }); assert.strictEqual(x.limit_price, '0.30'); assert.strictEqual(x.qty, '2'); assert.deepStrictEqual(x.legs.map(l => [l.side, l.position_intent]), [['buy', 'buy_to_close'], ['sell', 'sell_to_close']]);
});
t('order status classification', () => { assert.strictEqual(C.classify({ status: 'filled', filled_qty: '1' }, 1), 'filled'); assert.strictEqual(C.classify({ status: 'partially_filled', filled_qty: '1' }, 2), 'partial'); assert.strictEqual(C.classify({ status: 'canceled', filled_qty: '0' }, 1), 'dead'); assert.strictEqual(C.classify({ status: 'rejected' }, 1), 'dead'); assert.strictEqual(C.classify({ status: 'new' }, 1), 'working'); assert.strictEqual(C.classify({ status: 'pending_cancel' }, 1), 'working'); });
t('risk checks: off, halted, quantity, structure, expiry, buying power, daily loss limit; pass otherwise', () => {
  const ok = { on: true, halted: false, qty: 1, qtyMax: 1, ks: 711, kl: 713, expShort: 'a', expLong: 'a', bp: 5000, maxLoss: 145, dayLoss: 0, dayLimit: 540 };
  assert.strictEqual(C.riskCheck(ok), null); assert.ok(/off/.test(C.riskCheck(Object.assign({}, ok, { on: false })))); assert.ok(/halted/.test(C.riskCheck(Object.assign({}, ok, { halted: true, haltWhy: 'x' }))));
  assert.ok(/quantity/.test(C.riskCheck(Object.assign({}, ok, { qty: 2 })))); assert.ok(/quantity/.test(C.riskCheck(Object.assign({}, ok, { qty: 0 })))); assert.ok(/further out/.test(C.riskCheck(Object.assign({}, ok, { kl: 711 }))));
  assert.ok(/expiries/.test(C.riskCheck(Object.assign({}, ok, { expLong: 'b' })))); assert.ok(/buying power/.test(C.riskCheck(Object.assign({}, ok, { bp: 100 })))); assert.ok(/daily real loss/.test(C.riskCheck(Object.assign({}, ok, { dayLoss: -540 })))); assert.strictEqual(C.riskCheck(Object.assign({}, ok, { bp: null })), null);
});
t('entry happy path: places the first ladder price, waits, fills, records the real credit and slippage versus the simulated natural fill', async () => {
  const b = new Broker(), R = mk(); assert.strictEqual(await C.advance(R, ctxOf(b, 1000)), 'placed'); assert.strictEqual(b.placed[0].limit_price, '-0.60'); assert.strictEqual(R.entry.cid, 'csk-SPY-s1-2026-11-20-e0');
  assert.strictEqual(await C.advance(R, ctxOf(b, 5000)), undefined, 'nothing to do before 15 s'); b.fill('o1', -0.58); assert.strictEqual(await C.advance(R, ctxOf(b, 8000)), 'entry_filled');
  assert.strictEqual(R.state, 'open'); assert.strictEqual(R.fillPx, 0.58, 'sign of the broker price is ignored'); assert.strictEqual(R.slip, 0.03, '0.58 real vs 0.55 simulated natural'); assert.strictEqual(R.fillS, 7);
});
t('entry ladder timing: every 15 s cancel then re-place at the next price with a NEW client id; 4 attempts, then no fill after 60 s', async () => {
  const b = new Broker(), R = mk(); let now = 1000; await C.advance(R, ctxOf(b, now));
  for (let k = 1; k <= 3; k++) { now += 15000; assert.strictEqual(await C.advance(R, ctxOf(b, now)), 'cancel_sent'); now += 100; assert.strictEqual(await C.advance(R, ctxOf(b, now)), 'placed'); assert.strictEqual(R.entry.attempt, k); }
  assert.deepStrictEqual(b.placed.map(p => p.limit_price), ['-0.60', '-0.58', '-0.57', '-0.55']); assert.strictEqual(new Set(b.placed.map(p => p.client_order_id)).size, 4);
  now += 15000; assert.strictEqual(await C.advance(R, ctxOf(b, now)), 'cancel_sent'); assert.strictEqual(await C.advance(R, ctxOf(b, now + 100)), 'nofill'); assert.strictEqual(R.state, 'nofill'); assert.ok(/60s/.test(R.why)); assert.strictEqual(b.placed.length, 4, 'no fifth order');
});
t('fill/cancel race: an order that fills just as we cancel it is recorded as filled, never orphaned', async () => {
  const b = new Broker(), R = mk(); await C.advance(R, ctxOf(b, 1000)); await C.advance(R, ctxOf(b, 17000)); b.fill('o1', -0.6); assert.strictEqual(await C.advance(R, ctxOf(b, 17100)), 'entry_filled'); assert.strictEqual(R.state, 'open'); assert.strictEqual(b.placed.length, 1);
});
t('idempotency and restart: an unrecorded order id is adopted by client id (no duplicate); a never-sent id is placed once with the same id; duplicate-id 422 is adopted', async () => {
  const b = new Broker(), R = mk(); await C.advance(R, ctxOf(b, 1000)); const id = R.entry.orderId; R.entry.orderId = null; // crashed after sending, before saving the id
  assert.strictEqual(await C.advance(R, ctxOf(b, 2000)), 'adopted'); assert.strictEqual(R.entry.orderId, id); assert.strictEqual(b.placed.length, 1);
  const b2 = new Broker(), R2 = mk(); R2.entry.cid = 'csk-SPY-s1-2026-11-20-e0'; assert.strictEqual(await C.advance(R2, ctxOf(b2, 1000)), 'placed'); assert.strictEqual(b2.placed[0].client_order_id, 'csk-SPY-s1-2026-11-20-e0');
  const b3 = new Broker(), R3 = mk(); await C.advance(R3, ctxOf(b3, 1000)); const R4 = mk(); b3.failPlace = Object.assign(new Error('dup'), { status: 422 }); assert.strictEqual(await C.advance(R4, ctxOf(b3, 1000)), 'adopted'); assert.strictEqual(R4.entry.orderId, 'o1');
});
t('entry rejected by the broker: no position, reason recorded', async () => { const b = new Broker(), R = mk(); b.failPlace = Object.assign(new Error('insufficient buying power'), { status: 403 }); assert.strictEqual(await C.advance(R, ctxOf(b, 1000)), 'rejected'); assert.strictEqual(R.state, 'nofill'); assert.ok(/rejected/.test(R.why)); });
t('exit: only from open; fills at the natural debit; real P&L = (real credit - real debit) x 100 x qty', async () => {
  const b = new Broker(), R = mk(); assert.strictEqual(C.startExit(R, 'stop', 1.8, 0), false, 'not open yet'); await C.advance(R, ctxOf(b, 1000)); b.fill('o1', -0.58); await C.advance(R, ctxOf(b, 2000));
  assert.strictEqual(C.startExit(R, 'stop 3x credit', 1.8, 3000), true); assert.strictEqual(await C.advance(R, ctxOf(b, 3000)), 'placed'); assert.strictEqual(b.placed[1].limit_price, '1.80'); assert.deepStrictEqual(b.placed[1].legs.map(l => l.position_intent), ['buy_to_close', 'sell_to_close']);
  b.fill('o2', 1.8); assert.strictEqual(await C.advance(R, ctxOf(b, 4000)), 'exit_filled'); assert.strictEqual(R.state, 'closed'); assert.strictEqual(R.realPnl, -122);
});
t('unfilled stop: ladder steps up 0.02, then keeps retrying at the last price every 30 s and flags it; after the 15:55 cutoff it gives up as exit_failed', async () => {
  const b = new Broker(), R = mk(); await C.advance(R, ctxOf(b, 0)); b.fill('o1', -0.58); await C.advance(R, ctxOf(b, 100)); C.startExit(R, 'stop', 1.8, 200); let now = 200; await C.advance(R, ctxOf(b, now));
  for (let k = 1; k <= 3; k++) { now += 15000; await C.advance(R, ctxOf(b, now)); now += 10; await C.advance(R, ctxOf(b, now)); }
  assert.deepStrictEqual(b.placed.slice(1).map(p => p.limit_price), ['1.80', '1.82', '1.84', '1.86']); assert.ok(!R.unfilledStop);
  now += 29000; assert.strictEqual(await C.advance(R, ctxOf(b, now)), undefined, 'last price waits 30 s'); now += 2000; assert.strictEqual(await C.advance(R, ctxOf(b, now)), 'cancel_sent'); now += 10; await C.advance(R, ctxOf(b, now)); assert.strictEqual(R.unfilledStop, true); assert.strictEqual(b.placed[5].limit_price, '1.86');
  now += 31000; await C.advance(R, ctxOf(b, now)); assert.strictEqual(await C.advance(R, ctxOf(b, now + 10, { afterCutoff: true })), 'exit_failed'); assert.strictEqual(R.state, 'exit_failed');
});
t('expiry settlement: real P&L = (real credit - settle value) x 100; only from open', () => { const R = mk(); R.state = 'open'; R.fillPx = 0.58; assert.strictEqual(C.settleReal(R, 0, 5), true); assert.strictEqual(R.realPnl, 58); const R2 = mk(); R2.state = 'open'; R2.fillPx = 0.58; C.settleReal(R2, 2, 5); assert.strictEqual(R2.realPnl, -142); assert.strictEqual(C.settleReal(R2, 0, 6), false); });
t('D2 pre-close rule: close when the underlying is at/above the short strike or within 0.10% of it', () => { assert.strictEqual(C.preCloseDecision(711.5, 711, 0.001), true); assert.strictEqual(C.preCloseDecision(710.4, 711, 0.001), true); assert.strictEqual(C.preCloseDecision(710.2, 711, 0.001), false); assert.strictEqual(C.preCloseDecision(null, 711, 0.001), false); });
t('reconciliation: unknown csk- open order, wrong or missing position are problems; consistent state and in-flight entries are not', async () => {
  const b = new Broker(), R = mk(); await C.advance(R, ctxOf(b, 0)); b.fill('o1', -0.58); await C.advance(R, ctxOf(b, 10));
  const good = [{ symbol: R.short, qty: '1', side: 'short' }, { symbol: R.long, qty: '1', side: 'long' }]; assert.deepStrictEqual(C.reconcile([R], [], good), []);
  assert.ok(C.reconcile([R], [{ client_order_id: 'csk-QQQ-s1-2026-11-20-e0' }], good).some(p => /unknown open order/.test(p))); assert.deepStrictEqual(C.reconcile([R], [{ client_order_id: 'sweep-1' }, { client_order_id: R.entry.cid }], good), []);
  assert.ok(C.reconcile([R], [], [{ symbol: R.short, qty: '2', side: 'short' }, good[1]]).some(p => /position/.test(p))); assert.ok(C.reconcile([R], [], [good[1]]).some(p => /missing position/.test(p)));
  assert.deepStrictEqual(C.reconcile([R], [], good.concat([{ symbol: 'AAPL250101C00100000', qty: '1', side: 'long' }])), [], 'unrelated positions (e.g. Sweep) are ignored');
  const E = mk(); assert.deepStrictEqual(C.reconcile([E], [], [{ symbol: E.short, qty: '1', side: 'short' }]), [], 'entering: ambiguous, skipped'); R.state = 'closed'; assert.ok(C.reconcile([R], [], good).length > 0, 'a closed spread should have no leftover legs');
});
t('module source guard: no network, env, require or URLs in csk_orders.js', () => { const src = fs.readFileSync(path.join(__dirname, '..', 'csk_orders.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''); assert.ok(!/fetch\(|process\.env|require\(|https?:\/\//.test(src)); });
(async () => { for (const [n, f] of tests) { try { await f(); pass++; console.log('ok   ' + n); } catch (e) { console.error('FAIL ' + n + '\n' + (e && e.stack || e)); process.exitCode = 1; } } console.log(pass + '/' + tests.length + ' passed'); })();
