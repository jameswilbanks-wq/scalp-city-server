/* CSK2 second entry slot (server.js cskSlot / cskLook slot handling) test. Behaviour under test: slot 1 = 11:00-11:19 ET unchanged with the original done-key (sym); slot 2 = default 12:30-12:49 with done-key sym@2; CSK2_ON=0 disables slot 2; cskLook records slot on the open spread. No existing CSK test. Run: node test/csk2.test.js */
'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const cut = (a, b) => { const i = src.indexOf(a); assert.ok(i >= 0, 'missing: ' + a); const j = src.indexOf(b, i); assert.ok(j > i, 'missing end: ' + b); return src.slice(i, j); };
const mk = env => new Function('process', 'const CSK = { min: +process.env.CSK_MIN || 660 };\n' + cut('const CSK2 =', 'async function cskQuotes') + '\nreturn { CSK2, cskSlot };')({ env });
let pass = 0; const tests = []; const t = (n, f) => tests.push([n, f]);
t('slot 1 window 11:00-11:19 keeps the original done key', () => { const { cskSlot } = mk({}); assert.deepStrictEqual(cskSlot(660), { n: 1, tag: '' }); assert.deepStrictEqual(cskSlot(679), { n: 1, tag: '' }); assert.strictEqual(cskSlot(659), null); assert.strictEqual(cskSlot(680), null); });
t('slot 2 default 12:30-12:49 uses sym@2 tag', () => { const { cskSlot } = mk({}); assert.deepStrictEqual(cskSlot(750), { n: 2, tag: '@2' }); assert.deepStrictEqual(cskSlot(769), { n: 2, tag: '@2' }); assert.strictEqual(cskSlot(749), null); assert.strictEqual(cskSlot(770), null); });
t('CSK2_ON=0 disables slot 2; CSK2_MIN moves it; slot 1 unaffected', () => { const off = mk({ CSK2_ON: '0' }).cskSlot; assert.strictEqual(off(750), null); assert.strictEqual(off(660).n, 1); const mv = mk({ CSK2_MIN: '780' }).cskSlot; assert.strictEqual(mv(750), null); assert.strictEqual(mv(780).n, 2); });
t('cskLook wiring: done key is sym+tag, spread and trade carry slot, closed trade defaults to slot 1', () => {
  const look = cut('async function cskLook()', 'function cskClose'), close = cut('function cskClose', 'async function cskManage');
  assert.ok(/const dk = s \+ slot\.tag; if \(r\.csk\.done\[dk\]\) continue;/.test(look)); assert.ok(/r\.csk\.done\[dk\] = true/.test(look)); assert.ok(!/r\.csk\.done\[s\]/.test(look));
  assert.ok(/width, slot: slot\.n \}\);/.test(look)); assert.ok(/slot: p\.slot \|\| 1/.test(close));
});
t('two slots can both fire on one day for the same symbol (different done keys)', () => { const { cskSlot } = mk({}), done = {}; const run = m => { const sl = cskSlot(m); if (!sl) return false; const k = 'SPY' + sl.tag; if (done[k]) return false; done[k] = true; return true; }; assert.ok(run(660)); assert.ok(!run(665)); assert.ok(run(750)); assert.ok(!run(755)); });
(async () => { for (const [n, f] of tests) { try { await f(); pass++; console.log('ok   ' + n); } catch (e) { console.error('FAIL ' + n + '\n' + (e && e.stack || e)); process.exitCode = 1; } } console.log(pass + '/' + tests.length + ' passed'); })();
