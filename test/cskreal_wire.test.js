/* CSK real order path wiring in server.js (the CSK-REAL-BEGIN..END block) test, with a MOCK Alpaca behind apTrade. No network, no orders, no keys. Behaviour under test: off by default, risk blocks, entry -> real order -> fill, stop -> exit, D2 pre-close, reconciliation halt, paper-only source guard. Related existing tests: test/cskreal.test.js (the csk_orders.js module), test/csk2.test.js. Run: node test/cskreal_wire.test.js */
'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const BLOCK = SRC.slice(SRC.indexOf('/* CSK-REAL-BEGIN'), SRC.indexOf('/* CSK-REAL-END */'));
let pass = 0; const tests = []; const t = (n, f) => tests.push([n, f]);
function build(env) {
  const calls = [], orders = {}; let n = 0, positions = [], fills = [], accountFail = false, bp = 59000, openOrders = [];
  const apTrade = async (method, p, body) => { calls.push([method, p, body]);
    if (method === 'GET' && p === '/v2/account') { if (accountFail) throw new Error('down'); return { options_buying_power: String(bp) }; }
    if (method === 'POST' && p === '/v2/orders') { const id = 'o' + (++n); orders[id] = { id, status: 'new', filled_qty: '0', client_order_id: body.client_order_id, body }; return { id }; }
    if (method === 'GET' && p.startsWith('/v2/orders:by_client_order_id')) { const c = decodeURIComponent(p.split('=')[1]), o = Object.values(orders).find(x => x.client_order_id === c); if (!o) throw Object.assign(new Error('nf'), { status: 404 }); return o; }
    if (method === 'GET' && p.startsWith('/v2/orders?status=open')) return openOrders;
    if (method === 'GET' && p.startsWith('/v2/orders/')) return orders[p.split('/')[3].split('?')[0]];
    if (method === 'DELETE') { orders[p.split('/')[3]].status = 'canceled'; return {}; }
    if (method === 'GET' && p.startsWith('/v2/account/activities/FILL')) return fills;
    if (method === 'GET' && p === '/v2/positions') return positions; throw new Error('unexpected ' + method + ' ' + p); };
  const P = { rec: { csk: { open: [], trades: [], pnl: 0, done: {} } }, info: { SPY: { bar: { c: 710 } } } }, quotes = { rhS: { ask_price: '0.30', bid_price: '0.28' }, rhL: { ask_price: '0.10', bid_price: '0.08' } };
  let saved = 0; const f = new Function('process', 'require', 'apTrade', 'P', 'nowET', 'slog', 'saveRec', 'cskQuotes', BLOCK + '\nreturn { cskRealEnter, cskRealOnClose, cskRealTick, cskRealSummary, cskRealState };');
  const ctl = { min: 700 }, api = f({ env }, p => require(path.join(__dirname, '..', p)), apTrade, P, () => ({ min: ctl.min }), () => {}, () => { saved++; }, async () => quotes);
  return Object.assign({ calls, orders, P, ctl, quotes, saved: () => saved, setPos: x => { positions = x; }, setFills: x => { fills = x; }, failAccount: () => { accountFail = true; }, setBp: x => { bp = x; }, fill(id, px) { Object.assign(orders[id], { status: 'filled', filled_qty: '1', filled_avg_price: String(px) }); } }, api);
}
const spread = () => ({ sym: 'SPY', slot: 1, exp: '2026-11-23', ks: 711, kl: 713, instS: 'rhS', instL: 'rhL', creditNat: 0.55, creditMid: 0.6, width: 2 });
const posts = w => w.calls.filter(c => c[0] === 'POST');

t('off by default: CSK_REAL_ON unset sends nothing and reads nothing', async () => { const w = build({}); await w.cskRealEnter(w.P.rec, spread()); await w.cskRealTick(); assert.strictEqual(w.calls.length, 0); assert.strictEqual(w.P.rec.cskreal, undefined); });
t('on: a simulated entry becomes a real mleg paper order via the paper helper, id linked to the simulated spread', async () => {
  const w = build({ CSK_REAL_ON: '1' }), p = spread(); await w.cskRealEnter(w.P.rec, p); assert.strictEqual(p.realId, 'SPY|s1|2026-11-23'); await w.cskRealTick();
  assert.strictEqual(posts(w).length, 1); assert.strictEqual(posts(w)[0][1], '/v2/orders'); assert.strictEqual(posts(w)[0][2].order_class, 'mleg'); assert.strictEqual(posts(w)[0][2].limit_price, '-0.60'); assert.strictEqual(posts(w)[0][2].qty, '1');
  assert.deepStrictEqual(posts(w)[0][2].legs.map(l => l.symbol), ['SPY261123C00711000', 'SPY261123C00713000']); assert.ok(w.saved() > 0);
});
t('fill: real credit and slippage recorded; summary shows it', async () => {
  const w = build({ CSK_REAL_ON: '1' }); await w.cskRealEnter(w.P.rec, spread()); await w.cskRealTick(); w.fill('o1', -0.57); await w.cskRealTick(); const R = w.P.rec.cskreal.list[0];
  assert.strictEqual(R.state, 'open'); assert.strictEqual(R.fillPx, 0.57); assert.strictEqual(R.slip, 0.02); const s = w.cskRealSummary(w.P.rec); assert.strictEqual(s.list[0].credit, 0.57); assert.strictEqual(s.qty, 1);
});
t('risk blocks: account read failure and low buying power block the order and place nothing', async () => {
  const a = build({ CSK_REAL_ON: '1' }); a.failAccount(); await a.cskRealEnter(a.P.rec, spread()); await a.cskRealTick(); assert.strictEqual(a.P.rec.cskreal.list[0].state, 'blocked'); assert.ok(/account read failed/.test(a.P.rec.cskreal.list[0].why)); assert.strictEqual(posts(a).length, 0);
  const b = build({ CSK_REAL_ON: '1' }); b.setBp(100); await b.cskRealEnter(b.P.rec, spread()); await b.cskRealTick(); assert.ok(/buying power/.test(b.P.rec.cskreal.list[0].why)); assert.strictEqual(posts(b).length, 0);
});
t('quantity: CSK_REAL_QTY is honoured and hard-capped at 5', async () => { const a = build({ CSK_REAL_ON: '1', CSK_REAL_QTY: '3' }); await a.cskRealEnter(a.P.rec, spread()); assert.strictEqual(a.P.rec.cskreal.list[0].qty, 3); const b = build({ CSK_REAL_ON: '1', CSK_REAL_QTY: '50' }); await b.cskRealEnter(b.P.rec, spread()); assert.strictEqual(b.P.rec.cskreal.list[0].qty, 5); });
t('daily real-loss limit blocks further real orders', async () => { const w = build({ CSK_REAL_ON: '1' }); const st = w.cskRealState(w.P.rec); st.list.push({ id: 'old', state: 'closed', realPnl: -600 }); await w.cskRealEnter(w.P.rec, spread()); assert.ok(/daily real loss/.test(st.list[1].why)); });
t('simulated stop starts the real exit (debit at the simulated natural), and the real P&L is recorded on its fill', async () => {
  const w = build({ CSK_REAL_ON: '1' }), p = spread(); await w.cskRealEnter(w.P.rec, p); await w.cskRealTick(); w.fill('o1', -0.57); await w.cskRealTick();
  w.cskRealOnClose(p, 1.8, 'stop 3x credit', false); await w.cskRealTick(); const x = posts(w)[1][2]; assert.strictEqual(x.limit_price, '1.80'); assert.deepStrictEqual(x.legs.map(l => l.position_intent), ['buy_to_close', 'sell_to_close']);
  w.fill('o2', 1.8); await w.cskRealTick(); assert.strictEqual(w.P.rec.cskreal.list[0].state, 'closed'); assert.strictEqual(w.P.rec.cskreal.list[0].realPnl, -123);
});
t('a stop that fires while the real entry is still working is remembered and exits once the entry fills (no orphan)', async () => {
  const w = build({ CSK_REAL_ON: '1' }), p = spread(); await w.cskRealEnter(w.P.rec, p); await w.cskRealTick(); w.cskRealOnClose(p, 1.8, 'stop 3x credit', false); assert.ok(w.P.rec.cskreal.list[0].pendingStop);
  w.fill('o1', -0.57); await w.cskRealTick(); await w.cskRealTick(); assert.strictEqual(posts(w).length, 2); assert.strictEqual(w.P.rec.cskreal.list[0].state, 'exiting');
});
t('expiry: real record settled at the same settle value, no order sent', async () => {
  const w = build({ CSK_REAL_ON: '1' }), p = spread(); await w.cskRealEnter(w.P.rec, p); await w.cskRealTick(); w.fill('o1', -0.57); await w.cskRealTick(); const n = posts(w).length; w.cskRealOnClose(p, 0, 'expired worthless', true);
  assert.strictEqual(w.P.rec.cskreal.list[0].state, 'expired'); assert.strictEqual(w.P.rec.cskreal.list[0].realPnl, 57); assert.strictEqual(posts(w).length, n);
});
t('D2 at 15:40 ET: underlying within 0.10% of the short strike closes the real spread; far below does not', async () => {
  const w = build({ CSK_REAL_ON: '1' }); await w.cskRealEnter(w.P.rec, spread()); await w.cskRealTick(); w.fill('o1', -0.57); await w.cskRealTick(); w.ctl.min = 941; w.P.info.SPY.bar.c = 710.4; await w.cskRealTick();
  const x = posts(w)[1][2]; assert.strictEqual(x.limit_price, '0.22'); assert.ok(/pre-close D2/.test(w.P.rec.cskreal.list[0].exitReason));
  const v = build({ CSK_REAL_ON: '1' }); await v.cskRealEnter(v.P.rec, spread()); await v.cskRealTick(); v.fill('o1', -0.57); await v.cskRealTick(); v.ctl.min = 941; v.P.info.SPY.bar.c = 705; await v.cskRealTick(); assert.strictEqual(posts(v).length, 1); assert.strictEqual(v.P.rec.cskreal.list[0].state, 'open');
});
t('reconciliation: two consecutive mismatches halt new real orders; one clean read resets; an unrelated Sweep position is ignored', async () => {
  const w = build({ CSK_REAL_ON: '1' }); await w.cskRealEnter(w.P.rec, spread()); await w.cskRealTick(); w.fill('o1', -0.57); await w.cskRealTick(); const st = w.P.rec.cskreal;
  w.setPos([{ symbol: 'SPY261123C00711000', qty: '1', side: 'short' }, { symbol: 'SPY261123C00713000', qty: '1', side: 'long' }, { symbol: 'AAPL261120C00100000', qty: '5', side: 'long' }]); st.lastRecon = 0; await w.cskRealTick(); assert.strictEqual(st.reconMiss, 0); assert.ok(!st.halted);
  w.setPos([]); st.lastRecon = 0; await w.cskRealTick(); assert.strictEqual(st.reconMiss, 1); assert.ok(!st.halted); st.lastRecon = 0; await w.cskRealTick(); assert.strictEqual(st.halted, true);
  await w.cskRealEnter(w.P.rec, Object.assign(spread(), { sym: 'QQQ' })); assert.ok(/halted/.test(st.list[1].why));
});
t('overlap: a slot-2 spread whose leg is a live slot-1 contract is blocked with no order sent (the 2026-11-23 SPY rejection)', async () => {
  const w = build({ CSK_REAL_ON: '1' }), a = spread(); a.ks = 728; a.kl = 730; await w.cskRealEnter(w.P.rec, a); await w.cskRealTick(); w.fill('o1', -0.56); await w.cskRealTick();
  const n = posts(w).length, b = Object.assign(spread(), { slot: 2, ks: 726, kl: 728 }); await w.cskRealEnter(w.P.rec, b); await w.cskRealTick(); const R2 = w.P.rec.cskreal.list[1]; assert.strictEqual(R2.state, 'blocked'); assert.ok(/overlap/.test(R2.why)); assert.strictEqual(posts(w).length, n);
});
t('after the close the journal P&L is replaced by the P&L computed from Alpaca fills (broker auto-liquidation is caught), once', async () => {
  const w = build({ CSK_REAL_ON: '1' }), p = spread(); p.ks = 654; p.kl = 656; p.sym = 'SPY'; await w.cskRealEnter(w.P.rec, p); await w.cskRealTick(); w.fill('o1', -0.69); await w.cskRealTick();
  w.cskRealOnClose(p, 0, 'expired worthless', true, 654.3); const R = w.P.rec.cskreal.list[0]; assert.strictEqual(R.realPnl, 69); const k = R.short, l = R.long;
  w.setFills([{ symbol: k, side: 'sell_short', price: '1.74', qty: '1' }, { symbol: l, side: 'buy', price: '1.05', qty: '1' }, { symbol: k, side: 'buy', price: '0.73', qty: '1' }]);
  w.ctl.min = 961; await w.cskRealTick(); assert.strictEqual(R.verified, undefined, 'not before 16:02 ET'); w.ctl.min = 962; await w.cskRealTick(); assert.strictEqual(R.realPnl, -4); assert.strictEqual(R.realPnlJournal, 69); assert.strictEqual(R.verified, true);
  const calls = w.calls.length; await w.cskRealTick(); assert.strictEqual(w.calls.filter(c => String(c[1]).includes('activities')).length, 1, 'fetched once');
});
t('manual close of a simulated spread starts the real exit at the simulated natural debit, same as a stop (reason manual close)', async () => {
  const w = build({ CSK_REAL_ON: '1' }), p = spread(); await w.cskRealEnter(w.P.rec, p); await w.cskRealTick(); w.fill('o1', -0.57); await w.cskRealTick();
  w.cskRealOnClose(p, 0.6, 'manual close', false); await w.cskRealTick(); const x = posts(w)[1][2]; assert.strictEqual(x.limit_price, '0.60'); assert.deepStrictEqual(x.legs.map(l => l.position_intent), ['buy_to_close', 'sell_to_close']); assert.ok(/manual close/.test(w.P.rec.cskreal.list[0].exitReason));
});
t('source guard: the block uses only apTrade (hardcoded paper endpoint); no other trading URL, no live key names, no secrets', () => {
  assert.ok(!/https?:\/\/|api\.alpaca\.markets|ALPACA_KEY|ALPACA_SECRET|APCA-/i.test(BLOCK)); assert.ok(/const ALPACA_PAPER_TRADING_BASE = 'https:\/\/paper-api\.alpaca\.markets'/.test(SRC)); assert.ok(!/ALPACA_LIVE/i.test(SRC));
});
(async () => { for (const [n, f] of tests) { try { await f(); pass++; console.log('ok   ' + n); } catch (e) { console.error('FAIL ' + n + '\n' + (e && e.stack || e)); process.exitCode = 1; } } console.log(pass + '/' + tests.length + ' passed'); })();
