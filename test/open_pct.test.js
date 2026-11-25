/* % gain/loss column in the server panel's open-trades table (public/city.html: pctG, pctTd, addOpenRow's pct argument, the "%" header) test. Behaviour under test: every open-position row shows a percent next to the P&L; long-option books (ORB, ORBN, X9, FP, on-demand) use gain / price paid, credit books (CSK, condor) use gain / credit received; no quote yet shows an ellipsis, not 0%; closed-trade rows keep the table aligned with a blank cell; the empty-state row spans all 6 columns. Pure text/number checks, no network, no orders. No existing test covers this table. Run: node test/open_pct.test.js */
'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'city.html'), 'utf8');
let pass = 0; const tests = []; const t = (n, f) => tests.push([n, f]);
const m = HTML.match(/function pctG\(g,b\)\{[^\n]*\}/); assert.ok(m, 'pctG missing'); const pctG = new Function(m[0] + '\nreturn pctG;')();
const m2 = HTML.match(/function pctTd\(tr,x\)\{[^\n]*\}/); assert.ok(m2, 'pctTd missing');

t('long option: paid $1.17, bid now $0.72 is -38.5%; paid $1.14, bid $1.35 is +18.4%; a worthless option is -100%', () => {
  assert.strictEqual(+pctG(0.72 - 1.17, 1.17).toFixed(1), -38.5); assert.strictEqual(+pctG(1.35 - 1.14, 1.14).toFixed(1), 18.4); assert.strictEqual(pctG(0 - 2.1, 2.1), -100);
});
t('credit spread: credit 0.48, buyback 0.67 is -39.6% of the credit; credit 0.37, buyback -0.02 is +105.4% (above 100% because the quoted buyback went slightly negative)', () => {
  assert.strictEqual(+pctG(0.48 - 0.67, 0.48).toFixed(1), -39.6); assert.strictEqual(+pctG(0.37 - -0.02, 0.37).toFixed(1), 105.4);
});
t('no quote or no base gives null (shown as an ellipsis), never 0%', () => { assert.strictEqual(pctG(null, 1), null); assert.strictEqual(pctG(undefined, 1), null); assert.strictEqual(pctG(0.5, 0), null); assert.strictEqual(pctG(0.5, null), null); assert.strictEqual(pctG(0, 1), 0); });
t('table: header has the % column after P&L, the empty row spans 6 columns, closed rows get a blank cell, and every open-position book passes a percent', () => {
  assert.ok(/<th>P&amp;L<\/th><th title="[^"]*">%<\/th><th>Why closed<\/th>/.test(HTML)); assert.ok(/c0\.colSpan=6/.test(HTML)); assert.ok(/tdTxt\(tr,''\);tdTxt\(tr,t\.why\|\|''\)/.test(HTML));
  for (const b of ['ORB', 'ORBN', 'CSK', 'X9', 'MAN', 'FP', 'CDR']) { const i = HTML.indexOf("addOpenRow('" + b + "',"); assert.ok(i > 0, b); const line = HTML.slice(i, HTML.indexOf('\n', i)); assert.ok(/pctG\(/.test(line), b + ' passes a percent'); }
  assert.ok(/function addOpenRow\(label,o,contract,pnl,detail,pct\)/.test(HTML) && /pctTd\(tr,pct\)/.test(HTML));
  assert.ok(/'…'/.test(m2[0]) && /x>0\?'\+':''/.test(m2[0]), 'ellipsis when unknown, plus sign for gains');
});
t('X9 and FP open-row P&L is in dollars like ORB (bid - ask) x 100, not per share', () => {
  for (const b of ['X9', 'FP']) { const i = HTML.indexOf("addOpenRow('" + b + "',"), line = HTML.slice(HTML.lastIndexOf(String.fromCharCode(10), i), i); assert.ok(/Math\.round\(\(o\.live\.bid-o\.entryAsk\)\*100\):null/.test(line), b + ' dollars'); assert.ok(!/\*100\)\/100/.test(line), b + ' no extra /100'); }
});
(async () => { for (const [n, f] of tests) { try { await f(); pass++; console.log('ok   ' + n); } catch (e) { console.error('FAIL ' + n + '\n' + (e && e.stack || e)); process.exitCode = 1; } } console.log(pass + '/' + tests.length + ' passed'); })();
