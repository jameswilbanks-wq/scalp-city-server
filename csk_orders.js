/* CSK real order path, Phase 1 (James approved 2026-11-20: "D1 - yes D2 - yes D3 - ok D4 - yes existing"; spec docs/csk-order-path-spec.md).
   Real multi-leg (mleg) call-spread orders against the Alpaca PAPER account only, 1 lot, shadowing the simulated CSK book. OFF unless CSK_REAL_ON=1. The simulated book makes every entry/exit decision; this module only mirrors it with real orders and records slippage.
   Pure logic + a small async state machine with an injected `api` ({place, get, cancel, getByCid}), so it is testable with a mock broker. No network, no env reads, no keys in here: server.js supplies the paper-only api. */
'use strict';
const STEP_MS = 15000, EXIT_RETRY_MS = 30000, EXIT_STEP_PX = 0.02, CREDIT_FLOOR = 0.03, FLOOR_BELOW_SIM = 0.05, STEPS = 3, MAX_EXIT_REJECTS = 3;
const TERMINAL = ['nofill', 'blocked', 'closed', 'expired', 'exit_failed'];
const r2 = x => Math.round(x * 100) / 100, cents = x => (Math.round(x * 100) / 100).toFixed(2);
// OCC option symbol, e.g. SPY261120C00711000 (exp = 'YYYY-MM-DD')
function occ(sym, exp, strike) { return sym + exp.slice(2, 4) + exp.slice(5, 7) + exp.slice(8, 10) + 'C' + String(Math.round(strike * 1000)).padStart(8, '0'); }
function cidOf(R, kind, n) { return ['csk', R.sym, 's' + R.slot, R.day, kind + n].join('-'); }
// D1 ladder: entry credit starts at the quoted mid and steps toward the natural credit in 3 steps (4 prices, 15 s each = 60 s), never below max(0.03, simulated natural credit - 0.05)
function entryLadder(mid, nat, simNat) { const floor = Math.max(CREDIT_FLOOR, r2(simNat - FLOOR_BELOW_SIM)), out = []; for (let k = 0; k <= STEPS; k++) out.push(Math.max(floor, r2(mid + (nat - mid) * k / STEPS))); return out; }
// exit debit starts at the natural debit and steps up $0.02 each step (4 prices)
function exitLadder(nat) { const out = []; for (let k = 0; k <= STEPS; k++) out.push(r2(nat + EXIT_STEP_PX * k)); return out; }
// kind 'open': sell the short call, buy the long call, net CREDIT; 'close': buy back the short, sell the long, net DEBIT. creditSign: sign convention for a net credit limit price (to be confirmed on paper, spec section 3 item 2)
function mlegPayload(o) {
  const open = o.kind === 'open', px = open ? (o.creditSign === 1 ? 1 : -1) * o.price : o.price;
  return { order_class: 'mleg', qty: String(o.qty), type: 'limit', limit_price: cents(px), time_in_force: 'day', client_order_id: o.cid,
    legs: [{ symbol: o.short, ratio_qty: '1', side: open ? 'sell' : 'buy', position_intent: open ? 'sell_to_open' : 'buy_to_close' }, { symbol: o.long, ratio_qty: '1', side: open ? 'buy' : 'sell', position_intent: open ? 'buy_to_open' : 'sell_to_close' }] };
}
// net fill price of a multi-leg order: the parent filled_avg_price when present, else computed from the legs (credit = sold - bought for an open, debit = bought - sold for a close); null when unknown
function fillPx(o, kind) {
  const pp = o && o.filled_avg_price; if (pp !== null && pp !== undefined && pp !== '' && isFinite(+pp)) return Math.abs(+pp);
  const legs = (o && o.legs) || []; if (legs.length < 2) return null; let sold = 0, bought = 0;
  for (const l of legs) { const v = l.filled_avg_price; if (v === null || v === undefined || v === '' || !isFinite(+v)) return null; if (String(l.side).toLowerCase() === 'sell') sold += +v; else bought += +v; }
  return r2(kind === 'open' ? sold - bought : bought - sold);
}
function classify(o, qty) {
  const st = String((o && o.status) || '').toLowerCase(), fq = +((o && o.filled_qty) || 0);
  if (st === 'filled' && fq >= qty) return 'filled';
  if (fq > 0 && fq < qty) return 'partial';
  if (['canceled', 'cancelled', 'expired', 'rejected', 'done_for_day', 'stopped', 'suspended'].includes(st)) return 'dead';
  return 'working';
}
// deterministic pre-order risk checks; returns null when OK, else the reason
function riskCheck(c) {
  if (!c.on) return 'CSK_REAL_ON is off'; if (c.halted) return 'halted: ' + (c.haltWhy || 'reconciliation');
  if (!(c.qty >= 1) || c.qty > c.qtyMax) return 'quantity ' + c.qty + ' outside 1..' + c.qtyMax;
  if (!(c.kl > c.ks)) return 'long leg is not further out of the money than the short'; if (c.expShort !== c.expLong) return 'legs have different expiries';
  if (c.bp !== null && c.bp !== undefined && c.bp < c.maxLoss * c.qty) return 'buying power $' + c.bp + ' below max loss $' + (c.maxLoss * c.qty);
  if (c.dayLoss <= -Math.abs(c.dayLimit)) return 'daily real loss limit reached ($' + c.dayLoss + ')';
  return null;
}
// D2: at 15:40 ET close a spread whose short strike is in the money or within pct of the underlying
function preCloseDecision(u, ks, pct) { return u !== null && u !== undefined && u >= ks * (1 - pct); }
function newReal(p, cfg, now) {
  const day = p.exp, R = { id: p.sym + '|s' + p.slot + '|' + day, sym: p.sym, slot: p.slot || 1, day, exp: p.exp, ks: p.ks, kl: p.kl, short: occ(p.sym, p.exp, p.ks), long: occ(p.sym, p.exp, p.kl), instS: p.instS, instL: p.instL, qty: cfg.qty, creditNat: p.creditNat, creditMid: p.creditMid, state: 'entering', since: now };
  R.entry = { ladder: entryLadder(p.creditMid, p.creditNat, p.creditNat), attempt: 0, orders: [], cid: null, orderId: null }; R.exit = null; return R;
}
function startExit(R, reason, natDebit, now) { if (R.state !== 'open') return false; R.state = 'exiting'; R.exitReason = reason; R.exit = { ladder: exitLadder(natDebit), attempt: 0, orders: [], cid: null, orderId: null, rejects: 0 }; R.exitSince = now; return true; }
function settleReal(R, settleVal, now) { if (R.state !== 'open') return false; R.state = 'expired'; R.settle = settleVal; R.closedAt = now; R.realPnl = r2((R.fillPx - settleVal) * 100 * R.qty); return true; }
// compares broker truth with our records: unknown open csk- orders, and positions in CSK leg symbols that differ from what our records expect
function reconcile(list, openOrders, positions) {
  const problems = [], tracked = new Set(); list.forEach(R => [R.entry, R.exit].forEach(L => { if (L) { (L.orders || []).forEach(x => tracked.add(x.cid)); if (L.cid) tracked.add(L.cid); } }));
  (openOrders || []).forEach(o => { if (String(o.client_order_id || '').startsWith('csk-') && !tracked.has(o.client_order_id)) problems.push('unknown open order ' + o.client_order_id); });
  const exp = {}, skip = new Set(), universe = new Set();
  list.forEach(R => { universe.add(R.short); universe.add(R.long); if (R.state === 'entering' || R.state === 'expired') { skip.add(R.short); skip.add(R.long); }
    if (R.state === 'open' || R.state === 'exiting') { exp[R.short] = (exp[R.short] || 0) - R.qty; exp[R.long] = (exp[R.long] || 0) + R.qty; } });
  (positions || []).forEach(x => { if (!universe.has(x.symbol) || skip.has(x.symbol)) return; const q = (String(x.side).toLowerCase() === 'short' ? -1 : 1) * Math.abs(+x.qty); if (q !== (exp[x.symbol] || 0)) problems.push('position ' + x.symbol + ' is ' + q + ', expected ' + (exp[x.symbol] || 0)); });
  universe.forEach(s => { if (skip.has(s)) return; if ((exp[s] || 0) !== 0 && !(positions || []).some(x => x.symbol === s)) problems.push('missing position ' + s + ', expected ' + exp[s]); });
  return problems;
}
// a new spread must not share an option contract with a spread that is still live: Alpaca nets positions per contract and would read the new leg as a close (seen 2026-11-23: SPY slot 2 long 728 = slot 1 short 728, order rejected 422)
function legOverlap(list, R) { const live = ['entering', 'open', 'exiting', 'exit_failed']; const x = list.find(o => o !== R && live.includes(o.state) && (o.short === R.short || o.short === R.long || o.long === R.short || o.long === R.long)); return x ? x.id : null; }
// true realized P&L of one spread from the broker's FILL activities (catches broker-initiated closes such as alpaca auto_liquidate): cash from every fill on its two contracts, plus any leg still held at expiry valued at intrinsic against the underlying close. null when it cannot be valued.
function pnlFromFills(R, fills, uClose) {
  let cash = 0, n = 0; const net = {};
  for (const f of fills || []) { if (f.symbol !== R.short && f.symbol !== R.long) continue; const q = +f.qty, px = +f.price, buy = String(f.side).toLowerCase() === 'buy'; cash += (buy ? -1 : 1) * px * q; net[f.symbol] = (net[f.symbol] || 0) + (buy ? q : -q); n++; }
  if (!n) return null; let resid = 0;
  for (const sy of [R.short, R.long]) { const q = net[sy] || 0; if (!q) continue; if (uClose === null || uClose === undefined) return null; resid += q * Math.max(0, uClose - (sy === R.short ? R.ks : R.kl)); }
  return r2((cash + resid) * 100);
}
// one state-machine step for a real spread. ctx: {now, api, cfg:{creditSign}, afterCutoff}. Returns an event string or undefined.
async function place(R, ctx, side) {
  const L = R[side], n = L.attempt, px = L.ladder[Math.min(n, L.ladder.length - 1)], cid = cidOf(R, side === 'entry' ? 'e' : 'x', n);
  L.cid = cid; L.px = px; L.sentAt = ctx.now; L.canceling = false; L.orderId = null;
  const payload = mlegPayload({ kind: side === 'entry' ? 'open' : 'close', short: R.short, long: R.long, qty: R.qty, price: px, cid, creditSign: ctx.cfg && ctx.cfg.creditSign });
  try { const o = await ctx.api.place(payload); L.orderId = o.id; L.orders.push({ cid, px, id: o.id, at: ctx.now }); return 'placed'; }
  catch (e) {
    if (e && e.status === 422 && ctx.api.getByCid) { try { const o = await ctx.api.getByCid(cid); if (o && o.id) { L.orderId = o.id; L.orders.push({ cid, px, id: o.id, at: ctx.now, adopted: true }); return 'adopted'; } } catch (e2) {} }
    R.error = String(e && e.message || e).slice(0, 160);
    if (side === 'entry') { R.state = 'nofill'; R.why = 'order rejected: ' + R.error; return 'rejected'; }
    L.rejects = (L.rejects || 0) + 1; if (L.rejects >= MAX_EXIT_REJECTS) { R.state = 'exit_failed'; R.why = 'exit order rejected ' + L.rejects + 'x: ' + R.error; return 'exit_failed'; } return 'retry';
  }
}
async function advance(R, ctx) {
  if (TERMINAL.includes(R.state) || R.state === 'open') return;
  const side = R.state === 'entering' ? 'entry' : 'exit', L = R[side];
  if (!L.orderId) { // never placed, or the process died between sending and recording the id: adopt by client id before placing again
    if (L.cid && ctx.api.getByCid) { try { const o = await ctx.api.getByCid(L.cid); if (o && o.id) { L.orderId = o.id; return 'adopted'; } } catch (e) { if (!(e && e.status === 404)) return; } }
    if (side === 'exit' && ctx.afterCutoff) { R.state = 'exit_failed'; R.why = 'past 15:55 ET with the exit unfilled'; return 'exit_failed'; }
    return place(R, ctx, side);
  }
  let o; try { o = await ctx.api.get(L.orderId); } catch (e) { return; } // transient: retry next tick
  const c = classify(o, R.qty);
  if (c === 'filled') {
    const px = fillPx(o, side === 'entry' ? 'open' : 'close'); if (px === null) { R.alert = 'filled but net price unreadable'; return 'fill_price_unknown'; }
    if (side === 'entry') { R.state = 'open'; R.fillPx = px; R.filledAt = ctx.now; R.slip = r2(px - R.creditNat); R.fillS = Math.round((ctx.now - R.since) / 1000); return 'entry_filled'; }
    R.state = 'closed'; R.exitPx = px; R.closedAt = ctx.now; R.realPnl = r2((R.fillPx - px) * 100 * R.qty); return 'exit_filled';
  }
  if (c === 'partial') { R.alert = 'partial fill on ' + side; return 'partial'; }
  if (c === 'dead') {
    if (side === 'entry') { if (L.canceling && L.attempt < L.ladder.length - 1) { L.attempt++; return place(R, ctx, 'entry'); } R.state = 'nofill'; R.why = L.canceling ? 'no fill within ' + (L.ladder.length * STEP_MS / 1000) + 's' : 'order ' + o.status; return 'nofill'; }
    L.attempt++; if (L.attempt >= L.ladder.length) R.unfilledStop = true; if (ctx.afterCutoff) { R.state = 'exit_failed'; R.why = 'past 15:55 ET with the exit unfilled'; return 'exit_failed'; }
    if (!L.canceling) L.rejects = (L.rejects || 0) + 1; if ((L.rejects || 0) >= MAX_EXIT_REJECTS) { R.state = 'exit_failed'; R.why = 'exit order ' + o.status + ' ' + L.rejects + 'x'; return 'exit_failed'; }
    return place(R, ctx, 'exit');
  }
  const wait = side === 'exit' && L.attempt >= L.ladder.length - 1 ? EXIT_RETRY_MS : STEP_MS; // working
  if (!L.canceling && ctx.now - L.sentAt >= wait) { L.canceling = true; try { await ctx.api.cancel(L.orderId); } catch (e) {} return 'cancel_sent'; }
}
module.exports = { legOverlap, pnlFromFills, fillPx, occ, cidOf, entryLadder, exitLadder, mlegPayload, classify, riskCheck, preCloseDecision, newReal, startExit, settleReal, reconcile, advance, TERMINAL, STEP_MS };
