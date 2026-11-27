/* Trade Deck page wiring (public/deck.html served by server.js wrapPage at / for James and /son for his son; the old 3D page stays at /city). Behaviour under test: one page file serves both decks and tells them apart with window.__WHO__; the son's endpoint set contains only /api/son routes (never a James, stop-day, CSK or real-money route); the controls the approved mock had are all present (guardrail on/off and the three percentages plus the close-at-gain mode, close all, stop for the day, CSK switch and classic link for James only, partial-close picker, two-tap buy, support/resistance block, signal rows with the momentum arrow, closed tape, other-books list); the page holds no secret and no made-up numbers, says paper-only and no broker-held stop. Static checks on the files, no network. Related: son_book.test.js (server logic), signal_board.test.js and real_page.test.js (the old page, unchanged). Run: node test/deck_page.test.js */
'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'), HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'deck.html'), 'utf8');
const SCR = HTML.slice(HTML.indexOf('<script>'));
let pass = 0; const tests = []; const t = (n, f) => tests.push([n, f]);

t('one file, two decks: the who marker, the two wrapPage calls, / for the deck and /city for the classic page', () => {
  assert.ok(HTML.includes('<!--WEB-->') && HTML.includes("window.__WHO__==='son'"));
  assert.ok(SRC.includes("wrapPage('deck.html', 'james')") && SRC.includes("wrapPage('deck.html', 'son')"));
  assert.ok(SRC.includes("u.pathname === '/' && DECK") && SRC.includes("u.pathname === '/city' && CITY"), 'deck at /, classic at /city');
  assert.ok(SRC.indexOf("u.pathname === '/' && DECK") > SRC.indexOf('if (!authed(u, req))'), 'the deck sits behind the admin key');
});
t('the son endpoint set has only /api/son routes (no James, stop-day, CSK, control, close or real-money route)', () => {
  const a = SCR.indexOf('var EP=SON?{'), b = SCR.indexOf('}:{', a); assert.ok(a > 0 && b > a);
  const sonEP = SCR.slice(a, b);
  for (const p of ['/api/son/state', '/api/son/history', '/api/son/enter?', '/api/son/close?', '/api/son/guard?', '/api/son/stopday', '/api/son/resume']) assert.ok(sonEP.includes(p), p);
  const bad = /\/api\/(ondemand|closebook|manguard|stopday|resumeday|cskday|control|close|real|deck)/;
  assert.ok(!bad.test(sonEP.split('/api/son/').join('')), 'no James route in the son set');
});
t('the CSK switch and the classic link are shown only on James\'s deck; other-books close is only populated for James (server sends no others to the son)', () => {
  assert.ok(HTML.includes("if(!SON){$('classic')"), 'CSK and classic gated by !SON'); assert.ok(HTML.includes('style="display:none"') && /id="cskOn"[^>]*style="display:none"/.test(HTML), 'hidden until James mode');
  const deck = SRC.slice(SRC.indexOf('function deckOut('), SRC.indexOf('const HIST = ')); assert.ok(/if \(!cfg\.son\) \{ out\.cd = .*out\.others = deckOthers\(r\)/.test(deck));
});
t('controls from the approved mock are present: guardrails on/off, loss, gain, trail, mode, close all (manual only), stop for the day, signals fold, tape, partial picker, two-tap buy, levels', () => {
  for (const id of ['grOn', 'grStop', 'grTarget', 'grTrail', 'closeAll', 'stopDay', 'cskOn', 'sgFold', 'tickers', 'tape', 'cards', 'hist', 'others', 'sgSum', 'ladder']) assert.ok(HTML.includes('id="' + id + '"'), id);
  assert.ok(HTML.includes('data-m="trail"') && HTML.includes('data-m="close"'), 'mode buttons'); assert.ok(/min="5" max="90"/.test(HTML) && /min="10" max="1000"/.test(HTML) && /min="5" max="60"/.test(HTML), 'input bounds match the server');
  assert.ok(HTML.includes('data-a="pick"') && HTML.includes("Yes, sell '+p.pick") && HTML.includes('n>=p.qty?0:n'), 'partial close picker; choosing all closes the whole position');
  assert.ok(HTML.includes('armed.key===key&&Date.now()<armed.until'), 'two-tap buy'); assert.ok(HTML.includes('Close all manual'), 'James close all is labelled manual only');
  for (const w of ['Prior-day high', 'Opening-range high', 'Opening-range low', 'Prior-day low', 'VWAP', 'Near ', 'Approaching ']) assert.ok(HTML.includes(w), w);
  assert.ok(HTML.includes('class="arw up"') && HTML.includes('class="arw dn"') && HTML.includes('class="arw flat"'), 'momentum arrow (green up, red down, slash)');
});
t('honesty and safety: paper-only line, no broker-held stop line, no secret or broker name in the page, no random numbers, every server string is escaped before innerHTML', () => {
  assert.ok(HTML.includes('no orders are sent to any broker') && HTML.includes('no broker-held stop'));
  assert.ok(!/apikey|api_key|secret|bearer|alpaca|place_option_order|robinhood-key/i.test(HTML.replace('Robinhood option quotes', '')), 'no secret or broker call'); assert.ok(!/Math\.random/.test(SCR), 'no made-up data');
  assert.ok(/function esc\(/.test(SCR) && SCR.includes("esc(p.sym)") && SCR.includes("esc(c.sym)") && SCR.includes("esc(x.desc)") && SCR.includes("esc(RS[c.reason]||c.reason)"), 'escaped insertion points');
  assert.ok(SCR.includes('key=') && !/localStorage\.setItem\('key|sessionStorage/.test(SCR), 'the key is read from the address only and is never stored');
});
t('the page script parses and has a poll no faster than the server tick (5 s state, 60 s history)', () => {
  new Function(SCR.replace(/^<script>/, '').replace(/<\/script>\s*$/, '')); assert.ok(/setInterval\(poll,5000\)/.test(SCR) && /setInterval\(loadHist,60000\)/.test(SCR));
});
(async () => { for (const [n, f] of tests) { try { await f(); pass++; console.log('ok   ' + n); } catch (e) { console.log('FAIL ' + n + '\n' + (e && e.stack || e)); } } console.log(pass + '/' + tests.length + ' passed'); process.exit(pass === tests.length ? 0 : 1); })();
