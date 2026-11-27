/* Month calendar on the Trade Deck (public/deck.html renderCal, used by both / and /son). James 2026-11-27: "a calendar for whatever month we are in with the p&l for each day listed in the box for that particular day, a running monthly total at the top, and a weekly total for each week." Behaviour under test: the page's real renderCal is pulled out and run in a tiny fake DOM with sample history; it lays the month out Sunday to Saturday with the right first weekday and day count, puts each day's realized P&L in that day's box, sums each Sunday-to-Saturday row into its week box, shows the month total and the average over the days that had trades, uses today's closed trades for today, ignores days of other months, and leaves days with no trades blank. It reads only this deck's own history (the manual book for James, his own book for the son), never made-up numbers. No network. Run: node test/deck_calendar.test.js */
'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'deck.html'), 'utf8');
let pass = 0; const tests = []; const t = (n, f) => tests.push([n, f]);
function cut(name) { const i = HTML.indexOf('function ' + name + '('); assert.ok(i >= 0, name); let d = 0; for (let k = HTML.indexOf('{', i); k < HTML.length; k++) { if (HTML[k] === '{') d++; else if (HTML[k] === '}') { d--; if (d === 0) return HTML.slice(i, k + 1); } } throw new Error('unbalanced'); }
const money = (n, sign) => (n < 0 ? '-' : sign && n > 0 ? '+' : '') + '$' + Math.abs(Math.round(n)).toLocaleString('en-US');
function run(S, H, SON) {
  const el = {}; const $ = id => el[id] || (el[id] = { id, textContent: '', innerHTML: '', className: '' });
  new Function('S', 'H', 'SON', '$', 'money', cut('renderCal') + '\nrenderCal();')(S, H, SON, $, money);
  const cells = [...$('calG').innerHTML.matchAll(/<div class="(d|w)( [^"]*)?">(.*?)<\/div>/g)].map(m => ({ kind: m[1], cls: m[2]||"", html: m[3], text: m[3].replace(/<[^>]+>/g, '') }));
  return { el, cells, days: cells.filter(c => c.kind === 'd'), weeks: cells.filter(c => c.kind === 'w') };
}
const H = { days: [{ day: '2026-11-03', n: 4, pnl: 120 }, { day: '2026-11-04', n: 2, pnl: -45 }, { day: '2026-11-05', n: 3, pnl: 60 }, { day: '2026-11-12', n: 1, pnl: 30 }, { day: '2026-11-25', n: 5, pnl: -18 }, { day: '2026-10-30', n: 2, pnl: 999 }] };

t('November 2026: starts on Sunday, 30 days, 5 week rows, month total and average over days with trades, other months ignored', () => {
  const r = run({ day: '2026-11-27', closed: [], pnl: 0 }, H, false);
  assert.strictEqual(r.el.calT.textContent, 'November 2026'); assert.strictEqual(r.weeks.length, 5);
  assert.strictEqual(r.days.filter(d => !d.cls.includes('off')).length, 30, '30 real days');
  assert.strictEqual(r.days.filter(d => d.cls.includes('off')).length, 5, 'five blank trailing cells (Dec)');
  assert.strictEqual(r.el.calM.textContent, 'Month +$147', '120-45+60+30-18; the October row is not counted');
  assert.ok(/5 trading days with trades, 3 up, average \+\$29 per trading day/.test(r.el.calS.textContent), r.el.calS.textContent);
});
t('each day shows its own P&L in its own box; days with no trades are blank; losses are red and gains green', () => {
  const r = run({ day: '2026-11-27', closed: [], pnl: 0 }, H, false);
  assert.ok(r.days[2].text.includes('120'), 'Tuesday the 3rd = +$120 (index 2, the 1st is a Sunday)'); assert.ok(r.days[2].cls.includes('up') && r.days[3].cls.includes('dn'));
  assert.ok(r.days[3].text.includes('45') && r.days[4].text.includes('60') && r.days[11].text.includes('30') && r.days[24].text.includes('18'));
  assert.ok(!/\$/.test(r.days[0].text + r.days[1].text + r.days[5].text), 'Nov 1, 2, 6 are blank');
});
t('weekly totals: Sunday to Saturday rows add up; a row with no trades shows a dash', () => {
  const r = run({ day: '2026-11-27', closed: [], pnl: 0 }, H, false);
  assert.deepStrictEqual(r.weeks.map(w => w.text.replace(/\s+/g, '')), ['3days+$135', '1day+$30', '--', '1day-$18', '--']);
  assert.strictEqual(120 - 45 + 60, 135);
});
t('today comes from today\'s closed trades (live), replaces the saved row for today, and is highlighted', () => {
  const r = run({ day: '2026-11-27', closed: [{}, {}], pnl: 55 }, H, false);
  assert.ok(r.days[26].cls.includes('today') && r.days[26].text.includes('55') && r.days[26].text.includes('2 trades'));
  assert.strictEqual(r.el.calM.textContent, 'Month +$202'); assert.ok(/6 trading days/.test(r.el.calS.textContent));
  const again = run({ day: '2026-11-27', closed: [{}], pnl: 10 }, { days: H.days.concat([{ day: '2026-11-27', n: 1, pnl: 10 }]) }, false); assert.strictEqual(again.el.calM.textContent, 'Month +$157', 'today counted once, not twice');
});
t('other month lengths and weekdays: Feb 2028 (leap, starts Tuesday) and a month with no trades', () => {
  const r = run({ day: '2028-02-10', closed: [], pnl: 0 }, { days: [{ day: '2028-02-29', n: 1, pnl: 5 }] }, true);
  assert.strictEqual(r.el.calT.textContent, 'February 2028'); assert.strictEqual(r.days.filter(d => !d.cls.includes('off')).length, 29); assert.ok(r.days[2].text.startsWith('1') && !r.days[1].text.match(/\d/) , 'the 1st is the third cell (Tuesday)');
  assert.strictEqual(r.el.calM.textContent, 'Month +$5'); assert.ok(/Your book only/.test(r.el.calN.textContent), 'son label');
  const e = run({ day: '2026-12-01', closed: [], pnl: 0 }, { days: [] }, false); assert.strictEqual(e.el.calM.textContent, 'Month $0'); assert.ok(/No closed trades this month yet/.test(e.el.calS.textContent)); assert.ok(/Manual book only/.test(e.el.calN.textContent), 'James label says manual book only');
});
t('the calendar is redrawn when state and when history arrive, reads only the deck\'s own history endpoint, and holds no random or invented data', () => {
  assert.ok(/apply\(\);renderCal\(\)/.test(HTML) && /H=h;renderCal\(\)/.test(HTML)); assert.ok(!/Math\.random/.test(cut('renderCal'))); assert.ok(HTML.includes('id="cal"') && HTML.includes('id="calG"'));
});
(async () => { for (const [n, f] of tests) { try { await f(); pass++; console.log('ok   ' + n); } catch (e) { console.log('FAIL ' + n + '\n' + (e && e.stack || e)); } } console.log(pass + '/' + tests.length + ' passed'); process.exit(pass === tests.length ? 0 : 1); })();
