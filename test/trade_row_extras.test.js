/* Eval-harness Part 2 safety test: the new optional trade-row fields must be PURELY ADDITIVE.
   The real closePaper()/rowExtras() source is extracted from the working-tree server.js and the ORIGINAL closePaper() from `git show HEAD~N` is not needed:
   the baseline is rebuilt by calling the same function with rowExtras forced to return {} - the old code path - and by checking every non-extra field, the P&L, losers, cooldown and
   position clearing are identical. server.js is never loaded or started. Synthetic data only. Run: node test/trade_row_extras.test.js */
'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path');
let pass = 0; const t = (n, f) => { try { f(); pass++; console.log('ok   ' + n); } catch (e) { console.error('FAIL ' + n + '\n' + (e && e.stack || e)); process.exitCode = 1; } };

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8').replace(/\r\n/g, '\n');
const a = src.indexOf('const MAIN_STRATEGY_VERSION'), f = src.indexOf('function closePaper('), b = src.indexOf('\n}\n', f);
assert.ok(a > 0 && f > a && b > f, 'could not locate rowExtras/closePaper in server.js');
const body = src.slice(a, b + 3);
const iso = ms => new Date(ms).toISOString();
function build(extrasOverride) {
  const P = { rec: { trades: [], pnl: 0, losers: 0, blockUntil: 0, pos: null } }, CFG = { cooldownMs: 600000 }; let saved = 0;
  const make = new Function('P', 'CFG', 'iso', 'shutCheck', 'saveRec', 'extrasOverride', body + '\nif (extrasOverride) rowExtras = extrasOverride;\nreturn { closePaper, rowExtras };');
  const fns = make(P, CFG, iso, () => {}, () => { saved++; }, extrasOverride);
  return { P, fns, saved: () => saved };
}
const T0 = Date.parse('2026-11-18T15:00:00Z');
const basePos = () => ({ sym: 'SPY', dir: 1, type: 'call', strike: 600, exp: '2026-11-18', inst: 'abc', t0: T0, sigT: T0 - 60000, entryAsk: 2.4, entryBid: 2.38, entryU: 600.1, qAge: 1200, qty: 1, trailR: 0.35, stopU: 599.7, trig: 'sweep', peak: 2.9, iv: 0.2, delta: 0.5, live: { bid: 2.7, ask: 2.74, t: T0 + 600000, age: 900 } });
const realClock = Date.now; Date.now = () => T0 + 15 * 60000;

t('extras are purely additive: removing them leaves exactly the old row; P&L, losers, cooldown, position clearing identical', () => {
  const withX = build(), without = build(() => ({}));
  [withX, without].forEach(x => { x.P.rec.pos = Object.assign(basePos(), { qBid: 2.38, qAsk: 2.4, trough: 2.3 }); x.fns.closePaper('stop', 2.2, { bar: { c: 599.6 } }); });
  const r1 = withX.P.rec.trades[0], r0 = without.P.rec.trades[0];
  const extraKeys = ['strategyVersion', 'quotedBid', 'quotedAsk', 'spreadIn', 'slippageVsMid', 'exitAsk', 'spreadOut', 'holdMinutes', 'mfe', 'mae', 'signalId'];
  const stripped = Object.assign({}, JSON.parse(JSON.stringify(r1))); extraKeys.forEach(k => delete stripped[k]);
  assert.deepStrictEqual(stripped, JSON.parse(JSON.stringify(r0)));
  ['pnl', 'losers', 'blockUntil'].forEach(k => assert.strictEqual(withX.P.rec[k], without.P.rec[k], k)); assert.strictEqual(withX.P.rec.pos, null); assert.strictEqual(withX.saved(), 1);
});
t('values: spread, slippage vs mid, hold time, mfe/mae in option dollars, signalId, version', () => {
  const x = build(); x.P.rec.pos = Object.assign(basePos(), { qBid: 2.38, qAsk: 2.4, trough: 2.3 }); x.fns.closePaper('trail', 2.7, { bar: { c: 600.4 } });
  const r = x.P.rec.trades[0];
  assert.strictEqual(r.strategyVersion, 'sweep-run-1'); assert.strictEqual(r.quotedBid, 2.38); assert.strictEqual(r.quotedAsk, 2.4); assert.strictEqual(r.spreadIn, 0.02);
  assert.strictEqual(r.slippageVsMid, 0.01); assert.strictEqual(r.exitAsk, 2.74); assert.strictEqual(r.spreadOut, 0.04); assert.strictEqual(r.holdMinutes, 15);
  assert.strictEqual(r.mfe, 50); assert.strictEqual(r.mae, -10); assert.strictEqual(r.signalId, 'SPY|sweep|' + iso(T0 - 60000));
});
t('real-order fill: quoted bid/ask survive even though entryAsk/entryBid were overwritten by the fill price', () => {
  const x = build(); x.P.rec.pos = Object.assign(basePos(), { qBid: 2.38, qAsk: 2.4, trough: 2.3, entryAsk: 2.43, entryBid: 2.43 }); x.fns.closePaper('trail', 2.7, null);
  const r = x.P.rec.trades[0]; assert.strictEqual(r.spreadIn, 0.02); assert.strictEqual(r.slippageVsMid, 0.04); assert.strictEqual(r.entryBid, 2.43);
});
t('a position restored from the journal WITHOUT the new fields still closes; unknowable values are simply absent (no nulls, no NaN)', () => {
  const x = build(); const p = basePos(); delete p.live; x.P.rec.pos = p; x.fns.closePaper('eod', 2.5, null);
  const r = x.P.rec.trades[0]; assert.strictEqual(r.quotedBid, undefined); assert.strictEqual(r.spreadIn, undefined); assert.strictEqual(r.mae, undefined); assert.strictEqual(r.exitAsk, undefined);
  assert.strictEqual(r.strategyVersion, 'sweep-run-1'); assert.ok(r.mfe > 0 && Number.isFinite(r.holdMinutes));
  JSON.parse(JSON.stringify(r), (k, v) => { assert.ok(!(typeof v === 'number' && !Number.isFinite(v)), 'non-finite ' + k); return v; });
});
t('fail open: if the helper throws or is handed garbage, the trade row is still written and P&L is correct', () => {
  const x = build(); const bad = { get qty() { throw new Error('boom'); } };
  assert.deepStrictEqual(x.fns.rowExtras(bad, 1), {}); assert.deepStrictEqual(x.fns.rowExtras(null, 1), {});
  x.P.rec.pos = Object.assign(basePos(), { qBid: 'x', qAsk: NaN, trough: undefined, peak: 'y' }); x.fns.closePaper('stop', 2.2, null);
  const r = x.P.rec.trades[0]; assert.strictEqual(r.pnl, -20); assert.strictEqual(x.P.rec.pnl, -20); assert.strictEqual(r.quotedBid, undefined); assert.strictEqual(r.mfe, undefined);
});
t('non-sweep main-book trigger gets its own version string (samples are never mixed)', () => {
  const x = build(); const p = basePos(); delete p.trailR; p.trig = 'ema'; x.P.rec.pos = p; x.fns.closePaper('target', 2.7, null);
  assert.strictEqual(x.P.rec.trades[0].strategyVersion, 'main-ema-1');
});
Date.now = realClock;
console.log(pass + ' passed');
