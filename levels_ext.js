'use strict';
/* EXTENDED PRICE LEVELS for the Trade Deck (James 2026-11-27: "add fibonacci and also previous day's high/low, previous day's 4 hour, previous week's high/low, previous month's high/low ... also GEX indicators where high volume is bunched up ... use your best judgement to enhance our support/resistance indicators").
   DISPLAY ONLY. Nothing here feeds an order, a signal, a sizing rule or a risk limit. Whether price reacts at any of these lines is NOT tested; they are reference prices. Pure functions plus one refresher that takes its data access (`api`) as a parameter, so tests run with fixtures and no network.
   PRE-REGISTERED DEFINITIONS (so a later study tests exactly what was displayed; also in docs/DECISIONS.md 2026-11-27):
   - Reference day: today on a weekday, the coming Monday on a weekend. "Previous" is chosen by DATE: previous day = last daily bar before the reference day; previous week = last weekly bar starting before that Monday; previous month = last monthly bar starting before the 1st of the reference month. Daily/weekly/monthly bars are regular-hours (RTH) bars from Alpaca (SIP feed when the plan allows it, else IEX; the feed used is recorded).
   - Fibonacci (prior-day retracement): R = prior-day high minus low. If the prior day closed at or above its open, levels = high - r*R; otherwise low + r*R; r = 0.382, 0.5, 0.618.
   - Previous-day 4-hour candles: two blocks of the previous regular session, 9:30-13:30 ET and 13:30-session close (a session that closes at 13:00 has only the first block, marked partial); high and low of each block from 30-minute bars inside the session (session close from the Alpaca calendar).
   - Volume profile (previous session, 1-minute bars): each bar's volume is placed at its typical price (H+L+C)/3 into price bins of max(0.05, 0.03% of price rounded to 0.05); POC = the busiest bin; value area = the smallest run of bins around the POC holding 70% of volume, grown one bin at a time toward the side with the busier next bin (ties go up); VAH/VAL = centres of its top and bottom bins.
   - Open interest (a FACT, as published by the options clearing data Alpaca relays, as of the date shown, usually the previous trading day): over expirations within 7 days and strikes within 6% of the price: OI call wall = strike at or above price with the most call OI; OI put wall = strike at or below price with the most put OI; OI max = strike with the most total OI.
   - GEX (an ESTIMATE, not a fact): dollar gamma per 1% move = gamma * OI * 100 * price^2 * 0.01, calls counted positive and puts negative (assumes customers are net long calls and short puts, so dealers are the opposite; this assumption is often wrong). Gamma is Black-Scholes with the implied vol Alpaca reports, rate 0, time to the 16:00 ET expiry (minimum 30 minutes). GEX call wall = strike with the largest positive net, GEX put wall = largest negative net, gamma flip = the price in a +/-6% grid where total net GEX crosses zero, nearest the price. Today's new open interest is not in the data until tomorrow.
*/
const ETF = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const r2 = x => Math.round(x * 100) / 100;
function etOf(t) { const p = {}; ETF.formatToParts(new Date(t)).forEach(x => { p[x.type] = x.value; }); return { day: p.year + '-' + p.month + '-' + p.day, min: (+p.hour) * 60 + (+p.minute) }; }
const dayMs = d => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
const msDay = ms => new Date(ms).toISOString().slice(0, 10);
function refDay(nowMs) { const today = etOf(nowMs).day, dow = new Date(dayMs(today)).getUTCDay(); return dow === 6 ? msDay(dayMs(today) + 2 * 864e5) : dow === 0 ? msDay(dayMs(today) + 864e5) : today; }
const weekStart = d => msDay(dayMs(d) - ((new Date(dayMs(d)).getUTCDay() + 6) % 7) * 864e5);
const monthStart = d => d.slice(0, 8) + '01';
const barDay = b => String(b.t).slice(0, 10); // daily, weekly and monthly bars are stamped at midnight Eastern, so the UTC date is the Eastern date
function priorBar(bars, kind, ref) {
  const cut = kind === 'day' ? ref : kind === 'week' ? weekStart(ref) : monthStart(ref); let hit = null;
  (bars || []).forEach(b => { const d = barDay(b); if (d < cut && (!hit || d > barDay(hit))) hit = b; }); return hit;
}
function htf(daily, weekly, monthly, nowMs) {
  const ref = refDay(nowMs), d = priorBar(daily, 'day', ref), w = priorBar(weekly, 'week', ref), m = priorBar(monthly, 'month', ref), o = { ref };
  if (d) Object.assign(o, { pdDay: barDay(d), pdo: r2(d.o), pdh: r2(d.h), pdl: r2(d.l), pdc: r2(d.c) });
  if (w) Object.assign(o, { pwStart: barDay(w), pwh: r2(w.h), pwl: r2(w.l) });
  if (m) Object.assign(o, { pmStart: barDay(m), pmh: r2(m.h), pml: r2(m.l) });
  return o;
}
function fib(h) {
  if (!h || h.pdh == null || h.pdl == null || h.pdo == null || h.pdc == null) return null;
  const R = h.pdh - h.pdl; if (!(R > 0)) return null; const up = h.pdc >= h.pdo, at = r => r2(up ? h.pdh - r * R : h.pdl + r * R);
  return { dir: up ? 'up' : 'down', f382: at(0.382), f500: at(0.5), f618: at(0.618) };
}
function sessionBars(bars, day, closeMin) { return (bars || []).filter(b => { const e = etOf(b.t); return e.day === day && e.min >= 570 && e.min < (closeMin || 960); }); }
function fourHour(m30, day, closeMin) {
  const s = sessionBars(m30, day, closeMin); if (!s.length) return null;
  const blk = a => a.length ? { h: r2(Math.max.apply(null, a.map(b => b.h))), l: r2(Math.min.apply(null, a.map(b => b.l))) } : null;
  const am = blk(s.filter(b => etOf(b.t).min < 810)), pm = blk(s.filter(b => etOf(b.t).min >= 810));
  return { amH: am ? am.h : null, amL: am ? am.l : null, pmH: pm ? pm.h : null, pmL: pm ? pm.l : null, amPartial: (closeMin || 960) < 810 };
}
function volProfile(m1, day, closeMin) {
  const s = sessionBars(m1, day, closeMin).filter(b => b.v > 0); if (s.length < 30) return null;
  const px = s[s.length - 1].c, w = Math.max(0.05, Math.round(0.0003 * px / 0.05) * 0.05), bins = {}; let tot = 0;
  s.forEach(b => { const k = Math.floor((b.h + b.l + b.c) / 3 / w + 1e-9); bins[k] = (bins[k] || 0) + b.v; tot += b.v; });
  const ks = Object.keys(bins).map(Number).sort((a, b) => a - b); let ip = 0; ks.forEach((k, i) => { if (bins[k] > bins[ks[ip]]) ip = i; });
  let lo = ip, hi = ip, acc = bins[ks[ip]];
  while (acc < 0.7 * tot && (lo > 0 || hi < ks.length - 1)) {
    const up = hi < ks.length - 1 ? bins[ks[hi + 1]] : -1, dn = lo > 0 ? bins[ks[lo - 1]] : -1;
    if (up >= dn) { hi++; acc += bins[ks[hi]]; } else { lo--; acc += bins[ks[lo]]; }
  }
  const c = k => r2((k + 0.5) * w); return { poc: c(ks[ip]), vah: c(ks[hi]), val: c(ks[lo]), bars: s.length };
}
const sorted = m => Object.keys(m).sort((a, b) => a - b);
function oiLevels(cons, spot) {
  const call = {}, put = {}, tot = {};
  (cons || []).forEach(c => { if (!(c.oi > 0)) return; const m = c.type === 'call' ? call : put; m[c.strike] = (m[c.strike] || 0) + c.oi; tot[c.strike] = (tot[c.strike] || 0) + c.oi; });
  const best = (m, f) => { let k = null; sorted(m).forEach(s => { if (f(+s) && (k === null || m[s] > m[k])) k = s; }); return k === null ? null : { strike: +k, oi: m[k] }; };
  return { callWall: best(call, s => s >= spot), putWall: best(put, s => s <= spot), max: best(tot, () => true) };
}
const phi = x => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
function bsGamma(S, K, T, iv) { if (!(S > 0 && K > 0 && T > 0 && iv > 0)) return 0; const sd = iv * Math.sqrt(T), d1 = (Math.log(S / K) + 0.5 * iv * iv * T) / sd; return phi(d1) / (S * sd); }
function gexLevels(rows, spot, nowMs) {
  const T = r => Math.max((Date.parse(r.exp + 'T16:00:00-05:00') - nowMs) / (365 * 864e5), 30 / (365 * 1440));
  const use = (rows || []).filter(r => r.oi > 0 && r.iv > 0 && r.strike > 0); if (use.length < 6) return null;
  const sign = r => r.type === 'call' ? 1 : -1, net = {};
  use.forEach(r => { net[r.strike] = (net[r.strike] || 0) + sign(r) * bsGamma(spot, r.strike, T(r), r.iv) * r.oi * 100 * spot * spot * 0.01; });
  let cw = null, pw = null, total = 0; sorted(net).forEach(s => { const v = net[s]; total += v; if (v > 0 && (cw === null || v > net[cw])) cw = s; if (v < 0 && (pw === null || v < net[pw])) pw = s; });
  let flip = null, bd = Infinity, pS = null, pV = null;
  for (let i = -24; i <= 24; i++) {
    const S = spot * (1 + i * 0.0025); let v = 0; use.forEach(r => { v += sign(r) * bsGamma(S, r.strike, T(r), r.iv) * r.oi * 100 * S * S * 0.01; });
    if (pV !== null && ((pV < 0 && v >= 0) || (pV > 0 && v <= 0))) { const x = pS + (0 - pV) * (S - pS) / (v - pV); if (Math.abs(x - spot) < bd) { bd = Math.abs(x - spot); flip = x; } }
    pS = S; pV = v;
  }
  return { callWall: cw === null ? null : +cw, putWall: pw === null ? null : +pw, flip: flip === null ? null : r2(flip), netUSD: Math.round(total), n: use.length };
}
const iso = ms => new Date(ms).toISOString();
async function fetchBars(api, st, sym, tf, start, end) {
  let err; for (const feed of ['sip', 'iex']) { try { const b = await api.bars(sym, tf, start, end, feed); if (feed === 'iex') st.feed = 'iex'; else if (st.feed !== 'iex') st.feed = 'sip'; return b; } catch (e) { err = e; } }
  throw err;
}
async function loadHtf(api, sym, st, now, cal) {
  const end = iso(now - 16 * 60000);
  const daily = await fetchBars(api, st, sym, '1Day', iso(now - 45 * 864e5), end), weekly = await fetchBars(api, st, sym, '1Week', iso(now - 28 * 864e5), end), monthly = await fetchBars(api, st, sym, '1Month', iso(now - 100 * 864e5), end);
  const h = htf(daily, weekly, monthly, now); if (!h.pdDay) throw new Error('no previous day in the daily bars');
  let closeMin = 960; try { if (!cal[h.pdDay]) { const c = await api.calendar(h.pdDay, h.pdDay), row = (c || []).filter(x => x.date === h.pdDay)[0]; cal[h.pdDay] = row && /^\d\d:\d\d$/.test(row.close) ? (+row.close.slice(0, 2)) * 60 + (+row.close.slice(3)) : 960; } closeMin = cal[h.pdDay]; } catch (e) { st.calErr = String(e && e.message || e).slice(0, 80); }
  const ws = h.pdDay + 'T00:00:00Z', we = iso(Math.min(dayMs(h.pdDay) + 30 * 3600000, now - 16 * 60000)); let h4 = null, vp = null;
  try { h4 = fourHour(await fetchBars(api, st, sym, '30Min', ws, we), h.pdDay, closeMin); } catch (e) { st.h4Err = String(e && e.message || e).slice(0, 80); }
  try { vp = volProfile(await fetchBars(api, st, sym, '1Min', ws, we), h.pdDay, closeMin); } catch (e) { st.vpErr = String(e && e.message || e).slice(0, 80); }
  st.htf = Object.assign(h, { closeMin }); st.fib = fib(h); st.h4 = h4; st.vp = vp; st.htfRef = h.ref; st.htfAt = now;
}
async function loadOi(api, sym, st, now, spot) {
  const ref = refDay(now), lo = spot * 0.92, hi = spot * 1.08, rows = []; let tok = '', pages = 0;
  do {
    const r = await api.contracts({ underlying_symbols: sym, expiration_date_gte: ref, expiration_date_lte: msDay(dayMs(ref) + 7 * 864e5), strike_price_gte: lo.toFixed(2), strike_price_lte: hi.toFixed(2), status: 'active', limit: 10000, page_token: tok || undefined });
    (r.option_contracts || []).forEach(c => { rows.push({ sym: c.symbol, type: c.type, strike: +c.strike_price, oi: +c.open_interest || 0, exp: c.expiration_date, oiDate: c.open_interest_date || null }); });
    tok = r.next_page_token || ''; pages++;
  } while (tok && pages < 6);
  if (!rows.length) throw new Error('no option contracts returned');
  st.oiRows = rows; st.oiRef = ref; st.oiAt = now;
}
async function loadGamma(api, sym, st, now, spot) {
  const ref = refDay(now), iv = {}; let tok = '', pages = 0;
  do {
    const r = await api.snaps(sym, { feed: 'indicative', limit: 1000, expiration_date_gte: ref, expiration_date_lte: msDay(dayMs(ref) + 7 * 864e5), strike_price_gte: (spot * 0.94).toFixed(2), strike_price_lte: (spot * 1.06).toFixed(2), page_token: tok || undefined });
    Object.keys(r.snapshots || {}).forEach(k => { const v = r.snapshots[k] && r.snapshots[k].impliedVolatility; if (v > 0) iv[k] = v; });
    tok = r.next_page_token || ''; pages++;
  } while (tok && pages < 6);
  st.ivMap = iv; st.gexAt = now;
}
function recompute(st, spot, now) {
  if (!st.oiRows || !(spot > 0)) return;
  const band = st.oiRows.filter(r => Math.abs(r.strike - spot) <= 0.06 * spot), oi = oiLevels(band, spot), dates = band.map(r => r.oiDate).filter(Boolean).sort();
  st.oi = Object.assign(oi, { oiDate: dates.length ? dates[dates.length - 1] : null, n: band.length });
  if (st.ivMap) { const g = gexLevels(band.map(r => ({ strike: r.strike, type: r.type, oi: r.oi, exp: r.exp, iv: st.ivMap[r.sym] })), spot, now); st.gex = g ? Object.assign(g, { asOf: st.gexAt, oiDate: st.oi.oiDate }) : null; }
}
/* One symbol, one pass. Each part fails on its own and keeps its last good value. Called about once a minute by the server's own timer. */
async function refreshSym(api, sym, st, o) {
  const now = o.now, ref = refDay(now), cal = o.cal || (o.cal = {}), spotNow = () => o.spot && o.spot(sym) || (st.htf && st.htf.pdc) || null;
  if (st.htfRef !== ref && now - (st.htfTry || 0) > 600000) { st.htfTry = now; try { await loadHtf(api, sym, st, now, cal); st.htfErr = null; } catch (e) { st.htfErr = String(e && e.message || e).slice(0, 100); } }
  const spot = spotNow();
  if (spot && st.oiRef !== ref && now - (st.oiTry || 0) > 600000) { st.oiTry = now; try { await loadOi(api, sym, st, now, spot); st.oiErr = null; } catch (e) { st.oiErr = String(e && e.message || e).slice(0, 100); } }
  if (spot && st.oiRows && o.open && now - (st.gexTry || 0) >= 600000) { st.gexTry = now; try { await loadGamma(api, sym, st, now, spot); st.gexErr = null; } catch (e) { st.gexErr = String(e && e.message || e).slice(0, 100); } }
  try { recompute(st, spot, now); } catch (e) { st.calcErr = String(e && e.message || e).slice(0, 100); }
}
function compact(st) {
  if (!st) return null; const e = [st.htfErr, st.oiErr, st.gexErr, st.calcErr].filter(Boolean);
  return { htf: st.htf || null, fib: st.fib || null, h4: st.h4 || null, vp: st.vp || null, oi: st.oi || null, gex: st.gex || null, feed: st.feed || null, err: e.length ? e.join(' | ') : null };
}
module.exports = { etOf, refDay, weekStart, monthStart, priorBar, htf, fib, sessionBars, fourHour, volProfile, oiLevels, bsGamma, gexLevels, refreshSym, compact };
