/* Deck-side support/resistance logic (public/deck.html levels, lvCluster, lvPaint labels). James 2026-11-27: add Fibonacci, previous day/week/month highs and lows, previous-day 4-hour, GEX / where volume is bunched, "use your best judgement". Behaviour under test: the real page functions are pulled out and run with sample payloads; lines closer together than the merge distance become one label (major names first, at most two names plus a count); a cluster counts as MAJOR only when it holds a major line, so Fibonacci, 4-hour, value-area, day high/low and the GEX estimates never trigger Near/Approaching on their own; the long-horizon lines (prior-day/week/month, POC, OI walls) are major; the prior-day line comes from the daily source when the server has it and falls back to the 1-minute one when it does not; the page labels GEX lines as estimates, says open interest is as of a date, never claims price "often stalls" at a level, and asks the server for nothing new. Related: levels_ext.test.js (server side), deck_page.test.js, deck_calendar.test.js. Run: node test/deck_levels.test.js */
'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'deck.html'), 'utf8');
let pass = 0; const tests = []; const t = (n, f) => tests.push([n, f]);
function cut(name) { const i = HTML.indexOf('function ' + name + '('); assert.ok(i >= 0, name); let d = 0; for (let k = HTML.indexOf('{', i); k < HTML.length; k++) { if (HTML[k] === '{') d++; else if (HTML[k] === '}') { d--; if (d === 0) return HTML.slice(i, k + 1); } } throw new Error('unbalanced'); }
const run = S => new Function('S', cut('levels') + '\n' + cut('lvCluster') + '\nreturn { levels, lvCluster };')(S);
const L0 = { px: 100, orh: 100.5, orl: 99.2, vwap: 99.9, dh: 100.6, dl: 99.1, pdh: 101, pdl: 98 };
const X0 = { htf: { pdh: 101.2, pdl: 98.1, pwh: 103, pwl: 96, pmh: 108, pml: 90 }, fib: { dir: 'up', f382: 99.6, f500: 100.1, f618: 100.52 }, h4: { amH: 100.9, amL: 99.3, pmH: 100.55, pmL: 99.5 }, vp: { poc: 99.95, vah: 100.7, val: 99.4 }, oi: { callWall: { strike: 102, oi: 9 }, putWall: { strike: 97, oi: 8 }, max: { strike: 100, oi: 12 }, oiDate: '2026-11-24' }, gex: { callWall: 101.5, putWall: 98.5, flip: 99.7 } };

t('every requested family appears, with the right major/minor split', () => {
  const { levels } = run({ lv: { SPY: L0 }, lvx: { SPY: X0 } }), r = levels('SPY'), by = n => r.list.filter(x => x.n === n)[0];
  ['Prior-day high', 'Prior-day low', 'Prior-week high', 'Prior-week low', 'Prior-month high', 'Prior-month low', 'Opening-range high', 'Opening-range low', 'VWAP', 'Prior-day volume POC', 'OI call wall', 'OI put wall', 'OI max pin'].forEach(n => assert.ok(by(n) && by(n).major, n + ' is a major line'));
  ['Fib 38.2 of prior day', 'Fib 50 of prior day', 'Fib 61.8 of prior day', 'Prior 4h high, morning', 'Prior 4h low, afternoon', 'Prior value area high', 'Day high', 'GEX call wall (est.)', 'GEX put wall (est.)', 'Gamma flip (est.)'].forEach(n => assert.ok(by(n) && !by(n).major, n + ' is a minor line'));
  assert.strictEqual(r.list.length, 5 + 6 + 3 + 4 + 3 + 3 + 3 - 0 - 0 - 0, 'count'); assert.strictEqual(r.oiDate, '2026-11-24');
});
t('the prior-day line comes from the daily source when present and from the 1-minute source otherwise; no price means no levels', () => {
  assert.strictEqual(run({ lv: { SPY: L0 }, lvx: { SPY: X0 } }).levels('SPY').list.filter(x => x.n === 'Prior-day high')[0].v, 101.2);
  assert.strictEqual(run({ lv: { SPY: L0 } }).levels('SPY').list.filter(x => x.n === 'Prior-day high')[0].v, 101, 'fallback');
  assert.strictEqual(run({ lv: {}, lvx: { SPY: X0 } }).levels('SPY'), null); assert.strictEqual(run({}).levels('SPY'), null);
  const bare = run({ lv: { SPY: { px: 100, vwap: 99.9 } } }).levels('SPY'); assert.deepStrictEqual(bare.list.map(x => x.n), ['VWAP'], 'missing values are skipped, not shown as NaN');
});
t('lines closer than the merge distance become one label: major names first, two names plus a count; a minor-only cluster is not major', () => {
  const { lvCluster } = run({}), c = lvCluster([{ n: 'Fib 50', v: 100.02, major: false }, { n: 'Prior-day high', v: 100, major: true }, { n: 'OI max pin', v: 100.03, major: true }, { n: 'Day high', v: 100.04, major: false }, { n: 'Fib 38', v: 99, major: false }], 0.0005);
  assert.strictEqual(c.length, 2); assert.strictEqual(c[1].n, 'Prior-day high + OI max pin +2 more'); assert.strictEqual(c[1].major, true); assert.strictEqual(c[1].v, 100); assert.deepStrictEqual([c[0].n, c[0].major], ['Fib 38', false]);
  assert.strictEqual(lvCluster([], 0.001).length, 0); assert.strictEqual(lvCluster([{ n: 'a', v: 100, major: true }, { n: 'b', v: 100.5, major: true }], 0.001).length, 2, 'beyond the distance stays separate');
});
t('page text: GEX lines carry "(est.)", open interest says as-of, no untested "often stalls" claim, nothing new asked of the server', () => {
  ['GEX call wall (est.)', 'GEX put wall (est.)', 'Gamma flip (est.)', 'Fib 38.2 of prior day', 'Prior-week high', 'Prior-month high', 'Prior 4h high, morning', 'Prior-day volume POC', 'OI call wall'].forEach(s => assert.ok(HTML.includes(s), s));
  assert.ok(/OI is open interest'\+\(L\.oiDate\?' as of '/.test(HTML), 'OI date shown'); assert.ok(HTML.includes('GEX lines are model estimates, not facts'));
  assert.ok(!/often stalls/.test(HTML), 'no untested claim'); assert.ok(HTML.includes('Reference line only, not a tested signal'));
  assert.ok(!/fetch\(['"]\/api\/(lvx|levels)/.test(HTML), 'levels ride the existing state poll'); assert.ok(HTML.includes('S.lvx') || /S&&S\.lvx/.test(HTML));
});
t('line sizes follow the kind of level (month 5, week/OI wall 4, day/VWAP/OR/POC 3, minor 2); a stack of three or more grows one size, capped at 5; ticks carry a hover text and the page has one shared tooltip', () => {
  const { levels, lvCluster } = run({ lv: { SPY: L0 }, lvx: { SPY: X0 } }), w = n => levels('SPY').list.filter(x => x.n === n)[0].w;
  assert.deepStrictEqual([w('Prior-month high'), w('Prior-week low'), w('OI call wall'), w('Prior-day high'), w('VWAP'), w('Prior-day volume POC'), w('Fib 50 of prior day'), w('Gamma flip (est.)')], [5, 4, 4, 3, 3, 3, 2, 2]);
  const c = lvCluster([{ n: 'a', v: 100, w: 3, major: true }, { n: 'b', v: 100.01, w: 2 }, { n: 'c', v: 100.02, w: 2 }], 0.001); assert.strictEqual(c[0].w, 4); assert.strictEqual(lvCluster([{ n: 'a', v: 1, w: 5, major: true }, { n: 'b', v: 1, w: 2 }, { n: 'c', v: 1, w: 2 }], 0.001)[0].w, 5);
  assert.ok(HTML.includes('data-tip="') && HTML.includes("className='lvtip'") && HTML.includes('Hover or tap a line'), 'tooltip wiring'); assert.ok(HTML.includes('lvticks'), 'ticks on the horizontal line');
});
(async () => { for (const [n, f] of tests) { try { await f(); pass++; console.log('ok   ' + n); } catch (e) { console.log('FAIL ' + n + '\n' + (e && e.stack || e)); } } console.log(pass + '/' + tests.length + ' passed'); process.exit(pass === tests.length ? 0 : 1); })();
