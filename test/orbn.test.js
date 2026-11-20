/* ORBN (bt28 variant C, next-expiry ORB15) safety test. The real ORBN block and pickContract/pickExpiry are extracted from server.js source and run with mocks; server.js is never loaded or
   started and nothing is sent anywhere. Synthetic data only. Run: node test/orbn.test.js */
'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path');
let pass = 0; const tests = [];
const t = (n, f) => tests.push([n, f]);
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8').replace(/\r\n/g, '\n');
const cut = (a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); assert.ok(i > 0 && j > i, 'cannot locate ' + a); return src.slice(i, j); };
const orbnSrc = cut('/* ORBN-BEGIN', '/* ORBN-END */');
const T0 = Date.parse('2026-11-19T15:05:00Z'); // 10:05 ET
const ARGS = ['process', 'P', 'CFG', 'ORB_R', 'ORB_BE', 'marketOpen', 'orb15Sig', 'pickContract', 'logSignal', 'saveRec', 'rh', 'exitReason', 'iso'];
function build(over) {
  over = over || {};
  const P = { rec: { signals: [], orbk: { open: [], trades: [], pnl: 0, done: {} }, shut: '' }, info: { SPY: { bar: { c: 600, t: T0 - 60000 } } }, bars: { SPY: [] } };
  const calls = { pick: [], saves: 0 };
  const vals = [{ env: Object.assign({}, over.env) }, P, { syms: ['SPY'] }, 1.25, 0.5, () => true,
    over.sig || (() => ({ sig: { dir: 1, stopPx: 599, trig: 'orb5' }, bar: { c: 600, t: T0 - 60000 } })),
    over.pick || (async (...a) => { calls.pick.push(a); return over.pk || { type: 'call', strike: 600, exp: '2026-11-20', inst: 'i1', ask: 2.0, bid: 1.95, qAge: 1000, iv: 0.2, delta: 0.5 }; }),
    (s, sig, px, act, why) => P.rec.signals.push({ s, trig: sig.trig, act, why }), () => { calls.saves++; },
    over.rh || (async () => ({ results: [] })), over.exitReason || (() => ''), ms => new Date(ms).toISOString()];
  const fns = new Function(...ARGS, orbnSrc + '\nreturn { orbnLook, manageOrbN };')(...vals);
  return { P, calls, fns };
}
const realNow = Date.now; Date.now = () => T0;

t('entry: next-expiry contract requested (dte 1, $150 cap), own book orbnk, ORB book untouched, signal tagged orbn', async () => {
  const { P, calls, fns } = build(); await fns.orbnLook();
  assert.deepStrictEqual(calls.pick[0], ['SPY', 1, 600, 150, 1]);
  const o = P.rec.orbnk.open[0]; assert.ok(o); assert.strictEqual(o.book, 'orbn'); assert.strictEqual(o.exp, '2026-11-20'); assert.strictEqual(o.trig, 'orb5'); assert.strictEqual(o.flatMin, 930);
  assert.strictEqual(o.tgtU, 600 + 1.25 * 1); assert.strictEqual(o.stopU, 599); assert.strictEqual(o.be, 0.5);
  assert.deepStrictEqual(P.rec.orbk, { open: [], trades: [], pnl: 0, done: {} });
  assert.strictEqual(P.rec.signals[0].trig, 'orbn'); assert.strictEqual(P.rec.signals[0].act, 'entered');
});
t('one trade per symbol per day: a second look does nothing', async () => {
  const { P, calls, fns } = build(); await fns.orbnLook(); await fns.orbnLook();
  assert.strictEqual(P.rec.orbnk.open.length, 1); assert.strictEqual(calls.pick.length, 1);
});
t('no usable contract: logged skip, no position, symbol marked done', async () => {
  const { P, fns } = build({ pk: { why: 'nothing near the money under $150 with a tight spread' } }); await fns.orbnLook();
  assert.strictEqual(P.rec.orbnk.open.length, 0); assert.strictEqual(P.rec.orbnk.done.SPY, true); assert.strictEqual(P.rec.signals[0].act, 'skipped');
});
t('stale signal (> 2 min old) is skipped without picking a contract', async () => {
  const { P, calls, fns } = build({ sig: () => ({ sig: { dir: 1, stopPx: 599, trig: 'orb5' }, bar: { c: 600, t: T0 - 600000 } }) }); await fns.orbnLook();
  assert.strictEqual(calls.pick.length, 0); assert.strictEqual(P.rec.orbnk.open.length, 0); assert.strictEqual(P.rec.signals[0].act, 'skipped');
});
t('incomplete opening range: nothing happens and the day is not marked done', async () => {
  const { P, calls, fns } = build({ sig: () => ({ incomplete: true, n: 10 }) }); await fns.orbnLook();
  assert.strictEqual(calls.pick.length, 0); assert.ok(!P.rec.orbnk.done.SPY);
});
t('no signal: nothing happens', async () => {
  const { P, calls, fns } = build({ sig: () => null }); await fns.orbnLook(); assert.strictEqual(calls.pick.length, 0); assert.strictEqual(P.rec.orbnk.open.length, 0);
});
t('ORBN_ON=0 and a shut day both disable it', async () => {
  const off = build({ env: { ORBN_ON: '0' } }); await off.fns.orbnLook(); assert.strictEqual(off.calls.pick.length, 0); assert.ok(!off.P.rec.orbnk);
  const shut = build(); shut.P.rec.shut = 'loss'; await shut.fns.orbnLook(); assert.strictEqual(shut.calls.pick.length, 0);
});
t('pickContract failure is caught as a skip, not thrown', async () => {
  const { P, fns } = build({ pick: async () => { throw Object.assign(new Error('x'), { code: 'E1' }); } }); await fns.orbnLook();
  assert.strictEqual(P.rec.orbnk.open.length, 0); assert.ok(/could not load option data \(E1\)/.test(P.rec.signals[0].why));
});
t('exit: closes on reason, books pnl at (bid - entryAsk) x 100 into orbnk.trades only', async () => {
  const rh = async () => ({ results: [{ quote: { instrument_id: 'i1', bid_price: '2.30', ask_price: '2.34', updated_at: new Date(T0).toISOString() } }] });
  const { P, fns } = build({ rh, exitReason: () => 'target' }); await fns.orbnLook(); await fns.manageOrbN();
  assert.strictEqual(P.rec.orbnk.open.length, 0); const tr = P.rec.orbnk.trades[0];
  assert.strictEqual(tr.pnl, 30); assert.strictEqual(tr.reason, 'target'); assert.strictEqual(tr.book, 'orbn'); assert.strictEqual(tr.trig, 'orbn'); assert.strictEqual(P.rec.orbnk.pnl, 30);
  assert.strictEqual(P.rec.orbk.trades.length, 0); assert.strictEqual(P.rec.orbk.pnl, 0);
});
t('exit: stale quote is ignored; a throwing quote call never escapes', async () => {
  const stale = async () => ({ results: [{ quote: { instrument_id: 'i1', bid_price: '1', ask_price: '1.1', updated_at: new Date(T0 - 600000).toISOString() } }] });
  const a = build({ rh: stale, exitReason: () => 'target' }); await a.fns.orbnLook(); await a.fns.manageOrbN(); assert.strictEqual(a.P.rec.orbnk.open.length, 1); assert.strictEqual(a.P.rec.orbnk.trades.length, 0);
  const b = build({ rh: async () => { throw new Error('net'); } }); await b.fns.orbnLook(); await b.fns.manageOrbN(); assert.strictEqual(b.P.rec.orbnk.open.length, 1);
});

/* pickContract: the new 5th argument must not change any existing caller; with it, the next expiry is chosen. */
const pickExpirySrc = cut('function pickExpiry(', 'async function getInst('), pickSrc = cut('async function pickContract(', '\nfunction newRec(');
function pickBuild(cfgDte) {
  const seen = []; const ch = { id: 'c', dates: ['2026-11-19', '2026-11-20', '2026-11-23'] };
  const env = { nowET: () => ({ day: '2026-11-19' }), CFG: { maxPrem: 250, dte: cfgDte, maxSpread: 0.5 }, getChain: async () => ch,
    getInst: async (c, exp) => { seen.push(exp); return [{ strike: 600, id: 'k-' + exp }]; },
    rh: async () => ({ results: [{ quote: { instrument_id: 'k-' + seen[seen.length - 1], ask_price: '1.2', bid_price: '1.15', updated_at: new Date().toISOString() } }] }), slog: () => {} };
  const keys = Object.keys(env);
  return { seen, pick: new Function(...keys, pickExpirySrc + pickSrc + '\nreturn pickContract;')(...keys.map(k => env[k])) };
}
t('pickContract unchanged without the 5th argument (CFG.dte 0 -> today, CFG.dte 1 -> next day)', async () => {
  const a = pickBuild(0); assert.strictEqual((await a.pick('SPY', 1, 600, 0)).exp, '2026-11-19');
  const b = pickBuild(1); assert.strictEqual((await b.pick('SPY', 1, 600, 0)).exp, '2026-11-20');
});
t('pickContract with dteOverride 1 picks the next expiry even when CFG.dte is 0; override 0 picks today', async () => {
  const a = pickBuild(0); assert.strictEqual((await a.pick('SPY', 1, 600, 150, 1)).exp, '2026-11-20');
  const b = pickBuild(1); assert.strictEqual((await b.pick('SPY', 1, 600, 150, 0)).exp, '2026-11-19');
});
t('source guard: only ORBN passes a 5th pickContract argument, and the ORBN block never touches other books or the correlation cap', () => {
  const callers = src.match(/pickContract\([^;]*\);/g) || [];
  const five = callers.filter(c => /ORBN_MAXPREM,\s*1\)/.test(c));
  assert.strictEqual(five.length, 1, 'exactly one ORBN caller');
  assert.ok(!/corrCapBlocks|r\.orbk\b|\bcsk\b|x9k|fpk|cdrk|P\.rec\.pos\b/.test(orbnSrc), 'ORBN block must not touch other books or the correlation cap');
});

(async () => {
  for (const [n, f] of tests) { try { await f(); pass++; console.log('ok   ' + n); } catch (e) { console.error('FAIL ' + n + '\n' + (e && e.stack || e)); process.exitCode = 1; } }
  Date.now = realNow; console.log(pass + '/' + tests.length + ' passed');
})();
