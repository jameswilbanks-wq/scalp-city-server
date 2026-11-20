/* SWEEPX (Sweep improvement pack: limit entry, spread cap, time window, key-level filter, volume filter) safety test. The real SWEEPX block, lookForEntry and pollSweepReal are extracted from
   server.js source and run with mocks; server.js is never loaded or started and no order is ever sent. Synthetic data only. Run: node test/sweepx.test.js */
'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path');
let pass = 0; const tests = []; const t = (n, f) => tests.push([n, f]);
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8').replace(/\r\n/g, '\n');
const cut = (a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); assert.ok(i > 0 && j > i, 'cannot locate ' + a); return src.slice(i, j); };
const blockSrc = cut('/* SWEEPX-BEGIN', '/* SWEEPX-END */'), lookSrc = cut('async function lookForEntry()', 'async function tick()'), pollSrc = cut('async function pollSweepReal()', 'async function managePos()');
const ARGS = ['process', 'P', 'CFG', 'CHOP_MAX', 'QTY', 'CORR_CAP_USD', 'EXT_SYMS', 'SWEEP_RUN', 'SWEEP_REAL_ORDERS', 'iso', 'logSignal', 'saveRec', 'pickContract', 'corrCapBlocks', 'alpacaBuy1', 'alpacaBuyLimit', 'alpacaOrderStatus', 'apTrade', 'openShadow', 'closePaper'];
const MIN0 = Date.parse('2026-11-19T14:30:00Z'); // 9:30 ET
const mk = (day, min, o, h, l, c, v) => ({ t: Date.parse(day + 'T14:30:00Z') + (min - 570) * 60000, day, min, o, h, l, c, v });
function makeBars(over) {
  over = over || {}; const bars = [];
  if (!over.noPrior) for (let m = over.priorStart || 570; m < 960; m++) bars.push(mk('2026-11-18', m, 595, 610, 590, 600, 1000)); // prior day: high 610, low 590
  for (let m = 570; m < 585; m++) bars.push(mk('2026-11-19', m, 600, 602, 598, 600, 1000)); // opening range 598..602
  for (let m = 585; m < 630; m++) bars.push(mk('2026-11-19', m, 600, 601, 599, 600, 1000));
  const sigBar = Object.assign(mk('2026-11-19', 630, 599.5, 599.9, 597.5, 598.8, 2000), over.bar || {}); // low sweep: pokes below the opening-range low 598 and closes back above it
  bars.push(sigBar); return { bars, sigBar };
}
function build(over) {
  over = over || {}; const env = Object.assign({}, over.env); const { bars, sigBar } = makeBars(over.bars);
  const P = { rec: { pos: null, blockUntil: 0, signals: [], trades: [] }, info: { SPY: { bar: sigBar, signal: { dir: over.dir || 1, trig: over.trig || 'sweep', lvl: 599, stopPx: 597.4, atr: 0.6 }, chop: 0 } }, seenSig: {}, bars: { SPY: bars }, extNow: null };
  const calls = { limit: [], market: [], deletes: [], logs: [], saves: 0 };
  const pk = over.pk || { type: 'call', strike: 600, exp: '2026-11-19', inst: 'i1', ask: 2.0, bid: 1.98, qAge: 1000, iv: 0.2, delta: 0.5 };
  const vals = [{ env }, P, { syms: ['SPY'], dte: 0 }, 0, 1, 500, ['IWM'], true, over.real === false ? false : true, ms => new Date(ms).toISOString(),
    (s, sig, px, act, why) => { calls.logs.push({ act, why }); }, () => { calls.saves++; }, async () => pk, () => null,
    async (...a) => { calls.market.push(a); return { id: 'm1' }; }, async (...a) => { calls.limit.push(a); if (over.limitThrows) throw new Error('bad price'); return { id: 'l1' }; },
    over.status || (async () => ({ status: 'new' })), async (m, p) => { calls.deletes.push([m, p]); if (over.deleteThrows) throw new Error('net'); return {}; }, () => {}, () => {}];
  const fns = new Function(...ARGS, blockSrc + lookSrc + pollSrc + '\nreturn { sweepxFeatures, sweepxBlocks, sweepxLimitPx, lookForEntry, pollSweepReal, SWEEPX_LIMIT, SWEEPX_ON, SWEEPX_MAXSPREAD, SWEEPX_RVOL_MIN };')(...vals);
  return { P, calls, fns, bars, sigBar };
}
const realNow = Date.now; Date.now = () => MIN0 + 60 * 60000 + 60000 + 5000; // 10:31:05 ET, five seconds after the 10:30 signal bar closed

t('features: rvol, prior-day and opening-range keys, key hit on a low sweep', () => {
  const { fns, bars, sigBar } = build(); const f = fns.sweepxFeatures(bars, sigBar, 1);
  assert.strictEqual(f.rvol, 2); assert.strictEqual(f.keys.pdH, 610); assert.strictEqual(f.keys.pdL, 590); assert.strictEqual(f.keys.orH, 602); assert.strictEqual(f.keys.orL, 598);
  assert.deepStrictEqual(f.keyHit, ['orL']); assert.strictEqual(f.keyNA, false); assert.strictEqual(f.tmin, 630);
});
t('features: a high sweep only counts highs; no poke through a key level means no hit', () => {
  const { fns, bars, sigBar } = build(); assert.deepStrictEqual(fns.sweepxFeatures(bars, sigBar, -1).keyHit, []); // the bar did not poke above any high
  const b2 = Object.assign({}, sigBar, { h: 602.6, c: 601.5, l: 599.5 }); assert.deepStrictEqual(fns.sweepxFeatures(bars, b2, -1).keyHit, ['orH']);
});
t('features: a partial prior day is NOT trusted; short opening range and short history fail open', () => {
  const a = build({ bars: { priorStart: 700 } }); const f = a.fns.sweepxFeatures(a.bars, a.sigBar, 1); assert.ok(!('pdH' in f.keys)); assert.ok('orH' in f.keys);
  const b = build({ bars: { noPrior: true } }); const g = b.fns.sweepxFeatures(b.bars.filter(x => x.min >= 590), b.sigBar, 1); assert.strictEqual(g.keyNA, true); assert.deepStrictEqual(b.fns.sweepxBlocks(g, 0.01), []);
  const h = b.fns.sweepxFeatures([b.sigBar], b.sigBar, 1); assert.strictEqual(h.rvol, null); assert.deepStrictEqual(b.fns.sweepxBlocks(h, 0.01), []);
  assert.strictEqual(b.fns.sweepxFeatures(null, b.sigBar, 1).err !== undefined, true); // garbage input is caught, flagged and fails open
});
t('blocks: spread, time, level, rvol each block alone; everything fine blocks nothing', () => {
  const { fns } = build(); const ok = { tmin: 630, rvol: 2, keyHit: ['orL'], keyNA: false };
  assert.deepStrictEqual(fns.sweepxBlocks(ok, 0.03), []); assert.deepStrictEqual(fns.sweepxBlocks(ok, 0.04), ['spread']);
  assert.deepStrictEqual(fns.sweepxBlocks(Object.assign({}, ok, { tmin: 599 }), 0.02), ['time']); assert.deepStrictEqual(fns.sweepxBlocks(Object.assign({}, ok, { tmin: 900 }), 0.02), ['time']); assert.deepStrictEqual(fns.sweepxBlocks(Object.assign({}, ok, { tmin: 600 }), 0.02), []);
  assert.deepStrictEqual(fns.sweepxBlocks(Object.assign({}, ok, { keyHit: [] }), 0.02), ['level']); assert.deepStrictEqual(fns.sweepxBlocks(Object.assign({}, ok, { rvol: 1.49 }), 0.02), ['rvol']);
  assert.deepStrictEqual(fns.sweepxBlocks({ tmin: 580, rvol: 0.5, keyHit: [], keyNA: false }, 0.09), ['time', 'spread', 'level', 'rvol']);
});
t('blocks: each switch turns its own gate off; SWEEPX_ON=0 turns all off', () => {
  const bad = { tmin: 580, rvol: 0.5, keyHit: [], keyNA: false };
  assert.deepStrictEqual(build({ env: { SWEEPX_TIME: '0' } }).fns.sweepxBlocks(bad, 0.09), ['spread', 'level', 'rvol']);
  assert.deepStrictEqual(build({ env: { SWEEPX_SPREAD: '0', SWEEPX_LEVEL: '0' } }).fns.sweepxBlocks(bad, 0.09), ['time', 'rvol']);
  assert.deepStrictEqual(build({ env: { SWEEPX_ON: '0' } }).fns.sweepxBlocks(bad, 0.09), []);
});
t('limit price: mid rounded up to the cent, never above the ask, never below the bid', () => {
  const { fns } = build(); assert.strictEqual(fns.sweepxLimitPx(1.00, 1.03), 1.02); assert.strictEqual(fns.sweepxLimitPx(1.00, 1.01), 1.01); assert.strictEqual(fns.sweepxLimitPx(2.00, 2.00), 2.00); assert.strictEqual(fns.sweepxLimitPx(1.98, 2.00), 1.99); assert.strictEqual(fns.sweepxLimitPx(2.10, 2.15), 2.13);
  for (let b = 0.5; b < 3; b += 0.013) for (const sp of [0, 0.01, 0.02, 0.03, 0.05]) { const bid = Math.round(b * 100) / 100, ask = Math.round((bid + sp) * 100) / 100, p = fns.sweepxLimitPx(bid, ask); assert.ok(p <= ask + 1e-9 && p >= bid - 1e-9, bid + '/' + ask + ' -> ' + p); }
});
t('entry allowed: LIMIT order at the mid (not market), journaled with features, pending with a 30 s timeout', async () => {
  const { P, calls, fns } = build(); await fns.lookForEntry();
  assert.strictEqual(calls.market.length, 0); assert.strictEqual(calls.limit.length, 1); assert.deepStrictEqual(calls.limit[0].slice(0, 2), ['i1', 1]); assert.strictEqual(calls.limit[0][3], 1.99);
  assert.ok(P.rec.pos && P.rec.pos.real.limit === 1.99 && P.rec.pos.real.ms === 30000 && P.rec.pos.real.pending === 'entry');
  const x = P.rec.sweepx[0]; assert.strictEqual(x.action, 'entered'); assert.strictEqual(x.orderType, 'limit'); assert.strictEqual(x.limitPx, 1.99); assert.strictEqual(x.rvol, 2); assert.deepStrictEqual(x.keyHit, ['orL']); assert.deepStrictEqual(x.blocks, []);
});
t('entry blocked by spread: no order of any kind, no position, signal logged and journaled', async () => {
  const { P, calls, fns } = build({ pk: { type: 'call', strike: 600, exp: '2026-11-19', inst: 'i1', ask: 2.0, bid: 1.95 } }); await fns.lookForEntry();
  assert.strictEqual(calls.limit.length + calls.market.length, 0); assert.strictEqual(P.rec.pos, null);
  assert.strictEqual(P.rec.sweepx[0].action, 'blocked'); assert.deepStrictEqual(P.rec.sweepx[0].blocks, ['spread']); assert.ok(/sweepx blocked \[spread\]/.test(calls.logs[0].why));
});
t('entry blocked by volume and by key level', async () => {
  const a = build({ bars: { bar: { v: 1000 } } }); await a.fns.lookForEntry(); assert.deepStrictEqual(a.P.rec.sweepx[0].blocks, ['rvol']); assert.strictEqual(a.P.rec.pos, null);
  const b = build({ bars: { bar: { l: 598.5, c: 599.0 } } }); await b.fns.lookForEntry(); assert.deepStrictEqual(b.P.rec.sweepx[0].blocks, ['level']); assert.strictEqual(b.calls.limit.length, 0);
});
t('entry blocked by time window (signal bar 9:50 ET)', async () => {
  const { P, calls, fns } = build({ bars: { bar: { min: 590 } } }); await fns.lookForEntry(); assert.deepStrictEqual(P.rec.sweepx[0].blocks, ['time']); assert.strictEqual(calls.limit.length, 0);
});
t('SWEEPX_ON=0 restores the old behavior exactly: market order, no journal, no gates', async () => {
  const { P, calls, fns } = build({ env: { SWEEPX_ON: '0' }, pk: { type: 'call', strike: 600, exp: '2026-11-19', inst: 'i1', ask: 2.0, bid: 1.9 } }); await fns.lookForEntry();
  assert.strictEqual(calls.market.length, 1); assert.strictEqual(calls.limit.length, 0); assert.ok(P.rec.pos && !P.rec.pos.real.limit); assert.ok(!P.rec.sweepx);
});
t('SWEEPX_LIMIT=0 keeps the gates but uses the old market order', async () => {
  const { P, calls, fns } = build({ env: { SWEEPX_LIMIT: '0' } }); await fns.lookForEntry(); assert.strictEqual(calls.market.length, 1); assert.strictEqual(calls.limit.length, 0); assert.strictEqual(P.rec.sweepx[0].orderType, 'market');
});
t('non-sweep triggers are untouched by SWEEPX (no gates, no journal, no real order)', async () => {
  const { P, calls, fns } = build({ trig: 'vwap' }); await fns.lookForEntry(); assert.ok(!P.rec.sweepx); assert.strictEqual(calls.market.length + calls.limit.length, 0); assert.ok(P.rec.pos && !P.rec.pos.real); // real orders are sweep-only
});
t('no usable contract is journaled as no_contract and nothing is ordered', async () => {
  const { P, calls, fns } = build({ pk: { why: 'no live quotes' } }); await fns.lookForEntry(); assert.strictEqual(P.rec.sweepx[0].action, 'no_contract'); assert.strictEqual(calls.limit.length, 0); assert.strictEqual(P.rec.pos, null);
});
t('a failing limit order is a logged skip, not a position and not a market fallback', async () => {
  const { P, calls, fns } = build({ limitThrows: true }); await fns.lookForEntry(); assert.strictEqual(P.rec.pos, null); assert.strictEqual(calls.market.length, 0); assert.ok(calls.logs.some(l => /real order failed/.test(l.why)));
});

/* pollSweepReal: limit entry resolution. The position must never be orphaned at the broker. */
function pending(over, status) {
  const b = build(Object.assign({ status }, over)); b.P.rec.pos = { sym: 'SPY', dir: 1, inst: 'i1', trig: 'sweep', entryU: 598.8, sxT: b.sigBar.t, real: { entryOrderId: 'l1', pending: 'entry', since: Date.now() - 31000, limit: 1.99, ms: 30000 } };
  b.P.rec.sweepx = [{ sigT: b.sigBar.t, sym: 'SPY', action: 'entered' }]; return b;
}
t('limit timeout, order filled in the instant before the cancel: position KEPT with the fill price', async () => {
  const seq = [{ status: 'new' }, { status: 'filled', filled_avg_price: '1.98' }]; const b = pending({}, async () => seq.shift()); await b.fns.pollSweepReal();
  assert.ok(b.P.rec.pos); assert.strictEqual(b.P.rec.pos.entryAsk, 1.98); assert.strictEqual(b.P.rec.pos.real.pending, null); assert.strictEqual(b.P.rec.sweepx[0].fill, 'filled'); assert.strictEqual(b.calls.deletes.length, 1);
});
t('limit timeout, cancel confirmed: position dropped, journaled as timeout, not chased', async () => {
  const seq = [{ status: 'new' }, { status: 'canceled' }]; const b = pending({}, async () => seq.shift()); await b.fns.pollSweepReal();
  assert.strictEqual(b.P.rec.pos, null); assert.strictEqual(b.P.rec.sweepx[0].fill, 'timeout'); assert.ok(/not chased/.test(b.calls.logs[0].why)); assert.strictEqual(b.calls.limit.length + b.calls.market.length, 0);
});
t('limit timeout, status unclear (pending_cancel, failed re-read, failed cancel): position kept pending, resolved next tick', async () => {
  const a = pending({}, (() => { const s = [{ status: 'new' }, { status: 'pending_cancel' }]; return async () => s.shift(); })()); await a.fns.pollSweepReal(); assert.ok(a.P.rec.pos && a.P.rec.pos.real.pending === 'entry');
  const s2 = [{ status: 'new' }]; const b = pending({}, async () => { if (s2.length) return s2.shift(); throw new Error('net'); }); await b.fns.pollSweepReal(); assert.ok(b.P.rec.pos && b.P.rec.pos.real.pending === 'entry');
  const c = pending({ deleteThrows: true }, (() => { const s = [{ status: 'new' }, { status: 'new' }]; return async () => s.shift(); })()); await c.fns.pollSweepReal(); assert.ok(c.P.rec.pos); // cancel call failed and the order is still live: keep it, retry
});
t('limit order not yet 30 s old: nothing happens; a plain fill is recorded', async () => {
  const a = pending({}, async () => ({ status: 'new' })); a.P.rec.pos.real.since = Date.now() - 10000; await a.fns.pollSweepReal(); assert.ok(a.P.rec.pos); assert.strictEqual(a.calls.deletes.length, 0);
  const b = pending({}, async () => ({ status: 'filled', filled_avg_price: '1.99' })); await b.fns.pollSweepReal(); assert.strictEqual(b.P.rec.pos.entryAsk, 1.99); assert.strictEqual(b.P.rec.sweepx[0].fill, 'filled');
});
t('MARKET order timeout keeps the old behavior: 60 s, cancel, drop (no re-read)', async () => {
  let reads = 0; const b = pending({}, async () => { reads++; return { status: 'new' }; }); delete b.P.rec.pos.real.limit; delete b.P.rec.pos.real.ms;
  b.P.rec.pos.real.since = Date.now() - 31000; await b.fns.pollSweepReal(); assert.ok(b.P.rec.pos, 'a market order is not canceled before 60 s');
  b.P.rec.pos.real.since = Date.now() - 61000; await b.fns.pollSweepReal(); assert.strictEqual(b.P.rec.pos, null); assert.strictEqual(reads, 2); assert.ok(/never filled within 60s/.test(b.calls.logs[0].why));
});
t('source guard: exits are still market orders; the limit helper is only called once, for entry', () => {
  assert.strictEqual((src.match(/alpacaBuyLimit\(/g) || []).length, 2, 'definition plus the single entry call'); assert.ok(/async function alpacaSell1[^\n]*type: 'market'/.test(src));
});

(async () => {
  for (const [n, f] of tests) { try { await f(); pass++; console.log('ok   ' + n); } catch (e) { console.error('FAIL ' + n + '\n' + (e && e.stack || e)); process.exitCode = 1; } }
  Date.now = realNow; console.log(pass + '/' + tests.length + ' passed');
})();
