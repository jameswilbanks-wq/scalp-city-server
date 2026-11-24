/* CSK priority in the correlation cap (server.js: cskReservedUSD and the prio argument of corrCapBlocks) test. Behaviour under test: every book except CSK sees the room still owed to CSK entries not yet made (one spread's worst case, $160 for a $2 spread, per CSK symbol per slot whose window has not ended and whose done-flag is unset); CSK's own check ignores the reserve; the reserve disappears once a slot is entered, skipped or past its window; with the cap at $1,200 the 2026-11-24 case (two X9 calls open, CSK slot 2 pending) lets CSK in and holds the extra X9 trade back. Mock clock, no network, no orders. Related existing tests: orbn.test.js and sweepx.test.js (cap present, priority not covered). Run: node test/csk_priority.test.js */
'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
let pass = 0; const tests = []; const t = (n, f) => tests.push([n, f]);
function fn(name) { const i = SRC.indexOf('function ' + name + '('); assert.ok(i >= 0, 'missing ' + name); let d = 0; for (let k = SRC.indexOf('{', i); k < SRC.length; k++) { if (SRC[k] === '{') d++; else if (SRC[k] === '}') { d--; if (d === 0) return SRC.slice(i, k + 1); } } throw new Error('unbalanced'); }
const CODE = ['corrGroupOpenRiskUSD', 'cskReservedUSD', 'corrCapBlocks'].map(fn).join('\n');
function build(min, cap) {
  const f = new Function('CORR_GROUPS', 'CORR_CAP_USD', 'CSK_ON', 'CSK', 'CSK2', 'nowET', CODE + '\nreturn { corrCapBlocks, cskReservedUSD };');
  return f(['SPY', 'QQQ'], cap === undefined ? 1200 : cap, true, { syms: ['SPY', 'QQQ'], width: 2, min: 660 }, { on: true, min: 750 }, () => ({ min }));
}
const csk = (sym, credit) => ({ sym, width: 2, creditNat: credit });
const x9 = (sym, ask) => ({ sym, entryAsk: ask });

t('reserve: before slot 1 the room for four spreads (SPY and QQQ, both slots) is held back; after slot 1 is entered only slot 2 remains; after slot 2 nothing', () => {
  const w = build(600); assert.strictEqual(w.cskReservedUSD({ csk: { done: {} } }), 640);
  const w2 = build(700); assert.strictEqual(w2.cskReservedUSD({ csk: { done: { SPY: true, QQQ: true } } }), 320);
  assert.strictEqual(w2.cskReservedUSD({ csk: { done: { SPY: true, QQQ: true, 'SPY@2': true } } }), 160, 'one slot-2 symbol still owed');
  const w3 = build(751); assert.strictEqual(w3.cskReservedUSD({ csk: { done: { SPY: true, QQQ: true } } }), 320, 'inside the slot-2 window it is still pending');
  assert.strictEqual(build(770).cskReservedUSD({ csk: { done: { SPY: true, QQQ: true } } }), 0, 'window over: reserve gone'); assert.strictEqual(build(700).cskReservedUSD({ shut: 'stopped by you', csk: { done: {} } }), 0);
});
t('2026-11-24 12:30 case: two X9 calls open ($456) plus the two 11:00 spreads ($289) leave no room for slot 2 at a $800 cap, but fit at $1,200', () => {
  const rec = { csk: { done: { SPY: true, QQQ: true }, open: [csk('SPY', 0.48), csk('QQQ', 0.63)] }, x9k: { open: [x9('SPY', 2.43), x9('QQQ', 2.13)] } };
  const at800 = build(750, 800); assert.ok(at800.corrCapBlocks(rec, 'SPY', 158, true), 'the old $800 cap blocks CSK'); const at1200 = build(750, 1200); assert.strictEqual(at1200.corrCapBlocks(rec, 'SPY', 158, true), null, 'CSK passes at $1,200'); assert.strictEqual(at1200.corrCapBlocks(rec, 'QQQ', 153, true), null);
});
t('priority: before slot 2 an extra X9 entry is blocked when it would eat the room CSK still needs, while CSK itself is not blocked by its own reserve', () => {
  const rec = { csk: { done: { SPY: true, QQQ: true }, open: [csk('SPY', 0.48), csk('QQQ', 0.63)] }, x9k: { open: [x9('SPY', 2.43)] } }, w = build(745, 1200); // open 289 + 243 = 532; reserve 320 (slot 2) -> 852
  assert.strictEqual(w.corrCapBlocks(rec, 'QQQ', 213), null, '852 + 213 = 1065 fits');
  const rec2 = { csk: rec.csk, x9k: { open: [x9('SPY', 2.43), x9('QQQ', 2.13)] } }; assert.ok(w.corrCapBlocks(rec2, 'SPY', 250), 'a third X9 call at 456 + 289 + 320 + 250 = 1315 is held back'); assert.strictEqual(w.corrCapBlocks(rec2, 'SPY', 158, true), null, 'CSK ignores the reserve: 745 + 158 = 903');
});
t('cap off (0) or a symbol outside the group is never blocked', () => {
  assert.strictEqual(build(600, 0).corrCapBlocks({ csk: { done: {} } }, 'SPY', 9999), null); assert.strictEqual(build(600).corrCapBlocks({ csk: { done: {} } }, 'NVDA', 9999), null);
});
t('source guard: only the CSK entry check passes prio=true; every other book uses the reserve', () => {
  const calls = SRC.split('\n').filter(l => /corrCapBlocks\(r, s,/.test(l)); assert.strictEqual(calls.length, 6, 'six call sites'); assert.strictEqual(calls.filter(l => /, true\)/.test(l)).length, 1); assert.ok(calls.find(l => /, true\)/.test(l)).includes("'call spread:"));
});
(async () => { for (const [n, f] of tests) { try { await f(); pass++; console.log('ok   ' + n); } catch (e) { console.error('FAIL ' + n + '\n' + (e && e.stack || e)); process.exitCode = 1; } } console.log(pass + '/' + tests.length + ' passed'); })();
